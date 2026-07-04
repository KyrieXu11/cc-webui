import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as lark from "@larksuiteoapi/node-sdk";
import type { ImageAttachment } from "../groups/store.ts";
import type { AgentId } from "../groups/store.ts";
import { feishuDataDir } from "./config.ts";

const MAX_IMAGES = 4;
const MAX_BYTES_PER_IMAGE = 5 * 1024 * 1024;
const MAX_QUOTED_TEXT_CHARS = 12_000;
const MAX_CACHE_ENTRIES = 2_000;
const INBOX_DIR = path.join(os.tmpdir(), "cc-webui-feishu-inbox");
const MESSAGE_CACHE_FILE = path.join(feishuDataDir(), "message-cache.json");

type CachedMessage = {
  text: string;
  agent?: AgentId;
  updatedAt: number;
};

const messageCache = new Map<string, CachedMessage>();
let cacheLoaded = false;

export type QuotedContext = {
  text: string;
  images: ImageAttachment[];
  // Local-disk paths to the same images. Provided so Claude can act on
  // the raw bytes (`cp` / `mv` / image processing) — the multimodal
  // vision input only lets it *see* the image, not write the bytes out.
  imagePaths: string[];
};

// Feishu's streaming markdown replies are CardKit "interactive" messages that
// message.get only exposes as `{type:"card", data:{card_id}}`; there is no
// message-body text to parse. Since cc-webui produced those messages, keep a
// small local message_id → rendered markdown cache so later quote-replies can
// recover exactly what the user quoted.
export async function rememberFeishuMessage(
  messageId: string,
  entry: { text: string; agent?: AgentId },
): Promise<void> {
  const text = clipQuotedText(entry.text);
  if (!messageId || !text.trim()) return;
  await loadMessageCache();
  messageCache.set(messageId, {
    text,
    agent: entry.agent,
    updatedAt: Date.now(),
  });
  pruneMessageCache();
  await saveMessageCache();
}

// Resolve the content of the message a user is replying-to: pull out the
// embedded text (for text / post types) and download up to MAX_IMAGES images
// from image / post types. Failures degrade gracefully — a missing message or
// a download error returns whatever was already collected.
export async function fetchQuotedContext(
  channel: lark.LarkChannel,
  messageId: string,
): Promise<QuotedContext> {
  const out: QuotedContext = { text: "", images: [], imagePaths: [] };
  const cached = await getRememberedMessage(messageId);
  if (cached?.text) {
    out.text = cached.text;
  }

  let resp;
  try {
    resp = await channel.rawClient.im.v1.message.get({
      path: { message_id: messageId },
    });
  } catch (err) {
    console.error("[feishu quote] message.get failed:", err);
    return out;
  }
  const item = resp?.data?.items?.[0];
  if (!item) return out;

  const msgType = item.msg_type;
  const contentRaw = item.body?.content;
  if (!contentRaw) return out;

  let parsed: any;
  try {
    parsed = JSON.parse(contentRaw);
  } catch {
    return out;
  }

  const imageKeys: string[] = [];
  if (msgType === "image" && typeof parsed.image_key === "string") {
    imageKeys.push(parsed.image_key);
  } else if (msgType === "post" && Array.isArray(parsed.content)) {
    const { text, images } = extractPostContent(parsed);
    setQuotedTextFromApi(out, text);
    imageKeys.push(...images);
  } else if (msgType === "text" && typeof parsed.text === "string") {
    setQuotedTextFromApi(out, parsed.text);
  } else if (msgType === "interactive") {
    const text = extractCardText(parsed);
    setQuotedTextFromApi(out, text);
  }

  let savedDir = false;
  for (let i = 0; i < Math.min(imageKeys.length, MAX_IMAGES); i++) {
    const key = imageKeys[i];
    try {
      const buf = await downloadMessageImage(channel, messageId, key);
      if (buf.length > MAX_BYTES_PER_IMAGE) {
        console.warn(
          `[feishu quote] image ${key} too large (${buf.length} bytes), skipped`,
        );
        continue;
      }
      const mime = detectImageMime(buf);
      out.images.push({ mediaType: mime, data: buf.toString("base64") });

      // Persist to a stable local path so Claude can manipulate the raw
      // bytes via Bash/Read. Filename is keyed by message_id + index so
      // re-quoting the same message reuses the same path.
      if (!savedDir) {
        await fs.mkdir(INBOX_DIR, { recursive: true });
        savedDir = true;
      }
      const ext = extFromMime(mime);
      const filename = `${sanitize(messageId)}-${i}.${ext}`;
      const filepath = path.join(INBOX_DIR, filename);
      await fs.writeFile(filepath, buf);
      out.imagePaths.push(filepath);
    } catch (err) {
      console.error(`[feishu quote] download ${key} failed:`, err);
    }
  }

  return out;
}

// Message API text is a fallback for locally cached bot messages. In
// particular, CardKit streaming messages can expose only an unsupported-client
// placeholder like “请升级至最新版本客户端，以查看内容”. Do not let that overwrite the
// rendered markdown we cached when sending the card.
function setQuotedTextFromApi(out: QuotedContext, text: string): void {
  const normalized = normalizeExtractedQuotedText(text);
  if (!normalized) return;
  if (!out.text) out.text = normalized;
}

