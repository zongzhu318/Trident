import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUp,
  ArrowUpFromLine,
  Check,
  Download,
  File,
  Folder,
  FolderPlus,
  Pencil,
  PanelRightClose,
  RefreshCw,
  Trash2,
  Unplug,
  X,
} from "lucide-react";
import type { RemoteFile, Transfer } from "./types";
import { errorText } from "./errors";
const api = window.trident;
const join = (parent: string, name: string) =>
  `${parent === "/" ? "" : parent}/${name}`;
const sizeText = (size: number) =>
  size < 1024
    ? `${size} B`
    : size < 1048576
      ? `${(size / 1024).toFixed(1)} KB`
      : `${(size / 1048576).toFixed(1)} MB`;
const FileBrowser = memo(function FileBrowser({
  id,
  protocol,
  enabled,
  transfer,
  collapsed = false,
  onHide,
}: {
  id: string;
  protocol: string;
  enabled: boolean;
  transfer: Transfer | null;
  collapsed?: boolean;
  onHide?: () => void;
}) {
  const [directory, setDirectory] = useState("");
  const [pathInput, setPathInput] = useState("");
  const [files, setFiles] = useState<RemoteFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hidden, setHidden] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [edit, setEdit] = useState<{
    type: "mkdir" | "rename";
    name: string;
    source?: string;
  } | null>(null);
  const running = useRef(false);
  const listHost = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(500);
  useEffect(() => {
    const host = listHost.current!;
    const observer = new ResizeObserver(() => {
      if (host.clientHeight) setViewportHeight(host.clientHeight);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  async function refresh(target: string | null) {
    const result = await api.list(id, target);
    setDirectory(result.path);
    setPathInput(result.path);
    setFiles(result.files);
    setSelected(null);
    if (listHost.current) listHost.current.scrollTop = 0;
    setScrollTop(0);
  }
  async function perform(operation: () => Promise<unknown>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (e) {
      setError(errorText(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    if (enabled) void perform(() => refresh(null));
  }, [enabled, id]);
  const visibleFiles = useMemo(
    () =>
      files
        .filter((f) => hidden || !f.name.startsWith("."))
        .sort(
          (a, b) =>
            Number(b.directory) - Number(a.directory) ||
            a.name.localeCompare(b.name),
        ),
    [files, hidden],
  );
  const virtual = visibleFiles.length > 100;
  const start = Math.min(
    Math.max(0, Math.floor((scrollTop - 30) / 40) - 6),
    Math.max(0, visibleFiles.length - 1),
  );
  const end = Math.min(
    visibleFiles.length,
    start + Math.ceil(viewportHeight / 40) + 14,
  );
  const renderedFiles = virtual ? visibleFiles.slice(start, end) : visibleFiles;
  const item = visibleFiles.find((f) => f.name === selected);
  const blocked = busy || !enabled || !directory;
  const download = (file: RemoteFile) =>
    perform(() => api.download(id, join(directory, file.name)));
  return (
    <aside className="file-pane" id={`files-${id}`} hidden={collapsed}>
      <div className="pane-title">
        <Folder size={14} />
        远程文件<span>{protocol.toUpperCase()}</span>
        {onHide && (
          <button
            className="icon-button"
            aria-label="隐藏文件面板"
            title="隐藏文件面板"
            onClick={onHide}
          >
            <PanelRightClose size={15} />
          </button>
        )}
      </div>
      <div className="file-toolbar">
        <button
          className="icon-button"
          disabled={blocked || directory === "/"}
          title="上级目录"
          onClick={() =>
            void perform(() =>
              refresh(directory.slice(0, directory.lastIndexOf("/")) || "/"),
            )
          }
        >
          <ArrowUp size={16} />
        </button>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && enabled) void perform(() => refresh(pathInput));
          }}
        >
          <input
            aria-label="远程目录"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            disabled={!enabled}
            placeholder="输入绝对路径后按 Enter"
          />
        </form>
        <button
          className="icon-button"
          disabled={!enabled || busy}
          title="刷新"
          onClick={() => void perform(() => refresh(directory || null))}
        >
          <RefreshCw size={14} className={busy ? "spin" : ""} />
        </button>
      </div>
      <div className="file-actions">
        <button
          className="secondary small"
          disabled={blocked}
          onClick={() =>
            void perform(async () => {
              await api.upload(id, directory);
              await refresh(directory);
            })
          }
        >
          <ArrowUpFromLine size={13} />
          上传文件
        </button>
        <button
          className="icon-button"
          disabled={blocked}
          title="新建文件夹"
          onClick={() => setEdit({ type: "mkdir", name: "" })}
        >
          <FolderPlus size={16} />
        </button>
        <button
          className="icon-button"
          disabled={blocked || !item || item.directory || item.symlink}
          title="下载选中文件"
          onClick={() => item && void download(item)}
        >
          <Download size={16} />
        </button>
        <button
          className="icon-button"
          disabled={blocked || !item}
          title="重命名"
          onClick={() =>
            item &&
            setEdit({ type: "rename", name: item.name, source: item.name })
          }
        >
          <Pencil size={15} />
        </button>
        <button
          className="icon-button danger"
          disabled={blocked || !item}
          title="删除文件或空目录"
          onClick={() =>
            item &&
            void perform(async () => {
              if (await api.remove(id, join(directory, item.name)))
                await refresh(directory);
            })
          }
        >
          <Trash2 size={15} />
        </button>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={hidden}
            onChange={(e) => setHidden(e.target.checked)}
          />
          隐藏文件
        </label>
      </div>
      {edit && (
        <form
          className="new-folder"
          onSubmit={(e) => {
            e.preventDefault();
            if (blocked) return;
            void perform(async () => {
              if (edit.type === "mkdir")
                await api.mkdir(id, directory, edit.name);
              else
                await api.rename(id, join(directory, edit.source!), edit.name);
              setEdit(null);
              await refresh(directory);
            });
          }}
        >
          <input
            autoFocus
            required
            aria-label={edit.type === "mkdir" ? "新文件夹名称" : "新名称"}
            placeholder={edit.type === "mkdir" ? "新文件夹名称" : "新名称"}
            value={edit.name}
            onChange={(e) => setEdit({ ...edit, name: e.target.value })}
          />
          <button className="icon-button" disabled={blocked}>
            <Check size={16} />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => setEdit(null)}
          >
            <X size={16} />
          </button>
        </form>
      )}
      {error && (
        <div className="file-error" role="alert">
          {error}
        </div>
      )}
      <div
        className="file-list"
        ref={listHost}
        onScroll={(e) => {
          if (virtual) setScrollTop(e.currentTarget.scrollTop);
        }}
      >
        <div className="file-table-heading">
          <span>名称</span>
          <span>大小</span>
        </div>
        {!enabled ? (
          <div className="file-empty">
            <Unplug size={27} />
            <p>连接后浏览远程文件</p>
          </div>
        ) : visibleFiles.length === 0 ? (
          <div className="file-empty">
            <Folder size={27} />
            <p>{busy ? "正在读取目录…" : "此目录为空"}</p>
          </div>
        ) : (
          <div
            className={virtual ? "virtual-file-space" : undefined}
            style={virtual ? { height: visibleFiles.length * 40 } : undefined}
          >
            {renderedFiles.map((file, index) => (
              <button
                key={file.name}
                style={virtual ? { top: (start + index) * 40 } : undefined}
                disabled={blocked}
                className={`file-row ${selected === file.name ? "selected" : ""}`}
                aria-pressed={selected === file.name}
                title={`${file.name}\n权限 ${file.permissions}${file.modified ? ` · ${new Date(file.modified * 1000).toLocaleString()}` : ""}${file.symlink ? "\n符号链接不支持打开" : ""}`}
                onClick={() => setSelected(file.name)}
                onDoubleClick={() => {
                  if (file.symlink) return;
                  if (file.directory) {
                    setEdit(null);
                    void perform(() => refresh(join(directory, file.name)));
                  } else void download(file);
                }}
              >
                <span>
                  {file.directory ? (
                    <Folder className="folder-icon" size={16} />
                  ) : (
                    <File size={15} />
                  )}
                  <span>
                    {file.name}
                    {file.symlink ? " ↗" : ""}
                  </span>
                </span>
                <span>{file.directory ? "—" : sizeText(file.size)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="file-hint">
        {visibleFiles.length} 项 · 选中后操作，双击打开或下载
      </div>
      <div className="transfer-panel">
        <div className="pane-title">
          <ArrowDownToLine size={14} />
          文件传输
        </div>
        {transfer ? (
          <div className="transfer-item">
            <div>
              <span>
                {transfer.direction === "upload" ? "↑" : "↓"} {transfer.name}
              </span>
              <span>
                {transfer.state === "done"
                  ? "已完成"
                  : transfer.state === "error"
                    ? "失败 / 中断"
                    : transfer.total
                      ? `${Math.round(((transfer.transferred ?? 0) / transfer.total) * 100)}%`
                      : "传输中"}
              </span>
            </div>
            <div className={`progress ${transfer.state}`}>
              <span
                style={{
                  width:
                    transfer.state === "done"
                      ? "100%"
                      : `${transfer.total ? ((transfer.transferred ?? 0) / transfer.total) * 100 : 0}%`,
                }}
              />
            </div>
          </div>
        ) : (
          <div className="transfer-empty">暂无传输任务</div>
        )}
      </div>
    </aside>
  );
});
export default FileBrowser;
