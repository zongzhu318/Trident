import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { applyTheme, ThemeProvider } from "./theme";
async function start() {
  const initial = await window.trident.getTheme();
  applyTheme(initial);
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <ThemeProvider initial={initial}>
      <App />
    </ThemeProvider>,
  );
}
void start().catch((error) => {
  document.getElementById("root")!.textContent = `启动失败：${String(error)}`;
});
