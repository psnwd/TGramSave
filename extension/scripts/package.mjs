// Zips dist/<target>/ into dist/<target>.zip with manifest.json at the archive root. Usage: node scripts/package.mjs chrome|firefox
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { zipSync } from "fflate";

const target = process.argv[2];
const dir = join("dist", target ?? "");
if (!existsSync(join(dir, "manifest.json"))) {
  console.error(`dist/${target}/manifest.json not found — run the build for "${target}" first`);
  process.exit(1);
}

const files = {};
const walk = (d, prefix) => {
  for (const name of readdirSync(d)) {
    const full = join(d, name);
    const rel = posix.join(prefix, name);
    if (statSync(full).isDirectory()) walk(full, rel);
    else files[rel] = readFileSync(full);
  }
};
walk(dir, "");

writeFileSync(join("dist", `${target}.zip`), zipSync(files, { level: 9 }));
console.log(`dist/${target}.zip (${Object.keys(files).length} files)`);
