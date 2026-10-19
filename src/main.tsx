import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { applyTheme, ThemeProvider } from "./theme";
import { isMac } from "./platform";
document.documentElement.dataset.platform = isMac ? "mac" : "other";
// 退出准备或 Sparkle 恢复安装期间主进程会短暂拒绝 IPC，需等待其结束。
const MAX_ATTEMPTS = 5;
async function getThemeWithRetry() {
  for (let attempt = 0; ; attempt++) {
    try {
      return await window.trident.getTheme();
    } catch (error) {
      if (attempt + 1 >= MAX_ATTEMPTS || !String(error).includes("请稍候"))
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
}
async function start() {
  const initial = await getThemeWithRetry();
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
