/**
 * The CoordinationAuthority — the transport-independent heart of the host
 * (design §3.1). It assembles the pure `@cfls/core-state` engine, the
 * `@cfls/security` gates, and the durable {@link Store} into the definitive
 * coordination authority: authentication (Req 5), ingest with signature/replay/
 * idempotency/permission/data-minimization checks and monotonic Event_Revision
 * assignment (Req 7, 8, 29), broadcast projection scoped by session (Req 25),
 * sync-from-revision (Req 9), heartbeat/expiry (Req 26), and durable audit
 * (Req 28) with restart recovery (Req 1.5, 1.6).
 *
 * It is deliberately free of any WebSocket/TLS concerns so it can be unit- and
 * property-tested directly; {@link CoordinationServer} wires it to the network.
 */

import {
  CoordinationEventLog,
  DiffRegistry,
  ExpiryEngine,
  IngestGate,
  IntentRegistry,
  LivenessTracker,
  LockRegistry,
  MessageRegistry,
  NotificationRegistry,
  PresenceRegistry,
  RevisionCounter,
  RulesLunaBrain,
  TaskRegistry,
  buildNotification,
  type LunaContext,
  checkInboundMinimization,
  findMinimizationViolations,
  normalizePath,
  restoreSessionState,
  serializeSessionState,
  sessionKey,
  validateOverride,
  type ExpiryConfigInput,
  type IngestResult,
  type SessionRegistries,
  type SyncResponse,
} from "@cfls/core-state";
import {
  MESSAGE_FORMAT_VERSION,
  type AuditRecord,
  type AuthHelloPayload,
  type CoordinationUpdate,
  type DependencyGraph,
  type DepDeltaPayload,
  type DepSnapshotPayload,
  type ErrorCode,
  type EventAppliedLockConflict,
  type FileCreatedPayload,
  type IntentDeclarePayload,
  type IntentUpdatePayload,
  type IntentWithdrawPayload,
  type Lock,
  type LockAcquirePayload,
  type LockOverridePayload,
  type LockReleasePayload,
  type EventEnvelope,
  type MemberRef,
  type MembershipRegistryEntry,
  type DiffSharePayload,
  type LiveDiffDto,
  type LivenessState,
  type LunaReplyDto,
  type LunaRequestPayload,
  type MessageDto,
  type MessageReadPayload,
  type MessageSendPayload,
  type NotificationDto,
  type WakeRequestPayload,
  type TaskAssignPayload,
  type TaskDto,
  type TaskProgressPayload,
  type TaskRespondPayload,
  type TaskWithdrawPayload,
  type PathDeletedPayload,
  type PathRenamedPayload,
  type PresenceReportPayload,
  type SessionId,
  type SessionStateSnapshot,
  type SignedEvent,
  type TypedEventEnvelope,
} from "@cfls/protocol";
import {
  admitDevice,
  canAuthenticate,
  deriveDeviceId,
  findMembershipEntry,
  revokeDevice,
  verifySignedEvent,
  createReplayGuard,
  type DevicePublicKey,
  type ReplayRecord,
  type SignedInvitation,
} from "@cfls/security";

import { generateChallenge, verifyChallenge } from "./challenge";
import type { PersistedMutation, Store } from "./store";

/** An authenticated connection principal produced by a successful handshake. */
export interface AuthPrincipal {
  session: SessionId;
  deviceId: string;
  memberId: string;
  devicePublicKey: DevicePublicKey;
}

/** Outcome of {@link CoordinationAuthority.prepareChallenge}. */
export type ChallengeResult =
  { ok: true; nonce: string } | { ok: false; code: ErrorCode; message: string };

/** Outcome of {@link CoordinationAuthority.finalizeHandshake}. */
export type HandshakeResult =
  | { ok: true; principal: AuthPrincipal; highestRevision: number }
  | { ok: false; code: ErrorCode; message: string };

/**
 * A V2 messaging update to deliver to session participants (Phase 1; Req 1.1).
 * Unlike a {@link CoordinationUpdate} (delivered to all session subscribers), a
 * message is delivered only to its `audience`: `"all"` for broadcast/heads-up,
 * or the specific memberIds (sender + recipient) for a directed message,
 * question, or answer.
 */
export interface MessageBroadcast {
  op: "added" | "updated";
  message: MessageDto;
  audience: "all" | string[];
}

/**
 * A V2 task update to deliver to session participants (Phase 2; Req 2.1). Tasks
 * are shared team coordination metadata, so a task update is delivered to every
 * member of the session.
 */
export interface TaskBroadcast {
  op: "added" | "updated";
  task: TaskDto;
}

/** The reserved Luna orchestrator member identity (Phase 4; idea.md §5). */
const LUNA_MEMBER: MemberRef = { memberId: "luna", deviceId: "luna" };

/** A liveness change to broadcast (Phase 3; Req 3.1). */
export interface LivenessBroadcast {
  memberId: string;
  state: LivenessState;
  eventRevision: number;
}

/**
 * A V2 live-diff update to deliver to session participants (Phase 5; Req 5.1–5.3).
 * Live_Diffs are shared with authorized members only — i.e. every member of the
 * trusted session — so a diff update is delivered to the whole session.
 */
export interface DiffBroadcast {
  op: "shared" | "removed";
  diff: LiveDiffDto;
}

/** Outcome of ingesting a single coordination event. */
export interface IngestOutcome {
  accepted: boolean;
  eventRevision?: number;
  duplicateOf?: number;
  /** Present when an accepted lock acquisition was recorded as a loser. */
  lockConflict?: EventAppliedLockConflict;
  error?: ErrorCode;
  reason?: string;
  /** Coordination updates to broadcast to the session's subscribers (Req 25). */
  broadcasts: CoordinationUpdate[];
  /** V2 message updates to deliver to their audience (Phase 1; Req 1.1). */
  messageUpdates?: MessageBroadcast[];
  /** V2 task updates to broadcast to the session (Phase 2; Req 2.1). */
  taskUpdates?: TaskBroadcast[];
  /** V2 notifications to deliver to their target member (Phase 3; Req 3.2, 3.3). */
  notifications?: NotificationDto[];
  /** V2 Luna reply to return to the requester (Phase 4; Req 4.2–4.5). */
  lunaReply?: LunaReplyDto;
  /** V2 live-diff updates to deliver to the session (Phase 5; Req 5.1–5.3). */
  diffUpdates?: DiffBroadcast[];
}

/** Effects that must be committed with the event rather than during apply. */
interface MutationEffects {
  dependencyGraph?: DependencyGraph;
}

/** Options for constructing a {@link CoordinationAuthority}. */
export interface AuthorityOptions {
  /** Heartbeat/expiry tuning (Req 26). */
  expiry?: ExpiryConfigInput;
  /**
   * Opt-in Live_Diff sharing (Phase 5; Req 5.1, 5.4). Off by default so the host
   * behaves exactly as V1 (metadata only); when a team enables `liveDiffs` in
   * `.coordination/config.json`, the CLI passes `true` here and `diff.share`
   * events are accepted, data-minimized, and broadcast to the session.
   */
  liveDiffsEnabled?: boolean;
}

/** The result of one `sync.request` (Req 9). */
export type SyncResult = SyncResponse;

/**
 * The definitive, transport-independent coordination authority (design §3.1).
 */
export class CoordinationAuthority {
  private readonly locks = new LockRegistry();
  private readonly intents = new IntentRegistry();
  private readonly presence = new PresenceRegistry();
  private readonly messages = new MessageRegistry();
  private readonly tasks = new TaskRegistry();
  private readonly notificationsRegistry = new NotificationRegistry();
  private readonly diffs = new DiffRegistry();
  private readonly liveness = new LivenessTracker();
  /**
   * The default, deterministic Luna brain (Phase 4; Req 4.1). It requires no
   * external service. An optional LLM-backed brain is future/advanced wiring and
   * is off by default, keeping the sync ingest path key-free (Req 4.1.3, 4.1.4).
   */
  private readonly luna = new RulesLunaBrain();
  /** `session_key` → last broadcast liveness state per member (change detection). */
  private readonly lastLiveness = new Map<string, Map<string, LivenessState>>();
  private notificationSeq = 0;
  /** Whether opt-in Live_Diff sharing is enabled for this host (Phase 5; Req 5.1). */
  private readonly liveDiffsEnabled: boolean;
  private readonly revisions: RevisionCounter;
  private readonly eventLog = new CoordinationEventLog();
  private readonly gate: IngestGate;
  private readonly expiry: ExpiryEngine;

  private readonly registries: SessionRegistries;

  /** `session_key` → in-memory Membership_Registry (mirror of the store). */
  private readonly membershipBySession = new Map<
    string,
    MembershipRegistryEntry[]
  >();
  /** `session_key` → authorized admin Device_Public_Keys (Req 5.5). */
  private readonly adminKeysBySession = new Map<string, Set<DevicePublicKey>>();
  /** `session_key` → SessionId (every session the authority knows about). */
  private readonly knownSessions = new Map<string, SessionId>();
  /** `session_key` → the latest metadata-only Dependency_Graph (Req 19, 20). */
  private readonly dependencyGraphs = new Map<string, DependencyGraph>();
  /**
   * A failed durable commit leaves the gate/replay/revision internals advanced
   * in this process. Do not let that poisoned in-memory state acknowledge a
   * retry as a duplicate: reject every later mutation until process recovery
   * reconstructs those internals from the last atomic durable commit.
   */
  private storageFaulted = false;

