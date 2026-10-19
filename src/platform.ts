export const isMac = /Mac/.test(navigator.platform);
// Keep terminal Ctrl+C / Ctrl+A / Ctrl+W available for remote programs.
export const appModifier = (event: KeyboardEvent) =>
  isMac ? event.metaKey : event.ctrlKey && event.shiftKey;
export const shortcutPrefix = isMac ? "⌘" : "Ctrl+Shift+";
