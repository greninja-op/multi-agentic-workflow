/**
 * The wire message catalog: message-type constants for every message exchanged
 * between agent and host, plus the per-message payload interfaces.
 *
 * Mirrors design.md §4.3 "Message Catalog" and §4.7 "JSON-schema-style key
 * message definitions". Payload shapes are expressed over the DTOs in ./models
 * so the envelope, catalog, and DTOs stay a single source of truth.
 *
 * Direction legend used in the constant groups below:
 *   C→H  client (agent) → host
 *   H→C  host → client (agent)
 */

import type {
  SessionId,
  MemberRef,
  Lock,
  Presence,
  DeclaredIntent,
  DependencyGraph,
  DependencyEdge,
  PublicContractFingerprint,
  RiskLevel,
  ScopeKind,
  CoordinationUpdate,
  MessageDto,
  MessageKind,
  MessagePriority,
  TaskDto,
  LivenessState,
  NotificationDto,
  LunaRequestDto,
  LunaReplyDto,
  LiveDiffDto,
} from "./models";
import type { ErrorCode } from "./errors";
// NotificationDto is referenced by SessionStateSnapshot and NotifyPushPayload.

// ---------------------------------------------------------------------------
// Message-type constants (design §4.3)
// ---------------------------------------------------------------------------

/** Authentication handshake message types (§4.1). */
export const AuthMessageType = {
  /** C→H: device public key, target session, invitation, format version. */
  HELLO: "auth.hello",
  /** H→C: random challenge nonce. */
  CHALLENGE: "auth.challenge",
  /** C→H: Ed25519 signature over the challenge nonce. */
  RESPONSE: "auth.response",
  /** H→C: handshake accepted; carries current highestRevision. */
  OK: "auth.ok",
  /** H→C: handshake rejected with an authorization/format code. */
  ERROR: "auth.error",
} as const;

/** Presence message types (Req 11). */
export const PresenceMessageType = {
  /** C→H: report started/editing/stopped on a path. */
  REPORT: "presence.report",
  /** H→C: broadcast presence change. */
  UPDATE: "presence.update",
} as const;

/** Lock message types (Req 12, 14). */
export const LockMessageType = {
  /** C→H: acquire a soft / coordination-required / hard lock. */
  ACQUIRE: "lock.acquire",
  /** C→H: release a held lock. */
  RELEASE: "lock.release",
  /** C→H: override a coordination-required/hard restriction (needs a reason). */
  OVERRIDE: "lock.override",
  /** H→C: broadcast lock state change. */
  UPDATE: "lock.update",
  /** H→C: a losing/concurrent claim lost to an earlier revision. */
  CONFLICT: "lock.conflict",
} as const;

/** Declared-intent message types (Req 16–18). */
export const IntentMessageType = {
  /** C→H: declare a new intent (modify + create paths). */
  DECLARE: "intent.declare",
  /** C→H: update an owned intent. Also H→C broadcast of intent changes. */
  UPDATE: "intent.update",
  /** C→H: withdraw an owned intent. */
  WITHDRAW: "intent.withdraw",
  /** C→H: report progress on an owned intent. */
  PROGRESS: "intent.progress",
  /** H→C: a planned-file-creation / intent collision (Req 18). */
  CONFLICT: "intent.conflict",
} as const;

/** Dependency-graph message types (Req 19–20). */
export const DependencyMessageType = {
  /** C→H: full metadata-only graph snapshot. */
  SNAPSHOT: "dep.snapshot",
  /** C→H: incremental change delta. */
  DELTA: "dep.delta",
  /** H→C: acknowledgement the graph/delta was applied. */
  APPLIED: "dep.applied",
} as const;

/** Path-change message types (Req 30). */
export const PathMessageType = {
  /** C→H: a tracked file was renamed/moved. */
  RENAMED: "path.renamed",
  /** C→H: a tracked file was deleted. */
  DELETED: "path.deleted",
  /** C→H: a new file was created. */
  FILE_CREATED: "file.created",
  /** H→C: broadcast path change. */
  UPDATE: "path.update",
} as const;

/** Heartbeat message types (Req 26). */
export const HeartbeatMessageType = {
  /** C→H: liveness ping keeping locks/intents alive. */
  PING: "heartbeat.ping",
  /** H→C: liveness acknowledgement. */
  ACK: "heartbeat.ack",
} as const;

