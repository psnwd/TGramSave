// Regenerates public/icons/{16,32,48,128}.png from a master icon.
// Run via `make icons`. Uses public/icons/master.png if present, else the
// existing 128.png as the source (falling back to itself for the 128 output).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const ICONS_DIR = path.resolve(import.meta.dirname, "..", "public", "icons");
const MASTER = path.join(ICONS_DIR, "master.png");
const FALLBACK_SOURCE = path.join(ICONS_DIR, "128.png");
const SIZES = [16, 32, 48, 128];

async function main() {
  const sourcePath = existsSync(MASTER) ? MASTER : FALLBACK_SOURCE;
  if (!existsSync(sourcePath)) {
    console.error(`No source icon found at ${MASTER} or ${FALLBACK_SOURCE}`);
    process.exitCode = 1;
    return;
  }

  // Read fully into memory up front so writing 128.png doesn't race reading it as the source.
  const sourceBuffer = readFileSync(sourcePath);

  for (const size of SIZES) {
    const out = path.join(ICONS_DIR, `${size}.png`);
    await sharp(sourceBuffer).resize(size, size, { fit: "cover" }).png().toFile(out);
    console.log(`wrote ${path.relative(process.cwd(), out)}`);
  }
}

await main();
