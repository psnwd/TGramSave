import browser from "webextension-polyfill";
import { BACKEND_URL, FREE_DAILY_LIMIT, PREMIUM_ENABLED } from "@/config";
import { t } from "./i18n";
import { type DownloadKind, denyReasonKey } from "./premium-rules";

export type { DownloadKind } from "./premium-rules";

export interface PremiumState {
  secret: string;
  /** Activation code the user pastes into the Ko-fi message box. */
  code: string;
  tier: "free" | "premium";
  /** Unix seconds; null for free or lifetime. */
  expiresAt: number | null;
  lifetime: boolean;
  checkedAt: number;
}

export interface Plan {
  key: string;
  name: string;
  price: string;
  days: number;
}

const KEY = "premium";
const USAGE = "usage";
const STALE_MS = 60 * 60 * 1000;

export async function getPremium(): Promise<PremiumState | undefined> {
  return (await browser.storage.local.get(KEY))[KEY] as PremiumState | undefined;
}

/** Premium-disabled builds count as premium so nothing is gated. Cached expiry is honoured offline. */
export function isPremium(s?: PremiumState): boolean {
  return !PREMIUM_ENABLED || (s?.tier === "premium" && (s.lifetime || (s.expiresAt ?? 0) * 1000 > Date.now()));
}

type Status = Pick<PremiumState, "code" | "tier" | "expiresAt" | "lifetime">;

async function api<T>(path: string, init: RequestInit = {}, secret?: string): Promise<T> {
  const res = await fetch(BACKEND_URL + path, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
    headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
  });
  if (!res.ok) throw Object.assign(new Error(`${path} ${res.status}`), { status: res.status });
  return res.json() as Promise<T>;
}

export const getPlans = () => api<Plan[]>("/v1/plans");

const save = async (s: PremiumState) => {
  await browser.storage.local.set({ [KEY]: s });
  return s;
};

/**
 * Registers on first use, then syncs tier from the backend (or claims by email when given).
 * Network code is for the background/popup only: content scripts can't fetch cross-origin, they message the background.
 * The Web Lock stops popup + background registering two installs at once.
 */
export async function refreshPremium(email?: string, txn?: string): Promise<PremiumState | undefined> {
  if (!PREMIUM_ENABLED) return undefined;
  return await navigator.locks.request("tgs-premium", async () => {
    let s = await getPremium();
    try {
      if (!s?.secret) {
        const r = await api<{ secret: string; code: string }>("/v1/register", { method: "POST" });
        s = await save({
          secret: r.secret,
          code: r.code,
          tier: "free",
          expiresAt: null,
          lifetime: false,
          checkedAt: 0,
        });
      }
      const st = email
        ? await api<Status>("/v1/claim", { method: "POST", body: JSON.stringify({ email, txn }) }, s.secret)
        : await api<Status>("/v1/status", {}, s.secret);
      return await save({ ...s, ...st, checkedAt: Date.now() });
    } catch (e) {
      if ((e as { status?: number }).status === 401) {
        await browser.storage.local.remove(KEY); // backend forgot this install; re-register next time
        return undefined;
      }
      if (email) throw e; // let the UI show claim failures (e.g. 429)
      return s; // offline: keep cached state
    }
  });
}

const today = () => new Date().toISOString().slice(0, 10);

export async function usedToday(): Promise<number> {
  const u = (await browser.storage.local.get(USAGE))[USAGE] as { day: string; count: number } | undefined;
  return u?.day === today() ? u.count : 0;
}

/** Why this download is not allowed, or null. Pure, so the popup can pre-check without counting. */
export function denyReason(s: PremiumState | undefined, used: number, kind: DownloadKind): string | null {
  const key = denyReasonKey(isPremium(s), used, kind, FREE_DAILY_LIMIT);
  return key ? t(key, { limit: FREE_DAILY_LIMIT }) : null;
}

function toast(msg: string): void {
  const el = document.createElement("div");
  el.textContent = `TGramSave: ${msg}`;
  Object.assign(el.style, {
    position: "fixed",
    bottom: "24px",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: "2147483647",
    background: "#222",
    color: "#fff",
    padding: "10px 16px",
    borderRadius: "8px",
    font: "14px sans-serif",
  });
  document.body.append(el);
  setTimeout(() => el.remove(), 4000);
}

/** Content-script gate: checks (and for free singles, counts) a download. Shows an on-page toast when denied. */
export async function gate(kind: DownloadKind): Promise<boolean> {
  let s = await getPremium();
  if (PREMIUM_ENABLED && !isPremium(s) && Date.now() - (s?.checkedAt ?? 0) > STALE_MS) {
    const fresh = (await browser.runtime.sendMessage({ type: "premium_refresh" }).catch(() => undefined)) as
      | PremiumState
      | undefined;
    s = fresh ?? s;
  }
  const used = await usedToday();
  const reason = denyReason(s, used, kind);
  if (reason) {
    toast(reason);
    return false;
  }
  // ponytail: read-modify-write across tabs can undercount by a click; fine for a soft free-tier cap.
  if (!isPremium(s)) await browser.storage.local.set({ [USAGE]: { day: today(), count: used + 1 } });
  return true;
}
