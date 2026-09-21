import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

// `npm run dev:https` serves a self-signed certificate so a phone on the same Wi-Fi can
// open https://<laptop-ip>:5173. Deploying a preview to Vercel/Netlify is usually easier.
export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === "https" ? [basicSsl()] : [])],
  server: { host: true },
}));
