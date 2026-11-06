import ar from "@/locales/ar.json";
import de from "@/locales/de.json";
import en from "@/locales/en.json";
import es from "@/locales/es.json";
import fr from "@/locales/fr.json";
import hi from "@/locales/hi.json";
import it from "@/locales/it.json";
import ja from "@/locales/ja.json";
import ko from "@/locales/ko.json";
import ptBR from "@/locales/pt-BR.json";
import ru from "@/locales/ru.json";
import tr from "@/locales/tr.json";
import zhCN from "@/locales/zh-CN.json";
import zhTW from "@/locales/zh-TW.json";

/** English is the source of truth: every other locale may be partial and falls back to it. */
export type MessageKey = keyof typeof en;
type Table = Partial<Record<MessageKey, string>>;

export interface LocaleInfo {
  code: string;
  label: string;
  dir?: "rtl";
}

export const LOCALES: readonly LocaleInfo[] = [
  { code: "en", label: "English" },
  { code: "zh-CN", label: "简体中文" },
  { code: "zh-TW", label: "繁體中文" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "pt-BR", label: "Português (Brasil)" },
  { code: "ru", label: "Русский" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "it", label: "Italiano" },
  { code: "tr", label: "Türkçe" },
  { code: "ar", label: "العربية", dir: "rtl" },
  { code: "hi", label: "हिन्दी" },
] as const;

const TABLES: Record<string, Table> = {
  en,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  es,
  fr,
  de,
  "pt-BR": ptBR,
  ru,
  ja,
  ko,
  it,
  tr,
  ar,
  hi,
};

let current: string = "en";
const listeners = new Set<() => void>();

function systemLanguage(): string {
  try {
    const chromeLocale = (
      globalThis as { chrome?: { i18n?: { getUILanguage?: () => string } } }
    ).chrome?.i18n?.getUILanguage?.();
    if (chromeLocale) return chromeLocale;
    const browserLocale = (
      globalThis as { browser?: { i18n?: { getUILanguage?: () => string } } }
    ).browser?.i18n?.getUILanguage?.();
    if (browserLocale) return browserLocale;
  } catch {
    // ignore
  }
  return typeof navigator === "undefined" ? "en" : navigator.language;
}

/** Maps `zh`, `zh_Hans`, `pt`, `es-419`, `system`, … to a shipped locale code. */
export function normalizeLocale(preference: string | undefined): string {
  if (!preference || preference === "system") return normalizeLocale(systemLanguage());
  const raw = preference.replace("_", "-");
  const exact = LOCALES.find((locale) => locale.code.toLowerCase() === raw.toLowerCase());
  if (exact) return exact.code;

  const base = raw.split("-")[0]?.toLowerCase() ?? "en";
  if (base === "zh") return raw.toLowerCase().includes("tw") || raw.toLowerCase().includes("hant") ? "zh-TW" : "zh-CN";
  if (base === "pt") return "pt-BR";
  const match = LOCALES.find((locale) => locale.code.split("-")[0]?.toLowerCase() === base);
  return match?.code ?? "en";
}

export function getLocale(): string {
  return current;
}

export function getLocaleInfo(code: string): LocaleInfo | undefined {
  return LOCALES.find((locale) => locale.code === code);
}

export function setLocale(preference: string | undefined): void {
  const next = normalizeLocale(preference);
  const info = getLocaleInfo(next);
  if (typeof document !== "undefined") {
    document.documentElement.lang = next;
    document.documentElement.dir = info?.dir ?? "ltr";
  }
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Translate a key with `{name}` interpolation; missing translations fall back to English. */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const table = TABLES[current];
  let message = table?.[key] ?? en[key] ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      message = message.replaceAll(`{${name}}`, String(value));
    }
  }
  return message;
}

/** Used by `main.ts` to apply the persisted language before the first render. */
export function initI18n(preference: string | undefined): void {
  setLocale(preference ?? "system");
}
