/** UI-only ancestry. Outside-project files never change the tree root.
 * Parent traversal / symlink resolution remains a server responsibility: do
 * not collapse .. and accidentally highlight a different file in the tree. */
export function fileTreeTarget(cwd: string, file: string | null | undefined): { path: string; directories: string[] } | null {
  const clean = (value: string) => {
    if (!value.startsWith("/") || value.startsWith("//") || /[\u0000-\u001f\u007f\\]/.test(value)) return null;
    const parts = value.split("/").filter(part => part && part !== ".");
    return parts.includes("..") ? null : "/" + parts.join("/");
  };
  if (!file || file.endsWith("/")) return null;
  const root = clean(cwd), path = clean(file);
  if (!root || !path || path === root || !path.startsWith(root === "/" ? "/" : root + "/")) return null;
  const relative = path.slice(root === "/" ? 1 : root.length + 1).split("/");
  const directories: string[] = [];
  let parent = root === "/" ? "" : root;
  for (const name of relative.slice(0, -1)) {
    parent += "/" + name;
    directories.push(parent);
  }
  return { path, directories };
}
