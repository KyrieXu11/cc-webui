import { Hono } from "hono";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const uploadRoute = new Hono();

const UPLOAD_DIR =
  process.env.CC_WEBUI_UPLOAD_DIR ||
  path.join(os.tmpdir(), "cc-webui-uploads");

function sanitize(name: string): string {
  return (
    name
      .replace(/[/\\]/g, "_")
      .replace(/[^\w.\-一-龥]/g, "_")
      .slice(0, 120) || "file"
  );
}

uploadRoute.post("/", async (c) => {
  const body = await c.req.parseBody({ all: true });
  const raw = body["files"];
  const list: File[] = [];
  if (Array.isArray(raw)) {
    for (const x of raw) if (x instanceof File) list.push(x);
  } else if (raw instanceof File) {
    list.push(raw);
  }
  if (list.length === 0) return c.json({ error: "no files" }, 400);

  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const saved: Array<{
    name: string;
    path: string;
    size: number;
    mime: string;
  }> = [];
  for (const f of list) {
    const stamp = Date.now().toString(36);
    const safe = sanitize(f.name);
    const filename = `${stamp}-${safe}`;
    const dest = path.join(UPLOAD_DIR, filename);
    const buf = Buffer.from(await f.arrayBuffer());
    await fs.writeFile(dest, buf);
    saved.push({
      name: f.name,
      path: dest,
      size: buf.length,
      mime: f.type || "application/octet-stream",
    });
  }
  return c.json({ files: saved });
});

export { uploadRoute };
