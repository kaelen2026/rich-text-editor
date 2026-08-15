import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./style.css";

const host = document.getElementById("root");
if (!host) {
  throw new Error("缺少 #root 挂载点");
}

// 刻意开启 StrictMode：开发模式下的双挂载是 mount/unmount 幂等性的日常验证。
createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
