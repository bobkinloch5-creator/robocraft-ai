import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

// 6 themes: 2 base (dark/light) + 4 Roblox-flavored skins.
// All map to CSS classes defined in src/styles.css.
export type Theme = "dark" | "light" | "neon" | "obby" | "tycoon" | "rpg";

export const THEMES: { id: Theme; label: string; emoji: string; hint: string }[] = [
  { id: "dark", label: "Obsidian", emoji: "🌑", hint: "Default dark builder" },
  { id: "light", label: "Daylight", emoji: "☀️", hint: "Studio daylight" },
  { id: "neon", label: "Neon Arcade", emoji: "💜", hint: "Cyberpunk purple + cyan" },
  { id: "obby", label: "Obby", emoji: "🟧", hint: "Bright candy primaries" },
  { id: "tycoon", label: "Tycoon", emoji: "💰", hint: "Money green + gold" },
  { id: "rpg", label: "RPG Dark", emoji: "🗡️", hint: "Dungeon ember + steel" },
];

const ALL_CLASSES = THEMES.map((t) => t.id);

const ThemeContext = createContext<{
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
}>({ theme: "dark", setTheme: () => {}, toggle: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("dark");

  useEffect(() => {
    const saved = window.localStorage.getItem("bs_theme") as Theme | null;
    if (saved && ALL_CLASSES.includes(saved)) {
      setThemeState(saved);
    }
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    ALL_CLASSES.forEach((c) => root.classList.remove(c));
    root.classList.add(theme);
    // Roblox theme variants inherit dark-mode color-scheme by default
    root.style.colorScheme = theme === "light" ? "light" : "dark";
    window.localStorage.setItem("bs_theme", theme);
  }, [theme]);

  const toggle = () =>
    setThemeState((t) => {
      const i = ALL_CLASSES.indexOf(t);
      return ALL_CLASSES[(i + 1) % ALL_CLASSES.length];
    });

  return (
    <ThemeContext.Provider value={{ theme, setTheme: setThemeState, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
