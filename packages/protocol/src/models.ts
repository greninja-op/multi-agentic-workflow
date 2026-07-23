/**
 * Core DTOs and shared wire types for Collaborative File Lock Sync.
 *
 * These are the single source of truth for the data models exchanged between
 * host, agent, mcp-server, and extension. They are type-only (no runtime logic);
 * the versioned envelope catalog, error codes, and JSON-schema validation land in
 * tasks 2.2 and 2.3.
 *
 * Definitions mirror design.md §5.1 "Core TypeScript interfaces".
 */

// ---- Shared unions ----

/** Coordination strictness of a lock/path (Req 15). */
export type RiskLevel = "soft" | "coordination-required" | "hard";

/** How a lock/intent scope is expressed. */
export type ScopeKind = "file" | "folder" | "glob";

/** Directed dependency-edge classification (Req 19). */
export type EdgeKind =
  | "runtime_import"
  | "type_only_import"
  | "test_dependency"
  | "build_dependency"
  | "generated_dependency"
  | "dynamic_unknown";

/** Confidence level attached to an inferred dependency edge (Req 19.6). */
export type Confidence = "high" | "medium" | "low" | "unknown";

// ---- Identity & session ----

/** Canonical, transport-independent session identity (Req 10.1). */
export interface SessionId {
  /** Canonical repository ID (normalized remote). */
  repoId: string;
  teamId: string;
  /** Branch_Context. */
  branch: string;
  /** Base_Revision where available. */
  baseRevision: string | null;
}

/** A member and the specific device it is acting from. */
export interface MemberRef {
  memberId: string;
  deviceId: string;
}

/** An active coordination session for a repository (Req 10). */
export interface RepositorySession {
  id: SessionId;
  /** True when derived from the Req 10.6 manual-configuration fallback. */
  manualConfig: boolean;
  /** Highest assigned Event_Revision for the session (Req 1.6, 8.1). */
  highestRevision: number;
}

// ---- Wire envelope ----

/** The canonical, versioned wire envelope (§4.2, Req 7.1). */
export interface EventEnvelope {
  type: string;
  version: number;
  eventId: string;
  session: SessionId;
  deviceId: string;
  replay: { counter: number; nonce: string };
  sentAt: string;
  payload: unknown;
}

/** An EventEnvelope with its detached Ed25519 signature (Req 7.1). */
export interface SignedEvent {
  envelope: EventEnvelope;
  /** base64 Ed25519 signature. */
  signature: string;
}

// ---- Coordination primitives ----

/** A coordination lock over a path/folder/glob (Req 12.3, 32). */
export interface Lock {
  lockId: string;
  /** path/folder/glob, <=4096 chars. */
  scope: string;
  scopeKind: ScopeKind;
  mode: RiskLevel;
  holder: MemberRef;
  /** Branch_Context. */
  branch: string;
  eventRevision: number;
  acquiredAt: string;
  /** A losing / concurrent claim (Req 8.4, 12.4, 18). */
  concurrent: boolean;
}

/** A member's presence on a specific path (Req 11). */
export interface Presence {
  member: MemberRef;
  path: string;
  state: "started" | "editing" | "stopped";
  eventRevision: number;
}

/** A not-yet-existing path a member plans to create (Req 16, 18). */
export interface PlannedFileCreation {
  /** <=4096 chars, not yet existing. */
  path: string;
}

/** A declared intent describing planned modifications/creations (Req 16.2, 32). */
export interface DeclaredIntent {
  intentId: string;
  owner: MemberRef;
  /** AI_Agent identifier. */
  agentId: string;
  modifyPaths: string[];
  createPaths: PlannedFileCreation[];
  /** file/folder/glob. */
  scopeKind: ScopeKind;
  branch: string;
  description: string;
  eventRevision: number;
}

// ---- Dependency Graph: five metadata categories only (Req 19.2) ----

/** Category 1 — repository snapshot metadata. */
export interface RepositorySnapshotMetadata {
  sessionId: SessionId;
  graphVersion: number;
  analyzerVersion: string;
}

/** Category 2 — package/manifest dependency metadata. */
export interface PackageDependencyMetadata {
  manifestPath: string;
  packageManager: string;
  directDependencyNames: string[];
  declaredVersionRanges: Record<string, string>;
  scope: "prod" | "dev" | "peer" | "optional";
  lockfileHash: string;
}

/** Category 3 — a single directed dependency edge. */
export interface DependencyEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  confidence: Confidence;
}

