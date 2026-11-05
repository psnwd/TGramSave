import { fileURLToPath, URL } from "node:url";
import { crx } from "@crxjs/vite-plugin";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import { createManifest, type Target } from "./src/manifest";

// `vite build --mode firefox|chrome` selects the target; plain `vite` (dev) builds Chrome with the dev-only `key`.
export default defineConfig(({ mode }) => {
  const target: Target = mode === "firefox" ? "firefox" : "chrome";
  return {
    plugins: [vue(), crx({ manifest: createManifest(target, mode === "development"), browser: target })],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    build: {
      outDir: `dist/${target}`,
      emptyOutDir: true,
    },
  };
});