  constructor(
    private readonly store: Store,
    options: AuthorityOptions = {},
  ) {
    this.liveDiffsEnabled = options.liveDiffsEnabled ?? false;
    this.revisions = new RevisionCounter();
    this.expiry = new ExpiryEngine(
      this.locks,
      this.intents,
      this.revisions,
      options.expiry,
      this.presence,
    );
    this.registries = {
      locks: this.locks,
      intents: this.intents,
      presence: this.presence,
      revisions: this.revisions,
      // Messages are persisted and restored via the same snapshot mechanism as
      // locks/presence/intents (Req 1.4, X.2); no separate table is needed.
      messages: this.messages,
      // Tasks likewise persist via the snapshot (Req 2.1, X.2).
      tasks: this.tasks,
      // Notifications likewise persist via the snapshot (Req 3.2, X.2).
      notifications: this.notificationsRegistry,
      // Live diffs persist via the snapshot only when the opt-in is enabled; the
      // registry stays empty and unused otherwise (Phase 5; Req 5.1, 5.4, X.2).
      ...(this.liveDiffsEnabled ? { diffs: this.diffs } : {}),
    };

    // Reseed the replay guard from persisted per-device counters (Req 7.5).
    const replaySeed: Array<readonly [string, ReplayRecord]> = this.store
      .deviceCounters()
      .map(({ deviceId, highestCounter }) => [
        deviceId,
        { highestCounter, usedNonces: new Set<string>() },
      ]);

    // Reseed the applied-Event_ID index so idempotency survives a restart (Req 7.4).
    const appliedSeed: Array<readonly [SessionId, string, number]> = [];
    for (const { session } of this.store.allSessions()) {
      for (const { eventId, eventRevision } of this.store.appliedEvents(
        session,
      )) {
        appliedSeed.push([session, eventId, eventRevision]);
      }
    }

    this.gate = new IngestGate({
      revisions: this.revisions,
      replayGuard: createReplayGuard(replaySeed),
      checkPermission: (envelope: TypedEventEnvelope) =>
        this.checkPermission(envelope),
      appliedEvents: appliedSeed,
    });

    this.recover();
  }

  // -------------------------------------------------------------------------
  // Session registration & membership
  // -------------------------------------------------------------------------

  /**
   * Register (or update) a session and its authorized admin keys (Req 5.5).
   * Admin keys are the devices permitted to issue `Signed_Invitation`s that
   * admit other devices to the session.
   */
  registerSession(
    session: SessionId,
    adminKeys: readonly DevicePublicKey[],
    options: { manualConfig?: boolean } = {},
  ): void {
    const key = sessionKey(session);
    this.knownSessions.set(key, session);
    this.adminKeysBySession.set(key, new Set(adminKeys));
    if (!this.membershipBySession.has(key)) {
      this.membershipBySession.set(key, this.store.membership(session));
    }
    this.store.upsertSession(session, options.manualConfig ?? false);
    this.store.setAdminKeys(session, adminKeys);
  }

  /** The current Membership_Registry for a session. */
  membership(session: SessionId): readonly MembershipRegistryEntry[] {
    return this.membershipBySession.get(sessionKey(session)) ?? [];
  }

  /** Revoke a device's key for a session (Req 5.6); rejects it thereafter. */
  revoke(session: SessionId, devicePublicKey: DevicePublicKey): void {
    const key = sessionKey(session);
    const registry = this.membershipBySession.get(key) ?? [];
    const next = revokeDevice(registry, devicePublicKey);
    this.membershipBySession.set(key, next);
    this.store.replaceMembership(session, next);
  }

  /** Every session the authority currently knows about. */
  sessions(): SessionId[] {
    return [...this.knownSessions.values()];
  }

  // -------------------------------------------------------------------------
  // Authentication handshake (Req 5.3–5.6; design §4.1)
  // -------------------------------------------------------------------------

  /**
   * Validate an `auth.hello` and, on success, issue a challenge nonce
   * (design §4.1 steps 2–3). Rejects an unsupported message-format version
   * (Req 7.6), an unregistered/forbidden session (Req 10.7), a device/session
   * mismatch or an invitation that does not chain to an authorized admin
   * (Req 5.4, 5.5), and a device whose key is already revoked (Req 5.6).
   */
  prepareChallenge(hello: AuthHelloPayload): ChallengeResult {
    if (hello.version !== MESSAGE_FORMAT_VERSION) {
      return {
        ok: false,
        code: "FORMAT_ERROR",
        message: `Unsupported message-format version ${hello.version}.`,
      };
    }

    const key = sessionKey(hello.session);
    const adminKeys = this.adminKeysBySession.get(key);
    if (adminKeys === undefined) {
      return {
        ok: false,
        code: "AUTH_SESSION_FORBIDDEN",
        message: "Unknown or unauthorized session.",
      };
    }

    const invitation = this.decodeInvitation(hello.signedInvitation);
    if (invitation === null) {
      return {
        ok: false,
        code: "AUTH_INVALID_DEVICE",
        message: "Malformed Signed_Invitation.",
      };
    }

    // The invitation must be for this session and this connecting device.
    if (sessionKey(invitation.claims.session) !== key) {
      return {
        ok: false,
        code: "AUTH_SESSION_FORBIDDEN",
        message: "Invitation is for a different session.",
      };
    }
    if (invitation.claims.devicePublicKey !== hello.devicePublicKey) {
      return {
        ok: false,
        code: "AUTH_INVALID_DEVICE",
        message: "Invitation does not match the connecting device.",
      };
    }

    // A device whose key is already revoked cannot re-admit itself (Req 5.6).
    const existing = findMembershipEntry(
      this.membershipBySession.get(key) ?? [],
      hello.devicePublicKey,
    );
    if (existing?.revoked === true) {
      return {
        ok: false,
        code: "AUTH_INVALID_DEVICE",
        message: "Device key has been revoked.",
      };
    }

    // Dry-run admission validates signature, expiry, and admin chaining.
    const admission = admitDevice(
      this.membershipBySession.get(key) ?? [],
      invitation,
      adminKeys,
    );
    if (!admission.admitted) {
      return { ok: false, code: admission.code, message: admission.reason };
    }

    return { ok: true, nonce: generateChallenge() };
  }

  /**
   * Complete the handshake: verify the `auth.response` signature over the
   * challenge nonce (Req 5.3), admit the device into the Membership_Registry,
   * and return the authenticated principal with the session's current highest
   * revision (design §4.1 steps 4–5).
   */
  finalizeHandshake(
    hello: AuthHelloPayload,
    nonce: string,
    responseSignature: string,
  ): HandshakeResult {
    // Re-validate the hello (cheap; guards against a tampered replay).
    const revalidated = this.prepareChallenge(hello);
    if (!revalidated.ok) {
      return {
        ok: false,
        code: revalidated.code,
        message: revalidated.message,
      };
    }

    if (!verifyChallenge(nonce, responseSignature, hello.devicePublicKey)) {
      return {
        ok: false,
        code: "AUTH_INVALID_DEVICE",
        message: "Challenge signature verification failed.",
      };
    }

    const key = sessionKey(hello.session);
    const invitation = this.decodeInvitation(hello.signedInvitation);
    const adminKeys = this.adminKeysBySession.get(key);
    if (invitation === null || adminKeys === undefined) {
      return {
        ok: false,
        code: "AUTH_INVALID_DEVICE",
        message: "Invitation is no longer valid.",
      };
    }

    const admission = admitDevice(
      this.membershipBySession.get(key) ?? [],
      invitation,
      adminKeys,
    );
    if (!admission.admitted) {
      return { ok: false, code: admission.code, message: admission.reason };
    }

    this.membershipBySession.set(key, admission.registry);
    this.store.replaceMembership(hello.session, admission.registry);
    this.knownSessions.set(key, hello.session);

    const principal: AuthPrincipal = {
      session: hello.session,
      deviceId: deriveDeviceId(hello.devicePublicKey),
      memberId: admission.entry.memberId,
      devicePublicKey: hello.devicePublicKey,
    };

    return {
      ok: true,
      principal,
      highestRevision: this.revisions.highest(hello.session),
    };
  }

  // -------------------------------------------------------------------------
  // Ingest pipeline (Req 7, 8, 29; design §4.4, §4.5)
  // -------------------------------------------------------------------------

