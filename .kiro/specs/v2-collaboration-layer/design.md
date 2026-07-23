# Design — CFLS V2: Collaboration Layer

> Extends the V1 design (`.kiro/specs/collaborative-file-lock-sync/design.md`) with
> the idea.md §6 capabilities not shipped in the MVP. Reuses the V1 architecture,
> transport, identity, ingest, and sync unchanged. Nothing here goes beyond
> idea.md's feature set.

## 1. Architecture reuse (no new infrastructure)

V2 introduces **no new process, transport, or trust boundary**. Every V2 feature is
a new message family that flows through the exact V1 pipeline:

```
Editor/AI ──Local_API──▶ CoordinationAgent ══WSS/TLS Signed_Event══▶ CoordinationHost
                                   ▲                                        │
                                   └──────── coordination.update ◀──────────┘
```

- **Identity/security:** V2 events are ordinary Signed_Events — same Ed25519
  signing, replay guard, session scoping, and data-minimization gate (Req X.1).
- **Ordering:** every V2 mutation gets a monotonic `Event_Revision` from the same
  `RevisionCounter` (deterministic, restart-safe).
- **Delivery/offline:** V2 items ride the same broadcast + `sync.request` /
  `sync.snapshot` path, so reconnecting members receive missed items (Req X.2).
- **Persistence:** the same `Store` DAO gains a few metadata-only tables; SQLite in
  the MVP, PostgreSQL-ready via the same interface.

Luna is modeled as a **special session participant** owned by the host process (a
`MemberRef` with a reserved id), not a new network node.

## 2. Protocol additions (`packages/protocol`)

New message-type groups added to the catalog (`messages.ts`) and payload/validation
schemas (`validation.ts`). All wire-compatible under the existing
`MESSAGE_FORMAT_VERSION` (additive; unknown types already rejected safely).

### 2.1 Messaging (Phase 1)

```typescript
// message types
message.send        // C→H  send a directed/broadcast message, question, answer, heads-up
message.update      // H→C  broadcast of a message (added) / read-receipt (updated)
message.read        // C→H  mark a message read
```

```typescript
export type MessageKind = "direct" | "broadcast" | "question" | "answer" | "heads_up";
export type MessagePriority = "fyi" | "normal" | "urgent";

export interface MessageDto {
  messageId: string;
  kind: MessageKind;
  sender: MemberRef;
  /** Present for kind==="direct"|"question"|"answer": the single recipient memberId. */
  toMemberId?: string;
  priority: MessagePriority;
  /** Team text; never secrets/paths outside repo (data-minimized). */
  body: string;
  /** For question/answer correlation. */
  correlationId?: string;
  /** answered flag for a question. */
  answered?: boolean;
  eventRevision: number;
  sentAt: string;
}
```

### 2.2 Tasks (Phase 2)

```typescript
task.assign     // C→H  create a proposed task for an assignee (human or via Luna)
task.respond    // C→H  assignee approves | rejects an incoming proposed task
task.progress   // C→H  assignee sets in_progress | done
task.withdraw   // C→H  assigner/assignee withdraws
task.update     // H→C  broadcast of the authoritative task state
```

```typescript
export type TaskStatus =
  | "proposed" | "accepted" | "rejected" | "in_progress" | "done" | "withdrawn";

export interface TaskDto {
  taskId: string;
  title: string;
  description: string;
  assignee: MemberRef;      // whose Task_List it targets
  assigner: MemberRef;      // human or Luna
  status: TaskStatus;
  eventRevision: number;
}
```

### 2.3 Notifications, liveness & wake (Phase 3)

```typescript
liveness.update   // H→C  a member's active|idle|gone changed
wake.request      // C→H  ask an idle member to resume
notify.push       // H→C  a severity-tagged notification for a recipient
```

```typescript
export type LivenessState = "active" | "idle" | "gone";
export type NotifySeverity = "info" | "warn" | "urgent";

export interface NotificationDto {
  notificationId: string;
  toMemberId: string;
  severity: NotifySeverity;
  source: "message" | "task" | "question" | "wake" | "conflict";
  refId: string;          // messageId/taskId/etc.
  eventRevision: number;
}
```

### 2.4 Luna (Phase 4)

Luna reuses `message.*` and `task.*` on the wire. Its only protocol addition is a
request channel:

```typescript
luna.request    // C→H  human asks Luna to assign work | arbitrate | answer | summarize
luna.reply      // H→C  Luna's structured reply (also mirrored as a message)
```

```typescript
export type LunaAction = "assign" | "arbitrate" | "answer" | "summarize";
export interface LunaRequestDto { action: LunaAction; prompt: string; refId?: string; }
export interface LunaReplyDto { action: LunaAction; summary: string; producedTaskId?: string; producedMessageId?: string; }
```

### 2.5 Live diffs (Phase 5)

```typescript
diff.share    // C→H  (opt-in) share current diff for a path
diff.update   // H→C  broadcast a shared diff / its removal
```

