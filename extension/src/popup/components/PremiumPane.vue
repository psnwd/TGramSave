<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import browser from "webextension-polyfill";
import { ElMessage } from "element-plus";
import { Copy, Crown, ExternalLink } from "@lucide/vue";
import { FREE_DAILY_LIMIT, KOFI_URL } from "@/config";
import { getPlans, type Plan } from "@/lib/premium";
import { usePremium } from "../composables/usePremium";

const { state, used, premium, refresh } = usePremium();
const plans = ref<Plan[]>([]);
const email = ref("");
const busy = ref(false);
let poll: ReturnType<typeof setInterval> | undefined;

onMounted(async () => {
  void refresh();
  plans.value = await getPlans().catch(() => []);
});
onUnmounted(() => clearInterval(poll));

async function copyCode(): Promise<void> {
  if (!state.value) return;
  await navigator.clipboard.writeText(state.value.code).catch(() => undefined);
  ElMessage({ message: "Code copied. Paste it in the Ko-fi message box.", type: "success" });
}

/** After opening Ko-fi, re-check every 5s for ~2 min so the unlock appears without reopening the popup. */
function openKofi(): void {
  void browser.tabs.create({ url: KOFI_URL });
  clearInterval(poll);
  let ticks = 0;
  poll = setInterval(async () => {
    await refresh();
    if (premium.value || ++ticks >= 24) clearInterval(poll);
  }, 5000);
}

async function claim(): Promise<void> {
  busy.value = true;
  try {
    await refresh(email.value.trim());
    ElMessage(premium.value ? { message: "Premium activated!", type: "success" } : { message: "No unclaimed payment found for that email.", type: "warning" });
  } catch {
    ElMessage({ message: "Could not claim right now. Try again later.", type: "error" });
  } finally {
    busy.value = false;
  }
}

const until = () =>
  state.value?.lifetime ? "Lifetime" : state.value?.expiresAt ? `Until ${new Date(state.value.expiresAt * 1000).toLocaleDateString()}` : "";
</script>

<template>
  <div class="premium">
    <div v-if="premium" class="status is-premium"><Crown :size="16" /> Premium · {{ until() }}</div>
    <div v-else class="status">Free · {{ Math.min(used, FREE_DAILY_LIMIT) }}/{{ FREE_DAILY_LIMIT }} downloads today</div>

    <template v-if="!premium">
      <p class="lead">Unlimited downloads, batch &amp; ZIP, and the Channel downloader.</p>
      <ul v-if="plans.length" class="plans">
        <li v-for="p in plans" :key="p.key"><span>{{ p.name }}</span><b>{{ p.price }}</b></li>
      </ul>

      <ol class="steps">
        <li>
          Copy your code
          <el-button size="small" :disabled="!state" @click="copyCode"><Copy :size="12" />{{ state?.code ?? "…" }}</el-button>
        </li>
        <li>Open Ko-fi, pick a plan, and paste the code in the <i>message</i> box.</li>
        <li>This tab unlocks automatically once the payment arrives.</li>
      </ol>
      <el-button type="primary" @click="openKofi"><ExternalLink :size="14" />Upgrade on Ko-fi</el-button>

      <div class="claim">
        <p>Already paid, or reinstalled? Enter the email you used on Ko-fi.</p>
        <el-input v-model="email" size="small" placeholder="you@example.com" type="email" />
        <el-button size="small" :loading="busy" :disabled="!email" @click="claim">Restore</el-button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.premium {
  padding: var(--space-lg);
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  font-size: 13px;
  color: var(--color-ink);
}
.status {
  font-weight: 800;
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}
.is-premium {
  color: var(--color-positive-deep);
}
.lead,
.claim p {
  margin: 0;
  color: var(--color-mute);
}
.plans {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.plans li {
  display: flex;
  justify-content: space-between;
}
.steps {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}
.claim {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}
</style>
