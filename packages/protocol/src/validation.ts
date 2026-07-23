/**
 * Structural validation for the wire protocol (Req 7.6, 7.7; design §4.4, §4.7).
 *
 * The host MUST reject any message that (a) does not conform to the defined
 * message schema, or (b) carries an unsupported message-format `version`, with a
 * `FORMAT_ERROR` — and it MUST do so *before* touching authoritative state
 * (design §4.4). This module is that gate.
 *
 * Design choices:
 *   - Zero runtime dependencies. Validators are hand-written over a tiny,
 *     JSON-schema-style descriptor DSL ({@link ObjectSchema}/{@link FieldSpec}),
 *     so the exported schema objects double as both documentation and the thing
 *     that actually runs — there is no second, drifting source of truth.
 *   - Nothing throws on invalid input. Every entry point returns a discriminated
 *     result (`{ ok: true, … } | { ok: false, error }`) whose error `code` is
 *     always `FORMAT_ERROR` (§11.1).
 *   - Canonicalization for signing is NOT duplicated here; it lives in
 *     `./envelope` ({@link canonicalize}/{@link canonicalEnvelopeString}) and is
 *     re-exported from this module for convenience.
 */

import type { EventEnvelope, SignedEvent } from "./models";
import type { ProtocolError } from "./errors";
import { MESSAGE_FORMAT_VERSION, type TypedEventEnvelope } from "./envelope";
import {
  MESSAGE_TYPES,
  isMessageType,
  type MessageTypeName,
  type MessagePayloadMap,
} from "./messages";

// Re-export the single canonicalization source (design §4.2) so callers that
// need "validate + sign/verify" can pull both from one place without importing
// two modules or being tempted to reimplement canonicalization.
export { canonicalize, canonicalEnvelopeString } from "./envelope";

// ---------------------------------------------------------------------------
// Result types (no throwing; error.code is always FORMAT_ERROR)
// ---------------------------------------------------------------------------

/** Result of validating a bare {@link EventEnvelope}. */
export type EnvelopeValidationResult<
  T extends MessageTypeName = MessageTypeName,
> =
  | { ok: true; envelope: TypedEventEnvelope<T> }
  | { ok: false; error: ProtocolError };

/** Result of validating a {@link SignedEvent} wrapper. */
export type SignedEventValidationResult =
  | {
      ok: true;
      signedEvent: { envelope: TypedEventEnvelope; signature: string };
    }
  | { ok: false; error: ProtocolError };

/** Result of validating a single message payload against its schema. */
export type PayloadValidationResult<
  T extends MessageTypeName = MessageTypeName,
> =
  | { ok: true; payload: MessagePayloadMap[T] }
  | { ok: false; error: ProtocolError };

/** Build a `FORMAT_ERROR` {@link ProtocolError} (design §11.1). */
function formatError(message: string, refEventId?: string): ProtocolError {
  return refEventId === undefined
    ? { code: "FORMAT_ERROR", message }
    : { code: "FORMAT_ERROR", message, refEventId };
}

// ---------------------------------------------------------------------------
// JSON-schema-style descriptor DSL
// ---------------------------------------------------------------------------

/**
 * A field descriptor. Intentionally small — it covers exactly the shapes used by
 * the DTOs and payloads in §4.7 / §5.1, and no more.
 */
export type FieldSpec =
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "boolean" }
  /** A `string | null` field (e.g. `SessionId.baseRevision`). */
  | { kind: "stringOrNull" }
  /** A string constrained to a fixed set of literals. */
  | { kind: "enum"; values: readonly string[] }
  /** A homogeneous array. */
  | { kind: "array"; items: FieldSpec }
  /** A nested object validated against another {@link ObjectSchema}. */
  | { kind: "object"; schema: ObjectSchema }
  /** A string-keyed map with homogeneous values (e.g. `Record<string,string>`). */
  | { kind: "record"; values: FieldSpec };

/** A single field of an {@link ObjectSchema}. */
export interface FieldDefinition {
  spec: FieldSpec;
  /** When true, the key may be absent (but if present must still type-check). */
  optional?: boolean;
}

/**
 * A JSON-schema-style object descriptor. Unknown extra keys are permitted
 * (forward-compatibility); only the declared fields are constrained. Missing or
 * mistyped *required* fields fail validation (Req 7.6).
 */
export interface ObjectSchema {
  /** Human-readable name used in error messages. */
  name: string;
  fields: Record<string, FieldDefinition>;
}

