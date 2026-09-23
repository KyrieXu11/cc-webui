import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 8787,
    // 和生产同款（server/app.ts 里那条 middleware 有完整理由）：不把 fullscreen
    // 委派给 ONLYOFFICE 的跨源 iframe，这样 PPT 放映按一下 Esc 就退出。
    // ⚠️ 开发期少了这一条，放映的行为会和生产不一样（要按两下），很难当场看出来。
    headers: {
      "Permissions-Policy": "fullscreen=(self)",
    },
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8788",
        changeOrigin: true,
      },
      // 设备 WebSocket（docs/desktop-client.md）。⚠️ **必须写 ws: true** ——
      // 没有它 vite 不会代理 upgrade 请求，开发期客户端连 8787 会静默失败，
      // 而现场只能看到「连不上」，看不出是代理没转发。
      "/ws": {
        target: "http://127.0.0.1:8788",
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
