import { computed, ref } from "vue";
import { t as coreT, getLocale, initI18n, LOCALES, type MessageKey, setLocale, subscribeLocale } from "@/lib/i18n";

/**
 * Makes the plain-string i18n core reactive for Vue: `t()` and `locale` read `version`, so a language
 * change re-renders every component that uses them.
 */
const version = ref(0);
subscribeLocale(() => {
  version.value++;
});

const locale = computed(() => {
  void version.value;
  return getLocale();
});

export function useI18n() {
  return {
    t: (key: MessageKey, vars?: Record<string, string | number>) => {
      void version.value;
      return coreT(key, vars);
    },
    locale,
    locales: LOCALES,
    setLocale,
    initI18n,
  };
}
