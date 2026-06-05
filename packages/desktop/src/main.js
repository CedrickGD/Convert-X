import { setPlatform } from "@convertx/shared/platform";
import { createDesktopAdapter } from "./platform-desktop.js";
import App from "@convertx/shared/components/App.svelte";
import "@convertx/shared/assets/styles.css";
import { mount } from "svelte";

setPlatform(createDesktopAdapter());

const app = mount(App, {
  target: document.getElementById("app"),
});

export default app;
