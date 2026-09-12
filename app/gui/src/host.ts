// The only native boundary in the bundled frontend. Keep Node's require out of
// Vite's module resolver: NW resolves it relative to the page, not this file.
export interface GameSummary {
  gameKey: string;
  title: string;
  root: string;
  engine: { id: string };
  paths: { exe?: string | null };
  protection: { level: number };
  /** 能力声明（ADR 0002）：引擎适配器声明的本游戏支持的修改能力。 */
  capabilities?: string[];
}

export interface SessionSummary {
  gameKey: string;
  alive: boolean;
  connectedAt?: number;
  [field: string]: unknown;
}

export interface HostHandlers {
  onLog?: (line: string) => void;
  onSessions?: (sessions: SessionSummary[]) => void;
  onState?: (gameKey: string, state: Record<string, unknown>) => void;
}

export interface UpdateInfo {
  /** false for every failure path: offline, timeout, rate limit, no tag. */
  ok: boolean;
  current: string | null;
  latest?: string | null;
  url: string;
  notes?: string | null;
  /** only meaningful when ok is true. */
  updateAvailable?: boolean;
  /** short machine-readable cause when ok is false. */
  reason?: string;
  checkedAt: number;
}

export interface GuiHost {
  init(projectRoot?: string): Promise<unknown>;
  describe(): {
    projectRoot?: string | null;
    port: number;
    about: Record<string, unknown>;
  };
  checkForUpdate(): Promise<UpdateInfo>;
  setHandlers(handlers: HostHandlers): void;
  getLog(): string;
  log(message: string): void;
  listLibrary(): GameSummary[];
  listSessions(): SessionSummary[];
  addManualRoot(root: string): unknown;
  removeManualRoot(root: string): unknown;
  plan(root: string, strategy?: string): { [field: string]: unknown };
  /** 策略覆盖记录：手动路线选择按游戏持久化；选 auto 即清除。 */
  setRouteChoice(
    root: string,
    gameKey: string,
    route: string
  ): { ok: boolean; route?: string; reason?: string };
  clearRouteChoice(gameKey: string): { ok: boolean };
  listRouteChoices(): Record<string, string>;
  launch(
    root: string,
    strategy?: string
  ): Promise<{ gameKey: string; pid?: number; [field: string]: unknown }>;
  attach(
    root: string
  ): Promise<{ gameKey: string; pid?: number; [field: string]: unknown }>;
  stop(pid: number): unknown;
  // Game-engine commands are deliberately dynamic; callers must interpret the
  // returned payload for the selected command rather than assume one shape.
  send(
    gameKey: string,
    type: string,
    args: Record<string, unknown>
  ): Promise<unknown>;
  gameIcon(root: string): string | null;
  iconSetImage(root: string): string | null;
  iconFileImage(root: string, name: string): string | null;
  readBridgeLog(gameKey: string): string;
  openPath(target: string): unknown;
  /** Opens an http(s) URL in the user's browser; rejects any other scheme. */
  openExternal(url: string): unknown;
  saveDirOf(gameKey: string): string | null;
  backupSaves(gameKey: string): Promise<unknown>;
  listBackups(gameKey: string): unknown[];
  restoreBackup(gameKey: string, name: string): Promise<unknown>;
  deleteBackup(gameKey: string, name: string): unknown;
  deleteSaveFile(gameKey: string, name: string): Promise<unknown>;
  saveLocks(gameKey: string, locks: Record<string, unknown>): unknown;
  loadLocks(gameKey: string): Record<string, unknown> | null;
  hasLocks(gameKey: string): boolean;
}

export type HostLoader = (id: string) => unknown;
declare global {
  interface Window {
    require?: HostLoader;
  }
}

export function getGuiHost(
  loader: HostLoader | undefined = window.require
): GuiHost {
  if (typeof loader !== "function")
    throw new Error("原生宿主不可用，请通过 RMToolbox.exe 启动工具箱");
  const candidate = loader("./host.cjs");
  if (!candidate || typeof candidate !== "object")
    throw new Error("工具箱宿主未正确加载");
  for (const method of [
    "init",
    "describe",
    "setHandlers",
    "listLibrary",
    "listSessions",
    "send",
    "plan",
    "launch",
    "attach"
  ]) {
    if (typeof Reflect.get(candidate, method) !== "function")
      throw new Error("工具箱宿主缺少接口：" + method);
  }
  return candidate as GuiHost;
}
