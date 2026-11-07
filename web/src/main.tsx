import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";

// Регистрируем сервис-воркер для push-уведомлений (если браузер поддерживает)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
