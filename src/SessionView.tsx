import { appModifier, shortcutPrefix } from "./platform";
import { memo, useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  CaseSensitive,
  Globe,
  LoaderCircle,
  PanelRightClose,
  PanelRightOpen,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import type { Session, Transfer } from "./types";
import FileBrowser from "./FileBrowser";
import { useTheme } from "./theme";
import {
  getTerminalTheme,
  terminalThemeOptions,
  type TerminalThemeId,
} from "./terminal-themes";
import { errorText } from "./errors";
const api = window.trident;
const findDecorations = {
  matchBackground: "#f2c14e55",
  matchBorder: "#f2c14e88",
  matchOverviewRuler: "#f2c14e",
  activeMatchBackground: "#f0a020aa",
  activeMatchBorder: "#f0a020",
  activeMatchColorOverviewRuler: "#f0a020",
};

function TerminalPane({
  id,
  visible,
  ready,
  findOpen,
  onFindClose,
  onError,
}: {
  id: string;
  visible: boolean;
  ready: boolean;
  findOpen: boolean;
  onFindClose(): void;
  onError(error: string): void;
}) {
  const { effective, terminalTheme } = useTheme();
  const colors = getTerminalTheme(terminalTheme, effective);
  const currentTheme = useRef(colors);
  currentTheme.current = colors;
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<XTerminal>();
  const addon = useRef<FitAddon>();
  const search = useRef<SearchAddon>();
  const findInput = useRef<HTMLInputElement>(null);
  const findWasOpen = useRef(false);
  const [findText, setFindText] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [findResult, setFindResult] = useState({ index: -1, count: 0 });
  const readyRef = useRef(ready);
  readyRef.current = ready;
  useEffect(() => {
    const term = new XTerminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: '"SF Mono", Menlo, Monaco, monospace',
      lineHeight: 1.4,
      scrollback: 5000,
      theme: currentTheme.current,
      // SearchAddon highlights every match through the decoration API.
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    const find = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(find);
    term.open(host.current!);
    terminal.current = term;
    addon.current = fit;
    search.current = find;
    const findResults = find.onDidChangeResults(
      ({ resultIndex, resultCount }) =>
        setFindResult({ index: resultIndex, count: resultCount }),
    );
    term.attachCustomKeyEventHandler(
      (e) =>
        !(appModifier(e) && ["c", "v", "a", "f"].includes(e.key.toLowerCase())),
    );
    let fitFrame = 0;
    let lastSize = "";
    const fitTerminal = () => {
      if (host.current?.clientWidth) {
        fit.fit();
        const size = `${term.cols}:${term.rows}`;
        if (readyRef.current && size !== lastSize) {
          lastSize = size;
          void api.resize(id, term.cols, term.rows).catch(() => {});
        }
      }
    };
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(fitFrame);
      fitFrame = requestAnimationFrame(fitTerminal);
    });
    observer.observe(host.current!);
    const input = term.onData((data) => {
      if (readyRef.current)
        void api.write(id, data).catch((e) => onError(errorText(e)));
    });
    const unsub = api.onSessionEvent(
      id,
      (event) => {
        if (event.type === "data")
          term.write(event.data, () =>
            api.acknowledge(id, event.data.byteLength),
          );
        if (event.type === "close")
          term.writeln("\r\n\x1b[90m连接已关闭。\x1b[0m");
      },
      true,
    );
    return () => {
      unsub();
      findResults.dispose();
      input.dispose();
      observer.disconnect();
      cancelAnimationFrame(fitFrame);
      term.dispose();
      terminal.current = undefined;
      addon.current = undefined;
      search.current = undefined;
    };
  }, [id, onError]);
  useEffect(() => {
    if (terminal.current) terminal.current.options.theme = colors;
  }, [colors]);
  useEffect(() => {
    const update = () => {
      if (terminal.current)
        terminal.current.options.cursorBlink = visible && !document.hidden;
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, [visible]);
  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => {
      addon.current?.fit();
      const term = terminal.current;
      if (term && ready)
        void api.resize(id, term.cols, term.rows).catch(() => {});
      term?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [visible, ready, id]);
  function findNext() {
    if (!findText) return;
    search.current?.findNext(findText, {
      caseSensitive,
      decorations: findDecorations,
    });
  }
  function findPrevious() {
    if (!findText) return;
    search.current?.findPrevious(findText, {
      caseSensitive,
      decorations: findDecorations,
    });
  }
  function changeFindText(value: string) {
    setFindText(value);
    const find = search.current;
    if (!find) return;
    if (!value) {
      find.clearDecorations();
      terminal.current?.clearSelection();
      setFindResult({ index: -1, count: 0 });
      return;
    }
    find.findNext(value, {
      caseSensitive,
      incremental: true,
      decorations: findDecorations,
    });
  }
  function toggleCaseSensitive() {
    const next = !caseSensitive;
    setCaseSensitive(next);
    if (!findText) return;
    terminal.current?.clearSelection();
    search.current?.findNext(findText, {
      caseSensitive: next,
      decorations: findDecorations,
    });
  }
  useEffect(() => {
    const find = search.current;
    if (findOpen) {
      findWasOpen.current = true;
      findInput.current?.focus();
      findInput.current?.select();
      if (findText)
        find?.findNext(findText, {
          caseSensitive,
          decorations: findDecorations,
        });
      return;
    }
    if (!findWasOpen.current) return;
    findWasOpen.current = false;
    find?.clearDecorations();
    terminal.current?.clearSelection();
    setFindResult({ index: -1, count: 0 });
    if (visible) terminal.current?.focus();
  }, [findOpen]);
  const findCount = !findText
    ? ""
    : findResult.count
      ? `${findResult.index < 0 ? "…" : findResult.index + 1} / ${findResult.count}`
      : "无结果";
  return (
    <div className="terminal-pane" style={{ background: colors.background }}>
      {findOpen && (
        <div
          className="terminal-search"
          role="search"
          aria-label="查找终端输出"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onFindClose();
            }
          }}
        >
          <Search size={14} className="terminal-search-icon" />
          <input
            ref={findInput}
            value={findText}
            aria-label="查找终端输出"
            placeholder="查找终端输出"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => changeFindText(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter" || event.key === "F3") {
                event.preventDefault();
                if (event.shiftKey) findPrevious();
                else findNext();
              }
            }}
          />
          <span className="terminal-search-count" aria-live="polite">
            {findCount}
          </span>
          <button
            className={`icon-button terminal-search-case${caseSensitive ? " active" : ""}`}
            aria-label="区分大小写"
            aria-pressed={caseSensitive}
            title="区分大小写"
            onClick={toggleCaseSensitive}
          >
            <CaseSensitive size={15} />
          </button>
          <button
            className="icon-button"
            aria-label="上一个匹配"
            title="上一个匹配（Shift+Enter / Shift+F3）"
            disabled={!findText}
            onClick={findPrevious}
          >
            <ArrowUp size={15} />
          </button>
          <button
            className="icon-button"
            aria-label="下一个匹配"
            title="下一个匹配（Enter / F3）"
            disabled={!findText}
            onClick={findNext}
          >
            <ArrowDown size={15} />
          </button>
          <button
            className="icon-button"
            aria-label="关闭查找"
            title="关闭查找（Esc）"
            onClick={onFindClose}
          >
            <X size={15} />
          </button>
        </div>
      )}
      <div className="terminal-host" ref={host} />
    </div>
  );
}

