/** Origin/URL guard shared by the page-world injector and the background worker. */
export const TELEGRAM_ORIGIN = "https://web.telegram.org";

/**
 * Media/save requests are allowed only for Telegram-hosted URLs or local `blob:` URLs. Rejecting
 * everything else keeps a forged DOM event from turning the extension into a fetch-any-URL primitive.
 */
export function isAllowedTelegramUrl(url: string): boolean {
  if (url.startsWith("blob:")) return true;
  try {
    return new URL(url).origin === TELEGRAM_ORIGIN;
  } catch {
    return false;
  }
}
