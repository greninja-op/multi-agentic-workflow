/**
 * The {@link HostGateway} — the seam between the agent's {@link AgentCoordinationPort}
 * and the CoordinationHost authority (task 9.3).
 *
 * Query methods read the agent's cached {@link AgentView}; **mutations** must go
 * to the host, which is the sole authority for Event_Revisions and conflict
 * resolution. The gateway abstracts that transmission so the port can be
 * exercised both against a real WSS connection ({@link RealHostGateway}) and,
 * deterministically without a socket, against an in-process authority
 * ({@link LocalHostGateway}) used by the multi-client fan-in unit tests.
 *
 * A gateway emits `"update"` `(CoordinationUpdate)` for every authoritative
 * broadcast so the port can converge its single shared view (Req 31.1), and
 * reports connectivity + staleness for the response envelope (Req 4.7, 33.2).
 * While offline, {@link HostGateway.transmit} returns `OFFLINE_QUEUED` and never
 * falsely reports host acceptance (Req 4.8).
 */

import { EventEmitter } from "node:events";

import {
  LockRegistry,
  IntentRegistry,
  RevisionCounter,
  resolveMode,
  type RepositoryRulesConfig,
} from "@cfls/core-state";
import type {
  CoordinationUpdate,
  EventAppliedLockConflict,
  IntentDeclarePayload,
  IntentUpdatePayload,
  IntentWithdrawPayload,
  LockAcquirePayload,
  LockReleasePayload,
  DiffSharePayload,
  LunaReplyDto,
  LunaRequestPayload,
  MemberRef,
  MessageReadPayload,
  MessageSendPayload,
  SessionId,
  TaskAssignPayload,
  TaskProgressPayload,
  TaskRespondPayload,
  WakeRequestPayload,
} from "@cfls/protocol";
import type {
  ConnectionSnapshot,
  EnvelopeError,
  StalenessSnapshot,
} from "@cfls/mcp-server";

import type { HostConnection } from "./connection";

/** A state-mutating event the agent forwards to the host. */
export type MutationEvent =
  | { type: "lock.acquire"; payload: LockAcquirePayload }
  | { type: "lock.release"; payload: LockReleasePayload }
  | { type: "intent.declare"; payload: IntentDeclarePayload }
  | { type: "intent.update"; payload: IntentUpdatePayload }
  | { type: "intent.withdraw"; payload: IntentWithdrawPayload }
  | { type: "message.send"; payload: MessageSendPayload }
  | { type: "message.read"; payload: MessageReadPayload }
  | { type: "task.assign"; payload: TaskAssignPayload }
  | { type: "task.respond"; payload: TaskRespondPayload }
  | { type: "task.progress"; payload: TaskProgressPayload }
  | { type: "wake.request"; payload: WakeRequestPayload }
  | { type: "diff.share"; payload: DiffSharePayload };

/** Outcome of transmitting a mutation to the host authority. */
export type TransmitResult =
  | {
      ok: true;
      eventId: string;
      eventRevision: number;
      /** The primary resulting broadcast, used by the in-process gateway. */
      update?: CoordinationUpdate;
      /** Present when an accepted lock acquisition lost to the named winner. */
      lockConflict?: EventAppliedLockConflict;
    }
  | { ok: false; error: EnvelopeError };

/** The gateway contract the port depends on (transport-agnostic). */
export interface HostGateway extends EventEmitter {
  /** Connectivity snapshot for the response envelope (Req 4.7). */
  getConnection(): ConnectionSnapshot;
  /** Staleness snapshot for the response envelope (Req 33.2). */
  getStaleness(): StalenessSnapshot;
  /** Whether the host connection is currently online. */
  online(): boolean;
  /** Forward a mutation to the host; `OFFLINE_QUEUED` while offline (Req 4.8). */
  transmit(event: MutationEvent): Promise<TransmitResult>;
  /**
   * Direct a request to Luna and await its reply (Phase 4; Req 4.2–4.5).
   * Optional: only the real WSS gateway implements it; the in-process fan-in
   * gateway used by unit tests does not orchestrate Luna.
   */
  askLuna?(
    payload: LunaRequestPayload,
  ): Promise<{ ok: true; reply: LunaReplyDto } | { ok: false; error: EnvelopeError }>;
}

function offlineError(type: string): TransmitResult {
  return {
    ok: false,
    error: {
      code: "OFFLINE_QUEUED",
      message:
        `The CoordinationAgent is offline; '${type}' was queued and not accepted ` +
        `by the CoordinationHost. Manual coordination is required until ` +
        `connectivity is restored.`,
    },
  };
}

/**
 * A {@link HostGateway} backed by the live {@link HostConnection}. Forwards
 * mutations as Signed_Events and waits for the host's direct, Event_ID-
 * correlated `event.applied` acknowledgement (or a correlated error). It never
 * infers its result from arbitrary session broadcasts.
 */