export function normalizeExtractedQuotedText(text: string): string {
  const clipped = clipQuotedText(text).trim();
  if (!clipped) return "";
  if (isUnsupportedClientFallback(clipped)) return "";
  return clipped;
}

function isUnsupportedClientFallback(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  return /^请升级至.*客户端[，,]?以查看内容$/.test(compact);
}

async function getRememberedMessage(
  messageId: string,
): Promise<CachedMessage | undefined> {
  await loadMessageCache();
  return messageCache.get(messageId);
}

async function loadMessageCache(): Promise<void> {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const raw = await fs.readFile(MESSAGE_CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw) as Record<string, CachedMessage>;
    for (const [messageId, entry] of Object.entries(parsed)) {
      if (entry && typeof entry.text === "string") {
        messageCache.set(messageId, entry);
      }
    }
    pruneMessageCache();
  } catch {
    /* cache is best-effort */
  }
}

async function saveMessageCache(): Promise<void> {
  try {
    await fs.mkdir(feishuDataDir(), { recursive: true });
    await fs.writeFile(
      MESSAGE_CACHE_FILE,
      JSON.stringify(Object.fromEntries(messageCache), null, 2),
    );
  } catch (err) {
    console.error("[feishu quote] save message cache failed:", err);
  }
}

function pruneMessageCache(): void {
  if (messageCache.size <= MAX_CACHE_ENTRIES) return;
  const entries = Array.from(messageCache.entries()).sort(
    (a, b) => b[1].updatedAt - a[1].updatedAt,
  );
  messageCache.clear();
  for (const [messageId, entry] of entries.slice(0, MAX_CACHE_ENTRIES)) {
    messageCache.set(messageId, entry);
  }
}

function extractPostContent(parsed: any): { text: string; images: string[] } {
  const textParts: string[] = [];
  const imageKeys: string[] = [];
  if (typeof parsed.title === "string" && parsed.title.trim()) {
    textParts.push(parsed.title.trim());
  }
  for (const row of parsed.content) {
    if (!Array.isArray(row)) continue;
    for (const el of row) {
      if (!el) continue;
      if (el.tag === "text" && typeof el.text === "string") {
        textParts.push(el.text);
      } else if (el.tag === "md" && typeof el.text === "string") {
        textParts.push(el.text);
      } else if (el.tag === "a" && typeof el.text === "string") {
        textParts.push(el.text);
      } else if (el.tag === "img" && typeof el.image_key === "string") {
        imageKeys.push(el.image_key);
      }
    }
  }
  return { text: clipQuotedText(textParts.join(" ").trim()), images: imageKeys };
}

function extractCardText(card: unknown): string {
  const parts: string[] = [];
  const visit = (value: unknown, parentKey = "") => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child, parentKey);
      return;
    }
    if (typeof value !== "object") return;
    const o = value as Record<string, unknown>;
    const tag = typeof o.tag === "string" ? o.tag : "";

    // Interactive Card v1/v2 common text-bearing shapes.
    if (
      (tag === "markdown" || tag === "plain_text" || tag === "lark_md") &&
      typeof o.content === "string"
    ) {
      parts.push(o.content);
    }
    if (
      (tag === "text" || tag === "md" || tag === "a") &&
      typeof o.text === "string"
    ) {
      parts.push(o.text);
    }
    if (typeof o.title === "string") parts.push(o.title);

    // Text objects nested under headers/buttons look like
    // `{tag:"plain_text", content:"..."}`. Avoid grabbing IDs/URLs.
    for (const [key, child] of Object.entries(o)) {
      if (
        key === "url" ||
        key.endsWith("_id") ||
        key === "card_id" ||
        key === "image_key"
      ) {
        continue;
      }
      if (key === "content" && typeof child === "string" && parentKey) {
        continue;
      }
      visit(child, key);
    }
  };
  visit(card);
  return clipQuotedText(
    parts
      .map((s) => s.trim())
      .filter(Boolean)
      .join("\n"),
  );
}

function clipQuotedText(s: string): string {
  return s.length > MAX_QUOTED_TEXT_CHARS
    ? s.slice(0, MAX_QUOTED_TEXT_CHARS) + "\n…"
    : s;
}

function extFromMime(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return "bin";
  }
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, "_");
}

// `channel.downloadResource(key, "image")` hits the legacy
// /open-apis/im/v1/images/:image_key endpoint which can only fetch images
// the bot itself uploaded. To download images attached to a user message
// we need the message-scoped endpoint: messageResource.get with the
// (message_id, file_key) pair.
async function downloadMessageImage(
  channel: lark.LarkChannel,
  messageId: string,
  fileKey: string,
): Promise<Buffer> {
  const resp = await channel.rawClient.im.v1.messageResource.get({
    params: { type: "image" },
    path: { message_id: messageId, file_key: fileKey },
  });
  const stream = resp.getReadableStream();
  const chunks: Buffer[] = [];
  return await new Promise<Buffer>((resolve, reject) => {
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

function detectImageMime(buf: Buffer): string {
  if (buf.length < 12) return "image/png";
  const b = buf;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return "image/png";
  }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return "image/jpeg";
  }
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return "image/gif";
  }
  if (
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    return "image/webp";
  }
  return "image/png";
}
