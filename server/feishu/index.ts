import { Hono } from "hono";
import { loadBotConfigs } from "./config.ts";
import { startChannel } from "./ws.ts";

const BOTS = loadBotConfigs();

if (BOTS.size > 0) {
  console.log(
    `[feishu] loaded bots: ${Array.from(BOTS.keys()).join(", ")}`,
  );
  for (const bot of BOTS.values()) {
    void startChannel(bot);
  }
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
