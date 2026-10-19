import { useState } from "react";
import { Download, LoaderCircle, Upload, X } from "lucide-react";
import type { Profile } from "./types";
import { protocolLabel } from "./ConnectionModal";
const api = window.trident;
export default function BackupModal({
  mode,
  onClose,
  onImported,
}: {
  mode: "import" | "export";
  onClose(): void;
  onImported(profiles: Profile[]): void;
}) {
  const [include, setInclude] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [preview, setPreview] = useState<{
    token: string;
    profiles: Profile[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  async function submit() {
    setBusy(true);
    setError("");
    try {
      if (mode === "export") {
        if (include && password !== confirm)
          throw new Error("两次输入的备份密码不一致");
        if (await api.exportProfiles(include, password)) {
          setDone(true);
          setPassword("");
          setConfirm("");
        }
      } else if (preview) {
        onImported(await api.commitImport(preview.token));
        onClose();
      } else {
        setPreview(await api.prepareImport(password));
        setPassword("");
      }
    } catch (e) {
      setError(
        String(e instanceof Error ? e.message : e).replace(
          /^Error invoking remote method '[^']+': Error: /,
          "",
        ),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onClose()}>
      <section className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-heading">
          <h2>{mode === "import" ? "导入连接" : "导出连接"}</h2>
          <button className="icon-button" disabled={busy} onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {done ? (
            <p className="inline-note">
              连接备份已导出，请妥善保管文件和备份密码。
            </p>
          ) : preview ? (
            <>
              <p className="inline-note">
                即将新增 {preview.profiles.length} 个连接，其中{" "}
                {preview.profiles.filter((p) => p.hasSavedCredentials).length}{" "}
                个包含凭据。不会覆盖现有连接。
              </p>
              <div className="import-preview">
                {preview.profiles.map((p) => (
                  <div key={p.id}>
                    <strong>{p.name}</strong>
                    <span>
                      {protocolLabel(p)} · {p.username}@{p.host}:{p.port}
                    </span>
                    <small>
                      {p.hasSavedCredentials ? "包含已保存凭据" : "不含凭据"}
                    </small>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              {mode === "export" ? (
                <>
                  <label className="checkbox remember-option">
                    <input
                      type="checkbox"
                      checked={include}
                      onChange={(e) => setInclude(e.target.checked)}
                    />
                    包含已保存的密码和私钥口令
                  </label>
                  <p className="inline-note">
                    未勾选时仅导出连接配置。包含凭据时，整个备份使用独立的备份密码加密，支持在其他
                    设备导入。
                  </p>
                </>
              ) : (
                <p className="inline-note">
                  选择 Trident JSON
                  备份。加密备份需先输入备份密码；普通连接配置留空。读取后会显示导入预览。
                </p>
              )}
              {(include || mode === "import") && (
                <label>
                  备份密码{mode === "import" ? "（加密文件必填）" : ""}
                  <input
                    type="password"
                    required={mode === "export"}
                    minLength={password ? 8 : undefined}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                    placeholder="至少 8 个字符"
                  />
                </label>
              )}
              {include && mode === "export" && (
                <label>
                  确认备份密码
                  <input
                    required
                    type="password"
                    minLength={8}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    autoComplete="new-password"
                  />
                </label>
              )}
              <p className="inline-note">
                备份不包含私钥文件内容和主机信任记录。换电脑后需要重新选择私钥并核验主机指纹。
              </p>
            </>
          )}
          {error && (
            <div className="error-message" role="alert">
              {error}
            </div>
          )}
          <div className="modal-footer">
            <span />
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={onClose}
            >
              {done ? "完成" : "取消"}
            </button>
            {!done && (
              <button
                className="primary"
                disabled={
                  busy || (preview !== null && !preview.profiles.length)
                }
              >
                {busy ? (
                  <LoaderCircle className="spin" size={16} />
                ) : mode === "import" ? (
                  <Upload size={16} />
                ) : (
                  <Download size={16} />
                )}
                {mode === "export"
                  ? "选择位置并导出"
                  : preview
                    ? "确认导入"
                    : "选择文件并预览"}
              </button>
            )}
          </div>
        </form>
      </section>
    </div>
  );
}
