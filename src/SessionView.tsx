import { memo, useEffect, useRef, useState } from "react";
import {
  Globe,
  LoaderCircle,
  LockKeyhole,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { Session, Transfer } from "./types";
import FileBrowser from "./FileBrowser";
import { useTheme, terminalThemes } from "./theme";
const api = window.trident;
export const errorText = (e: unknown) =>
  String(e instanceof Error ? e.message : e).replace(
    /^Error invoking remote method '[^']+': Error: /,
    "",
  );

function TerminalPane({
  id,
  visible,
  ready,
  onError,
}: {
  id: string;
  visible: boolean;
  ready: boolean;
  onError(error: string): void;
}) {
  const { effective } = useTheme();
  const currentTheme = useRef(effective);
  currentTheme.current = effective;
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<XTerminal>();
  const addon = useRef<FitAddon>();
  const readyRef = useRef(ready);
  readyRef.current = ready;
  useEffect(() => {
    const term = new XTerminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"SF Mono", Menlo, Monaco, monospace',
      lineHeight: 1.4,
      scrollback: 5000,
      theme: terminalThemes[currentTheme.current],
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    terminal.current = term;
    addon.current = fit;
    term.attachCustomKeyEventHandler(
      (e) => !(e.metaKey && ["c", "v", "a"].includes(e.key.toLowerCase())),
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
      input.dispose();
      observer.disconnect();
      cancelAnimationFrame(fitFrame);
      term.dispose();
      terminal.current = undefined;
      addon.current = undefined;
    };
  }, [id, onError]);
  useEffect(() => {
    if (terminal.current)
      terminal.current.options.theme = terminalThemes[effective];
  }, [effective]);
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
  return (
    <div className="terminal-pane">
      <div className="pane-title">
        <Terminal size={14} />
        终端<span>xterm-256color</span>
      </div>
      <div className="terminal-host" ref={host} />
    </div>
  );
}

const SessionView = memo(function SessionView({
  session,
  visible,
}: {
  session: Session;
  visible: boolean;
}) {
  const [status, setStatus] = useState<"connecting" | "ready" | "closed">(
    "connecting",
  );
  const [filesReady, setFilesReady] = useState(false);
  const [error, setError] = useState("");
  const [transfer, setTransfer] = useState<Transfer | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const pendingTransfer = useRef<Transfer | null>(null);
  useEffect(() => {
    if (visible) setTransfer(pendingTransfer.current);
  }, [visible]);
  const hasTerminal = session.profile.protocol === "ssh";
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
      <div className="session-heading">
        <div>
          <span
            className={`status-dot ${status !== "ready" ? "inactive" : ""}`}
          />
          <strong>{session.profile.name}</strong>
          <span className="muted">
            {session.profile.username}@{session.profile.host}:
            {session.profile.port}
          </span>
        </div>
        <span className="session-status">
          {status === "connecting" ? (
            <LoaderCircle className="spin" size={13} />
          ) : session.profile.protocol === "ftp" ? (
            <Globe size={13} />
          ) : (
            <ShieldCheck size={13} />
          )}
          {status === "connecting"
            ? "正在连接…"
            : status === "ready"
              ? `${session.profile.protocol.toUpperCase()} 已连接`
              : "已断开"}
        </span>
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
            onError={setError}
          />
        )}
        <FileBrowser
          id={session.id}
          protocol={hasTerminal ? "sftp" : session.profile.protocol}
          enabled={filesReady && status === "ready"}
          transfer={transfer}
        />
      </div>
      <div className="session-footer">
        <span>
          {session.profile.protocol === "ftp" ? (
            <Globe size={12} />
          ) : (
            <LockKeyhole size={12} />
          )}
          {status === "ready"
            ? session.profile.protocol === "ftp"
              ? "FTP 明文连接"
              : "加密连接"
            : status === "connecting"
              ? "等待服务器响应或身份确认"
              : "会话已结束，可从连接管理重新连接"}
        </span>
        <span>
          {session.profile.protocol.toUpperCase()} ·{" "}
          {session.profile.auth === "password"
            ? "PASSWORD"
            : session.profile.auth === "key"
              ? "PRIVATE KEY"
              : "SSH AGENT"}
        </span>
      </div>
    </section>
  );
});
export default SessionView;
