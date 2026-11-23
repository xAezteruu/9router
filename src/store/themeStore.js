"use client";

import { create } from "zustand";

const THEME_ID = "neobrutalism";
export const THEME_IDS = [THEME_ID];

function normalize() {
  return THEME_ID;
}

const useThemeStore = create((set) => ({
  theme: THEME_ID,
  canChangeTheme: false,
  hydrated: true,

  /** Called by ThemeProvider / shell; the site-wide theme is locked. */
  setServerTheme: (_theme, _canChange = false) => {
    set({ theme: THEME_ID, canChangeTheme: false, hydrated: true });
    applyTheme(THEME_ID);
  },

  /** Neobrutalism is the single locked site-wide visual system. */
  setTheme: async () => {
    set({ theme: THEME_ID });
    applyTheme(THEME_ID);
    return true;
  },

  toggleTheme: () => {
    applyTheme(THEME_ID);
    return THEME_ID;
  },
}));

export function applyTheme(_theme = THEME_ID) {
  if (typeof window === "undefined") return;
  const root = document.documentElement;
  root.classList.remove("glass", "brutalist");
  root.classList.add(THEME_ID);
  // Preserve the user's dark-mode choice (set in HeaderMenu / pre-paint script).
  try {
    const stored = localStorage.getItem("freepi-theme");
    const dark = stored ? stored === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.classList.toggle("dark", dark);
  } catch {}
}

export default useThemeStore;