export class RealHostGateway extends EventEmitter implements HostGateway {
  constructor(private readonly connection: HostConnection) {
    super();
    // Fan every host broadcast out to the port's view.
    this.connection.on("update", (u: CoordinationUpdate) =>
      this.emit("update", u),
    );
    // Relay V2 message updates (Phase 1) to the port's message view.
    this.connection.on("message", (m: unknown) => this.emit("message", m));
    // Relay V2 task updates (Phase 2) to the port's task view.
    this.connection.on("task", (t: unknown) => this.emit("task", t));
    // Relay V2 liveness + notifications (Phase 3) to the port's views.
    this.connection.on("liveness", (l: unknown) => this.emit("liveness", l));
    this.connection.on("notification", (n: unknown) =>
      this.emit("notification", n),
    );
    // Relay V2 live-diff updates (Phase 5) to the port's diff view.
    this.connection.on("diff", (d: unknown) => this.emit("diff", d));
  }

  getConnection(): ConnectionSnapshot {
    return this.connection.snapshot();
  }

  getStaleness(): StalenessSnapshot {
    return {
      stale: !this.connection.isOnline(),
      secondsSinceSync: this.connection.secondsSinceSync(),
    };
  }

  online(): boolean {
    return this.connection.isOnline();
  }

  async transmit(event: MutationEvent): Promise<TransmitResult> {
    if (!this.connection.isOnline()) {
      return offlineError(event.type);
    }
    const result = await this.connection.sendMutation(
      event.type,
      event.payload,
    );
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return {
      ok: true,
      eventId: result.eventId,
      eventRevision: result.acknowledgement.eventRevision,
      ...(result.acknowledgement.lockConflict !== undefined
        ? { lockConflict: result.acknowledgement.lockConflict }
        : {}),
    };
  }

  async askLuna(
    payload: LunaRequestPayload,
  ): Promise<
    { ok: true; reply: LunaReplyDto } | { ok: false; error: EnvelopeError }
  > {
    if (!this.connection.isOnline()) {
      return {
        ok: false,
        error: {
          code: "OFFLINE_QUEUED",
          message: "The CoordinationAgent is offline; Luna is unavailable.",
        },
      };
    }
    const result = await this.connection.requestLuna(payload);
    if (!result.ok) {
      return {
        ok: false,
        error: { code: "STORAGE_ERROR", message: result.message },
      };
    }
    return { ok: true, reply: result.reply };
  }
}

/** Options for a {@link LocalHostGateway}. */
export interface LocalHostGatewayOptions {
  session: SessionId;
  self: MemberRef;
  rules: RepositoryRulesConfig;
  online?: boolean;
  hostUrl?: string;
  now?: () => number;
}

/** The in-process equivalent of a host mutation acknowledgement plus updates. */
interface LocalAppliedMutation {
  updates: CoordinationUpdate[];
  lockConflict?: EventAppliedLockConflict;
}

/**
 * An in-process {@link HostGateway} that plays the role of the CoordinationHost
 * for deterministic tests (no socket). It assigns Event_Revisions from a real
 * {@link RevisionCounter}, applies mutations to authoritative registries, and
 * emits the resulting `coordination.update`(s) so the port's view converges —
 * exactly as a real host broadcast would. Peer activity can be injected with
 * {@link LocalHostGateway.injectRemote}.
 */
export class LocalHostGateway extends EventEmitter implements HostGateway {
  private readonly session: SessionId;
  private readonly self: MemberRef;
  private readonly rules: RepositoryRulesConfig;
  private readonly now: () => number;
  private readonly hostUrl: string;
  private isOnline: boolean;
  private lastSyncAt: string | null;

  private readonly locks = new LockRegistry();
  private readonly intents = new IntentRegistry();
  private readonly revisions = new RevisionCounter();

  constructor(options: LocalHostGatewayOptions) {
    super();
    this.session = options.session;
    this.self = options.self;
    this.rules = options.rules;
    this.now = options.now ?? Date.now;
    this.hostUrl = options.hostUrl ?? "wss://local.test:8443";
    this.isOnline = options.online ?? true;
    this.lastSyncAt = new Date(this.now()).toISOString();
  }

  setOnline(online: boolean): void {
    this.isOnline = online;
    if (online) {
      this.lastSyncAt = new Date(this.now()).toISOString();
    }
  }

  getConnection(): ConnectionSnapshot {
    return {
      status: this.isOnline ? "online" : "offline",
      hostUrl: this.hostUrl,
      lastSyncAt: this.lastSyncAt,
    };
  }

