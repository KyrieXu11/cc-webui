import { Hono } from "hono";
import { loadBotConfigs } from "./config.ts";
import { startChannel } from "./ws.ts";

// Explicitly called from server/index.ts rather than running on import.
//
// It used to be a module-level side effect, which made "turn Feishu off" a trap:
// commenting out the route mount changed nothing, because merely importing this
// file had already connected the live bots. Now the connection is a function
// call, and importing the router is free — which is also what lets the route
// coverage test build the app without dialling anything.
export function startFeishuChannels(): number {
  const bots = loadBotConfigs();
  if (bots.size === 0) return 0;
  console.log(`[feishu] loaded bots: ${Array.from(bots.keys()).join(", ")}`);
  for (const bot of bots.values()) {
    void startChannel(bot);
  }
  return bots.size;
}

// Empty Hono router kept so server/index.ts mount stays the same.
// All Feishu events flow over the WebSocket channel; the HTTP route only
// returns 404 to make it obvious if someone hits an old webhook URL.
const feishu = new Hono();

feishu.all("/:bot/events", (c) =>
  c.text(
    "Feishu adapter is in WebSocket mode (no webhook). " +
      "If you want webhook mode see README — currently not wired.",
    404,
  ),
);

export { feishu };
