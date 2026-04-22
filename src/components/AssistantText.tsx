import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// remark-gfm 的 autolink 不识别中文标点/中文字符为 URL 终止符，会把
// "http://localhost:8787。刷新…" 整段吞成链接。这里在 URL 和紧跟的 CJK 字符
// 之间插入一个空格，既不破坏正文语义，也让 autolink 正常停下来。
const CJK_RE = /(https?:\/\/[^\s<>"'`]*?)([　-〿一-鿿＀-￯])/g;
function fixAutolinkBoundaries(src: string): string {
  return src.replace(CJK_RE, "$1 $2");
}

export default function AssistantText({
  text,
  delay = 0,
}: {
  text: string;
  delay?: number;
}) {
  return (
    <div
      className="msg-enter text-[14.5px] leading-[1.8] text-fg max-w-[94%] md-body"
      style={{ animationDelay: `${delay}ms` }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
          h1: ({ children }) => (
            <h1 className="text-[18px] font-semibold tracking-tight mt-5 mb-2 first:mt-0">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-[16px] font-semibold tracking-tight mt-5 mb-2 first:mt-0">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-[14.5px] font-semibold tracking-tight mt-4 mb-1.5 first:mt-0 text-fg">
              {children}
            </h3>
          ),
          h4: ({ children }) => (
            <h4 className="text-[13.5px] font-semibold mt-3 mb-1 first:mt-0 text-fg">
              {children}
            </h4>
          ),
          ul: ({ children }) => (
            <ul className="my-2 ml-5 list-disc marker:text-subtle space-y-1">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="my-2 ml-5 list-decimal marker:text-subtle space-y-1">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          strong: ({ children }) => (
            <strong className="font-semibold text-fg">{children}</strong>
          ),
          em: ({ children }) => <em className="italic text-fg">{children}</em>,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue underline decoration-blue/40 underline-offset-2 hover:decoration-blue transition-colors break-all"
            >
              {children}
            </a>
          ),
          hr: () => <hr className="my-5 border-t border-line" />,
          blockquote: ({ children }) => (
            <blockquote className="my-3 pl-3 border-l-2 border-line-strong text-muted">
              {children}
            </blockquote>
          ),
          code: ({ className, children, ...props }) => {
            const isBlock = className?.startsWith("language-");
            if (isBlock) {
              return (
                <code className={`${className} font-mono text-[12.5px] leading-[1.6]`} {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code
                className="font-mono text-[12.5px] bg-fg/[0.06] text-fg px-1.5 py-0.5 rounded-[4px] break-words"
                {...props}
              >
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="my-3 p-3.5 rounded-md bg-surface border border-line overflow-x-auto font-mono text-[12.5px] leading-[1.65]">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto">
              <table className="w-full text-[13px] border-collapse">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => <thead className="border-b border-line-strong">{children}</thead>,
          tr: ({ children }) => <tr className="border-b border-line last:border-b-0">{children}</tr>,
          th: ({ children }) => (
            <th className="text-left font-semibold py-1.5 px-3 text-fg">{children}</th>
          ),
          td: ({ children }) => (
            <td className="py-1.5 px-3 text-muted align-top">{children}</td>
          ),
        }}
      >
        {fixAutolinkBoundaries(text)}
      </ReactMarkdown>
    </div>
  );
}
