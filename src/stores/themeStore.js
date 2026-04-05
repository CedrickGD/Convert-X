import { writable } from "svelte/store";

function createThemeStore() {
  const stored = typeof localStorage !== "undefined"
    ? localStorage.getItem("convertx-theme")
    : null;
  const initial = stored || "dark";

  const { subscribe, set, update } = writable(initial);

  // Apply theme to DOM on init
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", initial);
  }

  return {
    subscribe,
    toggle() {
      update((current) => {
        const next = current === "dark" ? "light" : "dark";
        document.documentElement.setAttribute("data-theme", next);
        localStorage.setItem("convertx-theme", next);
        return next;
      });
    },
    set(value) {
      document.documentElement.setAttribute("data-theme", value);
      localStorage.setItem("convertx-theme", value);
      set(value);
    },
  };
}

export const theme = createThemeStore();