// ---------------------------------------------------------------------------
// Core checker: returns an error message, or null when the value is valid
// ---------------------------------------------------------------------------

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate `value` against `spec`; return an error string or `null` if valid. */
function checkField(
  value: unknown,
  spec: FieldSpec,
  path: string,
): string | null {
  switch (spec.kind) {
    case "string":
      return typeof value === "string"
        ? null
        : `${path} must be a string (got ${typeName(value)})`;
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? null
        : `${path} must be a finite number (got ${typeName(value)})`;
    case "boolean":
      return typeof value === "boolean"
        ? null
        : `${path} must be a boolean (got ${typeName(value)})`;
    case "stringOrNull":
      return typeof value === "string" || value === null
        ? null
        : `${path} must be a string or null (got ${typeName(value)})`;
    case "enum":
      return typeof value === "string" && spec.values.includes(value)
        ? null
        : `${path} must be one of [${spec.values.join(", ")}] (got ${
            typeof value === "string" ? `"${value}"` : typeName(value)
          })`;
    case "array": {
      if (!Array.isArray(value)) {
        return `${path} must be an array (got ${typeName(value)})`;
      }
      for (let i = 0; i < value.length; i++) {
        const err = checkField(value[i], spec.items, `${path}[${i}]`);
        if (err) return err;
      }
      return null;
    }
    case "record": {
      if (!isPlainObject(value)) {
        return `${path} must be an object map (got ${typeName(value)})`;
      }
      for (const key of Object.keys(value)) {
        const err = checkField(value[key], spec.values, `${path}.${key}`);
        if (err) return err;
      }
      return null;
    }
    case "object":
      return checkObject(value, spec.schema, path);
  }
}

