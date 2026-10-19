import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { crx } from "@crxjs/vite-plugin";
import vue from "@vitejs/plugin-vue";
import JavaScriptObfuscator from "javascript-obfuscator";
import { defineConfig, type Plugin } from "vite";
import { createManifest, type Target } from "./src/manifest";

const options = JSON.parse(readFileSync("javascript-obfuscator.config.json", "utf8"));

// Opt-in (`OBFUSCATE=1`): AMO and the Chrome Web Store reject obfuscated code, so store builds stay off.
const obfuscate = (): Plugin => ({
  name: "obfuscate",
  apply: "build",
  writeBundle({ dir }, bundle) {
    for (const [name, f] of Object.entries(bundle)) {
      if (f.type !== "chunk" || !dir || f.name === "vendor") continue; // vendor = public code, skip
      const path = join(dir, name);
      writeFileSync(path, JavaScriptObfuscator.obfuscate(readFileSync(path, "utf8"), options).getObfuscatedCode());
    }
  },
});

// `vite build --mode firefox|chrome` selects the target; plain `vite` (dev) builds Chrome with the dev-only `key`.
export default defineConfig(({ mode }) => {
  const target: Target = mode === "firefox" ? "firefox" : "chrome";
  return {
    plugins: [
      vue(),
      crx({ manifest: createManifest(target, mode === "development"), browser: target }),
      ...(process.env.OBFUSCATE ? [obfuscate()] : []),
    ],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    build: {
      outDir: `dist/${target}`,
      emptyOutDir: true,
      // OBFUSCATE only: split node_modules into a "vendor" chunk so the plugin can skip it.
      ...(process.env.OBFUSCATE && {
        rollupOptions: {
          output: { manualChunks: (id: string) => (id.includes("node_modules") ? "vendor" : undefined) },
        },
      }),
    },
  };
});