/** Reconnect sync message types (Req 9, §4.6). */
export const SyncMessageType = {
  /** C→H: request events after a known revision. */
  REQUEST: "sync.request",
  /** H→C: incremental events for revisions > fromRevision. */
  EVENTS: "sync.events",
  /** H→C: full-state snapshot fallback. */
  SNAPSHOT: "sync.snapshot",
} as const;

/** Session broadcast message types (Req 25). */
export const BroadcastMessageType = {
  /** H→C: a coordination-data change for the session. */
  UPDATE: "coordination.update",
  /** H→C: current connected and known-offline members for the session. */
  PARTICIPANTS: "participants.update",
} as const;

/** Per-event mutation acknowledgement message types. */
export const EventMessageType = {
  /** H→C: direct acknowledgement for one accepted signed mutation event. */
  EVENT_APPLIED: "event.applied",
} as const;

/** V2 messaging message types (Phase 1; Req 1.1–1.4). */
export const MessagingMessageType = {
  /** C→H: send a directed/broadcast message, question, answer, or heads-up. */
  SEND: "message.send",
  /** H→C: broadcast of a message (added) or its updated state (answered/read). */
  UPDATE: "message.update",
  /** C→H: mark a delivered message as read. */
  READ: "message.read",
} as const;

/** V2 task message types (Phase 2; Req 2.1–2.3). */
export const TaskMessageType = {
  /** C→H: assign a new task (proposed) to a member. */
  ASSIGN: "task.assign",
  /** C→H: assignee approves or rejects an incoming proposed task. */
  RESPOND: "task.respond",
  /** C→H: assignee reports progress (in_progress | done). */
  PROGRESS: "task.progress",
  /** C→H: assigner or assignee withdraws a task. */
  WITHDRAW: "task.withdraw",
  /** H→C: broadcast of the authoritative task state. */
  UPDATE: "task.update",
} as const;

/** V2 notifications, liveness & wake message types (Phase 3; Req 3.1–3.3). */
export const PresenceLivenessMessageType = {
  /** H→C: a member's active/idle/gone liveness changed. */
  LIVENESS_UPDATE: "liveness.update",
  /** C→H: ask an idle member to resume (delivered at its next action). */
  WAKE_REQUEST: "wake.request",
  /** H→C: a severity-tagged notification for a recipient. */
  NOTIFY_PUSH: "notify.push",
} as const;

/**
 * V2 Luna orchestrator message types (Phase 4; Req 4.1–4.5). The `ASK`/`REPLY`
 * key names avoid colliding with the shared `REQUEST` key (`sync.request`) in
 * the flattened {@link MessageType} convenience map; the wire strings are
 * `luna.request` / `luna.reply`.
 */
export const LunaMessageType = {
  /** C→H: a human directs Luna to assign/arbitrate/answer/summarize. */
  ASK: "luna.request",
  /** H→C: Luna's structured reply to the requester. */
  REPLY: "luna.reply",
} as const;

/**
 * V2 live-diff message types (Phase 5; Req 5.1–5.5). Opt-in, off by default —
 * the only V2 family that moves source-derived content. `diff.share` /
 * `diff.update`.
 */
export const DiffMessageType = {
  /** C→H: (opt-in) share the current change diff for a path. */
  SHARE: "diff.share",
  /** H→C: broadcast a shared Live_Diff or its removal. */
  UPDATE: "diff.update",
} as const;

/** Error message type (§11.1, §11.2). */
export const ErrorMessageType = {
  /** H→C: typed error carrying an ErrorCode. */
  ERROR: "error",
} as const;

/**
 * The complete set of message-type string constants, flattened for convenience
 * and for building the message-type union.
 */
