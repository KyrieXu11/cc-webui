import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import AuthGate from "./AuthGate";
import "./index.css";
import { watchForStaleBuild } from "./lib/stale-build";

// 生产是「构建即上线」（服务直接托管仓库里的 dist/），所以开着不动的标签页
// 随时会比服务端旧一个版本。见 lib/stale-build.ts。
watchForStaleBuild();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </React.StrictMode>
);
