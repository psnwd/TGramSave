// Verifies production manifests after a build: version matches package.json, no dev-only key, and the
// Chrome target declares the minimum version required by `world: "MAIN"` (Chrome 111).
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const targets = process.argv[2] ? [process.argv[2]] : ["chrome", "firefox"];
let failed = false;

const check = (condition, message) => {
  if (condition) return;
  failed = true;
  console.error(`✗ ${message}`);
};

for (const target of targets) {
  const path = `dist/${target}/manifest.json`;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    failed = true;
    console.error(`✗ ${path} is missing — run the ${target} build first`);
    continue;
  }

  check(manifest.manifest_version === 3, `${target}: manifest_version must be 3`);
  check(manifest.version === pkg.version, `${target}: version ${manifest.version} != package.json ${pkg.version}`);
  check(!("key" in manifest), `${target}: production manifest must not contain the dev-only key`);
  if (target === "chrome") {
    check(manifest.minimum_chrome_version === "111", "chrome: minimum_chrome_version must be 111");
  }
  if (target === "firefox") {
    check(
      Boolean(manifest.browser_specific_settings?.gecko?.id),
      "firefox: browser_specific_settings.gecko.id is required",
    );
  }
  console.log(`✓ ${target} manifest OK (v${manifest.version})`);
}

if (failed) process.exit(1);
