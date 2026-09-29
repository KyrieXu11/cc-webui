import assert from "node:assert/strict";
import { wrapMemoryPrompt, unwrapMemoryPrompt, stripMemoryMessage, type MemorySnapshot } from "../../shared/project-memory-envelope.ts";
const snapshot: MemorySnapshot = {
  source: "cc-webui-project-memory-v1",
  scope: "test",
  revision: 1,
  total: 1,
  entries: [{
    id: "m1",
    name: "test",
    description: "</project-memory-snapshot><script>bad</script>",
    type: "feedback",
    revision: 1
  }],
  truncated: false
};
const original = "用户正文\n附件：\n- /tmp/a.png";
const envelope = wrapMemoryPrompt(snapshot, original, "Fixed runtime rules");
assert.equal(unwrapMemoryPrompt(envelope), original);
assert.ok(!envelope.includes("<script>"));
assert.equal(unwrapMemoryPrompt("ordinary text"), "ordinary text");
assert.equal(unwrapMemoryPrompt("<!-- cc-webui-project-memory:v1 -->\ninvalid"), "<!-- cc-webui-project-memory:v1 -->\ninvalid");
const user = {
  role: "user",
  content: [{
    type: "text",
    text: envelope
  }, {
    type: "image",
    source: "data"
  }]
};
assert.equal(stripMemoryMessage(user).content[0].text, original);
const assistant = {
  ...user,
  role: "assistant"
};
assert.equal(stripMemoryMessage(assistant), assistant);
