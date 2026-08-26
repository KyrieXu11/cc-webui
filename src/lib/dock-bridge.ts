// 右侧格的模块级通道。照律枢的 dockBridge：**不逐层传回调**。
//
// 为什么：能打开文件的入口会有好几个（取件台列表、目录树、以后消息里的附件卡），
// 而右侧格挂在 App 层。若靠 props 串起来，每加一个入口就要在中间的每一层加一个
// 参数，而中间那些层跟"打开文件"这件事毫无关系。

export type DockFile = {
  path: string;
  name: string;
};

type Listener = (f: DockFile) => void;

const listeners = new Set<Listener>();

export function openInDock(f: DockFile): void {
  for (const fn of listeners) fn(f);
}

export function onDockOpen(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
