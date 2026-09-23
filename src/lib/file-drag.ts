// 从文件树里拖出来的那批文件。两个落点：树里的另一个文件夹（＝移动）、
// 对话框（＝把相对路径插进去）。
//
// ⚠️⚠️ **dragover 阶段读不到 dataTransfer 的内容**（浏览器的 protected mode，
// 只有 dragstart 和 drop 能 getData，中间只能看 `types`）。而「这儿能不能放」
// 必须在 dragover 就答出来——所以：
//   · 判断「是不是我们的拖拽」用 `hasDraggedFiles`（只看 types，随时能用）；
//   · 需要看**内容**才能决定的（比如「这些文件本来就在这个文件夹里」「别把文件夹
//     拖进它自己」），只能另外用一个模块级变量记着，见 FileExplorer 里的 dragging。

export const FILE_DRAG_MIME = "application/x-cc-webui-files";

export type DraggedFile = {
  /** 绝对路径，移动时用。 */
  path: string;
  name: string;
  /** 相对当前 cwd 的路径，插进对话框时用（Composer 不知道 cwd 是什么）。 */
  rel: string;
};

export function hasDraggedFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  // types 是 DOMStringList/只读数组，Safari 下没有 includes。
  return Array.from(dt.types).includes(FILE_DRAG_MIME);
}

export function writeDraggedFiles(dt: DataTransfer, files: DraggedFile[]): void {
  dt.setData(FILE_DRAG_MIME, JSON.stringify(files));
  // 顺手给一份纯文本：拖到编辑器、终端、别的应用里也能用。
  dt.setData("text/plain", files.map((f) => f.rel).join(" "));
  dt.effectAllowed = "copyMove";
}

export function readDraggedFiles(dt: DataTransfer | null): DraggedFile[] {
  if (!dt) return [];
  try {
    const raw = dt.getData(FILE_DRAG_MIME);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is DraggedFile =>
        !!x && typeof x.path === "string" && typeof x.rel === "string"
    );
  } catch {
    return [];
  }
}
