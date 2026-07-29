import { defineManifest } from "@crxjs/vite-plugin";
import { APP_VERSION, AUTHOR_NAME, HOMEPAGE_URL, ICON_SIZES } from "./config";

/**
 * Same extension identity/permissions as the shipped manifest.json.
 * content-scripting-a.js / content-scripting-k.js are dropped: confirmed dead
 * (content-script/index.ts already contains both a-version and k-version
 * logic, runtime-selected by URL).
 */
export default defineManifest({
  manifest_version: 3,
  name: "__MSG_name__",
  description: "__MSG_desc__",
  default_locale: "en",
  version: APP_VERSION,
  key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAkfuSNkl5sXohciPOYp75MVNdTCGKVhbNzx++ugzOXwbi/8lAQUvJ6JOR9DxRkvKioCV4A/Hi1IerE6ZQ/qFCMP4zujtr917bAyZ7rxSqx/OqTSafp/NC6dAY4zlUfu2UIdJnyRlcxPeklGkPtqB2wnqTidx2azTp816T06VPuszDio4coEpdiQq6B0iG0x9/11jUVhM145ch/Q//DLrkF9zkmOXFoinT2Ai2fT/g2JkhSKebFxQNGOCO6oOgN3TsVkYrDWv/BiLTgX621TN30Viny2TOxxYxxPMASlD5Xc5I4K4qlVTwvqqTRJG18PacKKvmCtxLk4/M4Oj3Cp5EcQIDAQAB",
  icons: { ...ICON_SIZES },
  action: {
    default_icon: { ...ICON_SIZES },
    default_popup: "src/popup/index.html",
  },
  // Chrome's actual manifest schema accepts `author` as a plain string (see
  // developer.chrome.com/docs/extensions/reference/manifest/author) — @crxjs's
  // TS type only models the `{ email }` object form, so cast around it.
  ...(AUTHOR_NAME ? { author: AUTHOR_NAME as unknown as { email: string } } : {}),
  ...(HOMEPAGE_URL ? { homepage_url: HOMEPAGE_URL } : {}),
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  content_scripts: [
    {
      matches: ["https://web.telegram.org/*"],
      js: ["src/content-script/index.ts"],
      run_at: "document_end",
    },
    {
      matches: ["https://web.telegram.org/*"],
      js: ["src/channel-downloader/index.ts"],
      run_at: "document_end",
    },
    // Runs in the page's own MAIN world (Chrome 111+) so it can trigger
    // same-origin `<a download>` clicks against Telegram's blob/stream URLs.
    // This replaces manually creating a <script src> tag pointed at a
    // `chrome.runtime.getURL(...)`-resolved path: that path is a build-time
    // hash crxjs assigns per-build, nothing rewrites the literal source
    // string to match it, and the file isn't reliably web-accessible either
    // — it silently shipped broken/unreachable. Declaring the MAIN-world
    // script directly in the manifest sidesteps that whole problem class.
    {
      matches: ["https://web.telegram.org/*"],
      js: ["src/content-script-inject/index.ts"],
      world: "MAIN",
      run_at: "document_end",
    },
  ],
  host_permissions: ["https://web.telegram.org/*"],
  permissions: ["storage", "activeTab", "downloads", "downloads.open"],
  web_accessible_resources: [
    {
      matches: ["*://*/*"],
      resources: ["src/popup/index.html", "fonts/*", "icons/*"],
    },
  ],
});
