<script setup lang="ts">
import { computed } from "vue";
import { Monitor, Moon, Sun } from "@lucide/vue";
import type { ThemePreference } from "@/lib/storage";
import { APP_NAME, ICON_SIZES } from "@/config";
import { useI18n } from "../composables/useI18n";

const props = defineProps<{ theme: ThemePreference }>();
defineEmits<{ "cycle-theme": [] }>();
const { t } = useI18n();

const ICON = { light: Sun, dark: Moon, system: Monitor } as const;
const LABEL = computed<Record<ThemePreference, string>>(() => ({
  light: t("theme.light"),
  dark: t("theme.dark"),
  system: t("theme.system"),
}));
const icon = computed(() => ICON[props.theme]);
</script>

<template>
  <div class="header">
    <img class="logo" :src="`/${ICON_SIZES[128]}`" :alt="APP_NAME" />
    <span class="title">{{ APP_NAME }}</span>
    <button
      type="button"
      class="theme-toggle"
      :title="`${LABEL[theme]} — click to switch`"
      :aria-label="`${LABEL[theme]} — switch theme`"
      @click="$emit('cycle-theme')"
    >
      <component :is="icon" :size="16" />
    </button>
  </div>
</template>

<style scoped>
.header {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-md) var(--space-sm) var(--space-lg);
}
.logo {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
}
.title {
  font-weight: 800;
  font-size: 18px;
  letter-spacing: -0.02em;
  color: var(--color-ink);
  flex: 1;
}
.theme-toggle {
  border: none;
  background: var(--color-canvas);
  color: var(--color-ink);
  width: 32px;
  height: 32px;
  border-radius: var(--radius-pill);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
