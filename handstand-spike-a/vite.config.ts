import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { VitePWA } from "vite-plugin-pwa";

// `npm run dev:https` serves a self-signed certificate so a phone on the same Wi-Fi can
// open https://<laptop-ip>:5173. Deploying a preview to Vercel/Netlify is usually easier.
// vercel.json keeps HTML/manifest revalidating on the CDN; the service worker auto-updates cached assets.
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/*.png"],
      manifest: {
        name: "Handstand spike A",
        short_name: "Handstand",
        start_url: "/",
        display: "standalone",
        background_color: "#0e1218",
        theme_color: "#0e1218",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,wasm,webmanifest,task}"],
        cleanupOutdatedCaches: true,
        // Pose models under public/models are ~15 MB each.
        maximumFileSizeToCacheInBytes: 20 * 1024 * 1024,
      },
    }),
    ...(mode === "https" ? [basicSsl()] : []),
  ],
  build: {
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  server: { host: true },
}));
