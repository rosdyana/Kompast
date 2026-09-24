import { createContext, useContext, useState, type ReactNode } from "react";

export type Theme = "light" | "dark";

const THEME_COOKIE = "kompast-theme";
const MAX_AGE = 60 * 60 * 24 * 365;

const ThemeContext = createContext<{ theme: Theme; toggleTheme: () => void } | null>(null);

export function ThemeProvider({ initialTheme, children }: { initialTheme: Theme; children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  function toggleTheme() {
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      // Keep the browser chrome (mobile address bar) matching the canvas.
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", next === "dark" ? "#1f1f1e" : "#fbfbfa");
      document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=${MAX_AGE}; samesite=lax`;
      return next;
    });
  }

  return <ThemeContext.Provider value={{ theme, toggleTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
