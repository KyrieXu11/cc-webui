// Explicit one-way migration. No bot startup, no guessing actor ownership.
// npx tsx scripts/import-project-memory.ts --apply --manifest /absolute/plan.json --report /absolute/report.json
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadDotEnvOnce } from "../server/env.ts";
import { listUsers } from "../server/auth/users.ts";
import { closeDb } from "../server/db.ts";
import { resolveMemoryScope } from "../server/project-memory/scope.ts";
import { readClaudeProjectMemory } from "../server/memory-routes.ts";
import { importClaudeMemory } from "../server/project-memory/import.ts";

const args = process.argv.slice(2);
const value = (flag: string) => args[args.indexOf(flag) + 1];
if (!args.includes("--apply") || !args.includes("--manifest") || !args.includes("--report")) {
  throw new Error("Requires --apply --manifest PLAN.json --report REPORT.json; plan projects must explicitly name username and cwd");
}
const manifestPath = path.resolve(value("--manifest"));
const reportPath = path.resolve(value("--report"));
if (manifestPath === reportPath) throw new Error("Report must not overwrite the manifest");
const plan: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
if (!plan || typeof plan !== "object" || !("projects" in plan) || !Array.isArray(plan.projects)) throw new Error("projects array required");
const projects = plan.projects as Array<{ username: string; cwd: string }>;
if (projects.some(p => !p || typeof p.username !== "string" || typeof p.cwd !== "string" || !path.isAbsolute(p.cwd))) throw new Error("Each project needs username and absolute cwd");
loadDotEnvOnce();
const users = listUsers();
const reports = [];
try {
  for (const project of projects) {
    try {
      const user = users.find(u => u.username === project.username);
      if (!user) throw new Error("Unknown account");
      const scope = await resolveMemoryScope(user.id, project.cwd);
      const source = await readClaudeProjectMemory(project.cwd);
      if (!source.dir) throw new Error("No native memory directory for this project");
      const results = source.memories.length ? await importClaudeMemory(scope, source.memories.map(m => m.file), project.cwd) : [];
      reports.push({ ...project, results });
      console.log(`${project.username}: ${project.cwd}: ${results.filter(r => !("error" in r)).length}/${results.length} imported`);
    } catch (e) {
      reports.push({ ...project, error: e instanceof Error ? e.message : "Import failed" });
    }
  }
  await writeFile(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), projects: reports }, null, 2) + "\n", { mode: 0o600 });
  if (reports.some(p => "error" in p || p.results?.some(r => "error" in r))) process.exitCode = 1;
} finally {
  closeDb();
}
