<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import browser from "webextension-polyfill";
import { ElMessage } from "element-plus";
import { Copy, Crown, ExternalLink } from "@lucide/vue";
import { FREE_DAILY_LIMIT, KOFI_URL } from "@/config";
import { getPlans, type Plan } from "@/lib/premium";
import { useI18n } from "../composables/useI18n";
import { usePremium } from "../composables/usePremium";

const { t } = useI18n();
const { state, used, premium, refresh } = usePremium();
const plans = ref<Plan[]>([]);
const email = ref("");
/** Ko-fi transaction id from the receipt — proof of ownership; email alone is no longer accepted by default. */
const txn = ref("");
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
  ElMessage({ message: t("premium.copied"), type: "success" });
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
    await refresh(email.value.trim(), txn.value.trim());
    ElMessage(
      premium.value
        ? { message: t("premium.activated"), type: "success" }
        : { message: t("premium.notFound"), type: "warning" },
    );
  } catch {
    ElMessage({ message: t("premium.claimError"), type: "error" });
  } finally {
    busy.value = false;
  }
}

const until = () =>
  state.value?.lifetime
    ? t("premium.lifetime")
    : state.value?.expiresAt
      ? t("premium.until", { date: new Date(state.value.expiresAt * 1000).toLocaleDateString() })
      : "";
</script>

<template>
  <div class="premium">
    <div v-if="premium" class="status is-premium"><Crown :size="16" /> {{ t("premium.statusPremium") }} · {{ until() }}</div>
    <div v-else class="status">{{ t("premium.statusFree", { used: Math.min(used, FREE_DAILY_LIMIT), limit: FREE_DAILY_LIMIT }) }}</div>

    <template v-if="!premium">
      <p class="lead">{{ t("premium.lead") }}</p>
      <ul v-if="plans.length" class="plans">
        <li v-for="p in plans" :key="p.key"><span>{{ p.name }}</span><b>{{ p.price }}</b></li>
      </ul>

      <ol class="steps">
        <li>
          {{ t("premium.step1") }}
          <el-button size="small" :disabled="!state" @click="copyCode"><Copy :size="12" />{{ state?.code ?? "…" }}</el-button>
        </li>
        <li>{{ t("premium.step2") }}</li>
        <li>{{ t("premium.step3") }}</li>
      </ol>
      <el-button type="primary" @click="openKofi"><ExternalLink :size="14" />{{ t("premium.upgrade") }}</el-button>

      <div class="claim">
        <p>{{ t("premium.claimLead") }}</p>
        <el-input v-model="email" size="small" placeholder="you@example.com" type="email" />
        <el-input v-model="txn" size="small" :placeholder="t('premium.txnPlaceholder')" />
        <el-button size="small" :loading="busy" :disabled="!email || !txn" @click="claim">{{ t("premium.restore") }}</el-button>
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
