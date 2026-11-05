import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "@/locales/en.json";
import { getLocale, LOCALES, normalizeLocale, setLocale, t } from "./i18n";

const enKeys = new Set(Object.keys(en));

describe("locale files", () => {
  it("are valid JSON and only use keys defined in English", () => {
    const dir = join(process.cwd(), "src/locales");
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
      const table = JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, string>;
      for (const key of Object.keys(table)) {
        expect(enKeys.has(key), `${file} has unknown key ${key}`).toBe(true);
      }
    }
  });

  it("ships every advertised locale", () => {
    const dir = join(process.cwd(), "src/locales");
    const files = new Set(readdirSync(dir).map((name) => name.replace(/\.json$/, "")));
    for (const locale of LOCALES) expect(files.has(locale.code), `missing ${locale.code}.json`).toBe(true);
  });
});

describe("normalizeLocale", () => {
  it("resolves base and regional tags", () => {
    expect(normalizeLocale("zh")).toBe("zh-CN");
    expect(normalizeLocale("zh-Hant")).toBe("zh-TW");
    expect(normalizeLocale("pt")).toBe("pt-BR");
    expect(normalizeLocale("es-419")).toBe("es");
    expect(normalizeLocale("de-DE")).toBe("de");
    expect(normalizeLocale("xx")).toBe("en");
  });
});

describe("t", () => {
  it("translates and interpolates", () => {
    setLocale("en");
    expect(t("app.download")).toBe("Download");
    expect(t("download.selected", { n: 3 })).toBe("3 selected");
  });

  it("switches language and falls back to English for missing keys", () => {
    setLocale("zh-CN");
    expect(getLocale()).toBe("zh-CN");
    expect(t("app.download")).toBe("下载");
    // `fr` is intentionally partial; a missing key must fall back to English.
    setLocale("fr");
    expect(t("channel.beta")).toBe(en["channel.beta"]);
    setLocale("en");
  });
});
