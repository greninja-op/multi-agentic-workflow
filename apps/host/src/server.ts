/**
 * The CoordinationServer — the WSS/TLS transport wiring around the
 * {@link CoordinationAuthority} (Req 1.1, 6.1–6.3; design §2.2, §4.1).
 *
 * Responsibilities:
 *   - Listen for agent connections at the configured `Host_URL` over WSS/TLS
 *     within the start deadline (Req 1.1, 6.1); no hardcoded address.
 *   - Drive the Ed25519 challenge-response handshake per connection (Req 5.3).
 *   - Route post-auth Signed_Events through the authority's ingest pipeline and
 *     broadcast the resulting `coordination.update`s only to connections
 *     authorized for the same session (Req 25, 10.2).
 *   - Serve `sync.request` and `heartbeat.ping`, and expose loopback-safe
 *     health/diagnostics HTTP endpoints reporting operational + connectivity
 *     metadata only (Req 27).
 *   - Run a periodic stale lock/intent expiry sweep (Req 26).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server as HttpsServer } from "node:https";

import {
  AuthMessageType,
  BroadcastMessageType,
  DependencyMessageType,
  ErrorMessageType,
  DiffMessageType,
  EventMessageType,
  HeartbeatMessageType,
  MessagingMessageType,
  TaskMessageType,
  PresenceLivenessMessageType,
  LunaMessageType,
  SyncMessageType,
  type AuthHelloPayload,
  type AuthResponsePayload,
  type CoordinationUpdate,
  type MessageDto,
  type NotificationDto,
  type SessionId,
  type SyncRequestPayload,
  type TaskDto,
} from "@cfls/protocol";
import { sessionKey } from "@cfls/core-state";
import { WebSocketServer, type WebSocket } from "ws";

import {
  CoordinationAuthority,
  type AuthPrincipal,
  type AuthorityOptions,
  type DiffBroadcast,
} from "./authority";
import type { HostConfig } from "./config";
import { buildDashboardState, renderDashboardHtml } from "./dashboard";
import { resolveTls } from "./tls";

/** Per-connection state tracked by the server. */
interface Connection {
  socket: WebSocket;
  /** Set once the handshake completes. */
  principal: AuthPrincipal | undefined;
  /** The `auth.hello` seen while awaiting the challenge response. */
  pendingHello: AuthHelloPayload | undefined;
  /** The challenge nonce issued to this connection. */
  pendingNonce: string | undefined;
}

/** Operational health (Req 27.1) — metadata only. */
export interface HealthStatus {
  status: "ok";
  uptimeSeconds: number;
  sessions: number;
  connections: number;
}

/** Diagnostics/peer-connectivity report (Req 27.2–27.5) — metadata only. */
export interface DiagnosticsReport {
  status: "ok";
  uptimeSeconds: number;
  sessions: Array<{
    repoId: string;
    teamId: string;
    branch: string;
    connectedDevices: string[];
    highestRevision: number;
  }>;
}

/** Options for the {@link CoordinationServer}. */
export interface ServerOptions extends AuthorityOptions {
  /** Interval for the periodic expiry sweep (Req 26). Default 15s; 0 disables. */
  expirySweepIntervalMs?: number;
}

const DEFAULT_SWEEP_INTERVAL_MS = 15_000;

/**
 * The network-facing CoordinationHost server. Construct with a resolved
 * {@link HostConfig}; call {@link start} to listen and {@link stop} to shut down.
 */
export class CoordinationServer {
  readonly authority: CoordinationAuthority;

  private https: HttpsServer | undefined;
  private wss: WebSocketServer | undefined;
  private readonly connections = new Set<Connection>();
  /** `session_key` → connections authorized for that session (Req 25). */
  private readonly bySession = new Map<string, Set<Connection>>();
  private sweepTimer: NodeJS.Timeout | undefined;
  private startedAt = 0;