export const MessageType = {
  ...AuthMessageType,
  ...PresenceMessageType,
  ...LockMessageType,
  ...IntentMessageType,
  ...DependencyMessageType,
  ...PathMessageType,
  ...HeartbeatMessageType,
  ...SyncMessageType,
  // NOTE: MessagingMessageType is spread BEFORE BroadcastMessageType so the
  // shared `UPDATE` key still resolves to `coordination.update` in this
  // convenience map (the messaging `UPDATE` is `message.update`; consumers use
  // the MessagingMessageType const directly). MESSAGE_TYPES below is the lossless
  // catalog and includes every messaging wire string.
  ...MessagingMessageType,
  // TaskMessageType is likewise spread before BroadcastMessageType so the shared
  // `UPDATE` key still resolves to `coordination.update` in this convenience map.
  ...TaskMessageType,
  ...PresenceLivenessMessageType,
  ...LunaMessageType,
  // DiffMessageType is spread before BroadcastMessageType so its shared `UPDATE`
  // key still resolves to `coordination.update` in this convenience map (the
  // diff `UPDATE` is `diff.update`; consumers use the DiffMessageType const
  // directly). MESSAGE_TYPES below is the lossless catalog with every wire string.
  ...DiffMessageType,
  ...BroadcastMessageType,
  ...EventMessageType,
  ...ErrorMessageType,
} as const;

/** The literal string of every catalog message type. */
export type MessageTypeName =
  | (typeof AuthMessageType)[keyof typeof AuthMessageType]
  | (typeof PresenceMessageType)[keyof typeof PresenceMessageType]
  | (typeof LockMessageType)[keyof typeof LockMessageType]
  | (typeof IntentMessageType)[keyof typeof IntentMessageType]
  | (typeof DependencyMessageType)[keyof typeof DependencyMessageType]
  | (typeof PathMessageType)[keyof typeof PathMessageType]
  | (typeof HeartbeatMessageType)[keyof typeof HeartbeatMessageType]
  | (typeof SyncMessageType)[keyof typeof SyncMessageType]
  | (typeof BroadcastMessageType)[keyof typeof BroadcastMessageType]
  | (typeof EventMessageType)[keyof typeof EventMessageType]
  | (typeof MessagingMessageType)[keyof typeof MessagingMessageType]
  | (typeof TaskMessageType)[keyof typeof TaskMessageType]
  | (typeof PresenceLivenessMessageType)[keyof typeof PresenceLivenessMessageType]
  | (typeof LunaMessageType)[keyof typeof LunaMessageType]
  | (typeof DiffMessageType)[keyof typeof DiffMessageType]
  | (typeof ErrorMessageType)[keyof typeof ErrorMessageType];

/**
 * Runtime list of every message-type name.
 *
 * Built from the union of every group's values rather than from
 * {@link MessageType}: the flattened {@link MessageType} object is a lossy,
 * last-wins convenience map (several groups share key names — e.g. `UPDATE`
 * appears in presence/lock/intent/path/broadcast and `ERROR` in auth/error), so
 * deriving the catalog from `Object.values(MessageType)` would silently drop
 * wire types like `auth.error` and `presence.update`. Every wire *string* is
 * distinct, so this list is the complete, de-duplicated §4.3 catalog.
 */
export const MESSAGE_TYPES: readonly MessageTypeName[] = [
  ...Object.values(AuthMessageType),
  ...Object.values(PresenceMessageType),
  ...Object.values(LockMessageType),
  ...Object.values(IntentMessageType),
  ...Object.values(DependencyMessageType),
  ...Object.values(PathMessageType),
  ...Object.values(HeartbeatMessageType),
  ...Object.values(SyncMessageType),
  ...Object.values(BroadcastMessageType),
  ...Object.values(EventMessageType),
  ...Object.values(MessagingMessageType),
  ...Object.values(TaskMessageType),
  ...Object.values(PresenceLivenessMessageType),
  ...Object.values(LunaMessageType),
  ...Object.values(DiffMessageType),
  ...Object.values(ErrorMessageType),
] as MessageTypeName[];

const MESSAGE_TYPE_SET: ReadonlySet<string> = new Set(MESSAGE_TYPES);

/** Narrowing type guard: is `value` a known catalog message type? */
export function isMessageType(value: unknown): value is MessageTypeName {
  return typeof value === "string" && MESSAGE_TYPE_SET.has(value);
}

// ---------------------------------------------------------------------------
// Auth payloads (§4.1) — auth messages precede the signed envelope
// ---------------------------------------------------------------------------

/** `auth.hello` (C→H). */
export interface AuthHelloPayload {
  /** base64 Ed25519 Device_Public_Key. */
  devicePublicKey: string;
  /** Target session to join. */
  session: SessionId;
  /** base64 Signed_Invitation chaining to an admin (Req 5.5). */
  signedInvitation: string;
  /** MESSAGE_FORMAT_VERSION the client speaks (Req 7.6). */
  version: number;
}

