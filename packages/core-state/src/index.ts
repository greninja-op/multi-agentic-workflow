/**
 * @cfls/core-state — the pure, dependency-free coordination engine:
 * revisions, locks, presence, intents, risk, sync, expiry, coalescing,
 * and the data-minimization filter. Primary property-based-testing target.
 *
 * Implemented incrementally across spec tasks 4.1–4.26.
 */

export const PACKAGE_NAME = "@cfls/core-state";

// ---- Session identity, canonical repo ID, path normalization (task 4.1; §9) ----
export { deriveRepoId } from "./repo-id";
export {
  normalizePath,
  pathMatchKey,
  normalizePathKey,
  defaultCaseSensitivity,
} from "./path";
export type { PlatformCaseSensitivity } from "./path";
export { sessionKey, buildSessionId } from "./session";

// ---- Monotonic Event_Revision assignment with restart resume (task 4.4; §4.5) ----
export { RevisionCounter } from "./revisions";
export type { PersistedRevision } from "./revisions";

// ---- Ingest gate: idempotency, replay, schema/permission checks (task 4.6; §4.4) ----
export { IngestGate, permitAll } from "./ingest";
export type {
  IngestResult,
  IngestGateOptions,
  PermissionCheck,
  PermissionDecision,
  Applier,
  ApplierRejection,
  PersistedAppliedEvent,
} from "./ingest";

// ---- Conflict resolution by earliest Event_Revision (task 4.9; §10.2) ----
export {
  resolveByEarliestRevision,
  resolvePlannedFileCreationClaims,
  compareClaims,
} from "./conflict";
export type {
  RevisionClaim,
  ConflictInfo,
  ResolvedClaim,
  Resolution,
  PlannedFileCreationClaim,
} from "./conflict";

// ---- Lock registry & presence registry (task 4.8; §10.3, §10.4) ----
export { LockRegistry } from "./locks";
export type {
  LockAcquisition,
  LockRelease,
  AcquireOutcome,
  ReleaseResult,
  LockReleaseError,
} from "./locks";
export { PresenceRegistry } from "./presence";
export type { PresenceReport } from "./presence";

// ---- Coordination-required override validation & audit (task 4.26; Req 13.2–13.4; §10.3) ----
export { validateOverride } from "./override";
export type {
  OverrideError,
  OverrideRequest,
  OverrideResult,
} from "./override";

// ---- Declared-intent lifecycle & planned-file-creation collisions (task 4.11; Req 16–18, 32; §5.1, §10.2) ----
export { IntentRegistry } from "./intents";
export type {
  IntentError,
  DeclareIntentRequest,
  UpdateIntentRequest,
  WithdrawIntentRequest,
  Reclassification,
  PlannedCreationConflict,
  DeclareResult,
  WithdrawResult,
  CreationReconciliation,
  SaveReconciliation,
  WithdrawCreationResult,
  CoveringIntent,
} from "./intents";

// ---- Rules-precedence resolver (task 4.12; Req 15; §6) ----
export {
  resolveMode,
  parseRulesConfig,
  mostRestrictive,
  globMatch,
  isRiskLevel,
  ALL_SOFT_CONFIG,
} from "./rules";
export type {
  RepositoryRuleEntry,
  RepositoryRulesConfig,
  RulesConfigError,
  RulesConfigParseResult,
} from "./rules";

// ---- Risk classification & Risk_Map projection (task 4.14; Req 21, 22, 24, 31.5; §7.8, §10.1) ----
export { buildRiskMap, ContentionKind, lockContentionKind } from "./risk";
export type { RiskMapContext } from "./risk";

// ---- Data-minimization filter & host-side rejection (task 4.24; Req 29; §7.2, §8.3) ----
export {
  minimizeOutbound,
  findMinimizationViolations,
  checkInboundMinimization,
  isAbsolutePath,
  containsSecretMaterial,
  SOURCE_CONTENT_FIELD_NAMES,
  SECRET_FIELD_NAMES,
  OPAQUE_FIELD_NAMES,
} from "./minimize";
export type {
  MinimizationViolation,
  MinimizationViolationKind,
  MinimizationCheckResult,
} from "./minimize";

// ---- Authoritative-state snapshot serialize/deserialize & restart resume (task 4.16; §5.2, §4.6) ----
export { serializeSessionState, restoreSessionState } from "./snapshot";
export type { SessionRegistries } from "./snapshot";

// ---- Reconnect sync-from-revision convergence (task 4.18; Req 9, 33.4, 33.5; §4.6) ----
export {
  CoordinationEventLog,
  AgentSyncCache,
  projectSnapshot,
  coordinationEntryKey,
} from "./sync";
export type { SyncResponse } from "./sync";

// ---- Heartbeat tracking & stale lock/intent expiry sweep (task 4.20; Req 26; §5.2, §13.4) ----
export {
  ExpiryEngine,
  resolveExpiryConfig,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  MIN_HEARTBEAT_INTERVAL_MS,
  MAX_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LOCK_EXPIRY_INTERVAL_MS,
  MIN_LOCK_EXPIRY_INTERVAL_MULTIPLE,
  DEFAULT_SOFT_LOCK_MAX_AGE_MS,
} from "./expiry";
export type {
  ExpiryConfig,
  ExpiryConfigInput,
  ExpirySweepResult,
} from "./expiry";

// ---- V2 Phase 1 — Messaging channel (Req 1.1–1.4; idea.md §6 Communication) ----
export { MessageRegistry } from "./messaging";
export type { AppendMessageInput, AppendMessageResult } from "./messaging";

// ---- V2 Phase 2 — Task lifecycle & approvals (Req 2.1–2.3; idea.md §6) ----
export { TaskRegistry } from "./tasks";
export type {
  AssignTaskRequest,
  RespondTaskRequest,
  ProgressTaskRequest,
  WithdrawTaskRequest,
  TaskResult,
} from "./tasks";

// ---- V2 Phase 3 — Liveness & notifications (Req 3.1–3.3; idea.md §6) ----
export {
  LivenessTracker,
  notificationSeverity,
  buildNotification,
  memberIdOf,
  DEFAULT_ACTIVE_WINDOW_MS,
} from "./liveness";
export type { BuildNotificationInput } from "./liveness";
export { NotificationRegistry } from "./notifications";

// ---- V2 Phase 4 — Luna orchestrator (Req 4.1–4.4; idea.md §5) ----
export { RulesLunaBrain, LlmLunaBrain } from "./orchestrator";
export type {
  LunaBrain,
  LunaContext,
  LunaDecision,
  LunaAssignment,
  LunaMessagePlan,
  LlmCompletion,
} from "./orchestrator";

// ---- V2 Phase 5 — Live diffs (opt-in) (Req 5.1–5.3; idea.md §6) ----
export { DiffRegistry, diffMemberId } from "./diffs";

// ---- Coalescing & deduplication within the burst window (task 4.22; Req 34; §8.5) ----
export {
  Coalescer,
  DEFAULT_WINDOW_MS,
  MIN_WINDOW_MS,
  MAX_WINDOW_MS,
  DEFAULT_MAX_EVENTS_PER_WINDOW,
} from "./coalesce";
export type {
  CoalescableKind,
  OutboundEvent,
  CoalescerOptions,
} from "./coalesce";