  /**
   * Ingest a Signed_Event from an authenticated principal (design §4.4):
   * data-minimization rejection (Req 29.5), session/device authorization
   * (Req 10.7), signature verification against a non-revoked key (Req 7.2, 7.3),
   * then the shared ingest gate (schema/version, permission, idempotency, replay,
   * monotonic revision assignment — Req 7.4–7.7, 8.1). On acceptance the state
   * mutation runs exactly once and the produced broadcasts are logged, persisted,
   * and returned for session-scoped delivery.
   */
  ingest(principal: AuthPrincipal, input: SignedEvent): IngestOutcome {
    const envelope = input.envelope;

    // Session scoping: the event must target the connection's session (Req 10.7).
    if (sessionKey(envelope.session) !== sessionKey(principal.session)) {
      return {
        accepted: false,
        error: "AUTH_SESSION_FORBIDDEN",
        reason: "Event session does not match the authenticated session.",
        broadcasts: [],
      };
    }
    if (envelope.deviceId !== principal.deviceId) {
      return {
        accepted: false,
        error: "AUTH_INVALID_DEVICE",
        reason: "Event device does not match the authenticated device.",
        broadcasts: [],
      };
    }

    // Data-minimization rejection before any state change (Req 29.5).
    //
    // V2 messages carry a `body` of legitimate team text (idea.md §6 Safety),
    // which the generic gate would otherwise reject by field name as
    // source-content. For `message.send` we therefore value-scan the body for
    // secrets/absolute/out-of-tree/excluded paths (Req 1.4) and run the generic
    // gate over the rest of the envelope; every other event type is checked
    // wholesale exactly as in V1.
    const minimizationError = this.checkEventMinimization(envelope);
    if (minimizationError !== undefined) {
      return {
        accepted: false,
        error: minimizationError.code,
        reason: minimizationError.message,
        broadcasts: [],
      };
    }

    // Signature verification against a non-revoked, admitted key (Req 7.2, 7.3, 5.6).
    const key = sessionKey(principal.session);
    if (
      !canAuthenticate(
        this.membershipBySession.get(key) ?? [],
        principal.devicePublicKey,
      )
    ) {
      return {
        accepted: false,
        error: "AUTH_INVALID_DEVICE",
        reason: "Device is not admitted or has been revoked.",
        broadcasts: [],
      };
    }
    if (!verifySignedEvent(input, principal.devicePublicKey)) {
      return {
        accepted: false,
        error: "AUTH_INVALID_DEVICE",
        reason: "Event signature verification failed.",
        broadcasts: [],
      };
    }

    // A failed durable commit advances the gate's replay/idempotency metadata
    // before we can observe the failure. Fail closed until restart rather than
    // letting a retry receive a false `event.applied` duplicate acknowledgement.
    if (this.storageFaulted) {
      return this.storageFailureOutcome();
    }

    const member: MemberRef = {
      memberId: principal.memberId,
      deviceId: principal.deviceId,
    };
    const stateBefore = this.snapshot(envelope.session);
    const hadCachedDependencyGraph = this.dependencyGraphs.has(key);
    const cachedDependencyGraph = this.dependencyGraphs.get(key);
    const broadcasts: CoordinationUpdate[] = [];
    const audits: AuditRecord[] = [];
    const effects: MutationEffects = {};
    const acknowledgement: {
      lockConflict?: EventAppliedLockConflict;
    } = {};
    const messageUpdates: MessageBroadcast[] = [];
    const taskUpdates: TaskBroadcast[] = [];
    const notifications: NotificationDto[] = [];
    const lunaOut: { reply?: LunaReplyDto } = {};
    const diffUpdates: DiffBroadcast[] = [];

    let result: IngestResult;
    try {
      result = this.gate.ingest(
        input,
        (env: TypedEventEnvelope, eventRevision: number) =>
          this.apply(
            env,
            eventRevision,
            member,
            broadcasts,
            audits,
            acknowledgement,
            effects,
            messageUpdates,
            taskUpdates,
            notifications,
            lunaOut,
            diffUpdates,
          ),
      );
    } catch {
      return this.failClosedAfterPersistenceFailure(
        stateBefore,
        key,
        hadCachedDependencyGraph,
        cachedDependencyGraph,
      );
    }

    if (!result.accepted) {
      // A domain-rule rejection is a valid signed event: retain its replay
      // counter and consumed revision durably, but omit its Event_ID from the
      // applied index. A lost error response can therefore never turn into an
      // `event.applied` success on retry or after restart.
      if (result.eventRevision !== undefined) {
        try {
          this.store.commitMutation({
            event: {
              session: envelope.session,
              eventRevision: result.eventRevision,
              eventId: envelope.eventId,
              type: envelope.type,
              deviceId: envelope.deviceId,
              payloadJson: JSON.stringify(envelope.payload),
              replayCounter: envelope.replay.counter,
              createdAt: new Date().toISOString(),
            },
            audits: [],
            snapshot: this.snapshot(envelope.session),
            recordApplied: false,
          });
        } catch {
          return this.failClosedAfterPersistenceFailure(
            stateBefore,
            key,
            hadCachedDependencyGraph,
            cachedDependencyGraph,
          );
        }
      }
      return {
        accepted: false,
        ...(result.error !== undefined ? { error: result.error } : {}),
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
        ...(result.eventRevision !== undefined
          ? { eventRevision: result.eventRevision }
          : {}),
        broadcasts: [],
      };
    }

    // Idempotent duplicate: nothing re-applied, return the original revision.
    if (result.duplicateOf !== undefined) {
      const lockConflict = this.currentLockConflict(
        envelope as TypedEventEnvelope,
        member,
      );
      return {
        accepted: true,
        ...(result.eventRevision !== undefined
          ? { eventRevision: result.eventRevision }
          : {}),
        duplicateOf: result.duplicateOf,
        ...(lockConflict !== undefined ? { lockConflict } : {}),
        broadcasts: [],
      };
    }

    const eventRevision = result.eventRevision as number;
    const snapshot = this.snapshot(envelope.session);
    const mutation: PersistedMutation = {
      event: {
        session: envelope.session,
        eventRevision,
        eventId: envelope.eventId,
        type: envelope.type,
        deviceId: envelope.deviceId,
        payloadJson: JSON.stringify(envelope.payload),
        replayCounter: envelope.replay.counter,
        createdAt: new Date().toISOString(),
      },
      audits: audits.map((audit) => ({ ...audit, session: envelope.session })),
      snapshot,
      ...(effects.dependencyGraph !== undefined
        ? { dependencyGraph: effects.dependencyGraph }
        : {}),
    };

    // Event, idempotency index, audit, snapshot, and graph are one durable
    // unit. Do not publish or acknowledge before this transaction succeeds.
    try {
      this.store.commitMutation(mutation);
    } catch {
      return this.failClosedAfterPersistenceFailure(
        stateBefore,
        key,
        hadCachedDependencyGraph,
        cachedDependencyGraph,
      );
    }

    if (effects.dependencyGraph !== undefined) {
      this.dependencyGraphs.set(key, effects.dependencyGraph);
    }

    // The durable commit succeeded, so these in-memory sync entries can now be
    // safely exposed to peers.
    for (const update of broadcasts) {
      this.eventLog.append(envelope.session, update);
    }

    // The member just acted, so refresh its liveness activity (Req 3.1).
    this.liveness.recordActivity(envelope.session, member.memberId, Date.now());

    return {
      accepted: true,
      eventRevision,
      ...(acknowledgement.lockConflict !== undefined
        ? { lockConflict: acknowledgement.lockConflict }
        : {}),
      broadcasts,
      ...(messageUpdates.length > 0 ? { messageUpdates } : {}),
      ...(taskUpdates.length > 0 ? { taskUpdates } : {}),
      ...(notifications.length > 0 ? { notifications } : {}),
      ...(lunaOut.reply !== undefined ? { lunaReply: lunaOut.reply } : {}),
      ...(diffUpdates.length > 0 ? { diffUpdates } : {}),
    };
  }