/** `auth.challenge` (H→C). */
export interface AuthChallengePayload {
  /** Random base64 nonce to be signed. */
  nonce: string;
}

/** `auth.response` (C→H). */
export interface AuthResponsePayload {
  /** base64 Ed25519 signature over the challenge nonce. */
  signature: string;
}

/** `auth.ok` (H→C). */
export interface AuthOkPayload {
  /** Current highest assigned Event_Revision for the session (Req 1.6, 8.1). */
  highestRevision: number;
}

/** `auth.error` (H→C). */
export interface AuthErrorPayload {
  code: ErrorCode;
  message: string;
}

// ---------------------------------------------------------------------------
// Presence payloads (Req 11)
// ---------------------------------------------------------------------------

/** `presence.report` (C→H). */
export interface PresenceReportPayload {
  path: string;
  state: Presence["state"];
}

/** `presence.update` (H→C). */
export interface PresenceUpdatePayload {
  member: MemberRef;
  path: string;
  state: Presence["state"];
  eventRevision: number;
}

// ---------------------------------------------------------------------------
// Lock payloads (Req 12, 14, §4.7)
// ---------------------------------------------------------------------------

/** `lock.acquire` (C→H). */
export interface LockAcquirePayload {
  scope: string;
  scopeKind: ScopeKind;
  mode: RiskLevel;
}

/** `lock.release` (C→H) — release by lockId or by scope. */
export interface LockReleasePayload {
  lockId?: string;
  scope?: string;
}

/** `lock.override` (C→H) — coordination-required/hard override (Req 13.4). */
export interface LockOverridePayload {
  scope: string;
  scopeKind: ScopeKind;
  mode: RiskLevel;
  /** Required reason recorded in the Audit_Record (Req 13.3, 13.4). */
  overrideReason: string;
}

/** `lock.update` (H→C) — broadcast of the authoritative lock state. */
export interface LockUpdatePayload {
  op: "added" | "removed";
  lock: Lock;
}

/** `lock.conflict` (H→C). */
export interface LockConflictPayload {
  scope: string;
  winner: { memberId: string; eventRevision: number };
  loserEventId: string;
}

// ---------------------------------------------------------------------------
// Intent payloads (Req 16–18, §4.7)
// ---------------------------------------------------------------------------

/** `intent.declare` (C→H). */
export interface IntentDeclarePayload {
  modifyPaths: string[];
  createPaths: string[];
  description: string;
}

/** `intent.update` (C→H). */
export interface IntentUpdatePayload {
  intentId: string;
  modifyPaths: string[];
  createPaths: string[];
  description: string;
}

/** `intent.withdraw` (C→H). */
export interface IntentWithdrawPayload {
  intentId: string;
}

/** `intent.progress` (C→H). */
export interface IntentProgressPayload {
  intentId: string;
  /** Paths whose planned work is now complete. */
  completedPaths?: string[];
  note?: string;
}

/** `intent.update` broadcast (H→C) — the authoritative intent state. */
export interface IntentUpdateBroadcastPayload {
  op: "added" | "updated" | "removed";
  intent: DeclaredIntent;
}

/** `intent.conflict` (H→C) — planned-file-creation / intent collision (Req 18). */
export interface IntentConflictPayload {
  path: string;
  winner: { memberId: string; eventRevision: number };
  loserEventId: string;
  /** Set when a create was reclassified to modify because the path exists (Req 16.5). */
  reclassifiedAs?: "modify";
}

// ---------------------------------------------------------------------------
// Dependency payloads (Req 19–20, §4.7)
// ---------------------------------------------------------------------------

/** `dep.snapshot` (C→H) — full metadata-only graph. */
export interface DepSnapshotPayload {
  graph: DependencyGraph;
}

/** A single changed edge in a delta (edge + add/remove op). */
export type ChangedDependencyEdge = DependencyEdge & { op: "add" | "remove" };

/** `dep.delta` (C→H) — incremental metadata-only change. */
export interface DepDeltaPayload {
  changedEdges: ChangedDependencyEdge[];
  changedManifests: string[];
  changedLockfileHash?: string;
  changedContracts: PublicContractFingerprint[];
}