```typescript
export interface LiveDiffDto {
  path: string;
  member: MemberRef;
  /** Unified-diff text, data-minimized; only when Live_Diff is enabled. */
  patch: string;
  eventRevision: number;
}
```

## 3. Core-state additions (`packages/core-state`) — pure & testable

Following V1's pattern (pure registries, no I/O, property-tested):

- **`messaging.ts` — `MessageRegistry`** (Phase 1): append messages per session,
  track per-recipient delivery/read, resolve unanswered questions, exclude own
  messages from unread counts. Deterministic ordering by `eventRevision`.
- **`tasks.ts` — `TaskRegistry`** (Phase 2): task lifecycle state machine with the
  authorization rules (only assignee approves/rejects; assigner/assignee withdraw),
  per-member Task_List projection.
- **`liveness.ts` — `LivenessTracker`** (Phase 3): derive `active|idle|gone` from
  last-activity + heartbeat timestamps (reusing `ExpiryEngine` inputs); notification
  builder mapping events→severity.
- **`orchestrator.ts` — `LunaBrain` interface + `RulesLunaBrain`** (Phase 4):
  deterministic assignment (pick least-busy suitable member from liveness + current
  activity), arbitration (defer to earliest-revision, else tie-break rule), summary
  builder (plain text from state). Optional `LlmLunaBrain` adapter behind the same
  interface, unused unless injected.
- **`diffs.ts` — `DiffRegistry`** (Phase 5): store latest diff per (member, path)
  when enabled; drop on stop/exclusion.

All registries are added to the session snapshot (serialize/restore) and to the sync
projection, mirroring V1's `snapshot.ts` / `sync.ts`.

## 4. Host additions (`apps/host`)

- New `apply()` branches in `authority.ts` for each new message type, each returning
  broadcasts + audits, committed in the same atomic `commitMutation` transaction.
- New metadata-only `Store` tables: `messages`, `task_items`, `notifications`,
  `live_diffs` (+ read-state), with append/replace + snapshot integration.
- Luna lives in the host: a `LunaService` holds the `LunaBrain`, listens for
  `luna.request`, and emits `task.assign` / `message.send` / `luna.reply` as the
  reserved Luna member. Disabled-LLM default = `RulesLunaBrain`.
- Dashboard extended (metadata-only) with messages/tasks/liveness counts — no bodies
  unless already metadata; no diffs.

## 5. Agent additions (`apps/agent`)

- `AgentCoordinationPort` gains methods: `sendMessage`, `markRead`, `listMessages`,
  `assignTask`, `respondTask`, `progressTask`, `listTasks`, `getLiveness`,
  `wake`, `askLuna`, and (Phase 5) `shareDiff`/`listDiffs`.
- Local_API `dispatch.ts` routes the new methods; the extension and MCP bridge call
  them over the existing authenticated loopback.
- Live diffs (Phase 5): the watcher computes a diff **locally** (git diff of the
  Authorized_Folder) only when the team config enables it; nothing else changes.

## 6. MCP additions (`packages/mcp-server`)

New tools registered alongside the existing 13 (each returns the standard
`McpEnvelope` with connection/staleness):

- `send_message`, `list_messages`, `mark_message_read`
- `ask_question`, `answer_question`, `list_open_questions`
- `assign_task`, `respond_to_task`, `update_task_progress`, `list_tasks`
- `get_liveness`, `wake_member`, `get_notifications`
- `ask_luna`
- (Phase 5) `share_diff`, `list_diffs`

Every mutation obeys offline semantics (`OFFLINE_QUEUED`, never false acceptance).

## 7. VS Code extension additions (`apps/vscode-extension`)

The existing team panel gains tabs/sections (metadata-only rendering):

- **Messages** — inbox, priority styling, question/answer, compose.
- **Tasks** — my Task_List, incoming approvals (accept/reject), progress.
- **Team** — liveness dots (active/idle/gone), wake action.
- **Notifications** — severity-styled, sound cue for urgent.
- **Luna** — a chat box to direct Luna and read summaries.
- (Phase 5) **Live diffs** — read-only diff view when enabled.

## 8. Testing strategy (per phase)

- **Property tests** (core-state): message ordering/read-count exclusion; task
  state-machine legality; liveness monotonic transitions; arbitration determinism.
- **Unit tests**: registries, Luna rules, notification severity mapping, diff gating.
- **Integration tests**: host ingest+broadcast+sync round-trips for each new family;
  MCP tool round-trips; offline queue + reconnect delivery.
- **Simulation**: extend the multi-agent sim with a messaging→task→approval→Luna
  scenario and (opt-in) a live-diff scenario.
- **Regression**: the full V1 suite stays green (Req X.4).

## 9. Rollout / merge discipline

Build in phase order (P1→P5). Within a phase, land in stack order
(protocol→core-state→host→agent→mcp→extension→tests), committing per file/task.
At phase end: run `pnpm typecheck` + `pnpm test` green, then merge `V2`→`main`
(regular merge, no squash).