  /**
   * Apply a validated, accepted event to authoritative state, collecting the
   * broadcasts and audit records it produces. Returns an error descriptor when
   * the event is rejected by a business rule (holder/owner checks, override
   * reason, intent validation) before it mutates any registry; otherwise
   * `undefined`.
   */
  private apply(
    envelope: TypedEventEnvelope,
    eventRevision: number,
    member: MemberRef,
    broadcasts: CoordinationUpdate[],
    audits: AuditRecord[],
    acknowledgement: { lockConflict?: EventAppliedLockConflict },
    effects: MutationEffects,
    messageUpdates: MessageBroadcast[],
    taskUpdates: TaskBroadcast[],
    notifications: NotificationDto[],
    lunaOut: { reply?: LunaReplyDto },
    diffUpdates: DiffBroadcast[],
  ): { code: ErrorCode; reason: string } | undefined {
    const session = envelope.session;
    const now = new Date().toISOString();

    // Emit a notification to `toMemberId` unless it is the acting member's own
    // action (Req 3.2.3). Recorded durably (via snapshot) and returned for live
    // delivery. Each notification gets its own fresh Event_Revision.
    const emitNotification = (
      toMemberId: string,
      source: NotificationDto["source"],
      refId: string,
      summary: string,
      priority?: "fyi" | "normal" | "urgent",
    ): void => {
      if (toMemberId === "" || toMemberId === member.memberId) {
        return;
      }
      const notification = buildNotification({
        notificationId: `${envelope.eventId}-n${(this.notificationSeq += 1)}`,
        toMemberId,
        source,
        refId,
        summary,
        eventRevision: this.revisions.next(session),
        ...(priority !== undefined ? { priority } : {}),
      });
      this.notificationsRegistry.add(session, notification);
      notifications.push(notification);
    };

    switch (envelope.type) {
      case "presence.report": {
        const payload = envelope.payload as PresenceReportPayload;
        this.presence.report({
          session,
          member,
          path: payload.path,
          state: payload.state,
          eventRevision,
        });
        broadcasts.push({
          entryType: "presence",
          op: payload.state === "stopped" ? "removed" : "added",
          path: payload.path,
          member,
          eventRevision,
        });
        return undefined;
      }

      case "lock.acquire": {
        const payload = envelope.payload as LockAcquirePayload;
        const previousWinner = this.locks.winningLock(
          session,
          payload.scope,
          payload.scopeKind,
          session.branch,
        );
        const outcome = this.locks.acquire({
          session,
          lockId: envelope.eventId,
          scope: payload.scope,
          scopeKind: payload.scopeKind,
          mode: payload.mode,
          holder: member,
          branch: session.branch,
          eventRevision,
          acquiredAt: now,
        });
        this.captureLockConflict(
          payload.scope,
          outcome.winner,
          outcome.contended,
          acknowledgement,
        );
        this.emitWinningLockTransition(
          previousWinner,
          outcome.winner,
          this.revisionAllocator(session, eventRevision),
          broadcasts,
        );
        return undefined;
      }

      case "lock.override": {
        const payload = envelope.payload as LockOverridePayload;
        const validated = validateOverride({
          session,
          member,
          scope: payload.scope,
          overrideReason: payload.overrideReason,
          eventRevision,
          at: now,
        });
        if (!validated.ok) {
          return {
            code: validated.code,
            reason:
              "Coordination-required override requires an Override_Reason.",
          };
        }
        const previousWinner = this.locks.winningLock(
          session,
          payload.scope,
          payload.scopeKind,
          session.branch,
        );
        const outcome = this.locks.acquire({
          session,
          lockId: envelope.eventId,
          scope: payload.scope,
          scopeKind: payload.scopeKind,
          mode: payload.mode,
          holder: member,
          branch: session.branch,
          eventRevision,
          acquiredAt: now,
        });
        this.captureLockConflict(
          payload.scope,
          outcome.winner,
          outcome.contended,
          acknowledgement,
        );
        audits.push(validated.audit);
        this.emitWinningLockTransition(
          previousWinner,
          outcome.winner,
          this.revisionAllocator(session, eventRevision),
          broadcasts,
        );
        return undefined;
      }

      case "lock.release": {
        const payload = envelope.payload as LockReleasePayload;
        const release = this.locks.release({
          session,
          requester: member,
          branch: session.branch,
          ...(payload.lockId !== undefined ? { lockId: payload.lockId } : {}),
          ...(payload.scope !== undefined ? { scope: payload.scope } : {}),
        });
        if (!release.ok) {
          return {
            code: release.code,
            reason:
              release.code === "NOT_LOCK_HOLDER"
                ? "Release attempted by a non-holder."
                : "No active lock to release.",
          };
        }
        // The registry only permits release of the current winner, so the
        // released lock is the definitive previous client-facing projection.
        this.emitWinningLockTransition(
          release.released,
          release.promoted,
          this.revisionAllocator(session, eventRevision),
          broadcasts,
        );
        return undefined;
      }

      case "intent.declare": {
        const payload = envelope.payload as IntentDeclarePayload;
        const declared = this.intents.declare({
          session,
          intentId: envelope.eventId,
          owner: member,
          agentId: member.deviceId,
          modifyPaths: payload.modifyPaths,
          createPaths: payload.createPaths,
          scopeKind: "file",
          branch: session.branch,
          description: payload.description,
          eventRevision,
        });
        if (!declared.ok) {
          return {
            code: declared.code,
            reason:
              declared.errors?.join("; ") ?? "Intent declaration rejected.",
          };
        }
        this.emitIntentBroadcasts(
          declared.intent,
          "added",
          this.revisionAllocator(session, eventRevision),
          broadcasts,
        );
        audits.push({
          member,
          action: "create",
          targetScope:
            declared.intent.modifyPaths[0] ??
            declared.intent.createPaths[0]?.path ??
            "",
          eventRevision,
          time: now,
        });
        return undefined;
      }

      case "intent.update": {
        const payload = envelope.payload as IntentUpdatePayload;
        // Keep the old projection long enough to retire every cached path
        // before publishing the replacement. Without those removals, an agent
        // that receives an intent update could keep showing paths that are no
        // longer part of the task until it next receives a full snapshot.
        const previous = this.intents
          .allIntents(session)
          .find((intent) => intent.intentId === payload.intentId);
        const updated = this.intents.update({
          session,
          intentId: payload.intentId,
          requester: member,
          modifyPaths: payload.modifyPaths,
          createPaths: payload.createPaths,
          description: payload.description,
          eventRevision,
        });
        if (!updated.ok) {
          return {
            code: updated.code,
            reason: updated.errors?.join("; ") ?? "Intent update rejected.",
          };
        }
        const allocate = this.revisionAllocator(session, eventRevision);
        if (previous !== undefined) {
          this.emitIntentBroadcasts(previous, "removed", allocate, broadcasts);
        }
        this.emitIntentBroadcasts(
          updated.intent,
          "added",
          allocate,
          broadcasts,
        );
        audits.push({
          member,
          action: "update",
          targetScope: updated.intent.modifyPaths[0] ?? "",
          eventRevision,
          time: now,
        });
        return undefined;
      }

      case "intent.withdraw": {
        const payload = envelope.payload as IntentWithdrawPayload;
        const withdrawn = this.intents.withdraw({
          session,
          intentId: payload.intentId,
          requester: member,
        });
        if (!withdrawn.ok) {
          return {
            code: withdrawn.code,
            reason: "Intent withdrawal rejected.",
          };
        }
        this.emitIntentBroadcasts(
          withdrawn.removed,
          "removed",
          this.revisionAllocator(session, eventRevision),
          broadcasts,
        );
        audits.push({
          member,
          action: "withdraw",
          targetScope: withdrawn.removed.modifyPaths[0] ?? "",
          eventRevision,
          time: now,
        });
        return undefined;
      }

      case "path.renamed": {
        const payload = envelope.payload as PathRenamedPayload;
        this.applyRename(
          session,
          member,
          payload,
          eventRevision,
          broadcasts,
          audits,
          now,
        );
        return undefined;
      }

      case "path.deleted": {
        const payload = envelope.payload as PathDeletedPayload;
        this.applyDelete(
          session,
          member,
          payload,
          eventRevision,
          broadcasts,
          audits,
          now,
        );
        return undefined;
      }

      case "file.created": {
        const payload = envelope.payload as FileCreatedPayload;
        const allocate = this.revisionAllocator(session, eventRevision);
        // Record the created path as tracked and retire any matching
        // Planned_File_Creation on active intents (Req 17.2, 17.3).
        const reconciled = this.intents.reconcileCreation(
          session,
          payload.path,
        );
        for (const intent of reconciled.removedFrom) {
          broadcasts.push({
            entryType: "planned_file_creation",
            op: "removed",
            path: payload.path,
            member: intent.owner,
            eventRevision: allocate(),
            intent: {
              intentId: intent.intentId,
              description: intent.description,
            },
          });
        }
        return undefined;
      }

      case "intent.progress": {
        // Progress is advisory: it reports how far an owned intent has gotten
        // but changes none of the authoritative coordination state (locks,
        // intents, presence) and is not part of the broadcast
        // Coordination_Update model (design §4.3). The event is still validated,
        // persisted, and revision-stamped by the ingest pipeline; there is
        // simply nothing to mutate or broadcast here.
        return undefined;
      }

      case "dep.snapshot": {
        const payload = envelope.payload as DepSnapshotPayload;
        // Defer this cache/store update until it can commit with the Event_ID
        // and authoritative snapshot as one transaction.
        effects.dependencyGraph = payload.graph;
        return undefined;
      }

      case "dep.delta": {
        const payload = envelope.payload as DepDeltaPayload;
        effects.dependencyGraph = this.mergeDependencyDelta(session, payload);
        return undefined;
      }

      case "message.send": {
        const payload = envelope.payload as MessageSendPayload;
        const result = this.messages.append({
          session,
          messageId: envelope.eventId,
          kind: payload.kind,
          sender: member,
          ...(payload.toMemberId !== undefined
            ? { toMemberId: payload.toMemberId }
            : {}),
          priority: payload.priority ?? "normal",
          body: payload.body,
          ...(payload.correlationId !== undefined
            ? { correlationId: payload.correlationId }
            : {}),
          eventRevision,
          sentAt: now,
        });
        messageUpdates.push({
          op: "added",
          message: result.message,
          audience: messageAudience(result.message),
        });
        // Notify the recipient for questions and urgent directed messages
        // (Req 3.2). Broadcasts alert via the message priority on the client.
        if (result.message.toMemberId !== undefined) {
          if (result.message.kind === "question") {
            emitNotification(
              result.message.toMemberId,
              "question",
              result.message.messageId,
              `${member.memberId} asked you a question`,
            );
          } else if (result.message.priority === "urgent") {
            emitNotification(
              result.message.toMemberId,
              "message",
              result.message.messageId,
              `Urgent message from ${member.memberId}`,
              "urgent",
            );
          }
        }
        // An answer flips its correlated question to `answered`; surface the
        // updated question to that question's audience so the asker sees it.
        if (result.answeredQuestion !== undefined) {
          messageUpdates.push({
            op: "updated",
            message: result.answeredQuestion,
            audience: messageAudience(result.answeredQuestion),
          });
        }
        return undefined;
      }

      case "message.read": {
        const payload = envelope.payload as MessageReadPayload;
        // Read state is tracked live; it is intentionally not part of the
        // authoritative snapshot in Phase 1 (see messaging.ts). No broadcast.
        this.messages.markRead(session, payload.messageId, member.memberId);
        return undefined;
      }

      case "task.assign": {
        const payload = envelope.payload as TaskAssignPayload;
        // A task targets a member (not a device); assignee.deviceId is unknown
        // at assign time and unused by the lifecycle's authorization checks.
        const result = this.tasks.assign({
          session,
          taskId: envelope.eventId,
          title: payload.title,
          description: payload.description,
          assignee: { memberId: payload.assigneeMemberId, deviceId: "" },
          assigner: member,
          eventRevision,
        });
        if (!result.ok) {
          return { code: result.code, reason: result.reason };
        }
        taskUpdates.push({ op: "added", task: result.task });
        // Notify the assignee of the incoming task awaiting approval (Req 3.2).
        emitNotification(
          result.task.assignee.memberId,
          "task",
          result.task.taskId,
          `${member.memberId} assigned you: ${result.task.title}`,
        );
        audits.push({
          member,
          action: "create",
          targetScope: `task:${result.task.taskId}`,
          eventRevision,
          time: now,
        });
        return undefined;
      }

      case "task.respond": {
        const payload = envelope.payload as TaskRespondPayload;
        const result = this.tasks.respond({
          session,
          taskId: payload.taskId,
          requester: member,
          accept: payload.accept,
          eventRevision,
        });
        if (!result.ok) {
          return { code: result.code, reason: result.reason };
        }
        taskUpdates.push({ op: "updated", task: result.task });
        audits.push({
          member,
          action: "update",
          targetScope: `task:${result.task.taskId}`,
          eventRevision,
          time: now,
        });
        return undefined;
      }

      case "task.progress": {
        const payload = envelope.payload as TaskProgressPayload;
        const result = this.tasks.progress({
          session,
          taskId: payload.taskId,
          requester: member,
          status: payload.status,
          eventRevision,
        });
        if (!result.ok) {
          return { code: result.code, reason: result.reason };
        }
        taskUpdates.push({ op: "updated", task: result.task });
        audits.push({
          member,
          action: "update",
          targetScope: `task:${result.task.taskId}`,
          eventRevision,
          time: now,
        });
        return undefined;
      }

      case "task.withdraw": {
        const payload = envelope.payload as TaskWithdrawPayload;
        const result = this.tasks.withdraw({
          session,
          taskId: payload.taskId,
          requester: member,
          eventRevision,
        });
        if (!result.ok) {
          return { code: result.code, reason: result.reason };
        }
        taskUpdates.push({ op: "updated", task: result.task });
        audits.push({
          member,
          action: "withdraw",
          targetScope: `task:${result.task.taskId}`,
          eventRevision,
          time: now,
        });
        return undefined;
      }

      case "wake.request": {
        const payload = envelope.payload as WakeRequestPayload;
        // A wake is delivered as a notification to the target (Req 3.3); it is
        // surfaced at the target's next action rather than interrupting it.
        emitNotification(
          payload.targetMemberId,
          "wake",
          payload.targetMemberId,
          payload.reason !== undefined && payload.reason.length > 0
            ? `${member.memberId}: ${payload.reason}`
            : `${member.memberId} asked you to resume`,
        );
        return undefined;
      }

      case "luna.request": {
        const payload = envelope.payload as LunaRequestPayload;
        const context: LunaContext = {
          session,
          requester: member,
          members: this.sessionMemberIds(session),
          liveness: this.liveness.states(session, Date.now()),
          tasks: this.tasks.allTasks(session),
        };
        // The default Luna brain is synchronous and deterministic (Req 4.1).
        const decision = this.luna.decide(payload, context);
        const reply: LunaReplyDto = {
          action: decision.action,
          summary: decision.summary,
        };

        // Luna routes an assignment as a proposed Task assigned by Luna (Req 4.2).
        if (decision.assignment !== undefined) {
          const taskId = `${envelope.eventId}-luna-task`;
          const taskRev = this.revisions.next(session);
          const assigned = this.tasks.assign({
            session,
            taskId,
            title: decision.assignment.title,
            description: decision.assignment.description,
            assignee: {
              memberId: decision.assignment.assigneeMemberId,
              deviceId: "",
            },
            assigner: LUNA_MEMBER,
            eventRevision: taskRev,
          });
          if (assigned.ok) {
            taskUpdates.push({ op: "added", task: assigned.task });
            reply.producedTaskId = taskId;
            emitNotification(
              decision.assignment.assigneeMemberId,
              "task",
              taskId,
              `Luna assigned you: ${decision.assignment.title}`,
            );
          }
        }

        // Luna communicates arbitration/answers as a Message from Luna (Req 4.3, 4.4).
        if (decision.message !== undefined) {
          const messageId = `${envelope.eventId}-luna-msg`;
          const msgRev = this.revisions.next(session);
          const kind =
            decision.message.toMemberId !== undefined ? "direct" : "broadcast";
          const appended = this.messages.append({
            session,
            messageId,
            kind,
            sender: LUNA_MEMBER,
            ...(decision.message.toMemberId !== undefined
              ? { toMemberId: decision.message.toMemberId }
              : {}),
            priority: "normal",
            body: decision.message.body,
            eventRevision: msgRev,
            sentAt: now,
          });
          messageUpdates.push({
            op: "added",
            message: appended.message,
            audience: messageAudience(appended.message),
          });
          reply.producedMessageId = messageId;
        }

        lunaOut.reply = reply;
        return undefined;
      }

      case "diff.share": {
        // Opt-in Live_Diff sharing (Phase 5; Req 5.1–5.4). When the team has not
        // enabled it, reject so the host behaves exactly as V1 (metadata only).
        if (!this.liveDiffsEnabled) {
          return {
            code: "AUTH_NOT_AUTHORIZED",
            reason:
              "Live_Diff sharing is disabled for this team; enable liveDiffs in .coordination/config.json to share diffs.",
          };
        }
        const payload = envelope.payload as DiffSharePayload;
        const path = normalizePath(payload.path);
        const diff: LiveDiffDto = {
          path,
          member,
          patch: payload.patch,
          eventRevision,
        };
        const op = this.diffs.share(session, diff);
        // Broadcast the authoritative diff (or its removal) to the whole trusted
        // session — authorized members only (Req 5.2). On removal the stored diff
        // is gone, so echo the request's (empty-patch) diff for the update.
        const shared =
          op === "shared"
            ? (this.diffs.get(session, member.memberId, path) ?? diff)
            : diff;
        diffUpdates.push({ op, diff: shared });
        audits.push({
          member,
          action: op === "shared" ? "update" : "withdraw",
          targetScope: `diff:${path}`,
          eventRevision,
          time: now,
        });
        return undefined;
      }

      default:
        // Any remaining message types are accepted and recorded but produce no
        // coordination broadcast.
        return undefined;
    }
  }

