import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import "./styles.css";

if (import.meta.env.PROD) {
  registerSW({
    immediate: true,
    // `autoUpdate` reloads once a new SW takes over, but that only gets checked on
    // registration. iOS home-screen PWAs can stay open for a long session, so also poll
    // while the app is running.
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      setInterval(() => void registration.update(), 60_000);
    },
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
