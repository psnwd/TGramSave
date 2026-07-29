/** Single source of truth for branding/version/publisher info used across the manifest and popup UI. Edit here, not at each call site. */
export const APP_NAME = "TGramSave";
export const APP_TAGLINE = "Save Telegram Videos in One Click";
export const APP_VERSION = "1.0.0";
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
export const HOMEPAGE_URL = "";