  /**
   * Apply a confirmed rename/move (Req 30.2, 30.3): transfer the sender's lock
   * from the old path to the new one, follow the file in every intent that
   * referenced it, and emit the corresponding removal/addition broadcasts so
   * every agent's cached view converges.
   */
  private applyRename(
    session: SessionId,
    member: MemberRef,
    payload: PathRenamedPayload,
    eventRevision: number,
    broadcasts: CoordinationUpdate[],
    audits: AuditRecord[],
    now: string,
  ): void {
    const allocate = this.revisionAllocator(session, eventRevision);

    // Classify how each affected member's intent referenced the old path BEFORE
    // the rewrite, so removals carry the correct entry type.
    const before = this.intents.allIntents(session);
    const fromKey = normalizePath(payload.fromPath);
    const sourceWinner = this.locks.winningLock(
      session,
      payload.fromPath,
      "file",
      session.branch,
    );
    const destinationWinner = this.locks.winningLock(
      session,
      payload.toPath,
      "file",
      session.branch,
    );

    const moved = this.locks.transferPath({
      session,
      member,
      fromScope: payload.fromPath,
      toScope: payload.toPath,
      scopeKind: "file",
      branch: session.branch,
      eventRevision,
    });
    if (moved !== undefined) {
      this.emitWinningLockTransition(
        sourceWinner,
        this.locks.winningLock(
          session,
          payload.fromPath,
          "file",
          session.branch,
        ),
        allocate,
        broadcasts,
      );
      this.emitWinningLockTransition(
        destinationWinner,
        this.locks.winningLock(session, payload.toPath, "file", session.branch),
        allocate,
        broadcasts,
      );
    }

    const updated = this.intents.renamePath(
      session,
      payload.fromPath,
      payload.toPath,
    );
    for (const intent of updated) {
      const priorForOwner = before.find((i) => i.intentId === intent.intentId);
      const wasModify =
        priorForOwner?.modifyPaths.some((p) => normalizePath(p) === fromKey) ??
        false;
      const wasCreate =
        priorForOwner?.createPaths.some(
          (creation) => normalizePath(creation.path) === fromKey,
        ) ?? false;
      const emitMove = (
        entryType: "intent" | "planned_file_creation",
      ): void => {
        broadcasts.push({
          entryType,
          op: "removed",
          path: payload.fromPath,
          member: intent.owner,
          eventRevision: allocate(),
          intent: {
            intentId: intent.intentId,
            description: intent.description,
          },
        });
        broadcasts.push({
          entryType,
          op: "added",
          path: payload.toPath,
          member: intent.owner,
          eventRevision: allocate(),
          intent: {
            intentId: intent.intentId,
            description: intent.description,
          },
        });
      };
      if (wasModify) {
        emitMove("intent");
      }
      if (wasCreate) {
        emitMove("planned_file_creation");
      }
    }

    audits.push({
      member,
      action: "update",
      targetScope: payload.toPath,
      eventRevision,
      time: now,
    });
  }

