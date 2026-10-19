import { computed, ref } from "vue";
import browser from "webextension-polyfill";
import {
  type DownloadKind,
  denyReason,
  getPremium,
  isPremium,
  type PremiumState,
  refreshPremium,
  usedToday,
} from "@/lib/premium";

// Module-level so every popup component shares one state.
const state = ref<PremiumState>();
const used = ref(0);

async function load(): Promise<void> {
  state.value = await getPremium();
  used.value = await usedToday();
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.premium || changes.usage)) void load();
});
void load();

export function usePremium() {
  return {
    state,
    used,
    premium: computed(() => isPremium(state.value)),
    /** Re-sync with the backend (or claim by email), then reload local state. */
    refresh: async (email?: string) => {
      await refreshPremium(email);
      await load();
    },
    /** Reason this download isn't allowed, or null. Doesn't count usage; the content script does that. */
    deny: (kind: DownloadKind) => denyReason(state.value, used.value, kind),
  };
}
