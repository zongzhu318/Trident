import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ArrowDownToLine,
  ArrowUp,
  ArrowUpFromLine,
  Check,
  Download,
  File,
  Folder,
  FolderPlus,
  FolderUp,
  Pause,
  Pencil,
  Play,
  PanelRightClose,
  RefreshCw,
  Square,
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
const durationText = (seconds: number) => {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
};
const TERMINAL = new Set(["done", "error", "cancelled"]);
const percentOf = (transfer: Transfer) => {
  const dirs = transfer.dirs;
  // 建目录阶段文件尚未开始，按目录进度展示，避免进度条长时间停在 0%
  if (dirs && dirs.total > 0 && dirs.completed < dirs.total)
    return Math.min(100, (dirs.completed / dirs.total) * 100);
  const bytes = transfer.bytes;
  if (bytes && bytes.total > 0)
    return Math.min(100, (bytes.transferred / bytes.total) * 100);
  const files = transfer.files;
  if (files && files.total > 0)
    return Math.min(
      100,
      ((files.completed + files.skipped) / files.total) * 100,
    );
  return transfer.state === "done" ? 100 : 0;
};
const stateLabel = {
  preparing: "正在扫描",
  running: "传输中",
  paused: "已暂停",
  done: "已完成",
  error: "失败",
  cancelled: "已停止",
} as const;
function TransferItem({
  id,
  transfer,
  onDismiss,
  onError,
}: {
  id: string;
  transfer: Transfer;
  onDismiss?(taskId: string): void;
  onError(message: string): void;
}) {
  const terminal = TERMINAL.has(transfer.state);
  const overall = percentOf(transfer);
  const fileStats = transfer.files;
  const bytes = transfer.bytes;
  const remaining = fileStats
    ? Math.max(0, fileStats.total - fileStats.completed - fileStats.skipped)
    : 0;
  const control = (
    operation: (id: string, taskId: string) => Promise<boolean>,
  ) => {
    void operation(id, transfer.taskId).catch((e) => onError(errorText(e)));
  };
  return (
    <div className="transfer-item">
      <div className="transfer-line">
        <span className="transfer-name">
          {transfer.direction === "upload" ? "↑" : "↓"}{" "}
          {transfer.state === "preparing"
            ? `${transfer.name ? `${transfer.name} · ` : ""}正在扫描…`
            : transfer.name || "…"}
        </span>
        <span className="transfer-percent">
          {terminal ? stateLabel[transfer.state] : `${Math.floor(overall)}%`}
        </span>
      </div>
      <div
        className={`progress ${transfer.state}${transfer.state === "preparing" ? " indeterminate" : ""}`}
      >
        {transfer.state !== "preparing" && (
          <span style={{ width: `${overall}%` }} />
        )}
      </div>
      {transfer.state === "preparing" ? (
        <div className="transfer-meta">
          已发现 {transfer.discovered ?? 0} 项
        </div>
      ) : (
        <>
          <div className="transfer-meta">
            {(transfer.dirs?.total ?? 0) > (transfer.dirs?.completed ?? 0) && (
              <span>
                目录 {transfer.dirs?.completed ?? 0}/{transfer.dirs?.total ?? 0}
              </span>
            )}
            <span>
              已完成 {fileStats?.completed ?? 0}/{fileStats?.total ?? 0}
              {(fileStats?.skipped ?? 0) > 0
                ? `（跳过 ${fileStats?.skipped}）`
                : ""}
            </span>
            <span>
              {sizeText(bytes?.transferred ?? 0)} /{" "}
              {sizeText(bytes?.total ?? 0)}
            </span>
            {(transfer.active ?? 0) > 1 && (
              <span className="transfer-parallel">
                并行 {transfer.active} 个文件
              </span>
            )}
            <span>
              {transfer.state === "paused"
                ? "已暂停"
                : `${sizeText(transfer.speed ?? 0)}/s`}
            </span>
            {transfer.eta != null && (
              <span>剩余约 {durationText(transfer.eta)}</span>
            )}
          </div>
          {!terminal && (transfer.total ?? 0) > 0 && (
            <div className="transfer-current">
              当前文件{" "}
              {transfer.file && (
                <span className="transfer-file">{transfer.file} · </span>
              )}
              {Math.min(
                100,
                Math.round(
                  ((transfer.transferred ?? 0) / transfer.total!) * 100,
                ),
              )}
              % · {sizeText(transfer.transferred ?? 0)} /{" "}
              {sizeText(transfer.total!)}
            </div>
          )}
        </>
      )}
      {terminal && transfer.state === "error" && transfer.error && (
        <div className="transfer-error">{transfer.error}</div>
      )}
      {terminal && (
        <div className="transfer-final">
          <span className="transfer-summary">
            {[
              `${stateLabel[transfer.state]} ${fileStats?.completed ?? 0}/${fileStats?.total ?? 0}`,
              (fileStats?.skipped ?? 0) > 0 ? `跳过 ${fileStats?.skipped}` : "",
              (fileStats?.failed ?? 0) > 0 ? `失败 ${fileStats?.failed}` : "",
              `共 ${sizeText(bytes?.transferred ?? 0)}`,
              `耗时 ${transfer.elapsed ?? 0} 秒`,
              transfer.state === "cancelled" && remaining > 0
                ? `剩余 ${remaining} 项`
                : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          {onDismiss && (
            <button
              className="icon-button"
              title="清除传输记录"
              aria-label="清除传输记录"
              onClick={() => onDismiss(transfer.taskId)}
            >
              <X size={12} />
            </button>
          )}
        </div>
      )}
      {!terminal && (
        <div className="transfer-controls">
          {transfer.state !== "preparing" && (
            <button
              className="secondary small"
              onClick={() =>
                control(
                  transfer.state === "paused"
                    ? api.resumeTransfer
                    : api.pauseTransfer,
                )
              }
            >
              {transfer.state === "paused" ? (
                <>
                  <Play size={13} />
                  继续
                </>
              ) : (
                <>
                  <Pause size={13} />
                  暂停
                </>
              )}
            </button>
          )}
          <button
            className="secondary small danger"
            onClick={() => control(api.cancelTransfer)}
          >
            <Square size={13} />
            停止
          </button>
        </div>
      )}
    </div>
  );
}

const FileBrowser = memo(function FileBrowser({
  id,
  protocol,
  enabled,
  transfers,
  onDismissTransfer,
  collapsed = false,
  width = null,
  onWidthChange,
  onHide,
}: {
  id: string;
  protocol: string;
  enabled: boolean;
  transfers: Transfer[];
  onDismissTransfer?(taskId: string): void;
  collapsed?: boolean;
  width?: number | null;
  onWidthChange?(width: number | null): void;
  onHide?: () => void;
}) {
  const [directory, setDirectory] = useState("");
  const [pathInput, setPathInput] = useState("");
  const [files, setFiles] = useState<RemoteFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hidden, setHidden] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const selectionAnchor = useRef<string | null>(null);
  const dragDepth = useRef(0);
  const [edit, setEdit] = useState<{
    type: "mkdir" | "rename";
    name: string;
    source?: string;
  } | null>(null);
  const running = useRef(false);
  const directoryRef = useRef(directory);
  directoryRef.current = directory;
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
    setSelected(new Set());
    selectionAnchor.current = null;
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
  // 传输不占用面板：可以连续发起多个任务，其余文件操作保持可用
  function startTransfer(operation: () => Promise<unknown>) {
    setError("");
    void operation().catch((e) => setError(errorText(e)));
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
  const selectedFiles = visibleFiles.filter((file) => selected.has(file.name));
  const item = selectedFiles.length === 1 ? selectedFiles[0] : undefined;
  const selectableFiles = visibleFiles.filter((file) => !file.symlink);
  const allSelected =
    selectableFiles.length > 0 &&
    selectableFiles.every((file) => selected.has(file.name));
  const blocked = busy || !enabled || !directory;
  const canDrop = enabled && !blocked;
  function toggleFile(file: RemoteFile) {
    if (blocked || file.symlink) return;
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(file.name)) next.delete(file.name);
      else next.add(file.name);
      return next;
    });
    selectionAnchor.current = file.name;
  }
  function selectFile(
    file: RemoteFile,
    event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean },
  ) {
    if (blocked || file.symlink) return;
    if (event.shiftKey && selectionAnchor.current) {
      const from = visibleFiles.findIndex(
        (item) => item.name === selectionAnchor.current,
      );
      const to = visibleFiles.findIndex((item) => item.name === file.name);
      if (from >= 0 && to >= 0) {
        const [first, last] = from <= to ? [from, to] : [to, from];
        const range = visibleFiles
          .slice(first, last + 1)
          .filter((item) => !item.symlink)
          .map((item) => item.name);
        setSelected((previous) => new Set([...previous, ...range]));
        return;
      }
    }
    if (event.metaKey || event.ctrlKey) {
      toggleFile(file);
      return;
    }
    setSelected(new Set([file.name]));
    selectionAnchor.current = file.name;
  }
  function toggleAll() {
    if (blocked || !selectableFiles.length) return;
    setSelected(
      allSelected
        ? new Set()
        : new Set(selectableFiles.map((file) => file.name)),
    );
    selectionAnchor.current = null;
  }
  function toggleHidden(next: boolean) {
    setHidden(next);
    if (next) return;
    const visible = new Set(
      files.filter((file) => !file.name.startsWith(".")).map((f) => f.name),
    );
    setSelected(
      (previous) => new Set([...previous].filter((name) => visible.has(name))),
    );
  }
  function openFile(file: RemoteFile) {
    if (file.symlink) return;
    if (file.directory) {
      setEdit(null);
      void perform(() => refresh(join(directory, file.name)));
    } else void download(file);
  }
  function rowKeyDown(
    event: ReactKeyboardEvent<HTMLDivElement>,
    file: RemoteFile,
  ) {
    if (event.target !== event.currentTarget) return;
    if (event.key === " ") {
      event.preventDefault();
      toggleFile(file);
    } else if (event.key === "Enter") {
      event.preventDefault();
      openFile(file);
    }
  }
  const fileDrag = (event: ReactDragEvent<HTMLElement>) =>
    Array.from(event.dataTransfer.types).includes("Files");
  function dragEnter(event: ReactDragEvent<HTMLElement>) {
    if (!fileDrag(event)) return;
    event.preventDefault();
    dragDepth.current += 1;
    if (canDrop) setDropActive(true);
  }
  function dragOver(event: ReactDragEvent<HTMLElement>) {
    if (!fileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = canDrop ? "copy" : "none";
  }
  function dragLeave(event: ReactDragEvent<HTMLElement>) {
    if (!fileDrag(event)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDropActive(false);
  }
  function drop(event: ReactDragEvent<HTMLElement>) {
    if (!fileDrag(event)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDropActive(false);
    if (!canDrop) return;
    const files = [
      ...Array.from(event.dataTransfer.files),
      ...Array.from(event.dataTransfer.items)
        .map((item) => (item.kind === "file" ? item.getAsFile() : null))
        .filter((file): file is File => Boolean(file)),
    ];
    const sources = files
      .map((file) => {
        try {
          return api.getPathForFile(file);
        } catch {
          return "";
        }
      })
      .filter((value, index, all) => value && all.indexOf(value) === index);
    if (!sources.length) return;
    const target = directory;
    startTransfer(async () => {
      await api.uploadPaths(id, target, sources);
      if (directoryRef.current === target) await refresh(target);
    });
  }
  const download = (file: RemoteFile) =>
    startTransfer(() => api.download(id, join(directory, file.name)));
  function downloadSelected() {
    if (blocked) return;
    const filesToDownload = selectedFiles.filter((file) => !file.symlink);
    if (filesToDownload.length === 1) download(filesToDownload[0]);
    else if (filesToDownload.length > 1)
      startTransfer(() =>
        api.downloadPaths(
          id,
          filesToDownload.map((file) => join(directory, file.name)),
        ),
      );
  }
  const uploadAndRefresh = (mode: "files" | "folder") => {
    const target = directory;
    startTransfer(async () => {
      await api.upload(id, target, mode);
      if (directoryRef.current === target) await refresh(target);
    });
  };
  function beginResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !onWidthChange) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth =
      event.currentTarget.parentElement?.getBoundingClientRect().width ?? 340;
    let width = startWidth;
    const move = (e: PointerEvent) => {
      width = Math.min(560, Math.max(260, startWidth - (e.clientX - startX)));
      onWidthChange?.(width);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.body.classList.remove("resizing");
      localStorage.setItem(
        "trident.file-pane-width",
        String(Math.round(width)),
      );
    };
    document.body.classList.add("resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }
  function nudgeResize(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!onWidthChange) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const current =
      event.currentTarget.parentElement?.getBoundingClientRect().width ?? 340;
    const width = Math.min(
      560,
      Math.max(260, current + (event.key === "ArrowLeft" ? 16 : -16)),
    );
    onWidthChange(width);
    localStorage.setItem("trident.file-pane-width", String(Math.round(width)));
  }
  function resetWidth() {
    onWidthChange?.(null);
    localStorage.removeItem("trident.file-pane-width");
  }
  return (
    <aside
      className="file-pane"
      id={`files-${id}`}
      hidden={collapsed}
      style={onHide && width ? { width } : undefined}
      onDragEnter={dragEnter}
      onDragOver={dragOver}
      onDragLeave={dragLeave}
      onDrop={drop}
    >
      {onHide && (
        <div
          className="panel-resizer file-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整文件面板宽度"
          title="拖拽调整文件面板宽度，双击恢复默认"
          tabIndex={0}
          onPointerDown={beginResize}
          onKeyDown={nudgeResize}
          onDoubleClick={resetWidth}
        />
      )}
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
          onClick={() => uploadAndRefresh("files")}
        >
          <ArrowUpFromLine size={13} />
          上传文件
        </button>
        <button
          className="secondary small"
          disabled={blocked}
          title="上传文件夹（含子目录）"
          onClick={() => uploadAndRefresh("folder")}
        >
          <FolderUp size={13} />
          上传文件夹
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
          className="secondary small"
          disabled={blocked || !selectableFiles.length}
          title={allSelected ? "取消全选" : "全选可见条目"}
          onClick={toggleAll}
        >
          {allSelected ? "取消全选" : "全选"}
        </button>
        {selectedFiles.length > 0 && (
          <span className="file-selected-count">
            已选 {selectedFiles.length} 项
          </span>
        )}
        <button
          className="icon-button"
          disabled={blocked || !selectedFiles.length}
          title="下载选中的文件或文件夹"
          onClick={downloadSelected}
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
            onChange={(e) => toggleHidden(e.target.checked)}
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
            role="listbox"
            aria-multiselectable="true"
            aria-label="远程文件"
            className={virtual ? "virtual-file-space" : undefined}
            style={virtual ? { height: visibleFiles.length * 40 } : undefined}
          >
            {renderedFiles.map((file, index) => (
              <div
                key={file.name}
                role="option"
                tabIndex={blocked ? -1 : 0}
                style={virtual ? { top: (start + index) * 40 } : undefined}
                className={`file-row ${selected.has(file.name) ? "selected" : ""}`}
                aria-selected={selected.has(file.name)}
                aria-disabled={blocked || undefined}
                title={`${file.name}\n权限 ${file.permissions}${file.modified ? ` · ${new Date(file.modified * 1000).toLocaleString()}` : ""}${file.symlink ? "\n符号链接不支持打开" : ""}`}
                onClick={(event) => selectFile(file, event)}
                onDoubleClick={() => openFile(file)}
                onKeyDown={(event) => rowKeyDown(event, file)}
              >
                <span>
                  <input
                    type="checkbox"
                    className="file-check"
                    tabIndex={-1}
                    checked={selected.has(file.name)}
                    disabled={blocked || file.symlink}
                    aria-label={`选择 ${file.name}`}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                    onChange={() => toggleFile(file)}
                  />
                  {file.directory ? (
                    <Folder className="folder-icon file-type-icon" size={16} />
                  ) : (
                    <File className="file-type-icon" size={15} />
                  )}
                  <span>
                    {file.name}
                    {file.symlink ? " ↗" : ""}
                  </span>
                </span>
                <span>{file.directory ? "—" : sizeText(file.size)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="file-hint">
        {visibleFiles.length} 项 · 选中后操作，双击打开或下载
        {enabled ? " · 可拖入本地文件或文件夹" : ""}
      </div>
      <div className="transfer-panel">
        <div className="pane-title">
          <ArrowDownToLine size={14} />
          文件传输
          {transfers.length > 0 && (
            <span>
              {transfers.some((item) => !TERMINAL.has(item.state))
                ? `进行中 ${transfers.filter((item) => !TERMINAL.has(item.state)).length}`
                : `${transfers.length} 个任务`}
            </span>
          )}
        </div>
        {transfers.length ? (
          <div className="transfer-list">
            {[...transfers].reverse().map((item) => (
              <TransferItem
                key={item.taskId}
                id={id}
                transfer={item}
                onDismiss={onDismissTransfer}
                onError={setError}
              />
            ))}
          </div>
        ) : (
          <div className="transfer-empty">暂无传输任务</div>
        )}
      </div>
      {dropActive && (
        <div className="file-drop-mask" aria-hidden="true">
          <ArrowUpFromLine size={26} />
          <p>松开以上传到当前目录</p>
        </div>
      )}
    </aside>
  );
});
export default FileBrowser;
