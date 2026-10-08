import { createReadStream } from "node:fs";

const HEAD_BYTES = 1024;

// Summary readers only need a handful of record types. readline decodes and
// repeatedly joins enormous image/tool/reasoning lines even when the caller
// immediately ignores them. Inspect a bounded UTF-8 header first, then drain
// known irrelevant records as bytes. Unknown/reordered headers always fall
// back to the complete line; this is NOT a head/tail transcript sampler.
export async function* summaryJsonlLines(
  file: string,
  skip: (head: string) => boolean,
): AsyncGenerator<{ head: string; line?: string }> {
  const stream = createReadStream(file);
  let parts: Buffer[] = [], headParts: Buffer[] = [];
  let headBytes = 0, head = "", ignored = false, decided = false, bytes = 0;
  const add = (part: Buffer) => {
    bytes += part.length;
    if (headBytes < HEAD_BYTES) {
      const prefix = part.subarray(0, HEAD_BYTES - headBytes);
      headParts.push(prefix); headBytes += prefix.length;
    }
    if (!decided && headBytes === HEAD_BYTES) {
      head = Buffer.concat(headParts).toString("utf8");
      ignored = skip(head); decided = true;
      if (ignored) parts = [];
    }
    if (!ignored) parts.push(part);
  };
  const finish = () => {
    if (!decided) {
      head = Buffer.concat(headParts).toString("utf8");
      ignored = skip(head);
    }
    const result = { head, ...(ignored ? {} : { line: Buffer.concat(parts).toString("utf8") }) };
    parts = []; headParts = []; headBytes = 0; bytes = 0;
    head = ""; ignored = false; decided = false;
    return result;
  };
  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      let start = 0, end: number;
      while ((end = buffer.indexOf(10, start)) !== -1) {
        add(buffer.subarray(start, end));
        yield finish();
        start = end + 1;
      }
      if (start < buffer.length) add(buffer.subarray(start));
    }
    if (bytes) yield finish();
  } finally { stream.destroy(); }
}

// Fast path only for the CLI's unambiguous, ordered top-level header. No
// matching against user text/private payloads (which can contain any words).
export function skipCodexSummaryLine(head: string, hasPrompt: boolean, hasFallback: boolean): boolean {
  const header = /^\s*\{\s*"timestamp"\s*:\s*"([^"]+)"\s*,\s*"type"\s*:\s*"([^"]+)"\s*,\s*"payload"\s*:\s*\{/.exec(head);
  if (!header || !Number.isFinite(Date.parse(header[1]))) return false;
  const type = header[2];
  if (type === "session_meta" || type === "turn_context") return false;
  const payload = head.slice(header[0].length);
  const subtype = /^\s*"type"\s*:\s*"([^"]+)"/.exec(payload)?.[1];
  if (type === "event_msg") {
    if (!subtype || subtype === "thread_name_updated") return false;
    return hasPrompt || (subtype !== "user_message" && subtype !== "item_completed");
  }
  if (type === "response_item") {
    // role=user fallback may still be needed; never guess from content/type.
    return hasPrompt || hasFallback;
  }
  return true;
}