  /**
   * Apply a confirmed deletion (Req 30.5): release the deleting member's lock on
   * the path and remove the path from that member's intents, emitting removals.
   */
  private applyDelete(
    session: SessionId,
    member: MemberRef,
    payload: PathDeletedPayload,
    eventRevision: number,
    broadcasts: CoordinationUpdate[],
    audits: AuditRecord[],
    now: string,
  ): void {
    const allocate = this.revisionAllocator(session, eventRevision);
    const key = normalizePath(payload.path);

    // Classify the member's references to the path before removing them.
    const owned = this.intents
      .allIntents(session)
      .filter((i) => i.owner.memberId === member.memberId);
    const previousWinner = this.locks.winningLock(
      session,
      payload.path,
      "file",
      session.branch,
    );

    const released = this.locks.releaseOnDelete(
      session,
      payload.path,
      "file",
      session.branch,
      member,
    );
    if (released !== undefined) {
      this.emitWinningLockTransition(
        previousWinner,
        this.locks.winningLock(session, payload.path, "file", session.branch),
        allocate,
        broadcasts,
      );
    }

    const updated = this.intents.deletePathForMember(
      session,
      payload.path,
      member,
    );
    if (updated.length > 0) {
      const updatedIds = new Set(updated.map((intent) => intent.intentId));
      for (const intent of owned) {
        if (!updatedIds.has(intent.intentId)) {
          continue;
        }
        const intentWasModify = intent.modifyPaths.some(
          (path) => normalizePath(path) === key,
        );
        const intentWasCreate = intent.createPaths.some(
          (creation) => normalizePath(creation.path) === key,
        );
        if (intentWasModify) {
          broadcasts.push({
            entryType: "intent",
            op: "removed",
            path: payload.path,
            member: intent.owner,
            eventRevision: allocate(),
            intent: {
              intentId: intent.intentId,
              description: intent.description,
            },
          });
        }
        if (intentWasCreate) {
          broadcasts.push({
            entryType: "planned_file_creation",
            op: "removed",
            path: payload.path,
            member: intent.owner,
            eventRevision: allocate(),
            intent: {
              intentId: intent.intentId,
              description: intent.description,
            },
          });
        }
      }
    }

    audits.push({
      member,
      action: "update",
      targetScope: payload.path,
      eventRevision,
      time: now,
    });
  }

  /**
   * Merge an incremental Dependency_Graph delta (Req 19.4) on top of the
   * current graph. Persistence is deliberately deferred to the event commit so
   * a graph cannot get ahead of its corresponding event/snapshot.
   */
  private mergeDependencyDelta(
    session: SessionId,
    delta: DepDeltaPayload,
  ): DependencyGraph {
    const key = sessionKey(session);
    const current =
      this.dependencyGraphs.get(key) ??
      this.store.getDependencyGraph(session) ??
      this.emptyGraph(session);

    const modules = current.modules.map((m) => ({
      sourceFile: m.sourceFile,
      edges: [...m.edges],
    }));
    const moduleByFile = new Map(modules.map((m) => [m.sourceFile, m]));
    const edgeKey = (from: string, to: string, kind: string): string =>
      `${from}\u0000${to}\u0000${kind}`;

    for (const change of delta.changedEdges) {
      let mod = moduleByFile.get(change.from);
      if (mod === undefined) {
        mod = { sourceFile: change.from, edges: [] };
        moduleByFile.set(change.from, mod);
        modules.push(mod);
      }
      if (change.op === "remove") {
        mod.edges = mod.edges.filter(
          (e) =>
            edgeKey(e.from, e.to, e.kind) !==
            edgeKey(change.from, change.to, change.kind),
        );
      } else {
        const exists = mod.edges.some(
          (e) =>
            edgeKey(e.from, e.to, e.kind) ===
            edgeKey(change.from, change.to, change.kind),
        );
        if (!exists) {
          mod.edges.push({
            from: change.from,
            to: change.to,
            kind: change.kind,
            confidence: change.confidence,
          });
        }
      }
    }

    // Apply contract changes: an empty fingerprint signals removal.
    const contracts = new Map(current.contracts.map((c) => [c.id, c]));
    for (const contract of delta.changedContracts) {
      if (contract.fingerprint === "") {
        contracts.delete(contract.id);
      } else {
        contracts.set(contract.id, contract);
      }
    }

    const merged: DependencyGraph = {
      snapshot: {
        sessionId: session,
        graphVersion: current.snapshot.graphVersion + 1,
        analyzerVersion: current.snapshot.analyzerVersion,
      },
      packages: current.packages,
      modules: modules.filter((m) => m.edges.length > 0),
      contracts: [...contracts.values()],
    };
    return merged;
  }

  /** An empty Dependency_Graph for a session (delta baseline). */
  private emptyGraph(session: SessionId): DependencyGraph {
    return {
      snapshot: {
        sessionId: session,
        graphVersion: 0,
        analyzerVersion: "unknown",
      },
      packages: [],
      modules: [],
      contracts: [],
    };
  }

  /**
   * A per-event revision allocator. A single ingested event can produce several
   * coordination broadcasts (e.g. a multi-path Declared_Intent, or a release
   * plus a promotion); each must carry its OWN strictly-increasing
   * Event_Revision so the coordination event log stays strictly ordered
   * (Req 8.1) and every agent cache applies all of them rather than dropping
   * later broadcasts that share a revision (Req 9.3). The first allocation
   * reuses the event's assigned revision; subsequent ones advance the shared
   * monotonic counter.
   */
  private revisionAllocator(session: SessionId, first: number): () => number {
    let used = false;
    return () => {
      if (!used) {
        used = true;
        return first;
      }
      return this.revisions.next(session);
    };
  }

  /**
   * Project only a lock group's current winner into the agent cache. The host
   * retains concurrent claims internally for deterministic promotion, but a
   * client must never see a losing claim as an active lock. Emitting the state
   * transition here keeps incremental broadcasts identical to snapshot
   * projection across acquisition, release, rename, and deletion.
   */
  private emitWinningLockTransition(
    previous: Lock | undefined,
    next: Lock | undefined,
    allocate: () => number,
    broadcasts: CoordinationUpdate[],
  ): void {
    if (previous?.lockId === next?.lockId) {
      return;
    }
    if (previous !== undefined) {
      broadcasts.push({
        entryType: "soft_lock",
        op: "removed",
        path: previous.scope,
        member: previous.holder,
        eventRevision: allocate(),
      });
    }
    if (next !== undefined) {
      broadcasts.push({
        entryType: "soft_lock",
        op: "added",
        path: next.scope,
        member: next.holder,
        eventRevision: allocate(),
      });
    }
  }

  /** Record the winner only for an accepted lock claim that lost contention. */
  private captureLockConflict(
    scope: string,
    winner: Lock,
    contended: boolean,
    acknowledgement: { lockConflict?: EventAppliedLockConflict },
  ): void {
    if (!contended) {
      return;
    }
    acknowledgement.lockConflict = {
      scope,
      winner: {
        memberId: winner.holder.memberId,
        eventRevision: winner.eventRevision,
      },
    };
  }

  /**
   * Recover lock-loss metadata for a duplicate Event_ID without reapplying it.
   * The acknowledgement reports the current authoritative winner, which is the
   * only safe result to surface after intervening promotions or releases.
   */
  private currentLockConflict(
    envelope: TypedEventEnvelope,
    member: MemberRef,
  ): EventAppliedLockConflict | undefined {
    let payload: LockAcquirePayload | LockOverridePayload;
    if (envelope.type === "lock.acquire") {
      payload = envelope.payload as LockAcquirePayload;
    } else if (envelope.type === "lock.override") {
      payload = envelope.payload as LockOverridePayload;
    } else {
      return undefined;
    }
    const winner = this.locks.winningLock(
      envelope.session,
      payload.scope,
      payload.scopeKind,
      envelope.session.branch,
    );
    if (winner === undefined || winner.holder.memberId === member.memberId) {
      return undefined;
    }
    return {
      scope: payload.scope,
      winner: {
        memberId: winner.holder.memberId,
        eventRevision: winner.eventRevision,
      },
    };
  }

