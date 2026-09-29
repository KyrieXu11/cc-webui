import { readClaudeProjectMemory } from "../memory-routes.ts";
import { digest, MemoryError, validateMemoryScope, resolveMemoryScope, type MemoryScope } from "./scope.ts";
import { saveMemory, MEMORY_TYPES, type MemoryType } from "./store.ts";
export async function importClaudeMemory(scope: MemoryScope, files: string[], sourceCwd = scope.cwd) {
  await validateMemoryScope(scope);
  if (!files.length || files.length > 300 || files.some(f => typeof f !== "string")) throw new MemoryError("invalid_input", "请选择要导入的原生记忆");
  if ((await resolveMemoryScope(scope.actorId, sourceCwd)).id !== scope.id) throw new MemoryError("scope_unavailable", "导入来源不是当前项目");
  const source = await readClaudeProjectMemory(sourceCwd);
  const selected = source.memories.filter(m => files.includes(m.file));
  if (selected.length !== new Set(files).size) throw new MemoryError("invalid_input", "只能导入服务端枚举出的记忆文件");
  const results = [];
  for (const m of selected) {
    try {
      if (m.truncated || !MEMORY_TYPES.includes(m.type as MemoryType)) throw new MemoryError("invalid_input", "正文被截断或类型无效，不能自动导入");
      const name = m.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "import-" + digest(m.file).slice(0, 16);
      const result = await saveMemory(scope, {
        operation_id: "import:" + digest(JSON.stringify([source.dir, m.file, m.body, m.description, m.type])),
        name,
        description: (m.description || m.name).replace(/[\r\n]/g, " ").slice(0, 240),
        type: m.type as MemoryType,
        body: m.body
      }, {
        provider: "claude-import",
        sessionId: ""
      });
      results.push({
        file: m.file,
        ...result
      });
    } catch (e) {
      const error = e instanceof MemoryError ? e : new MemoryError("storage_unavailable", "导入失败");
      results.push({
        file: m.file,
        error: error.code,
        message: error.message
      });
    }
  }
  return results;
}
