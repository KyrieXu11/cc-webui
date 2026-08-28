// 把命中的那一段标出来。HeaderSearch（项目内顶栏的搜索下拉）和 HomeView（首页
// 「最近项目」的就地过滤）共用同一个，别各写一份 —— 两处高亮不一样会显得像 bug。
//
// 只标**第一处**命中：这些文本是标题/路径，短，而且用户输的关键词就是他要找的那个词，
// 标满屏反而更难扫。
export default function Highlighted({
  text,
  query,
}: {
  text: string;
  query: string;
}) {
  const q = query.trim().toLowerCase();
  if (!q) return <span>{text}</span>;
  const pos = text.toLowerCase().indexOf(q);
  if (pos < 0) return <span>{text}</span>;
  return (
    <span>
      {text.slice(0, pos)}
      <span className="text-fg font-medium bg-blue/20 rounded-sm px-[1px]">
        {text.slice(pos, pos + q.length)}
      </span>
      {text.slice(pos + q.length)}
    </span>
  );
}