  private emitIntentBroadcasts(
    intent: {
      intentId: string;
      description: string;
      modifyPaths: readonly string[];
      createPaths: readonly { path: string }[];
      owner: MemberRef;
    },
    op: "added" | "removed",
    allocate: () => number,
    broadcasts: CoordinationUpdate[],
  ): void {
    for (const path of intent.modifyPaths) {
      broadcasts.push({
        entryType: "intent",
        op,
        path,
        member: intent.owner,
        eventRevision: allocate(),
        intent: {
          intentId: intent.intentId,
          description: intent.description,
        },
      });
    }
    for (const creation of intent.createPaths) {
      broadcasts.push({
        entryType: "planned_file_creation",
        op,
        path: creation.path,
        member: intent.owner,
        eventRevision: allocate(),
        intent: {
          intentId: intent.intentId,
          description: intent.description,
        },
      });
    }
  }

  /**
   * Data-minimization gate for one inbound envelope (Req 29.5, 1.4). Returns a
   * `ProtocolError` to reject with, or `undefined` when clean. For
   * `message.send`, the free-text `body` is allowed team content but its value
   * is still scanned for secrets/absolute/out-of-tree/excluded paths (Req 1.4);
   * the remaining envelope fields are checked by the standard gate.
   */
  private checkEventMinimization(
    envelope: EventEnvelope,
  ): { code: ErrorCode; message: string } | undefined {
    if (envelope.type === "message.send") {
      const payload = envelope.payload as MessageSendPayload;
      const bodyViolations = findMinimizationViolations(payload.body);
      if (bodyViolations.length > 0) {
        return {
          code: "FORMAT_ERROR",
          message: `data-minimization violation in message body: ${bodyViolations[0]!.message}`,
        };
      }
      // Check the rest of the envelope (without the free-text body) normally.
      const { body: _body, ...restPayload } = payload;
      void _body;
      const rest = { ...envelope, payload: restPayload };
      const check = checkInboundMinimization(rest);
      return check.ok ? undefined : check.error;
    }
    if (envelope.type === "diff.share") {
      // A Live_Diff `patch` is opt-in source-derived team content (Phase 5;
      // Req 5.1, 5.3). It is allowed by field name only when the feature is
      // enabled, but its value is still scanned for secrets/absolute/out-of-tree/
      // excluded paths so credentials are never shared even inside a diff.
      const payload = envelope.payload as DiffSharePayload;
      const patchViolations = findMinimizationViolations(payload.patch);
      if (patchViolations.length > 0) {
        return {
          code: "FORMAT_ERROR",
          message: `data-minimization violation in live diff patch: ${patchViolations[0]!.message}`,
        };
      }
      // Check the rest of the envelope (without the free-text patch) normally.
      const { patch: _patch, ...restPayload } = payload;
      void _patch;
      const rest = { ...envelope, payload: restPayload };
      const check = checkInboundMinimization(rest);
      return check.ok ? undefined : check.error;
    }
    const check = checkInboundMinimization(envelope);
    return check.ok ? undefined : check.error;
  }

  /** The gate's permission predicate: the sender must be admitted (Req 7.7, 10.7). */
  private checkPermission(
    envelope: TypedEventEnvelope,
  ):
    | { permitted: true }
    | { permitted: false; code: ErrorCode; reason: string } {
    const registry = this.membershipBySession.get(sessionKey(envelope.session));
    if (registry === undefined) {
      return {
        permitted: false,
        code: "AUTH_SESSION_FORBIDDEN",
        reason: "Unknown session.",
      };
    }
    const entry = registry.find(
      (e) => deriveDeviceId(e.devicePublicKey) === envelope.deviceId,
    );
    if (entry === undefined || entry.revoked || !entry.invitationValid) {
      return {
        permitted: false,
        code: "AUTH_NOT_AUTHORIZED",
        reason: "Sender is not authorized for this session.",
      };
    }
    return { permitted: true };
  }

  // -------------------------------------------------------------------------
  // Sync-from-revision (Req 9; design §4.6)
  // -------------------------------------------------------------------------

  /**
   * Serve a reconnect sync request (Req 9.2–9.5): incremental `sync.events` for
   * revisions `> fromRevision`, or a full `sync.snapshot` fallback built from the
   * authoritative registries when incremental service is impossible.
   */
  syncFrom(session: SessionId, fromRevision: number): SyncResult {
    const snapshot = serializeSessionState(session, this.registries);
    return this.eventLog.syncFrom(session, fromRevision, snapshot);
  }

  /** The current authoritative snapshot for a session (Req 9.5). */
  snapshot(session: SessionId) {
    return serializeSessionState(session, this.registries);
  }

  /**
   * Messages visible to `memberId` with an Event_Revision greater than
   * `fromRevision` (Phase 1; Req 1.4, X.2). The server sends these to a
   * reconnecting member after `sync.request` so messages sent while it was
   * offline are delivered — incremental `sync.events` only carries
   * CoordinationUpdates, so messages ride this parallel channel. Delivery is
   * idempotent: the agent keys messages by `messageId`.
   */
  messagesSince(
    session: SessionId,
    fromRevision: number,
    memberId: string,
  ): MessageDto[] {
    return this.messages
      .messagesFor(session, memberId)
      .filter((message) => message.eventRevision > fromRevision);
  }

  /**
   * Tasks with an Event_Revision greater than `fromRevision` (Phase 2; Req 2.1,
   * X.2). The server resends these as `task.update` to a reconnecting member so
   * task changes made while it was offline are delivered over the parallel task
   * channel (incremental `sync.events` carries only CoordinationUpdates).
   */
  tasksSince(session: SessionId, fromRevision: number): TaskDto[] {
    return this.tasks
      .allTasks(session)
      .filter((task) => task.eventRevision > fromRevision);
  }

  /**
   * Currently-shared Live_Diffs with an Event_Revision greater than
   * `fromRevision` (Phase 5; Req 5.1–5.3, X.2). Empty unless the opt-in is
   * enabled. The server resends these as `diff.update` to a reconnecting member
   * so diffs shared while it was offline are delivered over the parallel diff
   * channel (incremental `sync.events` carries only CoordinationUpdates).
   */
  diffsSince(session: SessionId, fromRevision: number): LiveDiffDto[] {
    if (!this.liveDiffsEnabled) {
      return [];
    }
    return this.diffs.since(session, fromRevision);
  }

  /** All currently-shared Live_Diffs for a session (for a list_diffs query). */
  allDiffs(session: SessionId): LiveDiffDto[] {
    return this.liveDiffsEnabled ? this.diffs.allDiffs(session) : [];
  }

  // -------------------------------------------------------------------------
  // Liveness & notifications (Phase 3; Req 3.1–3.3)
  // -------------------------------------------------------------------------

  /** Set the live member roster used for liveness derivation (Req 3.1). */
  setLiveRoster(session: SessionId, connectedMemberIds: Iterable<string>): void {
    this.liveness.setConnected(session, connectedMemberIds);
  }

  /** Record that a member acted (heartbeat/auth), refreshing its liveness (Req 3.1). */
  recordMemberActivity(
    session: SessionId,
    memberId: string,
    atMs: number = Date.now(),
  ): void {
    this.liveness.recordActivity(session, memberId, atMs);
  }

  /** Current liveness state of every known member (Req 3.1). */
  livenessStates(
    session: SessionId,
    nowMs: number = Date.now(),
  ): { memberId: string; state: LivenessState }[] {
    return this.liveness.states(session, nowMs);
  }

  /**
   * Members whose derived liveness changed since the last call (Req 3.1). The
   * server broadcasts a `liveness.update` for each. The advisory `eventRevision`
   * is the session's current highest revision (liveness is derived, not an
   * ordered coordination event, so it is applied by memberId, not by revision).
   */
  livenessChanges(
    session: SessionId,
    nowMs: number = Date.now(),
  ): LivenessBroadcast[] {
    const key = sessionKey(session);
    const previous = this.lastLiveness.get(key) ?? new Map<string, LivenessState>();
    const current = new Map<string, LivenessState>();
    const changes: LivenessBroadcast[] = [];
    const revision = this.revisions.highest(session);
    for (const { memberId, state } of this.liveness.states(session, nowMs)) {
      current.set(memberId, state);
      if (previous.get(memberId) !== state) {
        changes.push({ memberId, state, eventRevision: revision });
      }
    }
    // A member that dropped out of the roster entirely becomes 'gone'.
    for (const [memberId, prevState] of previous) {
      if (!current.has(memberId) && prevState !== "gone") {
        changes.push({ memberId, state: "gone", eventRevision: revision });
        current.set(memberId, "gone");
      }
    }
    this.lastLiveness.set(key, current);
    return changes;
  }

  /**
   * Notifications for `memberId` with an Event_Revision greater than
   * `fromRevision` (Phase 3; Req 3.2, X.2). The server resends these on
   * reconnect so notifications raised while the member was offline are delivered.
   */
  notificationsSince(
    session: SessionId,
    fromRevision: number,
    memberId: string,
  ): NotificationDto[] {
    return this.notificationsRegistry.since(session, memberId, fromRevision);
  }

