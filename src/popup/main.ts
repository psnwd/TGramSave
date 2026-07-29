import { createApp } from "vue";
import ElementPlus from "element-plus";
import "element-plus/dist/index.css";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-800.css";
import "./theme.css";
import App from "./App.vue";
import { APP_NAME } from "@/config";

document.title = APP_NAME;
createApp(App).use(ElementPlus).mount("#app");
