import type * as lark from "@larksuiteoapi/node-sdk";
import type { ImageAttachment } from "../groups/store.ts";

const MAX_IMAGES = 4;
const MAX_BYTES_PER_IMAGE = 5 * 1024 * 1024;

export type QuotedContext = {
  text: string;
  images: ImageAttachment[];
};

// Resolve the content of the message a user is replying-to: pull out the
// embedded text (for text / post types) and download up to MAX_IMAGES images
// from image / post types. Failures degrade gracefully — a missing message or
// a download error returns whatever was already collected.
export async function fetchQuotedContext(
  channel: lark.LarkChannel,
  messageId: string,
): Promise<QuotedContext> {
  const out: QuotedContext = { text: "", images: [] };

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
    const textParts: string[] = [];
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
    out.text = textParts.join(" ").trim();
  } else if (msgType === "text" && typeof parsed.text === "string") {
    out.text = parsed.text;
  }

  for (const key of imageKeys.slice(0, MAX_IMAGES)) {
    try {
      const buf = await downloadMessageImage(channel, messageId, key);
      if (buf.length > MAX_BYTES_PER_IMAGE) {
        console.warn(
          `[feishu quote] image ${key} too large (${buf.length} bytes), skipped`,
        );
        continue;
      }
      out.images.push({
        mediaType: detectImageMime(buf),
        data: buf.toString("base64"),
      });
    } catch (err) {
      console.error(`[feishu quote] download ${key} failed:`, err);
    }
  }

  return out;
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
