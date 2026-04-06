import { setPlatform } from "@convertx/shared/platform";
import { createWebAdapter } from "./platform-web.js";
import App from "@convertx/shared/components/App.svelte";
import "@convertx/shared/assets/styles.css";
import { mount } from "svelte";

setPlatform(createWebAdapter());

const app = mount(App, {
  target: document.getElementById("app"),
});

export default app;