  /** All notifications addressed to `memberId` (for a get_notifications query). */
  notificationsFor(session: SessionId, memberId: string): NotificationDto[] {
    return this.notificationsRegistry.forMember(session, memberId);
  }

  /** The admitted, non-revoked member ids for a session (for Luna context). */
  private sessionMemberIds(session: SessionId): string[] {
    const seen = new Set<string>();
    for (const entry of this.membershipBySession.get(sessionKey(session)) ?? []) {
      if (entry.invitationValid && !entry.revoked) {
        seen.add(entry.memberId);
      }
    }
    return [...seen].sort((a, b) => a.localeCompare(b));
  }

  /**
   * The latest metadata-only Dependency_Graph the host holds for a session, or
   * `null` when none has been uploaded (Req 19, 20). The server sends this to a
   * connecting agent so every client shares the same graph for risk analysis.
   */
  dependencyGraph(session: SessionId): DependencyGraph | null {
    const cached = this.dependencyGraphs.get(sessionKey(session));
    if (cached !== undefined) {
      return cached;
    }
    const stored = this.store.getDependencyGraph(session);
    if (stored !== null) {
      this.dependencyGraphs.set(sessionKey(session), stored);
    }
    return stored;
  }

  // -------------------------------------------------------------------------
  // Heartbeats & expiry (Req 26; design §5.2)
  // -------------------------------------------------------------------------

  /** Record a device heartbeat (Req 26.2). */
  recordHeartbeat(
    session: SessionId,
    deviceId: string,
    atMs: number = Date.now(),
  ): void {
    this.expiry.recordHeartbeat(session, deviceId, atMs);
  }

  /**
   * Run the stale lock/intent/presence expiry sweep and the soft-lock max-age
   * sweep for a session (Req 26.3–26.5), logging and persisting removals.
   * Returns the removal updates to broadcast.
   */
  sweepExpiry(
    session: SessionId,
    nowMs: number = Date.now(),
  ): CoordinationUpdate[] {
    // Once a mutation commit fails, no background maintenance may advance the
    // same registries/revisions before a restart reconstructs them from disk.
    if (this.storageFaulted) {
      return [];
    }
    const stateBefore = this.snapshot(session);
    const dependencyGraphKey = sessionKey(session);
    const hadCachedDependencyGraph =
      this.dependencyGraphs.has(dependencyGraphKey);
    const cachedDependencyGraph = this.dependencyGraphs.get(dependencyGraphKey);

    let removals: CoordinationUpdate[];
    try {
      const heartbeatExpiry = this.expiry.sweep(session, nowMs);
      const softLockExpiry = this.expiry.expireStaleSoftLocks(session, nowMs);
      removals = [
        ...heartbeatExpiry.removals,
        ...heartbeatExpiry.promotions,
        ...softLockExpiry.removals,
        ...softLockExpiry.promotions,
      ];
      if (removals.length === 0) {
        return [];
      }
      const at = new Date().toISOString();
      this.store.commitExpiry({
        session,
        audits: removals.map((update) => ({
          session,
          member: update.member,
          action: "expire" as const,
          targetScope: update.path ?? "",
          eventRevision: update.eventRevision,
          time: at,
        })),
        snapshot: this.snapshot(session),
      });
    } catch {
      this.failClosedAfterPersistenceFailure(
        stateBefore,
        dependencyGraphKey,
        hadCachedDependencyGraph,
        cachedDependencyGraph,
      );
      return [];
    }

    // Publish only after the complete expiry result is durable. A restart can
    // then never resurrect work that connected peers were told had expired.
    for (const update of removals) {
      this.eventLog.append(session, update);
    }
    return removals;
  }

  // -------------------------------------------------------------------------
  // Diagnostics (Req 27)
  // -------------------------------------------------------------------------

  /** The audit trail for a session (Req 28). */
  auditRecords(session: SessionId): AuditRecord[] {
    return this.store.auditRecords(session);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** A uniform safe response once this process can no longer trust its gate. */
  private storageFailureOutcome(): IngestOutcome {
    return {
      accepted: false,
      error: "STORAGE_ERROR",
      reason:
        "Host persistence is unavailable; restart the host before submitting more coordination changes.",
      broadcasts: [],
    };
  }

  /**
   * Revert the externally visible registries after a failed atomic commit and
   * fence this authority until restart. `IngestGate` deliberately advances
   * replay/idempotency metadata before invoking its applier; that metadata
   * cannot be safely rewound while preserving its public invariants. The
   * revision counter does have an explicit synchronous checkpoint rollback, so
   * snapshots do not expose a phantom revision. The fail-closed fence prevents
   * the remaining transient gate state from ever being acknowledged. Restart
   * rebuilds it exclusively from the last successful durable transaction.
   */
  private failClosedAfterPersistenceFailure(
    stateBefore: SessionStateSnapshot,
    dependencyGraphKey: string,
    hadCachedDependencyGraph: boolean,
    cachedDependencyGraph: DependencyGraph | undefined,
  ): IngestOutcome {
    this.storageFaulted = true;
    try {
      restoreSessionState(stateBefore, this.registries);
      // `restoreSessionState` deliberately only raises revision counters for
      // normal restart safety. This is a synchronous rollback before any
      // mutation was published, so restore the exact pre-transaction checkpoint
      // to avoid exposing a phantom revision in snapshots or sync responses.
      this.revisions.restoreCheckpoint(
        stateBefore.session,
        stateBefore.highestRevision,
      );
      if (hadCachedDependencyGraph && cachedDependencyGraph !== undefined) {
        this.dependencyGraphs.set(dependencyGraphKey, cachedDependencyGraph);
      } else {
        this.dependencyGraphs.delete(dependencyGraphKey);
      }
    } catch {
      // The authority remains fenced even if an unexpected in-memory restore
      // failure occurs; do not expose a possibly inconsistent acknowledgement.
    }
    return this.storageFailureOutcome();
  }

  /** Restore authoritative state and revision counters on startup (Req 1.5, 1.6). */
  private recover(): void {
    for (const { session, highestRevision } of this.store.allSessions()) {
      const key = sessionKey(session);
      this.knownSessions.set(key, session);
      this.membershipBySession.set(key, this.store.membership(session));
      this.adminKeysBySession.set(key, new Set(this.store.adminKeys(session)));

      const snapshot = this.store.loadSnapshot(session);
      if (snapshot !== null) {
        restoreSessionState(snapshot, this.registries);
        // Heartbeats are deliberately memory-only. A recovered lock/intent
        // owner therefore gets one bounded liveness grace period from restart;
        // a live agent refreshes it at auth/heartbeat, while a dead agent's
        // restored work still expires instead of persisting forever.
        this.seedRecoveryLiveness(snapshot, Date.now());
      }
      const highestAppliedRevision = this.store
        .appliedEvents(session)
        .reduce((highest, event) => Math.max(highest, event.eventRevision), 0);
      const recoveredRevision = Math.max(
        highestRevision,
        snapshot?.highestRevision ?? 0,
        highestAppliedRevision,
      );
      // Broadcast updates are intentionally memory-only. After a restart the
      // in-memory event log is empty even though the restored snapshot may be
      // newer than a reconnecting client's cursor. Mark the durable revision
      // boundary as compacted so every older cursor receives a replacement
      // snapshot rather than a misleading empty incremental suffix.
      this.eventLog.compact(session, recoveredRevision);
      // Resume the counter above the persisted highest revision (Req 1.6). The
      // applied-Event_ID index was reseeded into the gate at construction.
      this.revisions.resume(session, recoveredRevision);
    }
  }

  /** Seed a bounded expiry baseline for every device represented in a snapshot. */
  private seedRecoveryLiveness(
    snapshot: SessionStateSnapshot,
    atMs: number,
  ): void {
    const devices = new Set<string>();
    for (const lock of snapshot.locks) {
      devices.add(lock.holder.deviceId);
    }
    for (const intent of snapshot.intents) {
      devices.add(intent.owner.deviceId);
    }
    for (const presence of snapshot.presence) {
      devices.add(presence.member.deviceId);
    }
    for (const deviceId of devices) {
      this.expiry.recordHeartbeat(snapshot.session, deviceId, atMs);
    }
  }

  private decodeInvitation(encoded: string): SignedInvitation | null {
    try {
      const json = Buffer.from(encoded, "base64").toString("utf8");
      const parsed = JSON.parse(json) as SignedInvitation;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof parsed.signature !== "string" ||
        typeof parsed.claims !== "object"
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }
}

/**
 * Who should receive a message (Phase 1; Req 1.1): everyone for
 * broadcast/heads-up, or the sender plus the recipient for a directed message,
 * question, or answer.
 */
function messageAudience(message: MessageDto): "all" | string[] {
  if (message.kind === "broadcast" || message.kind === "heads_up") {
    return "all";
  }
  const audience = [message.sender.memberId];
  if (
    message.toMemberId !== undefined &&
    message.toMemberId !== message.sender.memberId
  ) {
    audience.push(message.toMemberId);
  }
  return audience;
}
