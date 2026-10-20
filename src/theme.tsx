import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { TerminalThemeId } from "./terminal-themes";
export type ThemeMode = "system" | "light" | "dark";
export type ThemeState = {
  mode: ThemeMode;
  effective: "light" | "dark";
  terminalTheme: TerminalThemeId;
};
const ThemeContext = createContext<ThemeState>({
  mode: "system",
  effective: "dark",
  terminalTheme: "auto",
});
export function applyTheme(theme: ThemeState) {
  document.documentElement.dataset.theme = theme.effective;
  document.documentElement.style.colorScheme = theme.effective;
}
export function ThemeProvider({
  initial,
  children,
}: {
  initial: ThemeState;
  children: ReactNode;
}) {
  const [theme, setTheme] = useState(initial);
  useEffect(() => {
    const update = (next: ThemeState) => {
      applyTheme(next);
      setTheme(next);
    };
    const unsubscribe = window.trident.onThemeChanged(update);
    void window.trident
      .getTheme()
      .then(update)
      .catch(() => {});
    return unsubscribe;
  }, []);
  return (
    <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>
  );
}
export const useTheme = () => useContext(ThemeContext);
