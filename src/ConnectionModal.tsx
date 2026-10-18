import { useState, type FormEvent } from "react";
import { Check, Folder, LoaderCircle, ShieldCheck, X, Zap } from "lucide-react";
import type { Profile, Credentials } from "./types";
import { errorText } from "./errors";
const api = window.trident;
export const protocolLabel = (p: Profile) =>
  p.protocol === "ssh" ? "SSH / SFTP" : p.protocol.toUpperCase();
export default function ConnectionModal({
  initial,
  connecting,
  onClose,
  onSave,
  onConnect,
}: {
  initial?: Profile;
  connecting: boolean;
  onClose(): void;
  onSave(p: Profile, c: Credentials, remember: boolean): Promise<void>;
  onConnect(
    p: Profile,
    c: Credentials,
    save: boolean,
    remember: boolean,
  ): Promise<void>;
}) {
  const [profile, setProfile] = useState<Profile>(
    initial ?? {
      id: crypto.randomUUID(),
      name: "",
      protocol: "ssh",
      host: "",
      port: 22,
      username: "root",
      auth: "password",
      keyPath: "",
      group: "",
    },
  );
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [save, setSave] = useState(true);
  const [remember, setRemember] = useState(
    Boolean(initial?.hasSavedCredentials),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isFTP = profile.protocol === "ftp" || profile.protocol === "ftps";
  const sameEndpoint =
    !!initial &&
    ["protocol", "host", "port", "username", "auth", "keyPath"].every(
      (k) => initial[k as keyof Profile] === profile[k as keyof Profile],
    );
  const canReuse = Boolean(
    initial?.hasSavedCredentials && sameEndpoint && (!save || remember),
  );
  function update<K extends keyof Profile>(key: K, value: Profile[K]) {
    setProfile((p) => ({ ...p, [key]: value }));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const value = {
        ...profile,
        host: profile.host.trim(),
        username: profile.username.trim(),
        name: profile.name.trim() || profile.host.trim(),
      };
      const credentials: Credentials =
        profile.auth === "password"
          ? password || !canReuse
            ? { password }
            : {}
          : profile.auth === "key"
            ? passphrase || !canReuse
              ? { passphrase }
              : {}
            : {};
      if (connecting) await onConnect(value, credentials, save, remember);
      else await onSave(value, remember ? credentials : {}, remember);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onClose()}>
      <section className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-heading">
          <div>
            <div className="eyebrow">NEW DESTINATION</div>
            <h2>
              {connecting ? "连接服务器" : initial ? "编辑连接" : "新建连接"}
            </h2>
          </div>
          <button className="icon-button" disabled={busy} onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <form onSubmit={(e) => void submit(e)}>
          <label>
            连接名称
            <input
              autoFocus
              value={profile.name}
              onChange={(e) => update("name", e.target.value)}
              placeholder="例如：开发服务器"
              maxLength={100}
            />
          </label>
          <label>
            连接协议
            <select
              value={profile.protocol}
              onChange={(e) => {
                const protocol = e.target.value as Profile["protocol"];
                const ftp = protocol === "ftp" || protocol === "ftps";
                setProfile((p) => ({
                  ...p,
                  protocol,
                  port: ftp ? 21 : 22,
                  auth: ftp ? "password" : p.auth,
                }));
                setPassword("");
                setPassphrase("");
              }}
            >
              <option value="ssh">SSH 终端 + SFTP</option>
              <option value="sftp">SFTP 文件连接</option>
              <option value="ftp">FTP 文件连接</option>
              <option value="ftps">FTPS 文件连接（显式 TLS）</option>
            </select>
          </label>
          {profile.protocol === "ftp" && (
            <div className="inline-note">
              FTP 以明文传输用户名、密码和文件。需要加密传输时请选择 FTPS 或
              SFTP。
            </div>
          )}
          <div className="form-row">
            <label className="grow">
              主机地址
              <input
                required
                value={profile.host}
                onChange={(e) => update("host", e.target.value)}
                placeholder="192.168.1.10 或 server.example.com"
              />
            </label>
            <label className="port">
              端口
              <input
                required
                type="number"
                min="1"
                max="65535"
                value={profile.port}
                onChange={(e) => update("port", Number(e.target.value))}
              />
            </label>
          </div>
          <div className="form-row">
            <label className="grow">
              用户名
              <input
                required
                value={profile.username}
                onChange={(e) => update("username", e.target.value)}
                autoComplete="off"
              />
            </label>
            <label className="grow">
              分组（可选）
              <input
                value={profile.group}
                onChange={(e) => update("group", e.target.value)}
                placeholder="例如：开发环境"
              />
            </label>
          </div>
          {!isFTP && (
            <label>
              认证方式
              <div className="segmented">
                {(["password", "key", "agent"] as const).map((auth) => (
                  <button
                    type="button"
                    key={auth}
                    className={profile.auth === auth ? "selected" : ""}
                    onClick={() => {
                      update("auth", auth);
                      setPassword("");
                      setPassphrase("");
                    }}
                  >
                    {auth === "password"
                      ? "密码"
                      : auth === "key"
                        ? "私钥"
                        : "SSH Agent"}
                  </button>
                ))}
              </div>
            </label>
          )}
          {profile.auth === "password" && (
            <label>
              密码
              <input
                required={!isFTP && !canReuse && (connecting || remember)}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                placeholder={
                  canReuse ? "已保存，留空继续使用；输入可替换" : "输入连接密码"
                }
              />
            </label>
          )}
          {profile.auth === "key" && (
            <>
              <label>
                私钥文件
                <div className="file-input">
                  <input
                    required
                    readOnly
                    value={profile.keyPath}
                    placeholder="选择本机的 SSH 私钥"
                  />
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      void api
                        .chooseKey()
                        .then((p) => p && update("keyPath", p))
                        .catch((e) => setError(errorText(e)))
                    }
                  >
                    <Folder size={16} />
                    选择
                  </button>
                </div>
              </label>
              <label>
                私钥口令（可选）
                <input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  autoComplete="new-password"
                  placeholder={
                    canReuse
                      ? "已保存，留空继续使用；取消保存可清除"
                      : "私钥没有口令时留空"
                  }
                />
              </label>
            </>
          )}
          {profile.auth === "agent" ? (
            <div className="inline-note">
              使用 SSH_AUTH_SOCK 指向的 SSH Agent，请先通过 ssh-add 添加密钥。
            </div>
          ) : (
            <>
              <label className="checkbox remember-option">
                <input
                  type="checkbox"
                  disabled={connecting && !save}
                  checked={remember && save}
                  onChange={(e) => setRemember(e.target.checked)}
                />
                在本机保存{profile.auth === "key" ? "私钥口令" : "密码"}
              </label>
              <div className="inline-note">
                <ShieldCheck size={15} />
                凭据加密保存到本机磁盘；取消勾选并保存将清除已存凭据。
              </div>
            </>
          )}
          {error && (
            <div className="error-message" role="alert">
              {error}
            </div>
          )}
          <div className="modal-footer">
            {connecting ? (
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={save}
                  onChange={(e) => setSave(e.target.checked)}
                />
                保存连接配置
              </label>
            ) : (
              <span />
            )}
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={onClose}
            >
              取消
            </button>
            <button className="primary" disabled={busy}>
              {busy ? (
                <LoaderCircle size={16} className="spin" />
              ) : connecting ? (
                <Zap size={16} />
              ) : (
                <Check size={16} />
              )}
              {connecting ? "连接" : "保存连接"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
