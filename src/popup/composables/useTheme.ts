import { onMounted, onUnmounted, ref } from "vue";
import { getSettings, setSettings, type ThemePreference } from "@/lib/storage";

/** Applies + persists the light/dark/system theme preference by stamping `data-theme` on <html>. */
export function useTheme() {
  const preference = ref<ThemePreference>("system");
  const media = window.matchMedia("(prefers-color-scheme: dark)");

  function apply(): void {
    const effective = preference.value === "system" ? (media.matches ? "dark" : "light") : preference.value;
    document.documentElement.setAttribute("data-theme", effective);
  }

  async function setPreference(next: ThemePreference): Promise<void> {
    preference.value = next;
    apply();
    const settings = await getSettings();
    await setSettings({ ...settings, theme: next });
  }

  function cycle(): void {
    const order: ThemePreference[] = ["light", "dark", "system"];
    const next = order[(order.indexOf(preference.value) + 1) % order.length]!;
    void setPreference(next);
  }

  const onMediaChange = () => apply();

  onMounted(async () => {
    const settings = await getSettings();
    preference.value = settings.theme;
    apply();
    media.addEventListener("change", onMediaChange);
  });

  onUnmounted(() => media.removeEventListener("change", onMediaChange));

  return { preference, setPreference, cycle };
}