  getStaleness(): StalenessSnapshot {
    return {
      stale: !this.isOnline,
      secondsSinceSync:
        this.lastSyncAt === null
          ? null
          : Math.max(
              0,
              Math.floor((this.now() - Date.parse(this.lastSyncAt)) / 1000),
            ),
    };
  }

  online(): boolean {
    return this.isOnline;
  }

  /** Inject a peer's authoritative broadcast into the view (test helper). */
  injectRemote(update: CoordinationUpdate): void {
    this.emit("update", update);
  }

  async transmit(event: MutationEvent): Promise<TransmitResult> {
    if (!this.isOnline) {
      return offlineError(event.type);
    }
    const revision = this.revisions.next(this.session);
    const eventId = `local-${revision}`;
    const applied = this.apply(event, revision, eventId);
    for (const update of applied.updates) {
      this.emit("update", update);
    }
    return Promise.resolve({
      ok: true,
      eventId,
      eventRevision: revision,
      ...(applied.updates[0] !== undefined
        ? { update: applied.updates[0] }
        : {}),
      ...(applied.lockConflict !== undefined
        ? { lockConflict: applied.lockConflict }
        : {}),
    });
  }

  private apply(
    event: MutationEvent,
    revision: number,
    eventId: string,
  ): LocalAppliedMutation {
    switch (event.type) {
      case "lock.acquire": {
        const previousWinner = this.locks.winningLock(
          this.session,
          event.payload.scope,
          event.payload.scopeKind,
          this.session.branch,
        );
        const outcome = this.locks.acquire({
          session: this.session,
          lockId: eventId,
          scope: event.payload.scope,
          scopeKind: event.payload.scopeKind,
          mode: resolveMode(event.payload.scope, this.rules),
          holder: this.self,
          branch: this.session.branch,
          eventRevision: revision,
          acquiredAt: new Date(this.now()).toISOString(),
        });
        const updates: CoordinationUpdate[] = [];
        if (previousWinner?.lockId !== outcome.winner.lockId) {
          if (previousWinner !== undefined) {
            updates.push({
              entryType: "soft_lock",
              op: "removed",
              path: previousWinner.scope,
              member: previousWinner.holder,
              eventRevision: revision,
            });
          }
          updates.push({
            entryType: "soft_lock",
            op: "added",
            path: outcome.winner.scope,
            member: outcome.winner.holder,
            eventRevision: revision,
          });
        }
        return {
          updates,
          ...(outcome.contended
            ? {
                lockConflict: {
                  scope: event.payload.scope,
                  winner: {
                    memberId: outcome.winner.holder.memberId,
                    eventRevision: outcome.winner.eventRevision,
                  },
                },
              }
            : {}),
        };
      }
      case "lock.release": {
        const release = this.locks.release({
          session: this.session,
          requester: this.self,
          branch: this.session.branch,
          ...(event.payload.lockId !== undefined
            ? { lockId: event.payload.lockId }
            : {}),
          ...(event.payload.scope !== undefined
            ? { scope: event.payload.scope }
            : {}),
        });
        if (!release.ok) {
          return { updates: [] };
        }
        const updates: CoordinationUpdate[] = [
          {
            entryType: "soft_lock",
            op: "removed",
            path: release.released.scope,
            member: release.released.holder,
            eventRevision: revision,
          },
        ];
        if (release.promoted !== undefined) {
          updates.push({
            entryType: "soft_lock",
            op: "added",
            path: release.promoted.scope,
            member: release.promoted.holder,
            eventRevision: revision,
          });
        }
        return { updates };
      }
      case "intent.declare": {
        const intentId = eventId;
        this.intents.declare({
          session: this.session,
          intentId,
          owner: this.self,
          agentId: this.self.deviceId,
          modifyPaths: event.payload.modifyPaths,
          createPaths: event.payload.createPaths,
          scopeKind: "file",
          branch: this.session.branch,
          description: event.payload.description,
          eventRevision: revision,
        });
        const path =
          event.payload.modifyPaths[0] ?? event.payload.createPaths[0] ?? "";
        const entryType =
          event.payload.modifyPaths.length > 0
            ? "intent"
            : "planned_file_creation";
        return {
          updates: [
            {
              entryType,
              op: "added",
              path,
              member: this.self,
              eventRevision: revision,
              intent: {
                intentId,
                description: event.payload.description,
              },
            },
          ],
        };
      }
      case "intent.update":
        return { updates: [] };
      case "intent.withdraw":
        return { updates: [] };
      case "message.send":
      case "message.read":
      case "task.assign":
      case "task.respond":
      case "task.progress":
      case "wake.request":
      case "diff.share":
        // Messaging, tasks, wakes, and live diffs are delivered over the host's
        // separate channels, not as CoordinationUpdates. The in-process gateway
        // (used only by fan-in unit tests) records no coordination updates here.
        return { updates: [] };
    }
  }
}
