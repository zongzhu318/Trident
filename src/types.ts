export type Profile = {
  id: string;
  name: string;
  protocol: "ssh" | "sftp" | "ftp" | "ftps";
  hasSavedCredentials?: boolean;
  host: string;
  port: number;
  username: string;
  auth: "password" | "key" | "agent";
  keyPath: string;
  group: string;
};
export type Credentials = { password?: string; passphrase?: string };
export type RemoteFile = {
  name: string;
  size: number;
  modified: number;
  directory: boolean;
  symlink: boolean;
  permissions: string;
};
export type Transfer = {
  name: string;
  direction: "upload" | "download";
  transferred?: number;
  total?: number;
  state: "running" | "done" | "error";
};
export type SessionEvent = {
  id: string;
  type: "data" | "ready" | "close" | "error" | "notice" | "transfer";
  data: any;
};
export type Session = {
  id: string;
  profile: Profile;
  credentials: Credentials;
};
declare global {
  interface Window {
    trident: {
      getTheme(): Promise<ThemeState>;
      setTheme(mode: ThemeMode): Promise<ThemeState>;
      onThemeChanged(callback: (theme: ThemeState) => void): () => void;
      acknowledge(id: string, bytes: number): void;
      onSessionEvent(
        id: string,
        callback: (event: SessionEvent) => void,
        includeData?: boolean,
      ): () => void;
      profiles(): Promise<Profile[]>;
      saveProfile(
        profile: Profile,
        credentials?: Credentials,
        remember?: boolean,
      ): Promise<Profile[]>;
      deleteProfile(id: string): Promise<Profile[]>;
      exportProfiles(
        includeCredentials: boolean,
        password?: string,
      ): Promise<boolean>;
      prepareImport(
        password?: string,
      ): Promise<{ token: string; profiles: Profile[] } | null>;
      commitImport(token: string): Promise<Profile[]>;
      chooseKey(): Promise<string | null>;
      connect(
        id: string,
        profile: Profile,
        credentials: Credentials,
      ): Promise<{ sftp: boolean }>;
      disconnect(id: string): Promise<void>;
      write(id: string, data: string): Promise<void>;
      resize(id: string, cols: number, rows: number): Promise<void>;
      list(
        id: string,
        path: string | null,
      ): Promise<{ path: string; files: RemoteFile[] }>;
      upload(id: string, path: string): Promise<string[]>;
      download(id: string, path: string): Promise<boolean>;
      mkdir(id: string, path: string, name: string): Promise<void>;
      rename(id: string, path: string, name: string): Promise<void>;
      remove(id: string, path: string): Promise<boolean>;
      onEvent(callback: (event: SessionEvent) => void): () => void;
    };
  }
}
import type { ThemeMode, ThemeState } from "./theme";
