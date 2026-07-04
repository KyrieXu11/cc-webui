import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const oldHome = process.env.HOME;
const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "cc-webui-quote-"));
process.env.HOME = tmpHome;

try {
  const {
    fetchQuotedContext,
    normalizeExtractedQuotedText,
    rememberFeishuMessage,
  } = await import(`./quote.ts?test=${Date.now()}`);

  assert.equal(
    normalizeExtractedQuotedText("请升级至最新版本客户端，以查看内容"),
    "",
  );
  assert.equal(
    normalizeExtractedQuotedText("请升级至最新版客户端，以查看内容"),
    "",
  );
  assert.equal(normalizeExtractedQuotedText("真实引用内容"), "真实引用内容");

  const fallbackCard = {
    elements: [
      { tag: "markdown", content: "请升级至最新版本客户端，以查看内容" },
    ],
  };
  const channel = {
    rawClient: {
      im: {
        v1: {
          message: {
            get: async () => ({
              data: {
                items: [
                  {
                    msg_type: "interactive",
                    body: { content: JSON.stringify(fallbackCard) },
                  },
                ],
              },
            }),
          },
        },
      },
    },
  } as any;

  await rememberFeishuMessage("om_cached", {
    text: "🔧 `bash(du -sh /tmp)`\n\n真实内容",
    agent: "claude",
  });

  const cached = await fetchQuotedContext(channel, "om_cached");
  assert.equal(cached.text, "🔧 `bash(du -sh /tmp)`\n\n真实内容");

  const uncached = await fetchQuotedContext(channel, "om_uncached");
  assert.equal(uncached.text, "");
} finally {
  process.env.HOME = oldHome;
  await fs.rm(tmpHome, { recursive: true, force: true });
}
