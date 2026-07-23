# CFLS V2 — Build Memory & Context

> **Purpose of this file:** the single, always-current source of truth for the V2
> build. If context is ever lost, READ THIS FIRST. It records the vision, what is
> already built, what V2 adds, the phase plan, decisions, conventions, and a live
> progress tracker. Update the "Progress tracker" section after every task.

---

## 0. Source of truth

- **Vision:** `Documentation/idea.md` (also mirrored to the user's `Downloads/idea.md`).
  V2 exists to build the parts of that vision the MVP (V1) deliberately did not ship.
- **V1 spec (already delivered):** `.kiro/specs/collaborative-file-lock-sync/`
  (requirements.md / design.md / tasks.md). V2 does **not** rewrite V1; it extends it.
- **V2 spec (this build):** `.kiro/specs/v2-collaboration-layer/`.

## 1. Working rules (do not violate)

1. **Branch:** all V2 work is committed to the `V2` branch. Merge `V2` → `main`
   with a **regular merge (never squash)** at the end of each phase, so every
   commit stays on the contribution graph on its original date.
2. **Commit granularity:** commit after **every file created or every task
   finished**. Small, frequent commits. Use clear messages:
   `V2(phaseN/taskX): <what>`.
3. **Do NOT push** unless the user explicitly asks. Commit locally only.
4. **No build errors, ever.** Keep `pnpm typecheck` and `pnpm test` green before
   moving to the next task. Each task must leave the tree in a working state.
5. **Match existing conventions:** strict TypeScript, ESM, JSDoc tone of
   `apps/*/src` and `packages/*/src`; EARS requirements; numbered tasks; property
   tests via `@cfls/test-utils` (≥100 runs, tagged).
6. **Metadata-only principle stays.** Coordination shares metadata, never source
   bytes — EXCEPT the opt-in "live diffs" feature (Phase 5), which is explicitly
   gated and off by default.
7. **Reuse, don't reinvent.** Build on `@cfls/protocol`, `@cfls/core-state`,
   `@cfls/security`, `@cfls/host`, `@cfls/agent`, `@cfls/mcp-server`.

## 2. What is already built (V1 MVP — DONE)

- Host authority (WSS/TLS, ingest gate, monotonic Event_Revision, persistence,
  restart recovery, dashboard).
- Local Agent (watcher, encrypted cache, loopback Local_API, embedded MCP,
  offline/stale, reconnect sync + re-assert).
- Protocol package (versioned envelope, message catalog, DTOs, error codes,
  hand-written validator).
- core-state (locks, presence, intents, risk, conflict-by-earliest-revision,
  sync, expiry, coalescing, data-minimization).
- security (Ed25519 keys, signing, signed invitations, revocation/rotation,
  replay guard, credential store).
- dependency-analyzer (metadata-only TS/JS graph, manifests, contract hashes).
- mcp-server (13 tools), vscode-extension (status item + team panel + hard-stop),
  cli (`cfls` onboarding/host/agent/mcp/service/sync), Git-sync (opt-in).
- Tests: unit + property + integration + 5-agent simulation.

## 3. Gap analysis — what V2 adds (from idea.md §6)

| idea.md capability | V1 status | V2 phase |
| --- | --- | --- |
| Agent↔agent messaging (direct/broadcast, priority, questions, FYIs) | ❌ | **P1** |
| Shared task system + assignment + human approval of incoming work | 🟡 (only intents) | **P2** |
| Notifications (severity/sound) + liveness active/idle/gone + wake idle agent | 🟡 | **P3** |
| Luna orchestrator (assign/route, arbitrate, answer, summarize) | ❌ | **P4** |
| Live diffs (opt-in) | ❌ (intentionally excluded) | **P5** |

Already strong in V1 (do not rebuild): live "who's on what", IDE panel,
reconnect safety, identity/invites/revocation, secrets never shared.

## 4. Phase plan (dependency order)

- **Phase 1 — Messaging channel.** Directed + broadcast messages, priority
  (fyi/normal/urgent), question/answer with correlation ids, delivery + read
  state. Foundation for P2/P3/P4.
- **Phase 2 — Tasks & approvals.** Shared task objects, per-member task lists,
  assign a task to a member, receiving human approves/rejects before it lands.
  Builds on P1.
- **Phase 3 — Notifications, liveness & wake.** active/idle/gone status,
  severity-based notifications surfaced in the extension, "wake/resume" a member's
  agent (delivered at its next action — honor idle non-goal).
- **Phase 4 — Luna orchestrator.** Central orchestrator: intelligent task
  assignment, conflict arbitration beyond mechanical rules, answering cross-agent
  questions, plain-language team summaries. Rules-based core with an OPTIONAL
  pluggable LLM adapter (off by default; no API key required to build/run).
- **Phase 5 — Live diffs (opt-in).** Share change diffs within the trusted team,
  strictly opt-in and gated; largest data-model change, done last.

Each phase flows through the stack:
`protocol` → `core-state` → `host` → `agent` → `mcp-server` → `vscode-extension`,
with tests at each layer, then a phase-end merge `V2` → `main`.

## 5. Key decisions

- **Luna is rules-based by default**, with a typed `LunaBrain` interface and an
  optional LLM adapter that is disabled unless configured. This respects the
  idea.md principle "keep cheap mechanical decisions out of the expensive path"
  and keeps the build/test deterministic and key-free.
- **Messaging is metadata-ish but may carry human/agent text** (message bodies,
  questions, answers, task descriptions). This is team content shared within the
  trusted team per idea.md §6 Safety — still never secrets, credentials, or files
  outside the repo. Data-minimization still rejects secrets/absolute paths.
- **Live diffs are the only feature that moves source-derived content**, so it is
  opt-in, gated by config, and clearly separated (Phase 5).
- **New MCP tools** are added for messaging/tasks/Luna so AI agents are
  first-class participants (idea.md §2).

## 6. Naming (proposed, refined in the spec)

New protocol message categories: `message.*`, `task.*`, `notify.*`, `luna.*`,
`diff.*`. New core-state modules: `messaging.ts`, `tasks.ts`, `liveness.ts`,
`orchestrator.ts`, `diffs.ts`. New MCP tools grouped alongside the existing 13.

## 7. Progress tracker (UPDATE AFTER EVERY TASK)

- [x] Spec authored (requirements / design / tasks) — DONE
- [x] Phase 1 — Messaging (COMPLETE: tasks 1.1–1.12; changed packages all green)
- [x] Phase 2 — Tasks & approvals (COMPLETE: tasks 2.1–2.11; changed packages green)
- [x] Phase 3 — Notifications, liveness & wake (COMPLETE: tasks 3.1–3.9; changed packages green)
- [x] Phase 4 — Luna orchestrator (COMPLETE: tasks 4.1–4.9; changed packages green)
- [x] Phase 5 — Live diffs (opt-in) (COMPLETE: tasks 5.1–5.9; changed packages green)

### Task log
- (append: `YYYY-MM-DD  V2(phaseN/taskX)  <commit hash>  <summary>`)
- V2(spec)  69dabbc/fbc7828/7b13d35/6a331ec  memory + requirements + design + tasks
- V2(p1/1.1) 7f63288  protocol: message.* types, MessageDto, MessageKind/Priority
- V2(p1/1.2) 20de98d  protocol: message.* validation schemas + unit tests (71 tests green)
- V2(p1/1.3) beecf83  core-state: MessageRegistry (addressing, Q/A, read state)
- V2(p1/1.4) 36ca765  core-state: MessageRegistry unit + property tests (307 tests green)
- NOTE: whole workspace `pnpm -r build` green; run `pnpm -r build` before core-state
  tests so @cfls/security dist resolves (ingest suites depend on it).
- V2(p1/1.5) 88960ed  snapshot includes messages (reconnect-safe); SessionStateSnapshot
  gained optional `messages`; host will re-send missed message.updates after sync.
- PUSH POLICY: push `V2` to origin after every commit (merge to main only at the end).
  Branch pushed & tracking origin/V2.
- V2(p1/1.6-1.8) b6626c9/3ece26b/aea380c/040c57b  host: message apply-branches,
  audience delivery, missed-message resend on sync, integration tests (65 host tests green).
- V2(p1/1.9-1.10) ce3a2b7/3b17541  agent messaging vertical (view MessageRegistry,
  gateway/connection relay of message.update, port sendMessage/listMessages/
  markMessageRead/listOpenQuestions, dispatch); 6 MCP tools + tests (28 mcp green).
- SIMPLIFICATION: ask/answer are MCP tools that call port.sendMessage with
  kind=question/answer (no separate port methods) — fewer port methods, same feature.
- PRE-EXISTING FLAKY TESTS (NOT ours): apps/agent local-api.integration
  "deduplicates subscriptions ... disposes on close" and connection.integration
  "retires a switched-away editor ..." fail on the CLEAN base in this sandbox
  (close-timing races). Verified via git stash. Do not chase these.
- V2(p1/1.11-1.12) 5ead765/2c30990  extension messages view-model + Phase 1 gate.
- PHASE 1 COMPLETE. Full-suite (`pnpm test`) shows 8 failures, ALL pre-existing/
  environmental (NOT V2): agent local-api "deduplicates…" + connection.integration
  editor-TTL tests (fail on clean base), cli config-files Windows owner-only perms +
  mcp-bridge reconnect-timing (files untouched, mock handlers), and simulation only
  under full parallel load (passes 11/11 in isolation). MERGE TO MAIN: only after ALL
  phases done (updated instruction). Next: Phase 2 — Tasks & approvals (task 2.1).
- PHASE 2 COMPLETE (tasks 2.1–2.11). Task lifecycle: proposed→accepted/rejected,
  accepted/in_progress→in_progress/done, →withdrawn. Only assignee responds/progresses;
  assigner or assignee withdraws. Tasks persist via snapshot (like messages, no table).
  Host broadcasts task.update to whole session + resends tasksSince on reconnect.
  4 MCP tools (assign_task/respond_to_task/update_task_progress/list_tasks). Extension
  view-model has myTasks/incomingTasks/allTasks. TaskDto.assignee.deviceId is "" (a task
  targets a member, not a device). core-state 323, host 68, mcp 31, extension 63.
  NEXT: Phase 3 — Notifications, liveness & wake (task 3.1).
- PHASE 3 COMPLETE (tasks 3.1–3.9). Liveness active/idle/gone: derived by
  LivenessTracker from live roster + activity window (60s); host broadcasts
  liveness.update on connect/disconnect/heartbeat/sweep (advisory revision, applied
  by memberId). Notifications: NotificationRegistry (persisted via snapshot); host
  emits notify.push to target on incoming task (warn), question (warn), urgent direct
  message (urgent), and wake (urgent); never for own actions. Wake = a source="wake"
  notification. 3 MCP tools (get_liveness/wake_member/get_notifications). Extension
  view-model has notifications + urgentNotificationCount + per-member liveness.
  protocol 81, core-state 335, host 72, mcp 34, extension 66. NEXT: Phase 4 — Luna.
- KEY DECISION: message `body` is allowed TEAM TEXT (idea.md §6 Safety). The host
  value-scans the body for secrets/absolute/excluded paths (Req 1.4) but does NOT
  name-block it. Do the same for future free-text fields (task descriptions, luna
  prompts) — but note `description`/`prompt`/`note` are already not name-blocked;
  only `body`/`text`/`content`/`diff`/`patch` etc. are. Live diffs (P5) will need
  the same value-scan treatment for `patch`.
- PHASE 4 COMPLETE (tasks 4.1–4.9). Luna orchestrator. protocol `luna.request`/
  `luna.reply` (LunaMessageType keys ASK/REPLY, wire strings `luna.request`/
  `luna.reply` — avoids flattened-map collision with sync.request). core-state
  `orchestrator.ts`: `LunaBrain` interface + deterministic `RulesLunaBrain`
  (assign/arbitrate/answer/summarize) + optional inert `LlmLunaBrain`. Host
  `LunaService` uses reserved LUNA_MEMBER = {memberId:"luna",deviceId:"luna"};
  handles luna.request → emits task.assign/message.send + luna.reply; rules-based
  default, no external service/key. Agent `askLuna` port method uses optional
  `gateway.askLuna?` (RealHostGateway → connection.requestLuna); returns
  OFFLINE_QUEUED when the gateway can't reach Luna. MCP tool `ask_luna`
  (action/prompt/refId) added to TOOL_NAMES. Extension view-model adds optional
  `luna?: AskLunaData` snapshot → `lunaLastReply` view (read-only summary).
  Counts: protocol 84, core-state 344, host 75, mcp 36, extension 68.
- FIX (p4/4.9): LivenessTracker.recordActivity now records the FIRST activity even
  at epoch 0 (was `?? 0` + strict `>`, which dropped atMs===0). Stabilizes the
  flaky liveness property 19 counterexample [true,0,0]. Real code fix, not a test
  change. Agent's local-api "deduplicates subscriptions … disposes on close" is
  still the known pre-existing close-timing flake (NOT a V2 regression).
- NEXT: Phase 5 — Live diffs (opt-in), tasks 5.1–5.9, then Final 6.1–6.3. Live
  diffs are the ONLY source-derived feature: opt-in team-shared config flag
  (`.coordination/config.json` `liveDiffs`) default OFF; host value-scans `patch`
  for secrets/absolute/excluded paths like message `body`; agent computes local
  git-diff of Authorized_Folder only when enabled.
- PHASE 5 COMPLETE (tasks 5.1–5.9). Live diffs — the ONLY source-derived,
  opt-in feature. protocol `diff.share`(C→H)/`diff.update`(H→C) + `LiveDiffDto`;
  DiffMessageType spread before Broadcast (shared UPDATE key); catalog now 48
  (errors.test.ts). core-state `DiffRegistry` stores latest per (member,path);
  empty patch clears; persists via snapshot (SessionStateSnapshot.diffs?).
  Team opt-in: `.coordination/config.json` `liveDiffs.enabled` (default OFF) via
  cli `readLiveDiffsConfig`; `cfls host` passes `liveDiffsEnabled` into
  AuthorityOptions (ServerOptions extends AuthorityOptions). Host apply-branch
  rejects diff.share with AUTH_NOT_AUTHORIZED when disabled (V1 parity); when
  enabled, value-scans `patch` via findMinimizationViolations (like message body),
  stores, broadcasts diff.update to whole session, resends diffsSince on reconnect.
  Agent: gateway MutationEvent + `diff.share`; connection emits "diff" from
  diff.update; AgentView.applyDiff/allDiffs (DiffRegistry); port shareDiff (mutation,
  optional localDiff provider computes git diff when patch omitted+online) / listDiffs
  (read); dispatch share_diff/list_diffs. MCP tools share_diff/list_diffs (28 tools).
  Extension view-model `liveDiffs` read-only projection (never auto-applies).
  Counts: protocol 89, core-state 352, host 78, mcp 38, extension 70, cli cfg green.
- ALL 5 PHASES + FINAL COMPLETE. 6.1 simulation scenario 11 (message→task→approval
  →Luna→live-diff, agentCount 2, liveDiffs on) green. 6.2 README + docs/features.md
  document V2 honestly (MCP tool groups + opt-in live diffs). 6.3 full `pnpm -r build`
  green; merging V2→main with a REGULAR merge (never squash) to preserve every
  commit's author date on the contribution graph.
- FINAL COUNTS: protocol 89, core-state 352, host 78, mcp 38, extension 70, cli
  config-files green, simulation scenario 11 green. Known pre-existing flaky tests
  (NOT V2): agent local-api "deduplicates subscriptions… disposes on close" +
  connection.integration editor-TTL races; cli config-files Windows perms +
  mcp-bridge reconnect; simulation only under full parallel load. Verify changed
  packages in isolation.
