import { appModifier, isMac, shortcutPrefix } from "./platform";
import {
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpFromLine,
  CircleHelp,
  Command,
  Folder,
  KeyRound,
  LockKeyhole,
  Maximize2,
  Minimize2,
  Sun,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Search,
  Server,
  ShieldCheck,
  Terminal,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import ConnectionModal, { protocolLabel } from "./ConnectionModal";
import BackupModal from "./BackupModal";
import SessionView from "./SessionView";
import type { Credentials, Profile, Session } from "./types";
import { useTheme, type ThemeMode } from "./theme";
import { errorText } from "./errors";

const api = window.trident;
const focusShortcut = isMac ? "⌘M" : "Ctrl+Shift+M";
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 420;
const storedWidth = (key: string, min: number, max: number) => {
  const value = Number(localStorage.getItem(key));
  return value >= min && value <= max ? value : null;
};
export default function App() {
  const theme = useTheme();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [active, setActive] = useState("home");
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [focusMode, setFocusMode] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(() =>
    storedWidth("trident.sidebar-width", SIDEBAR_MIN, SIDEBAR_MAX),
  );
  const [filePaneWidth, setFilePaneWidth] = useState<number | null>(() =>
    storedWidth("trident.file-pane-width", 260, 560),
  );
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState<{
    profile?: Profile;
    connect: boolean;
  } | null>(null);
  const [error, setError] = useState("");
  const [help, setHelp] = useState(false);
  const [backup, setBackup] = useState<"import" | "export" | null>(null);
  useEffect(() => {
    api
      ?.profiles()
      .then(setProfiles)
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    if (active === "home") setFocusMode(false);
  }, [active]);
  useEffect(() => {
    if (active === "home") return;
    return api.onToggleFocus(() => setFocusMode((value) => !value));
  }, [active]);
  function beginSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth =
      event.currentTarget.parentElement?.getBoundingClientRect().width ?? 234;
    let width = startWidth;
    const move = (e: PointerEvent) => {
      width = Math.min(
        SIDEBAR_MAX,
        Math.max(SIDEBAR_MIN, startWidth + e.clientX - startX),
      );
      setSidebarWidth(width);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.body.classList.remove("resizing");
      localStorage.setItem("trident.sidebar-width", String(Math.round(width)));
    };
    document.body.classList.add("resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }
  function resetSidebarWidth() {
    setSidebarWidth(null);
    localStorage.removeItem("trident.sidebar-width");
  }
  function nudgeSidebar(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const current =
      event.currentTarget.parentElement?.getBoundingClientRect().width ?? 234;
    const width = Math.min(
      SIDEBAR_MAX,
      Math.max(SIDEBAR_MIN, current + (event.key === "ArrowRight" ? 16 : -16)),
    );
    setSidebarWidth(width);
    localStorage.setItem("trident.sidebar-width", String(Math.round(width)));
  }
  function stepSession(delta: number) {
    if (!sessions.length) return;
    const index = sessions.findIndex((s) => s.id === active);
    const next =
      index === -1
        ? delta > 0
          ? 0
          : sessions.length - 1
        : (index + delta + sessions.length) % sessions.length;
    setActive(sessions[next].id);
  }
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const digit = /^[1-9]$/.test(event.key)
        ? event.key
        : /^Digit[1-9]$/.test(event.code)
          ? event.code.slice(-1)
          : "";
      if (appModifier(event) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        setModal({ connect: false });
      }
      if (appModifier(event) && event.key.toLowerCase() === "t") {
        event.preventDefault();
        setModal({ connect: true });
      }
      if (appModifier(event) && digit) {
        if (digit === "1") {
          event.preventDefault();
          setActive("home");
        } else {
          const session = sessions[Number(digit) - 2];
          if (session) {
            event.preventDefault();
            setActive(session.id);
          }
        }
      }
      if (
        appModifier(event) &&
        event.shiftKey &&
        (event.code === "BracketRight" || event.code === "BracketLeft")
      ) {
        event.preventDefault();
        stepSession(event.code === "BracketRight" ? 1 : -1);
      }
      if (appModifier(event) && event.key.toLowerCase() === "w") {
        const session = sessions.find((s) => s.id === active);
        if (session) {
          event.preventDefault();
          void closeSession(session.id).catch((e) => setError(errorText(e)));
        }
      }
      if (event.key === "Escape") {
        setModal(null);
        setHelp(false);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [sessions, active]);
  async function start(
    profile: Profile,
    credentials: Credentials,
    save: boolean,
    remember: boolean,
  ) {
    if (save)
      setProfiles(await api.saveProfile(profile, credentials, remember));
    const id = crypto.randomUUID();
    setSessions((items) => [...items, { id, profile, credentials }]);
    setActive(id);
    setModal(null);
  }
  function connectProfile(profile: Profile) {
    if (profile.hasSavedCredentials || profile.auth === "agent") {
      void start(profile, {}, false, false);
    } else {
      setModal({ profile, connect: true });
    }
  }
  async function closeSession(id: string) {
    if (
      !window.confirm("关闭此标签并断开连接？该连接的终端和文件传输会被中断。")
    )
      return;
    await api.disconnect(id);
    setSessions((items) => items.filter((s) => s.id !== id));
    if (active === id) setActive("home");
  }
  async function deleteProfile(profile: Profile) {
    if (!window.confirm(`删除连接「${profile.name}」？`)) return;
    try {
      setProfiles(await api.deleteProfile(profile.id));
    } catch (e) {
      setError(errorText(e));
    }
  }
  const filtered = profiles.filter((p) =>
    `${p.name} ${p.host} ${p.group}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <div className={`app${focusMode ? " focus" : ""}`}>
      <header className="titlebar">
        <div className="traffic-space" />
        <button
          className="sidebar-toggle"
          aria-label={sidebarVisible ? "隐藏连接管理栏" : "显示连接管理栏"}
          title={sidebarVisible ? "隐藏连接管理栏" : "显示连接管理栏"}
          aria-expanded={sidebarVisible}
          aria-controls="connection-sidebar"
          onClick={() => setSidebarVisible((value) => !value)}
        >
          {sidebarVisible ? (
            <PanelLeftClose size={18} />
          ) : (
            <PanelLeftOpen size={18} />
          )}
        </button>
        <img
          className="brand-mark"
          src="./logo.png"
          alt="Trident Logo"
          draggable={false}
        />
        <strong>Trident</strong>
        <span className="titlebar-sub">你的远程工作空间</span>
        <span className="titlebar-right">SSH · SFTP · FTP</span>
        {active !== "home" && (
          <button
            className="focus-toggle"
            aria-label={focusMode ? "退出专注模式" : "进入专注模式"}
            aria-pressed={focusMode}
            title={`${focusMode ? "退出" : "进入"}专注模式（${focusShortcut}）`}
            onClick={() => setFocusMode((value) => !value)}
          >
            {focusMode ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
        )}
      </header>
      <div className="layout">
        <aside
          className="sidebar"
          id="connection-sidebar"
          hidden={!sidebarVisible}
          style={sidebarWidth ? { width: sidebarWidth } : undefined}
        >
          <div className="workspace-name">
            <div className="workspace-avatar">
              <Command size={18} />
            </div>
            <div>
              <strong>个人工作空间</strong>
              <small>LOCAL WORKSPACE</small>
            </div>
            <LockKeyhole size={13} className="muted" />
          </div>
          <button
            className={`nav-item ${active === "home" ? "selected" : ""}`}
            onClick={() => setActive("home")}
          >
            <Server size={17} />
            连接管理<span className="count">{profiles.length}</span>
          </button>
          <div className="sidebar-section">
            <span>已保存的连接</span>
            <button
              className="icon-button"
              aria-label="新建连接"
              onClick={() => setModal({ connect: false })}
            >
              <Plus size={16} />
            </button>
          </div>
          <div className="sidebar-connections">
            {profiles.length === 0 ? (
              <div className="sidebar-empty">
                还没有保存的连接
                <br />
                <span>添加一台服务器，开始工作</span>
              </div>
            ) : (
              profiles.map((p) => (
                <div
                  className="connection-nav"
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => connectProfile(p)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      connectProfile(p);
                    }
                  }}
                >
                  <span className="server-dot" />
                  <span>
                    {p.name}
                    <small>
                      {p.username}@{p.host}
                    </small>
                  </span>
                  <button
                    className="icon-button nav-edit"
                    aria-label={`编辑连接 ${p.name}`}
                    title="编辑"
                    onClick={(e) => {
                      e.stopPropagation();
                      setModal({ profile: p, connect: false });
                    }}
                  >
                    <Pencil size={13} />
                  </button>
                </div>
              ))
            )}
          </div>
          <div className="sidebar-bottom">
            <label className="theme-control">
              <Sun size={16} />
              <span>外观</span>
              <select
                aria-label="主题"
                value={theme.mode}
                onChange={(e) =>
                  void api
                    .setTheme(e.target.value as ThemeMode)
                    .catch((error) => setError(errorText(error)))
                }
              >
                <option value="system">跟随系统</option>
                <option value="light">浅色</option>
                <option value="dark">深色</option>
              </select>
            </label>
            <div className="security-note">
              <ShieldCheck size={17} />
              <span>
                安全连接，专注工作<small>可选本机凭据保存与加密备份</small>
              </span>
            </div>
            <button className="help-button" onClick={() => setHelp(true)}>
              <CircleHelp size={16} />
              使用指南<span>v0.0.1</span>
            </button>
          </div>
          <div
            className="panel-resizer sidebar-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整侧边栏宽度"
            title="拖拽调整侧边栏宽度，双击恢复默认"
            tabIndex={0}
            onPointerDown={beginSidebarResize}
            onKeyDown={nudgeSidebar}
            onDoubleClick={resetSidebarWidth}
          />
        </aside>
        <main>
          <nav className="tabbar">
            <button
              className={`tab ${active === "home" ? "active" : ""}`}
              onClick={() => setActive("home")}
            >
              <Server size={14} />
              连接管理
            </button>
            {sessions.map((s) => (
              <div
                className={`tab ${active === s.id ? "active" : ""}`}
                key={s.id}
              >
                <button onClick={() => setActive(s.id)}>
                  {s.profile.protocol === "ssh" ? (
                    <Terminal size={14} />
                  ) : (
                    <Folder size={14} />
                  )}
                  {s.profile.name}
                </button>
                <button
                  className="tab-close"
                  aria-label="关闭会话"
                  onClick={() =>
                    void closeSession(s.id).catch((e) => setError(errorText(e)))
                  }
                >
                  <X size={13} />
                </button>
              </div>
            ))}
            <button
              className="icon-button tab-add"
              aria-label="新建连接"
              onClick={() => setModal({ connect: true })}
            >
              <Plus size={17} />
            </button>
          </nav>
          {error && (
            <div className="global-error">
              {error}
              <button className="icon-button" onClick={() => setError("")}>
                <X size={14} />
              </button>
            </div>
          )}
          {active === "home" && (
            <div className="home">
              <div className="page-heading">
                <div>
                  <div className="eyebrow">YOUR SERVERS, ONE PLACE</div>
                  <h1>
                    连接，化繁为简<span>.</span>
                  </h1>
                  <p>从一个终端出发，轻松管理你的远程服务器与文件。</p>
                </div>
                <button
                  className="primary"
                  onClick={() => setModal({ connect: false })}
                >
                  <Plus size={17} />
                  新建连接<span className="shortcut">{shortcutPrefix} N</span>
                </button>
              </div>
              <div className="quick-connect">
                <div className="quick-icon">
                  <Zap size={22} />
                </div>
                <div>
                  <h3>下一个目的地？</h3>
                  <p>连接 SSH 终端，或通过 SFTP / FTP / FTPS 管理远程文件。</p>
                </div>
                <button
                  className="secondary"
                  onClick={() => setModal({ connect: true })}
                >
                  快速连接
                  <ArrowRight size={16} />
                </button>
              </div>
              <div className="backup-actions">
                <button
                  className="secondary small"
                  onClick={() => setBackup("import")}
                >
                  <ArrowUpFromLine size={14} />
                  导入连接
                </button>
                <button
                  className="secondary small"
                  disabled={!profiles.length}
                  onClick={() => setBackup("export")}
                >
                  <ArrowDownToLine size={14} />
                  导出连接
                </button>
              </div>
              <div className="section-heading">
                <h2>
                  我的连接 <span>{profiles.length}</span>
                </h2>
                <label className="search">
                  <Search size={15} />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="搜索名称、主机或分组…"
                  />
                </label>
              </div>
              {filtered.length ? (
                <div className="connection-grid">
                  {filtered.map((p) => (
                    <article className="connection-card" key={p.id}>
                      <div className="card-top">
                        <div className="server-icon">
                          <Server size={22} />
                        </div>
                        <span className="protocol">{protocolLabel(p)}</span>
                        <div className="card-actions">
                          <button
                            className="icon-button"
                            title="编辑"
                            onClick={() =>
                              setModal({ profile: p, connect: false })
                            }
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            className="icon-button danger"
                            title="删除"
                            onClick={() => void deleteProfile(p)}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                      <h3>{p.name}</h3>
                      <p className="host-label">
                        {p.username}@{p.host}:{p.port}
                      </p>
                      <div className="card-footer">
                        <span>
                          <KeyRound size={12} />
                          {p.auth === "password"
                            ? "密码认证"
                            : p.auth === "key"
                              ? "私钥认证"
                              : "SSH Agent"}
                          {p.hasSavedCredentials && " · 已存凭据"}
                          {p.group && ` · ${p.group}`}
                        </span>
                        <button onClick={() => connectProfile(p)}>
                          连接
                          <ArrowRight size={14} />
                        </button>
                      </div>
                    </article>
                  ))}
                  <button
                    className="add-card"
                    onClick={() => setModal({ connect: false })}
                  >
                    <Plus size={23} />
                    添加新连接
                  </button>
                </div>
              ) : (
                <div className="empty-state">
                  <div className="empty-illustration">
                    <div className="orbit orbit-one" />
                    <div className="orbit orbit-two" />
                    <div className="empty-server">
                      <Terminal size={36} strokeWidth={1.4} />
                      <span />
                      <span />
                    </div>
                    <div className="floating-lock">
                      <LockKeyhole size={16} />
                    </div>
                  </div>
                  <h2>
                    {search
                      ? "没有找到匹配的连接"
                      : "你的第一台服务器，从这里开始"}
                  </h2>
                  <p>
                    {search
                      ? "试试其他名称或主机地址。"
                      : "保存常用连接，让每次远程工作都更从容。"}
                  </p>
                  {!search && (
                    <button
                      className="primary"
                      onClick={() => setModal({ connect: false })}
                    >
                      <Plus size={16} />
                      添加第一个连接
                    </button>
                  )}
                </div>
              )}
              <div className="feature-strip">
                <div>
                  <Terminal size={20} />
                  <span>
                    多标签终端<small>在多个远程会话间自由切换</small>
                  </span>
                </div>
                <div>
                  <Folder size={20} />
                  <span>
                    多协议文件管理<small>SFTP、FTP 与 FTPS 文件传输</small>
                  </span>
                </div>
                <div>
                  <ShieldCheck size={20} />
                  <span>
                    主机身份核验<small>记录指纹，识别服务器密钥变化</small>
                  </span>
                </div>
              </div>
              <footer className="home-footer">
                <span>
                  <span className="status-dot" />
                  本地工作空间
                </span>
                <span>Built for your next connection.</span>
              </footer>
            </div>
          )}
          {sessions.map((session) => (
            <SessionView
              key={session.id}
              session={session}
              visible={active === session.id}
              filePaneWidth={filePaneWidth}
              onFilePaneWidthChange={setFilePaneWidth}
            />
          ))}
        </main>
      </div>
      {modal && (
        <ConnectionModal
          initial={modal.profile}
          connecting={modal.connect}
          onClose={() => setModal(null)}
          onSave={async (p, credentials, remember) => {
            setProfiles(await api.saveProfile(p, credentials, remember));
            setModal(null);
          }}
          onConnect={start}
        />
      )}
      {backup && (
        <BackupModal
          mode={backup}
          onClose={() => setBackup(null)}
          onImported={setProfiles}
        />
      )}
      {help && (
        <div className="modal-backdrop" onMouseDown={() => setHelp(false)}>
          <section
            className="modal help-modal"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="modal-heading">
              <h2>开始使用 Trident</h2>
              <button className="icon-button" onClick={() => setHelp(false)}>
                <X size={20} />
              </button>
            </div>
            <p>
              新建连接，填写主机、端口和用户名，选择密码、私钥或 SSH Agent
              认证。
            </p>
            <p>
              首次连接时，请向管理员核对服务器的 SHA256
              指纹，再选择信任。密码和私钥口令可勾选保存在本机磁盘（明文存储，请确保本机账户安全）。
            </p>
            <p>
              终端支持交互式命令、颜色、Vim / htop 等全屏工具，以及{" "}
              {shortcutPrefix}C / {shortcutPrefix}V 复制粘贴。按 Ctrl+C
              中断远程命令，按 {shortcutPrefix}F 查找终端输出，Enter /
              Shift+Enter 跳转匹配，Esc 关闭。
            </p>
            <p>
              文件面板支持目录浏览、新建目录、上传下载、重命名和删除文件或空目录。选中文件后使用工具栏操作；双击目录进入，双击普通文件下载。符号链接不打开。FTP
              上传会预先检查同名文件，SFTP 使用独占创建。
            </p>
            <p>
              按 {focusShortcut}{" "}
              进入专注模式，隐藏侧栏、标签栏和会话信息栏；拖拽侧栏或文件面板的分隔条可调整宽度，双击恢复默认。
            </p>
            <p>
              支持 SSH、独立 SFTP、FTP 和显式
              FTPS。导出可选择包含已保存凭据的加密备份，导入先预览再新增连接。暂不支持目录递归传输、跳板机和交互式多因素认证。
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