/** `dep.applied` (H→C). */
export interface DepAppliedPayload {
  graphVersion: number;
  eventRevision: number;
}

// ---------------------------------------------------------------------------
// Path-change payloads (Req 30, §4.7)
// ---------------------------------------------------------------------------

/** `path.renamed` (C→H). */
export interface PathRenamedPayload {
  fromPath: string;
  toPath: string;
}

/** `path.deleted` (C→H). */
export interface PathDeletedPayload {
  path: string;
}

/** `file.created` (C→H). */
export interface FileCreatedPayload {
  path: string;
}

/** `path.update` (H→C). */
export interface PathUpdatePayload {
  op: "renamed" | "deleted" | "created";
  /** Present for renames — the prior path. */
  fromPath?: string;
  path: string;
  eventRevision: number;
}

// ---------------------------------------------------------------------------
// Heartbeat payloads (Req 26)
// ---------------------------------------------------------------------------

/** `heartbeat.ping` (C→H). */
export interface HeartbeatPingPayload {
  /** Optional advisory client send time. */
  sentAt?: string;
}

/** `heartbeat.ack` (H→C). */
export interface HeartbeatAckPayload {
  /** Optional advisory server time. */
  serverTime?: string;
}

// ---------------------------------------------------------------------------
// Sync payloads (Req 9, §4.6)
// ---------------------------------------------------------------------------

/** `sync.request` (C→H). */
export interface SyncRequestPayload {
  fromRevision: number;
}

/** `sync.events` (H→C) — incremental events for revisions > fromRevision. */
export interface SyncEventsPayload {
  events: CoordinationUpdate[];
}

/** A full authoritative-state snapshot for a session (sync fallback, Req 9.5). */
export interface SessionStateSnapshot {
  session: SessionId;
  locks: Lock[];
  presence: Presence[];
  intents: DeclaredIntent[];
  /**
   * V2 messaging history for the session (Phase 1; Req 1.4, X.2). Optional for
   * wire back-compatibility with V1 snapshots; when present, a reconnecting
   * agent restores it so messages sent while it was offline are delivered.
   */
  messages?: MessageDto[];
  /**
   * V2 tasks for the session (Phase 2; Req 2.1, X.2). Optional for wire
   * back-compatibility; when present, a reconnecting agent restores the task
   * list and any pending approvals.
   */
  tasks?: TaskDto[];
  /**
   * V2 notifications for the session (Phase 3; Req 3.2, X.2). Optional; when
   * present, a reconnecting agent restores its notifications and pending wakes.
   */
  notifications?: NotificationDto[];
  /**
   * V2 opt-in Live_Diffs for the session (Phase 5; Req 5.1–5.3, X.2). Optional
   * and present only when Live_Diff sharing is enabled; when present, a
   * reconnecting agent restores the currently-shared diffs. This is the only
   * snapshot field that carries source-derived content.
   */
  diffs?: LiveDiffDto[];
  highestRevision: number;
}

/** `sync.snapshot` (H→C) — full-state replacement fallback. */
export interface SyncSnapshotPayload {
  state: SessionStateSnapshot;
}

// ---------------------------------------------------------------------------
// Broadcast payload (Req 25)
// ---------------------------------------------------------------------------

/** `coordination.update` (H→C) — a single coordination-data change. */
export type CoordinationUpdatePayload = CoordinationUpdate;

/**
 * `participants.update` (H→C) — live member connectivity metadata. `offline`
 * contains admitted, non-revoked members that do not currently have a live
 * Host connection. It contains no source content or filesystem information.
 */
export interface ParticipantsUpdatePayload {
  connected: string[];
  offline: string[];
}

// ---------------------------------------------------------------------------
// Mutation acknowledgement payloads
// ---------------------------------------------------------------------------

/** The winner reported to an accepted but losing lock claimant. */
export interface EventAppliedLockConflict {
  /** The scope the losing acquisition targeted. */
  scope: string;
  /** The currently winning member and the revision that established it. */
  winner: { memberId: string; eventRevision: number };
}

/**
 * `event.applied` (H→C) — direct acknowledgement for exactly one accepted
 * signed mutation. It deliberately carries only coordination metadata, never
 * source content. Clients correlate it by `eventId`, rather than inferring
 * acceptance from an unrelated session broadcast.
 */
