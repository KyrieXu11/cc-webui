import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cc-memory-migrate-"));
Object.assign(process.env, { CC_WEBUI_DB: path.join(tmp,"db"), CC_WEBUI_PROJECT_MEMORY_DIR: path.join(tmp,"memory"), CC_WEBUI_WORKSPACES_DIR: path.join(tmp,"workspaces"), CC_WEBUI_CLAUDE_PROJECTS_DIR: path.join(tmp,"claude"), CC_WEBUI_COOKIE_SECRET_FILE: path.join(tmp,"cookie"), CC_WEBUI_GROUPS_DIR: path.join(tmp,"groups"), CC_WEBUI_PROJECT_MEMORY_ENABLED: "1" });
const { getDb, closeDb } = await import("./db.ts");
const { createUser, deleteUser } = await import("./auth/users.ts");
const { digest, resolveMemoryScope } = await import("./project-memory/scope.ts");
const { readMemory, listMemory, saveMemory, deleteMemory, recoverMemoryFiles, memoryRoot } = await import("./project-memory/store.ts");
await fs.mkdir(path.join(tmp,"project")); await fs.mkdir(path.join(tmp,"other"));
const cwd = await fs.realpath(path.join(tmp,"project")), otherCwd = await fs.realpath(path.join(tmp,"other"));
const alice = createUser({username:"alice",password:"pw",role:"user",allowedPaths:[tmp]});
const bob = createUser({username:"bob",password:"pw",role:"user",allowedPaths:[tmp]});
try {
  const db = getDb();
  db.exec("DROP TABLE project_memory_operations; DROP TABLE project_memory_revisions; DROP TABLE project_memories; DROP TABLE project_memory_scopes;");
  // Schema 9 fixture: shipped account/project storage, intentionally unchanged.
  db.exec(`
  CREATE TABLE project_memory_scopes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cwd TEXT NOT NULL, project_key TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    UNIQUE(user_id, cwd)
  );
  CREATE TABLE project_memories (
    id TEXT PRIMARY KEY,
    scope_id TEXT NOT NULL REFERENCES project_memory_scopes(id) ON DELETE CASCADE,
    name TEXT NOT NULL, description TEXT NOT NULL, type TEXT NOT NULL,
    revision INTEGER NOT NULL, file TEXT NOT NULL, hash TEXT NOT NULL, body_offset INTEGER NOT NULL,
    provider TEXT NOT NULL, session_id TEXT NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(scope_id, name)
  );
  CREATE INDEX idx_project_memory_scope ON project_memories(scope_id,updated_at DESC,id);
  CREATE TABLE project_memory_revisions (
    memory_id TEXT NOT NULL REFERENCES project_memories(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL, parent_revision INTEGER NOT NULL, file TEXT NOT NULL,
    hash TEXT NOT NULL, body_offset INTEGER NOT NULL, provider TEXT NOT NULL, session_id TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(memory_id, revision)
  );
  CREATE TABLE project_memory_operations (
    scope_id TEXT NOT NULL REFERENCES project_memory_scopes(id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL, request_hash TEXT NOT NULL, result TEXT NOT NULL,
    PRIMARY KEY(scope_id, operation_id)
  );
  `);
  db.exec("PRAGMA user_version=9");
  const scopeId = (user: string,p: string) => digest(JSON.stringify([user,p]));
  const insScope = db.prepare("INSERT INTO project_memory_scopes(id,user_id,cwd,project_key,revision) VALUES(?,?,?,?,?)");
  for (const [user,p] of [[alice.id,cwd],[bob.id,cwd],[alice.id,otherCwd]]) insScope.run(scopeId(user,p),user,p,digest(p),1);
  await fs.mkdir(memoryRoot(),{recursive:true}); await fs.writeFile(path.join(memoryRoot(),".cc-webui-project-memory"),"cc-webui-project-memory-v1\n");
  const originalFiles = new Map<string,string>();
  const add = async (user: string,p: string,name: string,body: string,now: number) => {
    const id=randomUUID(),relative=path.join(user,digest(p),id,randomUUID()+".md");
    const full=path.join(memoryRoot(),relative); await fs.mkdir(path.dirname(full),{recursive:true}); await fs.writeFile(full,body); originalFiles.set(full,body);
    db.prepare("INSERT INTO project_memories(id,scope_id,name,description,type,revision,file,hash,body_offset,provider,session_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(id,scopeId(user,p),name,"迁移测试","feedback",1,relative,digest(body),0,"claude","",now);
    db.prepare("INSERT INTO project_memory_revisions(memory_id,revision,parent_revision,file,hash,body_offset,provider,session_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id,1,0,relative,digest(body),0,"claude","",now);
    const input={ operation_id:"retry",name,description:"迁移测试",type:"feedback" as const,body };
    if (name==="rule") db.prepare("INSERT INTO project_memory_operations(scope_id,operation_id,request_hash,result) VALUES(?,?,?,?)").run(scopeId(user,p),"retry",digest(JSON.stringify(["save",null,null,name,input.description,input.type,body])),JSON.stringify({id,revision:1,scope_revision:1}));
    return { id,relative,input };
  };
  const a=await add(alice.id,cwd,"rule","alice original body",1);
  const b=await add(bob.id,cwd,"rule","bob original body",2);
  const reserved="rule-"+a.id.slice(0,8);
  const c=await add(bob.id,cwd,reserved,"reserved name record",3);
  const other=await add(alice.id,otherCwd,"rule","other project body",4);
  closeDb();
  const migrated=getDb(); assert.equal(migrated.prepare("PRAGMA user_version").get()!.user_version,10);
  assert.deepEqual(migrated.prepare("PRAGMA foreign_key_check").all(),[]);
  assert.equal(migrated.prepare("SELECT COUNT(*) as n FROM project_memory_scopes").get()!.n,2);
  const sharedA=await resolveMemoryScope(alice.id,cwd),sharedB=await resolveMemoryScope(bob.id,cwd);
  assert.equal(sharedA.id,sharedB.id); assert.equal((await listMemory(sharedA)).total,3);
  assert.equal((await readMemory(sharedA,b.id)).name,"rule");
  assert.notEqual((await readMemory(sharedB,a.id)).name,reserved,"suffix may not steal another entry's original name");
  assert.equal((await readMemory(sharedB,c.id)).name,reserved);
  assert.equal((await readMemory(sharedB,a.id)).body,"alice original body");
  await assert.rejects(readMemory(sharedB,other.id),/没有该记忆/);
  await recoverMemoryFiles();
  for (const [file,body] of originalFiles) assert.equal(await fs.readFile(file,"utf8"),body,"migration/recovery never rewrite or delete live immutable bodies");
  assert.equal((await saveMemory(sharedA,a.input,{provider:"claude",sessionId:""})).replayed,true);
  assert.equal((await saveMemory(sharedB,b.input,{provider:"claude",sessionId:""})).replayed,true);
  const updated=await saveMemory(sharedA,{...b.input,operation_id:"update",id:b.id,expected_revision:1,body:"shared new version"},{provider:"codex",sessionId:""});
  assert.equal(updated.revision,2);
  const oldFolder=path.dirname(path.join(memoryRoot(),b.relative));
  await deleteMemory(sharedB,{operation_id:"forget",id:b.id,expected_revision:2});
  await assert.rejects(fs.stat(oldFolder),/ENOENT/);
  await assert.rejects(fs.stat(path.join(memoryRoot(),"projects",sharedB.projectKey,b.id)),/ENOENT/);
  deleteUser(alice.id);
  assert.equal((await readMemory(sharedB,a.id)).body,"alice original body","account deletion retains shared memory and legacy body pointers");
  closeDb();
  assert.equal((await listMemory(sharedB)).total,2,"reopen must not run migration again");
} finally { closeDb(); await fs.rm(tmp,{recursive:true,force:true}); }
