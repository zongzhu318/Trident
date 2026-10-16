import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { ITheme } from "@xterm/xterm";
export type ThemeMode = "system" | "light" | "dark";
export type ThemeState = { mode: ThemeMode; effective: "light" | "dark" };
const ThemeContext = createContext<ThemeState>({
  mode: "system",
  effective: "dark",
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
export const terminalThemes: Record<"light" | "dark", ITheme> = {
  dark: {
    background: "#111318",
    foreground: "#d5dae3",
    cursor: "#65d8b5",
    cursorAccent: "#111318",
    selectionBackground: "#35443f",
    black: "#343a46",
    red: "#f38b9c",
    green: "#7bd8ae",
    yellow: "#edcf8b",
    blue: "#8cb5f5",
    magenta: "#c6a0e9",
    cyan: "#7cced4",
    white: "#e3e7ee",
    brightBlack: "#788392",
    brightRed: "#ffadba",
    brightGreen: "#a1ebc5",
    brightYellow: "#f5dfaa",
    brightBlue: "#b2ccfa",
    brightMagenta: "#ddbef6",
    brightCyan: "#a6e6e8",
    brightWhite: "#ffffff",
  },
  light: {
    background: "#ffffff",
    foreground: "#25312e",
    cursor: "#167d61",
    cursorAccent: "#ffffff",
    selectionBackground: "#cae5db",
    black: "#25312e",
    red: "#b12d43",
    green: "#247346",
    yellow: "#896112",
    blue: "#285caf",
    magenta: "#8540a2",
    cyan: "#176e7a",
    white: "#69736f",
    brightBlack: "#65736c",
    brightRed: "#c43f54",
    brightGreen: "#2f8554",
    brightYellow: "#9b711c",
    brightBlue: "#3370ce",
    brightMagenta: "#9655b0",
    brightCyan: "#208493",
    brightWhite: "#44504a",
  },
};