export interface EventAppliedPayload {
  /** The accepted client Event_ID. */
  eventId: string;
  /** The authoritative Event_Revision assigned to that event. */
  eventRevision: number;
  /** Present when the Event_ID was an idempotent duplicate. */
  duplicateOf?: number;
  /** Present when an accepted lock acquisition was recorded as a loser. */
  lockConflict?: EventAppliedLockConflict;
}

// ---------------------------------------------------------------------------
// Error payload (§11.1)
// ---------------------------------------------------------------------------

/** `error` (H→C) — typed error carrying an ErrorCode. */
export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  refEventId?: string;
}

// ---------------------------------------------------------------------------
// V2 messaging payloads (Phase 1; Req 1.1-1.4)
// ---------------------------------------------------------------------------

/** `message.send` (C→H). The host assigns messageId (=Event_ID), revision, sentAt. */
export interface MessageSendPayload {
  kind: MessageKind;
  /** Required for `direct`/`question`/`answer`; omitted for `broadcast`/`heads_up`. */
  toMemberId?: string;
  /** Defaults to `normal` when omitted (Req 1.2). */
  priority?: MessagePriority;
  body: string;
  /** Correlates an `answer` to its `question` (Req 1.3). */
  correlationId?: string;
}

/** `message.update` (H→C) — the authoritative message state. */
export interface MessageUpdatePayload {
  op: "added" | "updated";
  message: MessageDto;
}

/** `message.read` (C→H) — mark a delivered message read (Req 1.4). */
export interface MessageReadPayload {
  messageId: string;
}

// ---------------------------------------------------------------------------
// V2 task payloads (Phase 2; Req 2.1-2.3)
// ---------------------------------------------------------------------------

/** `task.assign` (C→H). The host assigns taskId (=Event_ID), assigner=sender. */
export interface TaskAssignPayload {
  title: string;
  description: string;
  /** The member whose Task_List the task targets. */
  assigneeMemberId: string;
}

/** `task.respond` (C→H) — assignee approves or rejects a proposed task (Req 2.2). */
export interface TaskRespondPayload {
  taskId: string;
  /** True to accept (→ accepted), false to reject (→ rejected). */
  accept: boolean;
}

/** `task.progress` (C→H) — assignee advances a task's status (Req 2.3). */
export interface TaskProgressPayload {
  taskId: string;
  status: "in_progress" | "done";
}

/** `task.withdraw` (C→H) — assigner or assignee withdraws a task (Req 2.2). */
export interface TaskWithdrawPayload {
  taskId: string;
}

/** `task.update` (H→C) — the authoritative task state. */
export interface TaskUpdatePayload {
  op: "added" | "updated" | "removed";
  task: TaskDto;
}

// ---------------------------------------------------------------------------
// V2 notifications, liveness & wake payloads (Phase 3; Req 3.1-3.3)
// ---------------------------------------------------------------------------

/** `liveness.update` (H→C) — a member's liveness changed (Req 3.1). */
export interface LivenessUpdatePayload {
  memberId: string;
  state: LivenessState;
  eventRevision: number;
}

/** `wake.request` (C→H) — ask an idle member to resume (Req 3.3). */
export interface WakeRequestPayload {
  /** The member to wake. */
  targetMemberId: string;
  /** Optional short team-text reason. */
  reason?: string;
}

/** `notify.push` (H→C) — a severity-tagged notification for a recipient (Req 3.2). */
export type NotifyPushPayload = NotificationDto;

// ---------------------------------------------------------------------------
// V2 Luna orchestrator payloads (Phase 4; Req 4.1-4.5)
// ---------------------------------------------------------------------------

/** `luna.request` (C→H) — a human directs Luna. */
export type LunaRequestPayload = LunaRequestDto;

/** `luna.reply` (H→C) — Luna's structured reply. */
export type LunaReplyPayload = LunaReplyDto;

// ---------------------------------------------------------------------------
// V2 live-diff payloads (Phase 5; Req 5.1-5.5)
// ---------------------------------------------------------------------------

/**
 * `diff.share` (C→H) — (opt-in) share the current change diff for a path. The
 * host stamps member=sender and eventRevision. An empty `patch` clears any
 * previously shared diff for the path.
 */
export interface DiffSharePayload {
  path: string;
  /** Unified-diff text, data-minimized; empty string removes the shared diff. */
  patch: string;
}