/** Category 3 — per-source-file dependency edges. */
export interface ModuleDependencyMetadata {
  sourceFile: string;
  edges: DependencyEdge[];
}

/** Category 4 — a hashed public-contract fingerprint (no contents). */
export interface PublicContractFingerprint {
  id: string;
  kind:
    | "public_api"
    | "exported_interface"
    | "db_schema"
    | "api_schema"
    | "migration"
    | "build_config";
  /** hash only, no contents. */
  fingerprint: string;
}

/** Category 5 — a change delta between graph revisions. */
export interface ChangeDeltaMetadata {
  changedEdges: (DependencyEdge & { op: "add" | "remove" })[];
  changedManifests: string[];
  changedLockfileHash?: string;
  changedContracts: PublicContractFingerprint[];
}

/** The full metadata-only dependency graph. */
export interface DependencyGraph {
  snapshot: RepositorySnapshotMetadata;
  packages: PackageDependencyMetadata[];
  modules: ModuleDependencyMetadata[];
  contracts: PublicContractFingerprint[];
}

// ---- Projections & records ----

/** A per-path risk-map entry projected for a requesting member (Req 24.7). */
export interface RiskMapEntry {
  path: string;
  riskLevel: RiskLevel;
  contributors: { member: MemberRef; kind: string }[];
  explanation: {
    type: "direct" | "indirect";
    edges?: DependencyEdge[];
    sharedContracts?: string[];
  };
  /** Req 13.5 — true when the member must acknowledge before proceeding. */
  acknowledgementRequired: boolean;
}

/** A durable audit record with no source content (Req 28). */
export interface AuditRecord {
  member: MemberRef;
  action: "create" | "update" | "withdraw" | "expire" | "override";
  targetScope: string;
  eventRevision: number;
  time: string;
  /** Req 13.3, 28.2 — no source content. */
  overrideReason?: string;
}

/** A membership-registry entry for a device public key (Req 5.2). */
export interface MembershipRegistryEntry {
  devicePublicKey: string;
  memberId: string;
  invitationValid: boolean;
  revoked: boolean;
  rotatedFrom?: string;
}

/** Metadata attached to an intent-derived coordination update for team activity views. */
export interface IntentActivity {
  /** The stable Declared_Intent identifier. */
  intentId: string;
  /** The member-provided, metadata-only description of the planned work. */
  description: string;
}

/** An incremental coordination update broadcast to authorized agents (Req 25.3). */
export interface CoordinationUpdate {
  entryType:
    | "soft_lock"
    | "presence"
    | "intent"
    | "planned_file_creation"
    | "dependency_risk";
  op: "added" | "removed";
  path?: string;
  member: MemberRef;
  eventRevision: number;
  /** Present for intent-derived entries so local UI/MCP can show the stated task. */
  intent?: IntentActivity;
}

// ---- V2 Collaboration Layer: Messaging (Phase 1; idea.md §6 Communication) ----

/** How a Message is addressed / what it expects (Req 1.1, 1.3). */
export type MessageKind =
  | "direct"
  | "broadcast"
  | "question"
  | "answer"
  | "heads_up";

/** How loudly a recipient should be alerted to a Message (Req 1.2). */
export type MessagePriority = "fyi" | "normal" | "urgent";

/**
 * A team coordination Message sent between members/AI agents (Req 1.1–1.4).
 *
 * Carries a human/agent-authored `body` as **team text metadata**. It is shared
 * only within the authorized Repository_Session and is subject to the same
 * data-minimization gate as every other event: it never carries secrets,
 * credentials, or absolute/out-of-repo paths. Source file contents are never
 * placed in a Message.
 */
export interface MessageDto {
  /** Globally unique message id (the originating Event_ID). */
  messageId: string;
  kind: MessageKind;
  /** The sending Team_Member and device. */
  sender: MemberRef;
  /** Recipient memberId for `direct`/`question`/`answer`; absent for `broadcast`/`heads_up`. */
  toMemberId?: string;
  priority: MessagePriority;
  /** Team text; data-minimized (no secrets, credentials, or out-of-repo paths). */
  body: string;
  /** Correlation id linking a `question` to its `answer` (Req 1.3). */
  correlationId?: string;
  /** True once a `question` has received an `answer` (Req 1.3). */
  answered?: boolean;
  /** Authoritative Event_Revision assigned by the host (Req 1.1). */
  eventRevision: number;
  /** ISO-8601 send time; advisory only, never a sole conflict resolver. */
  sentAt: string;
}