  constructor(
    private readonly config: HostConfig,
    authority: CoordinationAuthority,
    private readonly options: ServerOptions = {},
  ) {
    this.authority = authority;
  }

  /**
   * Start listening at the configured `Host_URL` over WSS/TLS (Req 1.1, 6.1).
   * Resolves once the socket is accepting connections; rejects if that does not
   * happen within {@link HostConfig.startTimeoutMs} (Req 1.1) or on a bind error.
   */
  async start(): Promise<{ port: number }> {
    const tls = await resolveTls(this.config.tls);
    if (tls.selfSigned) {
      // Development-only: clients must skip cert validation. Never for production.
      console.warn(
        "[cfls-host] WARNING: using a development self-signed TLS certificate. " +
          "Do not use in production (Req 6.1).",
      );
    }

    const https = createServer({ cert: tls.cert, key: tls.key }, (req, res) =>
      this.handleHttp(req, res),
    );
    const wss = new WebSocketServer({ server: https });
    wss.on("connection", (socket) => this.handleConnection(socket));
    this.https = https;
    this.wss = wss;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `Host did not start listening within ${this.config.startTimeoutMs}ms (Req 1.1).`,
          ),
        );
      }, this.config.startTimeoutMs);

      https.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      https.listen(this.config.port, this.config.host, () => {
        clearTimeout(timeout);
        this.startedAt = Date.now();
        this.startSweep();
        const address = https.address();
        const port =
          typeof address === "object" && address !== null
            ? address.port
            : this.config.port;
        resolve({ port });
      });
    });
  }

  /** Stop the server, closing all connections and the listener. */
  async stop(): Promise<void> {
    if (this.sweepTimer !== undefined) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    for (const conn of this.connections) {
      conn.socket.close();
    }
    this.connections.clear();
    this.bySession.clear();
    await new Promise<void>((resolve) => {
      this.wss?.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      if (this.https === undefined) {
        resolve();
        return;
      }
      this.https.close(() => resolve());
    });
  }

  /** Current operational health (Req 27.1). */
  health(): HealthStatus {
    return {
      status: "ok",
      uptimeSeconds: this.uptimeSeconds(),
      sessions: this.authority.sessions().length,
      connections: this.connections.size,
    };
  }

  /** Current diagnostics / peer-connectivity report (Req 27.2–27.5). */
  diagnostics(): DiagnosticsReport {
    return {
      status: "ok",
      uptimeSeconds: this.uptimeSeconds(),
      sessions: this.authority.sessions().map((session) => ({
        repoId: session.repoId,
        teamId: session.teamId,
        branch: session.branch,
        connectedDevices: this.connectedDevices(session),
        highestRevision: this.authority.snapshot(session).highestRevision,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // HTTP (health / diagnostics / dashboard)
  // -------------------------------------------------------------------------

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? "/";
    if (req.method === "GET" && url.startsWith("/health")) {
      this.sendJson(res, 200, this.health());
      return;
    }
    if (req.method === "GET" && url.startsWith("/diagnostics")) {
      this.sendJson(res, 200, this.diagnostics());
      return;
    }
    if (req.method === "GET" && this.config.dashboard) {
      // Keep the existing health/diagnostics prefix behavior unchanged, while
      // requiring exact dashboard paths so unrelated URLs never serve the page.
      const pathname = url.split("?", 1)[0] ?? "/";
      if (pathname === "/" || pathname === "/dashboard") {
        this.sendHtml(res, 200, renderDashboardHtml());
        return;
      }
      if (pathname === "/api/coordination") {
        this.sendJson(res, 200, this.dashboard());
        return;
      }
    }
    this.sendJson(res, 404, { error: "not_found" });
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(json);
  }

  private sendHtml(res: ServerResponse, status: number, html: string): void {
    // The dashboard is a standalone client shell. Never let a browser reuse an
    // earlier shell after the Host has been rebuilt; its live API polling alone
    // cannot update old markup, styling, or branding.
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(html);
  }

  /** Build the browser's deliberately narrow, metadata-only state projection. */
  private dashboard() {
    return buildDashboardState({
      uptimeSeconds: this.uptimeSeconds(),
      generatedAt: new Date().toISOString(),
      sessions: this.authority.sessions().map((session) => ({
        session,
        snapshot: this.authority.snapshot(session),
        connectedDevices: this.connectedDevices(session),
      })),
    });
  }

  // -------------------------------------------------------------------------
  // WebSocket connection lifecycle
  // -------------------------------------------------------------------------

  private handleConnection(socket: WebSocket): void {
    const conn: Connection = {
      socket,
      principal: undefined,
      pendingHello: undefined,
      pendingNonce: undefined,
    };
    this.connections.add(conn);
    socket.on("message", (data) => this.handleMessage(conn, data.toString()));
    socket.on("close", () => this.handleClose(conn));
    socket.on("error", () => this.handleClose(conn));
  }

  private handleClose(conn: Connection): void {
    // `error` and `close` can both arrive for one socket. Only the first path
    // mutates the roster and notifies peers.
    if (!this.connections.delete(conn) || conn.principal === undefined) {
      return;
    }
    const session = conn.principal.session;
    const key = sessionKey(session);
    const set = this.bySession.get(key);
    set?.delete(conn);
    if (set?.size === 0) {
      this.bySession.delete(key);
    }
    this.broadcastParticipants(session);
    // A disconnect changes the live roster; refresh + broadcast liveness (Req 3.1).
    this.updateLiveness(session);
  }

  private handleMessage(conn: Connection, raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      this.sendError(conn, "FORMAT_ERROR", "Message is not valid JSON.");
      return;
    }

    if (conn.principal === undefined) {
      this.handleAuthMessage(conn, message);
      return;
    }

    this.handleAuthenticatedMessage(conn, conn.principal, message);
  }

  private handleAuthMessage(conn: Connection, message: unknown): void {
    if (!isRecord(message) || typeof message.type !== "string") {
      this.sendError(conn, "FORMAT_ERROR", "Expected an auth message.");
      return;
    }

    if (message.type === AuthMessageType.HELLO) {
      const hello = message.payload as AuthHelloPayload;
      const challenge = this.authority.prepareChallenge(hello);
      if (!challenge.ok) {
        this.sendAuthError(conn, challenge.code, challenge.message);
        return;
      }
      conn.pendingHello = hello;
      conn.pendingNonce = challenge.nonce;
      this.send(conn, {
        type: AuthMessageType.CHALLENGE,
        payload: { nonce: challenge.nonce },
      });
      return;
    }

    if (message.type === AuthMessageType.RESPONSE) {
      const response = message.payload as AuthResponsePayload;
      if (conn.pendingHello === undefined || conn.pendingNonce === undefined) {
        this.sendAuthError(
          conn,
          "AUTH_INVALID_DEVICE",
          "No challenge in progress.",
        );
        return;
      }
      const result = this.authority.finalizeHandshake(
        conn.pendingHello,
        conn.pendingNonce,
        response.signature,
      );
      if (!result.ok) {
        this.sendAuthError(conn, result.code, result.message);
        return;
      }
      conn.principal = result.principal;
      conn.pendingHello = undefined;
      conn.pendingNonce = undefined;
      this.subscribe(conn, result.principal.session);
      // A freshly authenticated member is active; refresh + broadcast liveness.
      this.authority.recordMemberActivity(
        result.principal.session,
        result.principal.memberId,
      );
      // Authentication itself proves the device is live. Record it immediately
      // so work created before the first periodic agent heartbeat still has an
      // expiry baseline if the process exits abruptly.
      this.authority.recordHeartbeat(
        result.principal.session,
        result.principal.deviceId,
      );
      this.send(conn, {
        type: AuthMessageType.OK,
        payload: { highestRevision: result.highestRevision },
      });
      // Connection membership is independent of path activity. Broadcast the
      // current roster after auth so idle teammates are visible to MCP clients
      // and the editor panel, and peers see the new live member immediately.
      this.broadcastParticipants(result.principal.session);
      // Refresh + broadcast liveness now that a new member is connected (Req 3.1).
      this.updateLiveness(result.principal.session);
      // Hand the freshly-connected agent the current metadata-only
      // Dependency_Graph so it can compute indirect risk immediately, sharing
      // one graph across the whole session (Req 19, 20).
      this.sendDependencyGraph(conn, result.principal.session);
      return;
    }

    this.sendAuthError(
      conn,
      "FORMAT_ERROR",
      `Unexpected auth message "${message.type}".`,
    );
  }

  private handleAuthenticatedMessage(
    conn: Connection,
    principal: AuthPrincipal,
    message: unknown,
  ): void {
    // Post-auth messages are Signed_Events: { envelope, signature }.
    const refEventId = eventIdFromMessage(message);
    if (!isRecord(message) || !isRecord(message.envelope)) {
      this.sendError(
        conn,
        "FORMAT_ERROR",
        "Expected a Signed_Event.",
        refEventId,
      );
      return;
    }
    const envelope = message.envelope as {
      type?: unknown;
      eventId?: unknown;
      session?: SessionId;
      payload?: unknown;
    };
    const type = envelope.type;
    const eventId =
      typeof envelope.eventId === "string" ? envelope.eventId : undefined;

    // Heartbeat and sync are serviced on the authenticated connection (Req 9, 26).
    if (type === HeartbeatMessageType.PING) {
      this.authority.recordHeartbeat(principal.session, principal.deviceId);
      // A heartbeat is member activity for liveness (Req 3.1).
      this.authority.recordMemberActivity(
        principal.session,
        principal.memberId,
      );
      this.updateLiveness(principal.session);
      this.send(conn, {
        type: HeartbeatMessageType.ACK,
        payload: { serverTime: new Date().toISOString() },
      });
      return;
    }

    if (type === SyncMessageType.REQUEST) {
      const payload = envelope.payload as SyncRequestPayload;
      const response = this.authority.syncFrom(
        principal.session,
        payload.fromRevision,
      );
      if (response.kind === "events") {
        this.send(conn, {
          type: SyncMessageType.EVENTS,
          payload: { events: response.events },
        });
        // Incremental sync only carries CoordinationUpdates; deliver any V2
        // messages sent to this member while it was offline over the parallel
        // message channel (Req 1.4, X.2). A snapshot response already embeds
        // messages, so this is only needed on the incremental path.
        for (const message of this.authority.messagesSince(
          principal.session,
          payload.fromRevision,
          principal.memberId,
        )) {
          this.send(conn, {
            type: MessagingMessageType.UPDATE,
            payload: { op: "added", message },
          });
        }
        // Likewise deliver task changes made while this member was offline
        // (Phase 2; Req 2.1, X.2).
        for (const task of this.authority.tasksSince(
          principal.session,
          payload.fromRevision,
        )) {
          this.send(conn, {
            type: TaskMessageType.UPDATE,
            payload: { op: "updated", task },
          });
        }
        // Deliver notifications raised while this member was offline (Req 3.2, X.2).
        for (const notification of this.authority.notificationsSince(
          principal.session,
          payload.fromRevision,
          principal.memberId,
        )) {
          this.send(conn, {
            type: PresenceLivenessMessageType.NOTIFY_PUSH,
            payload: notification,
          });
        }
        // Deliver Live_Diffs shared while this member was offline (Phase 5;
        // Req 5.1–5.3, X.2). Empty unless the team enabled the opt-in.
        for (const diff of this.authority.diffsSince(
          principal.session,
          payload.fromRevision,
        )) {
          this.send(conn, {
            type: DiffMessageType.UPDATE,
            payload: { op: "shared", diff },
          });
        }
      } else {
        this.send(conn, {
          type: SyncMessageType.SNAPSHOT,
          payload: { state: response.snapshot },
        });
      }
      return;
    }

    // Everything else is a state-mutating coordination event.
    const outcome = this.authority.ingest(principal, message as never);
    if (!outcome.accepted) {
      this.sendError(
        conn,
        outcome.error ?? "FORMAT_ERROR",
        outcome.reason ?? "Event rejected.",
        eventId,
      );
      return;
    }
    for (const update of outcome.broadcasts) {
      this.broadcast(principal.session, update);
    }
    // Deliver V2 message updates to their audience only (Phase 1; Req 1.1).
    for (const messageUpdate of outcome.messageUpdates ?? []) {
      this.deliverMessage(principal.session, messageUpdate);
    }
    // Broadcast V2 task updates to the whole session (Phase 2; Req 2.1).
    for (const taskUpdate of outcome.taskUpdates ?? []) {
      this.deliverTask(principal.session, taskUpdate);
    }
    // Deliver V2 notifications to their target member (Phase 3; Req 3.2, 3.3).
    for (const notification of outcome.notifications ?? []) {
      this.deliverNotification(principal.session, notification);
    }
    // Broadcast V2 live-diff updates to the whole trusted session (Phase 5;
    // Req 5.1–5.3) — shared with authorized members only.
    for (const diffUpdate of outcome.diffUpdates ?? []) {
      this.deliverDiff(principal.session, diffUpdate);
    }
    // Return Luna's reply to the requester (Phase 4; Req 4.2–4.5).
    if (outcome.lunaReply !== undefined) {
      this.send(conn, {
        type: LunaMessageType.REPLY,
        payload: outcome.lunaReply,
      });
    }
    // Any accepted event is member activity; refresh liveness (Req 3.1).
    this.updateLiveness(principal.session);
    // A dependency-graph upload updates the shared graph: fan the merged graph
    // out to every OTHER connection in the session (Req 19.4, 20.1).
    if (
      type === DependencyMessageType.SNAPSHOT ||
      type === DependencyMessageType.DELTA
    ) {
      this.broadcastDependencyGraph(principal.session, conn);
    }

    // A direct, Event_ID-correlated acknowledgement is deliberately separate
    // from the session broadcast. A caller can never mistake another member's
    // update for its own accepted mutation, including a losing lock claim that
    // produces no winner-only cache broadcast.
    if (eventId === undefined || outcome.eventRevision === undefined) {
      this.sendError(
        conn,
        "STORAGE_ERROR",
        "Accepted event is missing acknowledgement metadata.",
        eventId,
      );
      return;
    }
    this.send(conn, {
      type: EventMessageType.EVENT_APPLIED,
      payload: {
        eventId,
        eventRevision: outcome.eventRevision,
        ...(outcome.duplicateOf !== undefined
          ? { duplicateOf: outcome.duplicateOf }
          : {}),
        ...(outcome.lockConflict !== undefined
          ? { lockConflict: outcome.lockConflict }
          : {}),
      },
    });
  }

  /** Send the session's current metadata-only Dependency_Graph to one connection. */
  private sendDependencyGraph(conn: Connection, session: SessionId): void {
    const graph = this.authority.dependencyGraph(session);
    if (graph !== null) {
      this.send(conn, {
        type: DependencyMessageType.SNAPSHOT,
        payload: { graph },
      });
    }
  }

  /** Fan the session's current Dependency_Graph out to all connections but `except`. */
  private broadcastDependencyGraph(
    session: SessionId,
    except: Connection,
  ): void {
    const graph = this.authority.dependencyGraph(session);
    if (graph === null) {
      return;
    }
    const set = this.bySession.get(sessionKey(session));
    if (set === undefined) {
      return;
    }
    for (const conn of set) {
      if (conn !== except) {
        this.send(conn, {
          type: DependencyMessageType.SNAPSHOT,
          payload: { graph },
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Broadcast & subscriptions (Req 25, 10.2)
  // -------------------------------------------------------------------------

  private subscribe(conn: Connection, session: SessionId): void {
    const key = sessionKey(session);
    let set = this.bySession.get(key);
    if (set === undefined) {
      set = new Set<Connection>();
      this.bySession.set(key, set);
    }
    set.add(conn);
  }

  /** Broadcast a coordination update to every connection in the session (Req 25). */
  broadcast(session: SessionId, update: CoordinationUpdate): void {
    const set = this.bySession.get(sessionKey(session));
    if (set === undefined) return;
    for (const conn of set) {
      this.send(conn, { type: BroadcastMessageType.UPDATE, payload: update });
    }
  }

  /**
   * Deliver a V2 message update only to its audience (Phase 1; Req 1.1): every
   * connection in the session for `"all"`, or only connections whose member is
   * in the audience list for a directed message/question/answer.
   */
  private deliverMessage(
    session: SessionId,
    update: { op: "added" | "updated"; message: MessageDto; audience: "all" | string[] },
  ): void {
    const set = this.bySession.get(sessionKey(session));
    if (set === undefined) return;
    const audience =
      update.audience === "all" ? null : new Set(update.audience);
    for (const conn of set) {
      if (conn.principal === undefined) continue;
      if (audience !== null && !audience.has(conn.principal.memberId)) {
        continue;
      }
      this.send(conn, {
        type: MessagingMessageType.UPDATE,
        payload: { op: update.op, message: update.message },
      });
    }
  }

  /**
   * Broadcast a V2 task update to every connection in the session (Phase 2;
   * Req 2.1) — tasks are shared team coordination metadata.
   */
  private deliverTask(
    session: SessionId,
    update: { op: "added" | "updated"; task: TaskDto },
  ): void {
    const set = this.bySession.get(sessionKey(session));
    if (set === undefined) return;
    for (const conn of set) {
      if (conn.principal === undefined) continue;
      this.send(conn, {
        type: TaskMessageType.UPDATE,
        payload: { op: update.op, task: update.task },
      });
    }
  }

  /**
   * Broadcast a V2 live-diff update to every connection in the session (Phase 5;
   * Req 5.1–5.3) — Live_Diffs are shared with authorized members only, i.e. the
   * whole trusted session.
   */
  private deliverDiff(session: SessionId, update: DiffBroadcast): void {
    const set = this.bySession.get(sessionKey(session));
    if (set === undefined) return;
    for (const conn of set) {
      if (conn.principal === undefined) continue;
      this.send(conn, {
        type: DiffMessageType.UPDATE,
        payload: { op: update.op, diff: update.diff },
      });
    }
  }

  /**
   * Deliver a V2 notification only to its target member's connections
   * (Phase 3; Req 3.2, 3.3).
   */
  private deliverNotification(
    session: SessionId,
    notification: NotificationDto,
  ): void {
    const set = this.bySession.get(sessionKey(session));
    if (set === undefined) return;
    for (const conn of set) {
      if (conn.principal?.memberId !== notification.toMemberId) continue;
      this.send(conn, {
        type: PresenceLivenessMessageType.NOTIFY_PUSH,
        payload: notification,
      });
    }
  }

  /** The set of member ids with a live authenticated connection in the session. */
  private connectedMemberIds(session: SessionId): string[] {
    const set = this.bySession.get(sessionKey(session));
    const members = new Set<string>();
    for (const conn of set ?? []) {
      if (conn.principal !== undefined) members.add(conn.principal.memberId);
    }
    return [...members];
  }

  /**
   * Refresh the authority's live roster and broadcast any liveness changes to
   * the session (Phase 3; Req 3.1).
   */
  private updateLiveness(session: SessionId): void {
    this.authority.setLiveRoster(session, this.connectedMemberIds(session));
    for (const change of this.authority.livenessChanges(session)) {
      this.broadcastLiveness(session, change);
    }
  }

  /** Broadcast a single liveness change to every connection in the session. */
  private broadcastLiveness(
    session: SessionId,
    change: { memberId: string; state: string; eventRevision: number },
  ): void {
    const set = this.bySession.get(sessionKey(session));
    if (set === undefined) return;
    for (const conn of set) {
      this.send(conn, {
        type: PresenceLivenessMessageType.LIVENESS_UPDATE,
        payload: change,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Expiry sweep (Req 26)
  // -------------------------------------------------------------------------

  private startSweep(): void {
    const interval =
      this.options.expirySweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    if (interval <= 0) return;
    this.sweepTimer = setInterval(() => {
      for (const session of this.authority.sessions()) {
        const removals = this.authority.sweepExpiry(session);
        for (const update of removals) {
          this.broadcast(session, update);
        }
        // Periodically re-derive liveness so active→idle transitions are
        // broadcast even without new events (Req 3.1).
        this.updateLiveness(session);
      }
    }, interval);
    // Do not keep the process alive solely for the sweep timer.
    this.sweepTimer.unref?.();
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private connectedDevices(session: SessionId): string[] {
    const set = this.bySession.get(sessionKey(session));
    if (set === undefined) return [];
    const devices = new Set<string>();
    for (const conn of set) {
      if (conn.principal !== undefined) devices.add(conn.principal.deviceId);
    }
    return [...devices].sort();
  }

  /** Build the live, metadata-only member roster for one authorized session. */
  private participants(session: SessionId): {
    connected: string[];
    offline: string[];
  } {
    const set = this.bySession.get(sessionKey(session));
    const connected = new Set<string>();
    for (const conn of set ?? []) {
      if (conn.principal !== undefined) {
        connected.add(conn.principal.memberId);
      }
    }
    const offline = new Set<string>();
    for (const entry of this.authority.membership(session)) {
      if (
        entry.invitationValid &&
        !entry.revoked &&
        !connected.has(entry.memberId)
      ) {
        offline.add(entry.memberId);
      }
    }
    return {
      connected: [...connected].sort((a, b) => a.localeCompare(b)),
      offline: [...offline].sort((a, b) => a.localeCompare(b)),
    };
  }

  /** Fan a live participant roster out only to authenticated session peers. */
  private broadcastParticipants(session: SessionId): void {
    const set = this.bySession.get(sessionKey(session));
    if (set === undefined) {
      return;
    }
    const payload = this.participants(session);
    for (const conn of set) {
      this.send(conn, {
        type: BroadcastMessageType.PARTICIPANTS,
        payload,
      });
    }
  }

  private uptimeSeconds(): number {
    return this.startedAt === 0
      ? 0
      : Math.floor((Date.now() - this.startedAt) / 1000);
  }

  private send(conn: Connection, message: unknown): void {
    if (conn.socket.readyState === conn.socket.OPEN) {
      conn.socket.send(JSON.stringify(message));
    }
  }

  private sendError(
    conn: Connection,
    code: string,
    message: string,
    refEventId?: string,
  ): void {
    this.send(conn, {
      type: ErrorMessageType.ERROR,
      payload: {
        code,
        message,
        ...(refEventId !== undefined ? { refEventId } : {}),
      },
    });
  }

  private sendAuthError(conn: Connection, code: string, message: string): void {
    this.send(conn, {
      type: AuthMessageType.ERROR,
      payload: { code, message },
    });
    conn.socket.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Extract a client Event_ID from a malformed or valid Signed_Event wrapper. */
function eventIdFromMessage(message: unknown): string | undefined {
  if (!isRecord(message) || !isRecord(message.envelope)) {
    return undefined;
  }
  const eventId = message.envelope.eventId;
  return typeof eventId === "string" ? eventId : undefined;
}
