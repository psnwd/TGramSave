import type { MessageKey } from "./i18n";

/** Pure Premium gating rules, separated from storage/network so they can be unit tested. */
export type DownloadKind = "single" | "batch" | "channel";

export type DenyReasonKey = Extract<MessageKey, "premium.channelOnly" | "premium.batchOnly" | "premium.freeLimit">;

export function denyReasonKey(
  premium: boolean,
  usedToday: number,
  kind: DownloadKind,
  freeDailyLimit: number,
): DenyReasonKey | null {
  if (premium) return null;
  if (kind === "channel") return "premium.channelOnly";
  if (kind === "batch") return "premium.batchOnly";
  if (usedToday >= freeDailyLimit) return "premium.freeLimit";
  return null;
}
