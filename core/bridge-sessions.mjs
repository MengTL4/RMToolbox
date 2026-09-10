// Session ownership shared by the real RGSS/CDP adapters and the GUI host.
// WS/file adoption remains inside BridgeServer: its liveness and replacement
// rules must not be applied to RGSS or CDP connections.
import { EventEmitter } from "node:events";

const EXTERNAL_KINDS = ["rgss", "tauri"];

export class SessionRegistry extends EventEmitter {
  constructor() {
    super();
    this.entries = new Map(EXTERNAL_KINDS.map((kind) => [kind, new Map()]));
  }

  get(kind, gameKey) {
    const entry = this.entries.get(kind).get(gameKey);
    return entry ? entry.session : null;
  }

  list(kind) {
    return [...this.entries.get(kind).values()].map(({ session }) =>
      session.describe()
    );
  }

  register(kind, session) {
    const entries = this.entries.get(kind);
    if (!entries) throw new Error(`unknown session kind: ${kind}`);
    const gameKey = session.gameKey;
    const previous = entries.get(gameKey);
    if (previous && previous.session === session) return session;
    if (previous) {
      // A new adapter for the same gameKey takes ownership. Unwire first so
      // the old close event cannot remove the replacement, then release its
      // timers/socket and reject its pending commands.
      previous.unwire();
      try {
        previous.session.close?.();
      } catch (_) {}
    }
    const onHello = () => this.emit("changed", gameKey);
    const onState = (state) => this.emit("state", gameKey, state);
    const onClose = () => {
      if (entries.get(gameKey) !== entry) return;
      entries.delete(gameKey);
      entry.unwire();
      this.emit("session-closed", gameKey);
    };
    const entry = {
      session,
      unwire() {
        session.removeListener("hello", onHello);
        session.removeListener("state", onState);
        session.removeListener("close", onClose);
      }
    };
    entries.set(gameKey, entry);
    session.on("hello", onHello);
    session.on("state", onState);
    session.on("close", onClose);
    this.emit("session-open", gameKey);
    return session;
  }

  find(gameKey) {
    // Preserve the host's existing command precedence: RGSS, CDP, then WS.
    for (const kind of EXTERNAL_KINDS) {
      const session = this.get(kind, gameKey);
      if (session) return session;
    }
    return null;
  }

  describe() {
    return EXTERNAL_KINDS.flatMap((kind) => this.list(kind));
  }
}

export const externalSessions = new SessionRegistry();

export class BridgeSessions extends EventEmitter {
  constructor({ server, registry = externalSessions }) {
    super();
    this.server = server;
    this.registry = registry;
    this.subscriptions = [];
    for (const source of [server, registry]) {
      for (const event of ["session-open", "session-closed", "state"]) {
        const forward = (...args) => this.emit(event, ...args);
        source.on(event, forward);
        this.subscriptions.push(() => source.removeListener(event, forward));
      }
    }
    const changed = (gameKey) => this.emit("changed", gameKey);
    registry.on("changed", changed);
    this.subscriptions.push(() => registry.removeListener("changed", changed));
  }

  list() {
    const sessions = this.server.listSessions().map((session) => ({
      gameKey: session.gameKey,
      alive: session.alive,
      bridgeVersion: session.bridgeVersion,
      engine: session.engine,
      connectedAt: session.connectedAt,
      state: session.state
    }));
    return sessions.concat(this.registry.describe());
  }

  send(gameKey, type, args = {}) {
    const session = this.registry.find(gameKey);
    return session
      ? session.send(type, args || {})
      : this.server.sendCommand(gameKey, type, args || {});
  }

  dispose() {
    // Unsubscribe only. The caller controls server/session lifetime; disposing
    // a view must never terminate a running game or another observer's session.
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
  }
}