const SessionView = memo(function SessionView({
  session,
  visible,
  filePaneWidth,
  onFilePaneWidthChange,
}: {
  session: Session;
  visible: boolean;
  filePaneWidth: number | null;
  onFilePaneWidthChange: (width: number | null) => void;
}) {
  const [status, setStatus] = useState<"connecting" | "ready" | "closed">(
    "connecting",
  );
  const [filesReady, setFilesReady] = useState(false);
  const [filesVisible, setFilesVisible] = useState(true);
  const [findOpen, setFindOpen] = useState(false);
  const [savingTheme, setSavingTheme] = useState(false);
  const filesToggle = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState("");
  const [transfer, setTransfer] = useState<Transfer | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const pendingTransfer = useRef<Transfer | null>(null);
  const { terminalTheme } = useTheme();
  useEffect(() => {
    if (visible) setTransfer(pendingTransfer.current);
  }, [visible]);
  const hasTerminal = session.profile.protocol === "ssh";
  useEffect(() => {
    if (!hasTerminal) return;
    const listener = (event: KeyboardEvent) => {
      if (!visibleRef.current) return;
      if (appModifier(event) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFindOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [hasTerminal]);
  const authLabel =
    session.profile.auth === "password"
      ? "PASSWORD"
      : session.profile.auth === "key"
        ? "PRIVATE KEY"
        : "SSH AGENT";
  const connectionHint =
    status === "connecting"
      ? "等待服务器响应或身份确认"
      : status !== "ready"
        ? "会话已结束，可从连接管理重新连接"
        : session.profile.protocol === "ftp"
          ? "FTP 明文连接"
          : "加密连接";
  const statusText =
    status === "connecting"
      ? "正在连接…"
      : status === "ready"
        ? `${session.profile.protocol.toUpperCase()} 已连接`
        : "已断开";
  useEffect(() => {
    let disposed = false;
    const unsub = api.onSessionEvent(session.id, (event) => {
      if (event.id !== session.id || disposed) return;
      if (event.type === "ready") {
        setStatus("ready");
        setFilesReady(event.data.sftp);
      }
      if (event.type === "close") {
        setStatus("closed");
        setFilesReady(false);
        if (pendingTransfer.current?.state === "running")
          pendingTransfer.current = {
            ...pendingTransfer.current,
            state: "error",
          };
        setTransfer((t) =>
          t?.state === "running" ? { ...t, state: "error" } : t,
        );
      }
      if (event.type === "error" || event.type === "notice")
        setError(event.data);
      if (event.type === "transfer") {
        pendingTransfer.current = event.data;
        if (visibleRef.current) setTransfer(event.data);
      }
    });
    void api
      .connect(session.id, session.profile, session.credentials)
      .catch((e) => {
        if (!disposed) {
          setError(errorText(e));
          setStatus("closed");
        }
      })
      .finally(() => {
        delete session.credentials.password;
        delete session.credentials.passphrase;
      });
    return () => {
      disposed = true;
      unsub();
      void api.disconnect(session.id).catch(() => {});
    };
  }, [session]);
  return (
    <section
      className="session"
      data-session-id={session.id}
      style={{ display: visible ? "flex" : "none" }}
    >
      <div className="session-toolbar">
        <div className="session-identity">
          <span
            className={`status-dot ${status !== "ready" ? "inactive" : ""}`}
          />
          <strong>{session.title}</strong>
          <span className="session-address">
            {session.profile.username}@{session.profile.host}:
            {session.profile.port}
          </span>
        </div>
        <div className="session-actions">
          <span
            className="session-status"
            title={`${connectionHint} · ${session.profile.protocol.toUpperCase()}${hasTerminal ? ` · ${authLabel}` : ""}`}
          >
            {status === "connecting" ? (
              <LoaderCircle className="spin" size={13} />
            ) : session.profile.protocol === "ftp" ? (
              <Globe size={13} />
            ) : (
              <ShieldCheck size={13} />
            )}
            {statusText}
          </span>
          {hasTerminal && (
            <button
              className="secondary small terminal-find-toggle"
              aria-label="查找终端输出"
              aria-pressed={findOpen}
              title={`查找终端输出（${shortcutPrefix}F）`}
              onClick={() => setFindOpen((open) => !open)}
            >
              <Search size={14} />
              查找
            </button>
          )}
          {hasTerminal && (
            <label
              className="terminal-theme-control"
              title="应用于所有 SSH 终端，并记住本次选择"
            >
              配色
              <select
                aria-label="终端配色"
                value={terminalTheme}
                disabled={savingTheme}
                onChange={async (event) => {
                  const theme = event.target.value as TerminalThemeId;
                  setSavingTheme(true);
                  try {
                    await api.setTerminalTheme(theme);
                  } catch (error) {
                    setError(errorText(error));
                  } finally {
                    setSavingTheme(false);
                  }
                }}
              >
                {terminalThemeOptions.map(({ id, label }) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {hasTerminal && (
            <button
              ref={filesToggle}
              className="secondary small file-panel-toggle"
              aria-label={filesVisible ? "隐藏文件面板" : "显示文件面板"}
              title={filesVisible ? "隐藏文件面板，展开终端" : "显示文件面板"}
              aria-expanded={filesVisible}
              aria-controls={`files-${session.id}`}
              onClick={() => setFilesVisible((value) => !value)}
            >
              {filesVisible ? (
                <PanelRightClose size={14} />
              ) : (
                <PanelRightOpen size={14} />
              )}
              文件面板
            </button>
          )}
        </div>
      </div>
      {error && (
        <div className="session-error">
          {error}
          <button className="icon-button" onClick={() => setError("")}>
            <X size={14} />
          </button>
        </div>
      )}
      <div className={`session-content ${hasTerminal ? "" : "files-only"}`}>
        {hasTerminal && (
          <TerminalPane
            id={session.id}
            ready={status === "ready"}
            visible={visible}
            findOpen={findOpen}
            onFindClose={() => setFindOpen(false)}
            onError={setError}
          />
        )}
        <FileBrowser
          id={session.id}
          protocol={hasTerminal ? "sftp" : session.profile.protocol}
          enabled={filesReady && status === "ready"}
          transfer={transfer}
          collapsed={hasTerminal && !filesVisible}
          width={hasTerminal ? filePaneWidth : null}
          onWidthChange={hasTerminal ? onFilePaneWidthChange : undefined}
          onHide={
            hasTerminal
              ? () => {
                  setFilesVisible(false);
                  filesToggle.current?.focus();
                }
              : undefined
          }
        />
      </div>
    </section>
  );
});
export default SessionView;
