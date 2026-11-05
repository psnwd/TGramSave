import pkg from "../package.json";

/** Single source of truth for branding/version/publisher info used across the manifest and popup UI. Edit here, not at each call site. */
export const APP_NAME = "TGramSave";
export const APP_TAGLINE = "Save Telegram Videos in One Click";
/** Sourced from package.json so the manifest, popup and changelog can't drift. */
export const APP_VERSION = pkg.version;
export const APP_DESCRIPTION =
  "Free extension to download videos from Telegram channels and groups, including private ones, in a single click.";

/**
 * Manifest-relative paths (no leading slash) — that's what manifest.ts's icon
 * fields require. Popup components resolve against the built extension's
 * public/ root, so prefix with "/" there: `` `/${ICON_SIZES[128]}` ``.
 * Regenerate all four from a source image via `make icons` (see
 * scripts/generate-icons.mjs — drop a public/icons/master.png to resize from).
 */
export const ICON_SIZES = {
  16: "icons/16.png",
  32: "icons/32.png",
  48: "icons/48.png",
  128: "icons/128.png",
} as const;

export const AUTHOR_NAME = "BlackCAT";
export const AUTHOR_EMAIL = "";
export const HOMEPAGE_URL = "https://github.com/psnwd/TGramSave";

/**
 * Premium (see /backend). Leave BOTH empty to ship the free-only build: no Premium tab, no gating, no network,
 * no extra manifest permissions. Fill both to enable it, then update STORE_SUBMISSION.md's data disclosures.
 */
export const BACKEND_URL = ""; // e.g. "https://api.example.com" (no trailing slash)
export const KOFI_URL = ""; // e.g. "https://ko-fi.com/yourpage"
export const FREE_DAILY_LIMIT = 10;
export const PREMIUM_ENABLED = BACKEND_URL !== "" && KOFI_URL !== "";
