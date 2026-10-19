// 下载前先列全清单、逐项授权；任何一项失败都不开始发 ZIP，避免悄悄漏文件。
import { constants, promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { assertCanOpen } from "./auth/paths.ts";
import {
  ZIP_MAX_ARCHIVE_BYTES,
  ZIP_MAX_ENTRIES,
  ZIP_MAX_ENTRY_BYTES,
  type ZipEntry,
} from "./zip.ts";

export class FileDownloadError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 413, message: string) {
    super(message);
  }
}

type Download =
  | { kind: "file"; path: string; size: number }
  | { kind: "zip"; name: string; entries: ZipEntry[] };

export async function prepareDownload(
  raws: string[],
  patterns: readonly string[],
  signal?: AbortSignal,
): Promise<Download> {
  const inspect = async (raw: string, nested = false) => {
    signal?.throwIfAborted();
    let target: string;
    try {
      target = await assertCanOpen(raw, patterns);
    } catch {
      throw new FileDownloadError(403, `${raw} 不在你账号可以打开的范围内`);
    }
    let stat: Stats;
    try {
      // 显式选中的路径沿用原来的 realpath 语义；目录内的软链不跟随，避免循环、
      // 越过所选目录或把同一份内容递归打包。不能静默跳过，整次拒绝并指出原因。
      stat = await fs.lstat(nested ? raw : target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new FileDownloadError(404, `文件不存在：${raw}`);
      }
      throw new FileDownloadError(403, `无法读取：${raw}`);
    }
    if (stat.isSymbolicLink()) {
      throw new FileDownloadError(400, `文件夹内含软链接，不能打包：${raw}`);
    }
    if (!stat.isFile() && !stat.isDirectory()) {
      throw new FileDownloadError(400, `只能下载文件或文件夹：${raw}`);
    }
    return { path: target, stat };
  };

  const selected = new Map<string, Awaited<ReturnType<typeof inspect>>>();
  for (const raw of raws) {
    const item = await inspect(raw);
    selected.set(item.path, item);
  }
  const items = [...selected.values()];
  // 先授权所有显式选择，再去掉被已选文件夹包含的后代。无论选择先后都只打包一次。
  const roots = items.filter(item => !items.some(other =>
    other !== item && other.stat.isDirectory() && isDescendant(other.path, item.path),
  ));
  if (roots.length === 1 && roots[0].stat.isFile()) {
    return { kind: "file", path: roots[0].path, size: roots[0].stat.size };
  }

  const root = commonDir(roots.map(item => item.path));
  const entries: ZipEntry[] = [];
  let archiveBytes = 22; // EOCD；其余头部与 UTF-8 文件名也计入 4GiB 上限。
  const visit = async (item: Awaited<ReturnType<typeof inspect>>, name: string): Promise<void> => {
    signal?.throwIfAborted();
    const directory = item.stat.isDirectory();
    const zipName = directory ? `${name}/` : name;
    // POSIX 允许反斜线文件名，但 Windows 解压器会把它当分隔符，甚至变成 ../。
    if (name.includes("\\") || /^[a-z]:/i.test(name) || Buffer.byteLength(zipName) > 0xffff) {
      throw new FileDownloadError(400, `文件名无法安全打包：${name}`);
    }
    if (entries.length >= ZIP_MAX_ENTRIES) {
      throw new FileDownloadError(413, `打包最多包含 ${ZIP_MAX_ENTRIES} 项，请分批下载`);
    }
    const size = directory ? 0 : item.stat.size;
    if (size > ZIP_MAX_ENTRY_BYTES) {
      throw new FileDownloadError(413, `${name} 超过 4GiB，打不进 zip`);
    }
    if (!directory) {
      try {
        await fs.access(item.path, constants.R_OK);
      } catch {
        throw new FileDownloadError(403, `无法读取：${item.path}`);
      }
    }
    archiveBytes += size + 76 + 2 * Buffer.byteLength(zipName) + (directory ? 0 : 16);
    if (archiveBytes > ZIP_MAX_ARCHIVE_BYTES) {
      throw new FileDownloadError(413, "打包总大小超过 4GiB，请分批下载");
    }
    entries.push({ path: item.path, name: zipName, mtimeMs: item.stat.mtimeMs, directory });
    if (!directory) return;

    let dir;
    try {
      dir = await fs.opendir(item.path);
    } catch {
      throw new FileDownloadError(403, `无法读取文件夹：${item.path}`);
    }
    // 顺序、逐目录枚举，不一次 readFile 整棵树，也不无限并发 stat/readdir。
    for await (const child of dir) {
      const next = await inspect(path.join(item.path, child.name), true);
      await visit(next, `${name}/${child.name}`);
    }
  };
  for (const item of roots) {
    await visit(item, path.relative(root, item.path).split(path.sep).join("/") || "files");
  }
  return {
    kind: "zip",
    name: `${roots.length === 1 ? path.basename(roots[0].path) || "files" : path.basename(root) || "files"}.zip`,
    entries,
  };
}

function isDescendant(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return !!relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// 包内路径相对「所选项的公共父目录」，而非遍历结果，保留所选文件夹本身这一层。
function commonDir(paths: string[]): string {
  let root = path.dirname(paths[0]);
  for (const target of paths.slice(1)) {
    while (root !== target && !isDescendant(root, target)) root = path.dirname(root);
  }
  return root;
}