// ---- V2 Collaboration Layer: Tasks (Phase 2; idea.md §6 Task management) ----

/**
 * The lifecycle status of a {@link TaskDto} (Req 2.1). A human (or Luna) assigns
 * a task as `proposed`; the receiving member `accepted`/`rejected` it before it
 * lands in their Task_List; the assignee then drives `in_progress` → `done`;
 * either party may `withdrawn` it.
 */
export type TaskStatus =
  | "proposed"
  | "accepted"
  | "rejected"
  | "in_progress"
  | "done"
  | "withdrawn";

/**
 * A shared unit of human-directed work (Req 2.1–2.3; idea.md §6). Tasks are the
 * larger, human-assigned work items that require the receiving member's
 * approval, distinct from the agent-level self-coordinated Declared_Intents.
 * A task carries only coordination metadata — a title and description as team
 * text, never source content.
 */
export interface TaskDto {
  /** Globally unique task id (the originating Event_ID). */
  taskId: string;
  /** Short team-text title. */
  title: string;
  /** Team-text description of the work. */
  description: string;
  /** The member whose Task_List this task targets. */
  assignee: MemberRef;
  /** The member (human or Luna) that assigned the task. */
  assigner: MemberRef;
  status: TaskStatus;
  /** Authoritative Event_Revision of the latest change to the task (Req 2.1). */
  eventRevision: number;
}

// ---- V2 Collaboration Layer: Notifications & Liveness (Phase 3; idea.md §6) ----

/**
 * A member's availability (Req 3.1; idea.md §6 Liveness): `active` (recently
 * acting), `idle` (connected but quiet), or `gone` (no live host connection).
 */
export type LivenessState = "active" | "idle" | "gone";

/** Severity of a {@link NotificationDto}, used for alerting (Req 3.2). */
export type NotifySeverity = "info" | "warn" | "urgent";

/** What produced a notification (Req 3.2). */
export type NotifySource =
  | "message"
  | "task"
  | "question"
  | "wake"
  | "conflict";

/**
 * A surfaced alert for a human (Req 3.2). Carries only coordination metadata —
 * a severity, the producing source, and a reference id (messageId/taskId/etc.);
 * never source content. The client renders it and (for high severity) may play
 * a sound cue.
 */
export interface NotificationDto {
  notificationId: string;
  /** The member this notification is for. */
  toMemberId: string;
  severity: NotifySeverity;
  source: NotifySource;
  /** The id of the producing entity (messageId, taskId, wakeId, path, …). */
  refId: string;
  /** Short team-text summary line. */
  summary: string;
  eventRevision: number;
}

// ---- V2 Collaboration Layer: Luna orchestrator (Phase 4; idea.md §5, §6) ----

/**
 * A direction a human gives Luna, the central orchestrator (Req 4.2–4.4;
 * idea.md §5). Luna only routes/assigns what a human directs — it never
 * autonomously carves a feature into subtasks (idea.md §9).
 */
export type LunaAction = "assign" | "arbitrate" | "answer" | "summarize";

/** A request directed to Luna (Req 4.2–4.5). */
export interface LunaRequestDto {
  action: LunaAction;
  /** The human/agent's plain-language prompt (team text; never source content). */
  prompt: string;
  /** Optional reference id the action concerns (a scope, taskId, questionId, …). */
  refId?: string;
}

/** Luna's structured reply (Req 4.2–4.4). */
export interface LunaReplyDto {
  action: LunaAction;
  /** Plain-language result Luna produced (a decision, an answer, or a summary). */
  summary: string;
  /** Set when the action produced a Task (e.g. `assign`). */
  producedTaskId?: string;
  /** Set when the action produced a Message (e.g. an `answer` or arbitration notice). */
  producedMessageId?: string;
}

/**
 * An opt-in, team-only Live_Diff: a member's current change diff for a path,
 * shared live with authorized members (V2 Phase 5; Req 5.1–5.5). This is the
 * ONLY V2 payload that carries source-derived content, so it is off by default,
 * gated by team config, and data-minimized (never secrets/excluded paths).
 */
export interface LiveDiffDto {
  /** The repository-relative path the diff concerns. */
  path: string;
  /** The Team_Member/device that shared the diff. */
  member: MemberRef;
  /** Unified-diff text, data-minimized; present only when Live_Diff is enabled. */
  patch: string;
  /** Authoritative Event_Revision of the latest change to this diff (Req 5.1). */
  eventRevision: number;
}
