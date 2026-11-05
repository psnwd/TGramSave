import ElementPlus from "element-plus";
import { createApp } from "vue";
import "element-plus/dist/index.css";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-800.css";
import "./theme.css";
import { APP_NAME } from "@/config";
import { initI18n } from "@/lib/i18n";
import { getSettings } from "@/lib/storage";
import App from "./App.vue";

async function bootstrap(): Promise<void> {
  try {
    const settings = await getSettings();
    initI18n(settings.language);
  } catch {
    initI18n("system");
  }
  document.title = APP_NAME;
  createApp(App).use(ElementPlus).mount("#app");
}

void bootstrap();
