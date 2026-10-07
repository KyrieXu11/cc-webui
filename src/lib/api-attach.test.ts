import assert from "node:assert/strict";
import { connectAttach } from "./api";

class FakeSource {
  static last: FakeSource;
  handlers = new Map<string, ((e: Event) => void)[]>();
  closed = false;
  constructor(public url: string) { FakeSource.last = this; }
  addEventListener(name: string, fn: (e: Event) => void) {
    this.handlers.set(name, [...this.handlers.get(name) ?? [], fn]);
  }
  close() { this.closed = true; }
  emit(name: string, data?: string) {
    const event = data === undefined ? new Event(name) : new MessageEvent(name, { data });
    for (const fn of this.handlers.get(name) ?? []) fn(event);
  }
}
const previous = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
Object.defineProperty(globalThis, "EventSource", { value: FakeSource, configurable: true });
try {
  const finished: unknown[] = [];
  const received: unknown[] = [];
  const callback = (reason: string, message?: string) => finished.push([reason, message]);
  connectAttach({ sessionId: "test", agentProvider: "codex" }, m => received.push(m), callback);
  assert(FakeSource.last.url.startsWith("/api/codex/chat/attach?"));
  FakeSource.last.emit("turn_meta", JSON.stringify({ effort: "high" }));
  assert.deepEqual(received, [{ effort: "high" }]);
  FakeSource.last.emit("error", JSON.stringify({ message: "该项目不在你获准打开的范围内" }));
  assert.deepEqual(finished.pop(), ["error", "该项目不在你获准打开的范围内"]);
  assert(FakeSource.last.closed);

  for (const payload of [undefined, "not JSON", JSON.stringify({ message: 12 })]) {
    connectAttach({ sessionId: "test" }, () => {}, callback);
    FakeSource.last.emit("error", payload);
    assert.deepEqual(finished.pop(), ["error", undefined]);
    assert(FakeSource.last.closed);
  }
  const unsubscribe = connectAttach({}, () => {}, callback);
  unsubscribe(); assert(FakeSource.last.closed);
} finally {
  if (previous) Object.defineProperty(globalThis, "EventSource", previous);
  else Reflect.deleteProperty(globalThis, "EventSource");
}
console.log("Attach preserves actionable server errors and safely falls back for transport errors");