/** `diff.update` (H→C) — the authoritative shared Live_Diff, or its removal. */
export interface DiffUpdatePayload {
  op: "shared" | "removed";
  diff: LiveDiffDto;
}

// ---------------------------------------------------------------------------
// Type-level payload map — associates each message type with its payload
// ---------------------------------------------------------------------------

/**
 * Maps every catalog message type to its payload shape. Consumers can index this
 * to obtain the payload type for a given message-type constant.
 */
export interface MessagePayloadMap {
  [AuthMessageType.HELLO]: AuthHelloPayload;
  [AuthMessageType.CHALLENGE]: AuthChallengePayload;
  [AuthMessageType.RESPONSE]: AuthResponsePayload;
  [AuthMessageType.OK]: AuthOkPayload;
  [AuthMessageType.ERROR]: AuthErrorPayload;

  [PresenceMessageType.REPORT]: PresenceReportPayload;
  [PresenceMessageType.UPDATE]: PresenceUpdatePayload;

  [LockMessageType.ACQUIRE]: LockAcquirePayload;
  [LockMessageType.RELEASE]: LockReleasePayload;
  [LockMessageType.OVERRIDE]: LockOverridePayload;
  [LockMessageType.UPDATE]: LockUpdatePayload;
  [LockMessageType.CONFLICT]: LockConflictPayload;

  [IntentMessageType.DECLARE]: IntentDeclarePayload;
  // intent.update is overloaded C→H (IntentUpdatePayload) and H→C
  // (IntentUpdateBroadcastPayload); the map records the client→host request shape.
  [IntentMessageType.UPDATE]: IntentUpdatePayload;
  [IntentMessageType.WITHDRAW]: IntentWithdrawPayload;
  [IntentMessageType.PROGRESS]: IntentProgressPayload;
  [IntentMessageType.CONFLICT]: IntentConflictPayload;

  [DependencyMessageType.SNAPSHOT]: DepSnapshotPayload;
  [DependencyMessageType.DELTA]: DepDeltaPayload;
  [DependencyMessageType.APPLIED]: DepAppliedPayload;

  [PathMessageType.RENAMED]: PathRenamedPayload;
  [PathMessageType.DELETED]: PathDeletedPayload;
  [PathMessageType.FILE_CREATED]: FileCreatedPayload;
  [PathMessageType.UPDATE]: PathUpdatePayload;

  [HeartbeatMessageType.PING]: HeartbeatPingPayload;
  [HeartbeatMessageType.ACK]: HeartbeatAckPayload;

  [SyncMessageType.REQUEST]: SyncRequestPayload;
  [SyncMessageType.EVENTS]: SyncEventsPayload;
  [SyncMessageType.SNAPSHOT]: SyncSnapshotPayload;

  [BroadcastMessageType.UPDATE]: CoordinationUpdatePayload;
  [BroadcastMessageType.PARTICIPANTS]: ParticipantsUpdatePayload;

  [EventMessageType.EVENT_APPLIED]: EventAppliedPayload;

  [MessagingMessageType.SEND]: MessageSendPayload;
  [MessagingMessageType.UPDATE]: MessageUpdatePayload;
  [MessagingMessageType.READ]: MessageReadPayload;

  [TaskMessageType.ASSIGN]: TaskAssignPayload;
  [TaskMessageType.RESPOND]: TaskRespondPayload;
  [TaskMessageType.PROGRESS]: TaskProgressPayload;
  [TaskMessageType.WITHDRAW]: TaskWithdrawPayload;
  [TaskMessageType.UPDATE]: TaskUpdatePayload;

  [PresenceLivenessMessageType.LIVENESS_UPDATE]: LivenessUpdatePayload;
  [PresenceLivenessMessageType.WAKE_REQUEST]: WakeRequestPayload;
  [PresenceLivenessMessageType.NOTIFY_PUSH]: NotifyPushPayload;

  [LunaMessageType.ASK]: LunaRequestPayload;
  [LunaMessageType.REPLY]: LunaReplyPayload;

  [DiffMessageType.SHARE]: DiffSharePayload;
  [DiffMessageType.UPDATE]: DiffUpdatePayload;

  [ErrorMessageType.ERROR]: ErrorPayload;
}
