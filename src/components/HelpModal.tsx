import { useEffect } from "react";
import { useAuth } from "../AuthGate";

interface Props {
  onClose: () => void;
}

// 操作手册。**写的是现在真实的交互**，改了哪个手势就回来改这里 ——
// 上一版还写着「单击文件 → 插入 @路径」，而那颗行为早就变成「在右侧打开」了。
type Section = {
  title: string;
  rows: Array<[string, string]>;
  note?: string;
  /** 只给管理员看：普通账号根本碰不到这些入口，写出来只会让人找不到。 */
  adminOnly?: boolean;
};

const SECTIONS: Section[] = [
  {
    title: "键盘快捷键",
    rows: [
      ["↵", "发送；上一轮还在跑时＝排队，这一轮跑完自动发出"],
      ["⇧↵", "换行"],
      ["⌘K / Ctrl+K", "首页：跳到搜索框"],
      ["Ctrl+O", "展开 / 收起所有工具步骤和思考"],
      ["Ctrl+B", "把正在跑的前台 bash 转成后台任务（没有前台任务时忽略）"],
      ["/", "调出斜杠命令 / skill 菜单"],
      ["↑ ↓ ↵", "在搜索 / 菜单 / 对话框里上下选、回车打开"],
      ["Esc", "关闭弹窗 / 菜单 / 预览；文件面板里退出多选"],
      ["Backspace（@路径 末尾）", "整段删掉这个路径引用"],
    ],
  },
  {
    title: "对话框",
    rows: [
      ["蓝色 ↑", "发送"],
      ["红色 ■", "停止当前生成：已经出来的文字保留；排队的消息不丢，只是先停住"],
      ["排队里的「发送」", "不等这一轮跑完，现在就插进正在跑的这一轮（Claude 才有）"],
      ["+", "附加图片 / 文件（也可以直接粘贴、拖进来）"],
      ["底栏 模型 · 模式 · effort", "模型分两组：「跟随最新」会随官方升级自动换新版；「固定版本」一直是那一版"],
      ["思考状态行「· xhigh effort」", "这一轮实际用的档位（看别人的对话时也是对方那一轮的）"],
    ],
  },
  {
    title: "附件",
    rows: [
      ["图片", "直接发给模型看"],
      ["其他文件（PDF、Word…）", "气泡里只显示文件名，鼠标停在上面能看到完整路径"],
    ],
    note:
      "⚠️ 通过对话框「+」上传的文件放在临时目录，大约 3 天后会被系统自动清掉。需要反复用的资料，请用文件面板的「上传」放进项目里。",
  },
  {
    title: "文件面板（右上角按钮打开，只在项目里有）",
    rows: [
      ["单击文件", "在右侧打开：文本可以直接改，.md / .html 可以切到渲染看，Office 文档在右侧打开"],
      ["⌘ / Ctrl + 单击文件", "浮窗速览"],
      ["单击文件夹", "展开 / 收起，同时把它设为「上传」「新建文件夹」的位置"],
      ["右键文件或文件夹", "进入多选（再右键或勾选继续加选）"],
      ["多选 → 下载", "一个文件直接下载，多个打包成 zip（文件夹不能下载）"],
      ["多选 → 删除", "真删、没有回收站；文件夹只能删空的，不空的会原样留下"],
      ["拖到文件夹 / 拖到对话框", "拖到文件夹＝移动；拖到对话框＝插入文件路径"],
      ["悬停出现的铅笔", "重命名"],
    ],
  },
  {
    title: "项目记忆",
    rows: [
      ["左侧竖栏的书本图标", "查看当前项目的统一记忆（有权打开项目的账号共用）（只读）：左边是索引、右边是正文；在对话里要求 AI 记住、更新或忘记，Claude / Codex 共用"],
    ],
  },
  {
    title: "本地命令（cc-webui）",
    rows: [
      ["/skills", "打开 skill 选择器，点击后插入 /<skill>"],
      ["/help", "打开这个手册"],
      ["/clear", "开启新会话（保留当前项目）"],
      ["/exit", "关闭项目，返回主页"],
    ],
    note: "输入 / 可以看到所有命令：上面这几条由 cc-webui 自己处理，其余的原样交给 claude 命令行。",
  },
  {
    title: "管理员",
    adminOnly: true,
    rows: [
      ["管理 → 用户 → 默认模型 / effort", "给某个账号设默认值：对方下次打开页面（或切回标签页）时换成你设的，之后对方自己改的会保留，直到你再保存"],
      ["顶栏「共享」", "把会话共享给别的账号：对方能看、能接着聊，但删不掉、也不能再共享"],
      ["管理 → 用户 → 目录白名单", "决定对方能在哪些文件夹里工作（是使用上的便利，不是安全隔离）"],
    ],
  },
];

export default function HelpModal({ onClose }: Props) {
  const { isAdmin } = useAuth();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/55 backdrop-blur-[2px] flex items-start justify-center pt-[10vh] p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[640px] soft-dialog overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <h3 className="text-fg text-[15px] font-semibold tracking-tight">操作手册</h3>
          <button
            onClick={onClose}
            aria-label="关闭"
            className="text-subtle hover:text-fg p-1 rounded"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path
                d="M3 3L11 11M11 3L3 11"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <div className="p-5 space-y-5 max-h-[70vh] overflow-y-auto">
          {SECTIONS.filter((s) => !s.adminOnly || isAdmin).map((s) => (
            <section key={s.title}>
              <h4 className="text-[11px] font-mono text-subtle uppercase tracking-[0.08em] mb-2">
                {s.title}
              </h4>
              <dl className="text-[13px]">
                {s.rows.map(([key, desc]) => (
                  <div
                    key={key}
                    className="flex items-baseline gap-4 py-1.5 border-b border-line last:border-b-0"
                  >
                    <dt className="font-mono text-[12px] text-fg w-[180px] shrink-0">{key}</dt>
                    <dd className="text-muted leading-relaxed">{desc}</dd>
                  </div>
                ))}
              </dl>
              {s.note && (
                <p className="text-[12px] text-subtle mt-2.5 leading-relaxed">{s.note}</p>
              )}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