/** Validate `value` against an {@link ObjectSchema}; error string or `null`. */
function checkObject(
  value: unknown,
  schema: ObjectSchema,
  path: string,
): string | null {
  if (!isPlainObject(value)) {
    return `${path} must be an object (got ${typeName(value)})`;
  }
  for (const [key, def] of Object.entries(schema.fields)) {
    const present = Object.prototype.hasOwnProperty.call(value, key);
    const fieldValue = value[key];
    const fieldPath = path === "" ? key : `${path}.${key}`;
    if (!present || fieldValue === undefined) {
      if (def.optional) continue;
      return `${fieldPath} is required`;
    }
    const err = checkField(fieldValue, def.spec, fieldPath);
    if (err) return err;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reusable DTO schemas (design §5.1)
// ---------------------------------------------------------------------------

const RISK_LEVELS = ["soft", "coordination-required", "hard"] as const;
const SCOPE_KINDS = ["file", "folder", "glob"] as const;
const PRESENCE_STATES = ["started", "editing", "stopped"] as const;
const EDGE_KINDS = [
  "runtime_import",
  "type_only_import",
  "test_dependency",
  "build_dependency",
  "generated_dependency",
  "dynamic_unknown",
] as const;
const CONFIDENCE_LEVELS = ["high", "medium", "low", "unknown"] as const;
const CONTRACT_KINDS = [
  "public_api",
  "exported_interface",
  "db_schema",
  "api_schema",
  "migration",
  "build_config",
] as const;
const COORD_ENTRY_TYPES = [
  "soft_lock",
  "presence",
  "intent",
  "planned_file_creation",
  "dependency_risk",
] as const;
const MESSAGE_KINDS = [
  "direct",
  "broadcast",
  "question",
  "answer",
  "heads_up",
] as const;
const MESSAGE_PRIORITIES = ["fyi", "normal", "urgent"] as const;
const TASK_STATUSES = [
  "proposed",
  "accepted",
  "rejected",
  "in_progress",
  "done",
  "withdrawn",
] as const;
const LIVENESS_STATES = ["active", "idle", "gone"] as const;
const NOTIFY_SEVERITIES = ["info", "warn", "urgent"] as const;
const NOTIFY_SOURCES = [
  "message",
  "task",
  "question",
  "wake",
  "conflict",
] as const;
const LUNA_ACTIONS = ["assign", "arbitrate", "answer", "summarize"] as const;

const sessionIdSchema: ObjectSchema = {
  name: "SessionId",
  fields: {
    repoId: { spec: { kind: "string" } },
    teamId: { spec: { kind: "string" } },
    branch: { spec: { kind: "string" } },
    baseRevision: { spec: { kind: "stringOrNull" } },
  },
};

const memberRefSchema: ObjectSchema = {
  name: "MemberRef",
  fields: {
    memberId: { spec: { kind: "string" } },
    deviceId: { spec: { kind: "string" } },
  },
};

const replayGuardSchema: ObjectSchema = {
  name: "ReplayGuard",
  fields: {
    counter: { spec: { kind: "number" } },
    nonce: { spec: { kind: "string" } },
  },
};

const lockSchema: ObjectSchema = {
  name: "Lock",
  fields: {
    lockId: { spec: { kind: "string" } },
    scope: { spec: { kind: "string" } },
    scopeKind: { spec: { kind: "enum", values: SCOPE_KINDS } },
    mode: { spec: { kind: "enum", values: RISK_LEVELS } },
    holder: { spec: { kind: "object", schema: memberRefSchema } },
    branch: { spec: { kind: "string" } },
    eventRevision: { spec: { kind: "number" } },
    acquiredAt: { spec: { kind: "string" } },
    concurrent: { spec: { kind: "boolean" } },
  },
};

const presenceSchema: ObjectSchema = {
  name: "Presence",
  fields: {
    member: { spec: { kind: "object", schema: memberRefSchema } },
    path: { spec: { kind: "string" } },
    state: { spec: { kind: "enum", values: PRESENCE_STATES } },
    eventRevision: { spec: { kind: "number" } },
  },
};

const plannedFileCreationSchema: ObjectSchema = {
  name: "PlannedFileCreation",
  fields: {
    path: { spec: { kind: "string" } },
  },
};

const declaredIntentSchema: ObjectSchema = {
  name: "DeclaredIntent",
  fields: {
    intentId: { spec: { kind: "string" } },
    owner: { spec: { kind: "object", schema: memberRefSchema } },
    agentId: { spec: { kind: "string" } },
    modifyPaths: { spec: { kind: "array", items: { kind: "string" } } },
    createPaths: {
      spec: {
        kind: "array",
        items: { kind: "object", schema: plannedFileCreationSchema },
      },
    },
    scopeKind: { spec: { kind: "enum", values: SCOPE_KINDS } },
    branch: { spec: { kind: "string" } },
    description: { spec: { kind: "string" } },
    eventRevision: { spec: { kind: "number" } },
  },
};

const winnerSchema: ObjectSchema = {
  name: "ConflictWinner",
  fields: {
    memberId: { spec: { kind: "string" } },
    eventRevision: { spec: { kind: "number" } },
  },
};

const dependencyEdgeSchema: ObjectSchema = {
  name: "DependencyEdge",
  fields: {
    from: { spec: { kind: "string" } },
    to: { spec: { kind: "string" } },
    kind: { spec: { kind: "enum", values: EDGE_KINDS } },
    confidence: { spec: { kind: "enum", values: CONFIDENCE_LEVELS } },
  },
};

const changedDependencyEdgeSchema: ObjectSchema = {
  name: "ChangedDependencyEdge",
  fields: {
    ...dependencyEdgeSchema.fields,
    op: { spec: { kind: "enum", values: ["add", "remove"] } },
  },
};

const publicContractFingerprintSchema: ObjectSchema = {
  name: "PublicContractFingerprint",
  fields: {
    id: { spec: { kind: "string" } },
    kind: { spec: { kind: "enum", values: CONTRACT_KINDS } },
    fingerprint: { spec: { kind: "string" } },
  },
};

const repositorySnapshotMetadataSchema: ObjectSchema = {
  name: "RepositorySnapshotMetadata",
  fields: {
    sessionId: { spec: { kind: "object", schema: sessionIdSchema } },
    graphVersion: { spec: { kind: "number" } },
    analyzerVersion: { spec: { kind: "string" } },
  },
};

const packageDependencyMetadataSchema: ObjectSchema = {
  name: "PackageDependencyMetadata",
  fields: {
    manifestPath: { spec: { kind: "string" } },
    packageManager: { spec: { kind: "string" } },
    directDependencyNames: {
      spec: { kind: "array", items: { kind: "string" } },
    },
    declaredVersionRanges: {
      spec: { kind: "record", values: { kind: "string" } },
    },
    scope: {
      spec: { kind: "enum", values: ["prod", "dev", "peer", "optional"] },
    },
    lockfileHash: { spec: { kind: "string" } },
  },
};

const moduleDependencyMetadataSchema: ObjectSchema = {
  name: "ModuleDependencyMetadata",
  fields: {
    sourceFile: { spec: { kind: "string" } },
    edges: {
      spec: {
        kind: "array",
        items: { kind: "object", schema: dependencyEdgeSchema },
      },
    },
  },
};

const dependencyGraphSchema: ObjectSchema = {
  name: "DependencyGraph",
  fields: {
    snapshot: {
      spec: { kind: "object", schema: repositorySnapshotMetadataSchema },
    },
    packages: {
      spec: {
        kind: "array",
        items: { kind: "object", schema: packageDependencyMetadataSchema },
      },
    },
    modules: {
      spec: {
        kind: "array",
        items: { kind: "object", schema: moduleDependencyMetadataSchema },
      },
    },
    contracts: {
      spec: {
        kind: "array",
        items: { kind: "object", schema: publicContractFingerprintSchema },
      },
    },
  },
};

const coordinationUpdateSchema: ObjectSchema = {
  name: "CoordinationUpdate",
  fields: {
    entryType: { spec: { kind: "enum", values: COORD_ENTRY_TYPES } },
    op: { spec: { kind: "enum", values: ["added", "removed"] } },
    path: { spec: { kind: "string" }, optional: true },
    member: { spec: { kind: "object", schema: memberRefSchema } },
    eventRevision: { spec: { kind: "number" } },
    intent: {
      spec: {
        kind: "object",
        schema: {
          name: "IntentActivity",
          fields: {
            intentId: { spec: { kind: "string" } },
            description: { spec: { kind: "string" } },
          },
        },
      },
      optional: true,
    },
  },
};

const messageDtoSchema: ObjectSchema = {
  name: "MessageDto",
  fields: {
    messageId: { spec: { kind: "string" } },
    kind: { spec: { kind: "enum", values: MESSAGE_KINDS } },
    sender: { spec: { kind: "object", schema: memberRefSchema } },
    toMemberId: { spec: { kind: "string" }, optional: true },
    priority: { spec: { kind: "enum", values: MESSAGE_PRIORITIES } },
    body: { spec: { kind: "string" } },
    correlationId: { spec: { kind: "string" }, optional: true },
    answered: { spec: { kind: "boolean" }, optional: true },
    eventRevision: { spec: { kind: "number" } },
    sentAt: { spec: { kind: "string" } },
  },
};

const taskDtoSchema: ObjectSchema = {
  name: "TaskDto",
  fields: {
    taskId: { spec: { kind: "string" } },
    title: { spec: { kind: "string" } },
    description: { spec: { kind: "string" } },
    assignee: { spec: { kind: "object", schema: memberRefSchema } },
    assigner: { spec: { kind: "object", schema: memberRefSchema } },
    status: { spec: { kind: "enum", values: TASK_STATUSES } },
    eventRevision: { spec: { kind: "number" } },
  },
};

const notificationDtoSchema: ObjectSchema = {
  name: "NotificationDto",
  fields: {
    notificationId: { spec: { kind: "string" } },
    toMemberId: { spec: { kind: "string" } },
    severity: { spec: { kind: "enum", values: NOTIFY_SEVERITIES } },
    source: { spec: { kind: "enum", values: NOTIFY_SOURCES } },
    refId: { spec: { kind: "string" } },
    summary: { spec: { kind: "string" } },
    eventRevision: { spec: { kind: "number" } },
  },
};

const liveDiffSchema: ObjectSchema = {
  name: "LiveDiffDto",
  fields: {
    path: { spec: { kind: "string" } },
    member: { spec: { kind: "object", schema: memberRefSchema } },
    patch: { spec: { kind: "string" } },
    eventRevision: { spec: { kind: "number" } },
  },
};

const eventAppliedLockConflictSchema: ObjectSchema = {
  name: "EventAppliedLockConflict",
  fields: {
    scope: { spec: { kind: "string" } },
    winner: { spec: { kind: "object", schema: winnerSchema } },
  },
};

const sessionStateSnapshotSchema: ObjectSchema = {
  name: "SessionStateSnapshot",
  fields: {
    session: { spec: { kind: "object", schema: sessionIdSchema } },
    locks: {
      spec: { kind: "array", items: { kind: "object", schema: lockSchema } },
    },
    presence: {
      spec: {
        kind: "array",
        items: { kind: "object", schema: presenceSchema },
      },
    },
    intents: {
      spec: {
        kind: "array",
        items: { kind: "object", schema: declaredIntentSchema },
      },
    },
    messages: {
      spec: {
        kind: "array",
        items: { kind: "object", schema: messageDtoSchema },
      },
      optional: true,
    },
    tasks: {
      spec: {
        kind: "array",
        items: { kind: "object", schema: taskDtoSchema },
      },
      optional: true,
    },
    notifications: {
      spec: {
        kind: "array",
        items: { kind: "object", schema: notificationDtoSchema },
      },
      optional: true,
    },
    highestRevision: { spec: { kind: "number" } },
  },
};

// ---------------------------------------------------------------------------
// Per-message payload schemas (design §4.3, §4.7)
// ---------------------------------------------------------------------------

/**
 * Registry mapping every catalog message type to the schema for its payload.
 * This is the authoritative per-type payload contract used by
 * {@link validatePayload}.
 */
export const PAYLOAD_SCHEMAS: Record<MessageTypeName, ObjectSchema> = {
  // Keys are the literal wire `type` strings. (The flattened `MessageType`
  // object collapses shared property names like `UPDATE`/`ERROR`, so string
  // literals — checked exhaustively by the `Record<MessageTypeName,…>` type —
  // are the unambiguous source of truth here.)

  // ---- Auth (§4.1) ----
  "auth.hello": {
    name: "AuthHelloPayload",
    fields: {
      devicePublicKey: { spec: { kind: "string" } },
      session: { spec: { kind: "object", schema: sessionIdSchema } },
      signedInvitation: { spec: { kind: "string" } },
      version: { spec: { kind: "number" } },
    },
  },
  "auth.challenge": {
    name: "AuthChallengePayload",
    fields: { nonce: { spec: { kind: "string" } } },
  },
  "auth.response": {
    name: "AuthResponsePayload",
    fields: { signature: { spec: { kind: "string" } } },
  },
  "auth.ok": {
    name: "AuthOkPayload",
    fields: { highestRevision: { spec: { kind: "number" } } },
  },
  "auth.error": {
    name: "AuthErrorPayload",
    fields: {
      code: { spec: { kind: "string" } },
      message: { spec: { kind: "string" } },
    },
  },

  // ---- Presence (Req 11) ----
  "presence.report": {
    name: "PresenceReportPayload",
    fields: {
      path: { spec: { kind: "string" } },
      state: { spec: { kind: "enum", values: PRESENCE_STATES } },
    },
  },
  "presence.update": {
    name: "PresenceUpdatePayload",
    fields: {
      member: { spec: { kind: "object", schema: memberRefSchema } },
      path: { spec: { kind: "string" } },
      state: { spec: { kind: "enum", values: PRESENCE_STATES } },
      eventRevision: { spec: { kind: "number" } },
    },
  },

  // ---- Locks (Req 12, 14, §4.7) ----
  "lock.acquire": {
    name: "LockAcquirePayload",
    fields: {
      scope: { spec: { kind: "string" } },
      scopeKind: { spec: { kind: "enum", values: SCOPE_KINDS } },
      mode: { spec: { kind: "enum", values: RISK_LEVELS } },
    },
  },
  "lock.release": {
    name: "LockReleasePayload",
    fields: {
      lockId: { spec: { kind: "string" }, optional: true },
      scope: { spec: { kind: "string" }, optional: true },
    },
  },
  "lock.override": {
    name: "LockOverridePayload",
    fields: {
      scope: { spec: { kind: "string" } },
      scopeKind: { spec: { kind: "enum", values: SCOPE_KINDS } },
      mode: { spec: { kind: "enum", values: RISK_LEVELS } },
      overrideReason: { spec: { kind: "string" } },
    },
  },
  "lock.update": {
    name: "LockUpdatePayload",
    fields: {
      op: { spec: { kind: "enum", values: ["added", "removed"] } },
      lock: { spec: { kind: "object", schema: lockSchema } },
    },
  },
  "lock.conflict": {
    name: "LockConflictPayload",
    fields: {
      scope: { spec: { kind: "string" } },
      winner: { spec: { kind: "object", schema: winnerSchema } },
      loserEventId: { spec: { kind: "string" } },
    },
  },

  // ---- Intents (Req 16-18, §4.7) ----
  "intent.declare": {
    name: "IntentDeclarePayload",
    fields: {
      modifyPaths: { spec: { kind: "array", items: { kind: "string" } } },
      createPaths: { spec: { kind: "array", items: { kind: "string" } } },
      description: { spec: { kind: "string" } },
    },
  },
  "intent.update": {
    name: "IntentUpdatePayload",
    fields: {
      intentId: { spec: { kind: "string" } },
      modifyPaths: { spec: { kind: "array", items: { kind: "string" } } },
      createPaths: { spec: { kind: "array", items: { kind: "string" } } },
      description: { spec: { kind: "string" } },
    },
  },
  "intent.withdraw": {
    name: "IntentWithdrawPayload",
    fields: { intentId: { spec: { kind: "string" } } },
  },
  "intent.progress": {
    name: "IntentProgressPayload",
    fields: {
      intentId: { spec: { kind: "string" } },
      completedPaths: {
        spec: { kind: "array", items: { kind: "string" } },
        optional: true,
      },
      note: { spec: { kind: "string" }, optional: true },
    },
  },
  "intent.conflict": {
    name: "IntentConflictPayload",
    fields: {
      path: { spec: { kind: "string" } },
      winner: { spec: { kind: "object", schema: winnerSchema } },
      loserEventId: { spec: { kind: "string" } },
      reclassifiedAs: {
        spec: { kind: "enum", values: ["modify"] },
        optional: true,
      },
    },
  },

  // ---- Dependency graph (Req 19-20, §4.7) ----
  "dep.snapshot": {
    name: "DepSnapshotPayload",
    fields: {
      graph: { spec: { kind: "object", schema: dependencyGraphSchema } },
    },
  },
  "dep.delta": {
    name: "DepDeltaPayload",
    fields: {
      changedEdges: {
        spec: {
          kind: "array",
          items: { kind: "object", schema: changedDependencyEdgeSchema },
        },
      },
      changedManifests: {
        spec: { kind: "array", items: { kind: "string" } },
      },
      changedLockfileHash: { spec: { kind: "string" }, optional: true },
      changedContracts: {
        spec: {
          kind: "array",
          items: { kind: "object", schema: publicContractFingerprintSchema },
        },
      },
    },
  },
  "dep.applied": {
    name: "DepAppliedPayload",
    fields: {
      graphVersion: { spec: { kind: "number" } },
      eventRevision: { spec: { kind: "number" } },
    },
  },

  // ---- Path changes (Req 30, §4.7) ----
  "path.renamed": {
    name: "PathRenamedPayload",
    fields: {
      fromPath: { spec: { kind: "string" } },
      toPath: { spec: { kind: "string" } },
    },
  },
  "path.deleted": {
    name: "PathDeletedPayload",
    fields: { path: { spec: { kind: "string" } } },
  },
  "file.created": {
    name: "FileCreatedPayload",
    fields: { path: { spec: { kind: "string" } } },
  },
  "path.update": {
    name: "PathUpdatePayload",
    fields: {
      op: { spec: { kind: "enum", values: ["renamed", "deleted", "created"] } },
      fromPath: { spec: { kind: "string" }, optional: true },
      path: { spec: { kind: "string" } },
      eventRevision: { spec: { kind: "number" } },
    },
  },

  // ---- Heartbeat (Req 26) ----
  "heartbeat.ping": {
    name: "HeartbeatPingPayload",
    fields: { sentAt: { spec: { kind: "string" }, optional: true } },
  },
  "heartbeat.ack": {
    name: "HeartbeatAckPayload",
    fields: { serverTime: { spec: { kind: "string" }, optional: true } },
  },

  // ---- Sync (Req 9, §4.6) ----
  "sync.request": {
    name: "SyncRequestPayload",
    fields: { fromRevision: { spec: { kind: "number" } } },
  },
  "sync.events": {
    name: "SyncEventsPayload",
    fields: {
      events: {
        spec: {
          kind: "array",
          items: { kind: "object", schema: coordinationUpdateSchema },
        },
      },
    },
  },
  "sync.snapshot": {
    name: "SyncSnapshotPayload",
    fields: {
      state: { spec: { kind: "object", schema: sessionStateSnapshotSchema } },
    },
  },

  // ---- Broadcast (Req 25) ----
  "coordination.update": coordinationUpdateSchema,
  "participants.update": {
    name: "ParticipantsUpdatePayload",
    fields: {
      connected: { spec: { kind: "array", items: { kind: "string" } } },
      offline: { spec: { kind: "array", items: { kind: "string" } } },
    },
  },

  // ---- Per-event mutation acknowledgement ----
  "event.applied": {
    name: "EventAppliedPayload",
    fields: {
      eventId: { spec: { kind: "string" } },
      eventRevision: { spec: { kind: "number" } },
      duplicateOf: { spec: { kind: "number" }, optional: true },
      lockConflict: {
        spec: { kind: "object", schema: eventAppliedLockConflictSchema },
        optional: true,
      },
    },
  },

  // ---- V2 messaging (Phase 1; Req 1.1-1.4) ----
  "message.send": {
    name: "MessageSendPayload",
    fields: {
      kind: { spec: { kind: "enum", values: MESSAGE_KINDS } },
      toMemberId: { spec: { kind: "string" }, optional: true },
      priority: {
        spec: { kind: "enum", values: MESSAGE_PRIORITIES },
        optional: true,
      },
      body: { spec: { kind: "string" } },
      correlationId: { spec: { kind: "string" }, optional: true },
    },
  },
  "message.update": {
    name: "MessageUpdatePayload",
    fields: {
      op: { spec: { kind: "enum", values: ["added", "updated"] } },
      message: { spec: { kind: "object", schema: messageDtoSchema } },
    },
  },
  "message.read": {
    name: "MessageReadPayload",
    fields: { messageId: { spec: { kind: "string" } } },
  },

  // ---- V2 tasks (Phase 2; Req 2.1-2.3) ----
  "task.assign": {
    name: "TaskAssignPayload",
    fields: {
      title: { spec: { kind: "string" } },
      description: { spec: { kind: "string" } },
      assigneeMemberId: { spec: { kind: "string" } },
    },
  },
  "task.respond": {
    name: "TaskRespondPayload",
    fields: {
      taskId: { spec: { kind: "string" } },
      accept: { spec: { kind: "boolean" } },
    },
  },
  "task.progress": {
    name: "TaskProgressPayload",
    fields: {
      taskId: { spec: { kind: "string" } },
      status: { spec: { kind: "enum", values: ["in_progress", "done"] } },
    },
  },
  "task.withdraw": {
    name: "TaskWithdrawPayload",
    fields: { taskId: { spec: { kind: "string" } } },
  },
  "task.update": {
    name: "TaskUpdatePayload",
    fields: {
      op: { spec: { kind: "enum", values: ["added", "updated", "removed"] } },
      task: { spec: { kind: "object", schema: taskDtoSchema } },
    },
  },

  // ---- V2 notifications, liveness & wake (Phase 3; Req 3.1-3.3) ----
  "liveness.update": {
    name: "LivenessUpdatePayload",
    fields: {
      memberId: { spec: { kind: "string" } },
      state: { spec: { kind: "enum", values: LIVENESS_STATES } },
      eventRevision: { spec: { kind: "number" } },
    },
  },
  "wake.request": {
    name: "WakeRequestPayload",
    fields: {
      targetMemberId: { spec: { kind: "string" } },
      reason: { spec: { kind: "string" }, optional: true },
    },
  },
  "notify.push": {
    name: "NotifyPushPayload",
    fields: {
      notificationId: { spec: { kind: "string" } },
      toMemberId: { spec: { kind: "string" } },
      severity: { spec: { kind: "enum", values: NOTIFY_SEVERITIES } },
      source: { spec: { kind: "enum", values: NOTIFY_SOURCES } },
      refId: { spec: { kind: "string" } },
      summary: { spec: { kind: "string" } },
      eventRevision: { spec: { kind: "number" } },
    },
  },

  // ---- V2 Luna orchestrator (Phase 4; Req 4.1-4.5) ----
  "luna.request": {
    name: "LunaRequestPayload",
    fields: {
      action: { spec: { kind: "enum", values: LUNA_ACTIONS } },
      prompt: { spec: { kind: "string" } },
      refId: { spec: { kind: "string" }, optional: true },
    },
  },
  "luna.reply": {
    name: "LunaReplyPayload",
    fields: {
      action: { spec: { kind: "enum", values: LUNA_ACTIONS } },
      summary: { spec: { kind: "string" } },
      producedTaskId: { spec: { kind: "string" }, optional: true },
      producedMessageId: { spec: { kind: "string" }, optional: true },
    },
  },

  // ---- V2 live diffs (Phase 5; Req 5.1-5.5) ----
  "diff.share": {
    name: "DiffSharePayload",
    fields: {
      path: { spec: { kind: "string" } },
      patch: { spec: { kind: "string" } },
    },
  },
  "diff.update": {
    name: "DiffUpdatePayload",
    fields: {
      op: { spec: { kind: "enum", values: ["shared", "removed"] } },
      diff: { spec: { kind: "object", schema: liveDiffSchema } },
    },
  },

  // ---- Error (§11.1) ----
  error: {
    name: "ErrorPayload",
    fields: {
      code: { spec: { kind: "string" } },
      message: { spec: { kind: "string" } },
      refEventId: { spec: { kind: "string" }, optional: true },
    },
  },
};

// ---------------------------------------------------------------------------
// Envelope schema (design §4.2, §5.1)
// ---------------------------------------------------------------------------

/**
 * Schema for the {@link EventEnvelope} structure, excluding `type`/`version`
 * (validated with dedicated catalog/version checks) and `payload` (validated
 * per-type by {@link validatePayload}).
 */
export const ENVELOPE_SCHEMA: ObjectSchema = {
  name: "EventEnvelope",
  fields: {
    type: { spec: { kind: "string" } },
    version: { spec: { kind: "number" } },
    eventId: { spec: { kind: "string" } },
    session: { spec: { kind: "object", schema: sessionIdSchema } },
    deviceId: { spec: { kind: "string" } },
    replay: { spec: { kind: "object", schema: replayGuardSchema } },
    sentAt: { spec: { kind: "string" } },
    // `payload` presence is required here; its shape is validated per-type.
    payload: {
      spec: { kind: "object", schema: { name: "payload", fields: {} } },
    },
  },
};

// ---------------------------------------------------------------------------
// Public validation entry points
// ---------------------------------------------------------------------------

/**
 * Validate a single message `payload` against the schema for `type`
 * (design §4.7). Returns a `FORMAT_ERROR` result for an unknown `type` or any
 * missing/mistyped required field (Req 7.6). Never throws.
 */
export function validatePayload<T extends MessageTypeName>(
  type: T,
  payload: unknown,
  refEventId?: string,
): PayloadValidationResult<T> {
  if (!isMessageType(type)) {
    return {
      ok: false,
      error: formatError(`unknown message type "${String(type)}"`, refEventId),
    };
  }
  const schema = PAYLOAD_SCHEMAS[type];
  const err = checkObject(payload, schema, schema.name);
  if (err) {
    return { ok: false, error: formatError(err, refEventId) };
  }
  return { ok: true, payload: payload as MessagePayloadMap[T] };
}

/**
 * Validate a bare {@link EventEnvelope} (design §4.2, §4.4).
 *
 * Rejects, with `FORMAT_ERROR` (Req 7.6):
 *   - a non-object or a structurally invalid envelope,
 *   - an unknown message `type` (not in the catalog),
 *   - an unsupported `version` (≠ {@link MESSAGE_FORMAT_VERSION}),
 *   - a payload that does not match its per-type schema.
 *
 * Never throws; authoritative state is untouched on failure (Req 7.6, 7.7).
 */
export function validateEnvelope(input: unknown): EnvelopeValidationResult {
  const structural = checkObject(input, ENVELOPE_SCHEMA, ENVELOPE_SCHEMA.name);
  if (structural) {
    return { ok: false, error: formatError(structural) };
  }

  const envelope = input as EventEnvelope;
  const refEventId =
    typeof envelope.eventId === "string" ? envelope.eventId : undefined;

  // Unknown type → FORMAT_ERROR (§4.4).
  if (!isMessageType(envelope.type)) {
    return {
      ok: false,
      error: formatError(
        `unknown message type "${String(envelope.type)}"`,
        refEventId,
      ),
    };
  }

  // Unsupported version → FORMAT_ERROR (Req 7.6).
  if (envelope.version !== MESSAGE_FORMAT_VERSION) {
    return {
      ok: false,
      error: formatError(
        `unsupported message-format version ${String(
          envelope.version,
        )} (expected ${MESSAGE_FORMAT_VERSION})`,
        refEventId,
      ),
    };
  }

  // Payload shape must match the per-type schema.
  const payloadResult = validatePayload(
    envelope.type,
    envelope.payload,
    refEventId,
  );
  if (!payloadResult.ok) {
    return { ok: false, error: payloadResult.error };
  }

  return {
    ok: true,
    envelope: envelope as TypedEventEnvelope,
  };
}

/**
 * Validate a {@link SignedEvent} wrapper: the `signature` must be a string and
 * the inner `envelope` must pass {@link validateEnvelope} (design §4.2).
 * Never throws.
 */
export function validateSignedEvent(
  input: unknown,
): SignedEventValidationResult {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      error: formatError(
        `SignedEvent must be an object (got ${typeName(input)})`,
      ),
    };
  }
  if (typeof input.signature !== "string") {
    return {
      ok: false,
      error: formatError("SignedEvent.signature must be a string"),
    };
  }
  const envelopeResult = validateEnvelope(input.envelope);
  if (!envelopeResult.ok) {
    return { ok: false, error: envelopeResult.error };
  }
  const signed: SignedEvent = {
    envelope: envelopeResult.envelope,
    signature: input.signature,
  };
  return {
    ok: true,
    signedEvent: {
      envelope: signed.envelope as TypedEventEnvelope,
      signature: signed.signature,
    },
  };
}

/** All catalog message types that have a registered payload schema. */
export const VALIDATED_MESSAGE_TYPES: readonly MessageTypeName[] =
  MESSAGE_TYPES;
