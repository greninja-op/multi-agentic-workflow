# Requirements Document — CFLS V2: Collaboration Layer

## Introduction

CFLS V1 delivered the coordination fabric: live presence, soft/coordination/hard
locks, declared intents, dependency-aware risk, per-device identity, reconnect-safe
sync, and a metadata-only host. CFLS **V2** builds the remaining half of the
`Documentation/idea.md` vision — turning a team of agents into a *communicating,
coordinated engineering team* — **strictly** the capabilities named in idea.md §6,
nothing more:

1. **Communication** — agents (and humans) send directed and broadcast messages,
   ask questions that need a reply, send heads-ups/FYIs, and mark message priority.
2. **Task management** — a shared, evolving set of tasks; each member has a task
   list; humans assign big work; the receiving human approves incoming work before
   it lands; agents self-coordinate only small things.
3. **Direction & control (human)** — a chat to direct Luna/the team, approvals for
   incoming assignments, notifications by severity, and the ability to wake/resume
   an idle agent.
4. **Orchestration (Luna)** — one central orchestrator that assigns/routes tasks
   intelligently, arbitrates conflicts the mechanical rules cannot resolve, answers
   cross-agent questions, and summarizes the live team state in plain language.
5. **Liveness & live diffs** — active/idle/gone status per member; and each
   participant can (opt-in) see other members' changes/diffs live.

V2 preserves every V1 guarantee and principle: git still moves file bytes; identity
is per-device and signed; only invited members join; secrets, credentials, and
anything outside the repo are never shared. New message/task/diff content is **team
content** shared only within the trusted, authorized team (idea.md §6 Safety).

This document is scoped **only** to idea.md's feature set. It adds no capability the
idea document does not call for.

## Scope and Phasing

Each requirement carries a bracketed phase tag matching the V2 phase plan.

- **(Phase 1: Messaging)** — communication channel.
- **(Phase 2: Tasks)** — task system + human approvals.
- **(Phase 3: Notifications & Liveness)** — notifications, active/idle/gone, wake.
- **(Phase 4: Luna)** — the orchestrator.
- **(Phase 5: Live Diffs)** — opt-in live diff sharing.

### Out of Scope (unchanged from V1, and idea.md non-goals §9)

- CFLS does not replace git; git moves file contents and handles branches/PRs.
- CFLS does not autonomously carve big features between agents — humans own the
  macro plan (Luna only assigns/routes what humans direct).
- CFLS does not read the internals of other AI tools' chats; it observes effects
  and relies on agents declaring intentions and sending messages.
- No "instant push into a sleeping agent": wake is delivered at the agent's next
  action, bridged via the always-on host and the human (idea.md §9).
- Anything not named in idea.md §6 is out of scope for V2.

## Glossary (V2 additions)

- **Message**: A metadata+text coordination item sent by one Team_Member/AI_Agent
  to another member (Directed_Message) or to everyone in the session
  (Broadcast_Message). Carries a body, a Message_Priority, and delivery/read state.
  Never carries secrets, credentials, or content outside the repository.
- **Directed_Message**: A Message addressed to exactly one recipient member.
- **Broadcast_Message**: A Message addressed to all members of the Repository_Session.
- **Question**: A Message that requires a reply, carrying a correlation id so its
  Answer can be matched to it. Supports a "wait for the answer" mode.
- **Answer**: A Message that replies to a Question, referencing its correlation id.
- **Heads_Up**: An FYI Message that expects no reply (e.g. "I renamed this function").
- **Message_Priority**: One of `fyi` | `normal` | `urgent`, controlling how loudly
  the recipient is alerted.
- **Task**: A shared unit of work with an id, a title/description, an owner
  (assignee) member, a lifecycle status, and the originating (assigning) member.
- **Task_List**: The set of Tasks currently assigned to a given Team_Member.
- **Task_Assignment**: The act of a human (directly or via Luna) assigning a Task
  to a Team_Member's machine.
- **Task_Approval**: The receiving Team_Member's explicit accept/reject of an
  incoming Task_Assignment before it lands in their Task_List.
- **Notification**: A surfaced alert to a human, carrying a severity derived from
  Message_Priority / task / question / blocking situation.
- **Liveness_State**: A member's current availability: `active` | `idle` | `gone`.
- **Wake_Request**: A request to resume/wake a member whose agent is idle; delivered
  at the member's next action (never an interrupt of a sleeping turn).
- **Luna**: The single central orchestrator participant. Assigns/routes tasks,
  arbitrates conflicts beyond mechanical rules, answers cross-agent questions, and
  summarizes team state. Rules-based by default with an optional pluggable brain.
- **Luna_Brain**: The pluggable decision component behind Luna. Default is
  deterministic/rules-based; an optional LLM adapter may be configured and is off
  by default.
- **Live_Diff**: An opt-in, team-only share of a member's current change diff for a
  path, surfaced live to other members. Off by default; the only V2 feature that
  moves source-derived content.

---

## Phase 1 — Communication (Messaging)

### Requirement 1.1 — Directed and broadcast messages (Phase 1: Messaging)

**User story:** As an AI_Agent, I want to send a message to a specific teammate or
to the whole team, so that we coordinate directly instead of colliding silently.

#### Acceptance Criteria
1. WHEN a Team_Member/AI_Agent sends a Directed_Message to a recipient in the same
   Repository_Session, THE SYSTEM SHALL deliver it only to that recipient's members
   and record it with a monotonic Event_Revision.
2. WHEN a Team_Member/AI_Agent sends a Broadcast_Message, THE SYSTEM SHALL deliver
   it to all authorized members of the Repository_Session.
3. THE SYSTEM SHALL reject a Message addressed to a member not authorized for the
   session with `AUTH_NOT_AUTHORIZED`, changing no state.
4. THE SYSTEM SHALL carry a message body as team text metadata and SHALL reject any
   Message whose body violates data-minimization (secrets/credentials/absolute
   paths) with `FORMAT_ERROR`.
5. THE SYSTEM SHALL attribute every Message to the sending member and device via a
   verifiable signed event.

### Requirement 1.2 — Message priority (Phase 1: Messaging)
1. THE SYSTEM SHALL support a Message_Priority of `fyi`, `normal`, or `urgent` on
   every Message.
2. WHEN priority is absent, THE SYSTEM SHALL default it to `normal`.
3. THE SYSTEM SHALL surface the priority to recipients so a client can alert
   accordingly (alerting behavior is Phase 3).

### Requirement 1.3 — Questions and answers (Phase 1: Messaging)
1. WHEN a member sends a Question, THE SYSTEM SHALL assign it a correlation id and
   mark it as awaiting an answer.
2. WHEN a member sends an Answer referencing a Question's correlation id, THE SYSTEM
   SHALL deliver it to the asker and mark the Question answered.
3. THE SYSTEM SHALL allow a client to query outstanding (unanswered) Questions
   addressed to it (supporting a "wait for the answer" mode).
4. THE SYSTEM SHALL support Heads_Up messages that expect no reply.

### Requirement 1.4 — Delivery and read state (Phase 1: Messaging)
1. THE SYSTEM SHALL track, per Message, whether each intended recipient has received
   and read it.
2. WHEN a recipient is offline, THE SYSTEM SHALL retain the Message and deliver it on
   the recipient's next successful sync (reconnect-safe, reusing V1 sync-from-revision).
3. THE SYSTEM SHALL make Messages available through both the MCP tools and the
   editor panel, and SHALL exclude a member's own sent messages from its unread count.

---

## Phase 2 — Task management & human approvals

### Requirement 2.1 — Shared tasks and per-member task lists (Phase 2: Tasks)
1. THE SYSTEM SHALL represent a Task with an id, title/description, assignee member,
   assigning member, and a lifecycle status of `proposed` | `accepted` | `rejected`
   | `in_progress` | `done` | `withdrawn`.
2. THE SYSTEM SHALL maintain a Task_List per Team_Member (the tasks assigned to them).
3. WHEN a Task changes, THE SYSTEM SHALL broadcast the change to authorized members
   with a monotonic Event_Revision.
4. THE SYSTEM SHALL treat Declared_Intents (V1) as the agent-level, self-coordinated
   small work, and Tasks as the human-directed larger work — the two coexist.

### Requirement 2.2 — Assignment and approval (Phase 2: Tasks)
1. WHEN a human (directly or via Luna) assigns a Task to a member, THE SYSTEM SHALL
   create the Task in status `proposed` targeting that member.
2. WHEN the receiving member approves an incoming `proposed` Task, THE SYSTEM SHALL
   move it to `accepted` and add it to that member's Task_List.
3. WHEN the receiving member rejects an incoming `proposed` Task, THE SYSTEM SHALL
   move it to `rejected` and SHALL NOT add it to the Task_List.
4. THE SYSTEM SHALL allow only the assignee to approve/reject their incoming Task
   (`NOT_AUTHORIZED` otherwise) and only the assigner or assignee to withdraw it.
5. THE SYSTEM SHALL record every assignment/approval/rejection as an Audit_Record
   (metadata only), reusing the V1 audit model.

### Requirement 2.3 — Task progress (Phase 2: Tasks)
1. WHEN the assignee marks a Task `in_progress` or `done`, THE SYSTEM SHALL update
   and broadcast the status.
2. THE SYSTEM SHALL expose a member's Task_List and all session Tasks via MCP and
   the editor panel.

---

## Phase 3 — Notifications, liveness & wake

### Requirement 3.1 — Liveness state (Phase 3: Notifications & Liveness)
1. THE SYSTEM SHALL classify each member as `active`, `idle`, or `gone` based on
   recent activity and heartbeats (reusing V1 heartbeats/presence).
2. WHEN a member's Liveness_State changes, THE SYSTEM SHALL broadcast the change.
3. THE SYSTEM SHALL expose current Liveness_State for all members via MCP and the
   editor panel.

### Requirement 3.2 — Notifications by severity (Phase 3: Notifications & Liveness)
1. WHEN a member receives an `urgent` Message, an incoming Task_Assignment, a
   Question, or a blocking coordination situation, THE SYSTEM SHALL raise a
   Notification carrying an appropriate severity.
2. THE SYSTEM SHALL surface Notifications in the editor (severity-appropriate,
   including a sound cue for high severity) and via MCP.
3. THE SYSTEM SHALL not raise a Notification to a member for that member's own actions.

### Requirement 3.3 — Wake / resume an idle agent (Phase 3: Notifications & Liveness)
1. WHEN a member sends a Wake_Request to an idle member, THE SYSTEM SHALL record it
   and deliver it to the target at the target's next action (never as a mid-turn
   interrupt — idea.md §9).
2. THE SYSTEM SHALL surface pending Wake_Requests to the target member.

---

## Phase 4 — Orchestration (Luna)

### Requirement 4.1 — Luna participant and pluggable brain (Phase 4: Luna)
1. THE SYSTEM SHALL provide a single Luna orchestrator per Repository_Session.
2. THE SYSTEM SHALL implement Luna behavior behind a `Luna_Brain` interface whose
   default is deterministic/rules-based and requires no external service.
3. THE SYSTEM SHALL allow an optional LLM-backed Luna_Brain to be configured; it
   SHALL be disabled by default and the system SHALL build and run without it.
4. IF Luna is temporarily unavailable, THEN THE SYSTEM SHALL continue to operate
   using the mechanical V1 rules and human direction (idea.md §6 reliability).

### Requirement 4.2 — Intelligent task assignment (Phase 4: Luna)
1. WHEN a human directs Luna to assign work, THE SYSTEM SHALL let Luna choose a
   suitable assignee based on members' current activity and the work's nature, then
   create a `proposed` Task (Phase 2), leaving final approval to the receiving human.
2. THE SYSTEM SHALL never let Luna autonomously carve a big feature into subtasks;
   Luna only routes/assigns what a human directs (idea.md §9).

### Requirement 4.3 — Conflict arbitration (Phase 4: Luna)
1. WHEN the mechanical rules cannot resolve a coordination conflict, THE SYSTEM SHALL
   let Luna arbitrate and communicate a decision via Messages, recorded in the audit.
2. THE SYSTEM SHALL keep V1's earliest-Event_Revision resolution as the default; Luna
   arbitration applies only to cases the mechanical rule leaves ambiguous.

### Requirement 4.4 — Answering questions & team summaries (Phase 4: Luna)
1. WHEN a cross-agent Question is directed to Luna, THE SYSTEM SHALL let Luna produce
   an Answer (Phase 1) using the coordination state it can see.
2. WHEN a human requests it, THE SYSTEM SHALL let Luna produce a plain-language
   summary of the live team state (who is doing what, tasks, conflicts).

### Requirement 4.5 — Human direction chat (Phase 4: Luna)
1. THE SYSTEM SHALL let a human send directions to Luna and the team through the
   messaging channel (Phase 1) surfaced in the editor panel.

---

## Phase 5 — Live diffs (opt-in)

### Requirement 5.1 — Opt-in live diff sharing (Phase 5: Live Diffs)
1. THE SYSTEM SHALL keep Live_Diff sharing **disabled by default**, enabled only via
   explicit team configuration.
2. WHEN Live_Diff is enabled and a member is editing a path, THE SYSTEM SHALL share
   that member's current change diff for the path with authorized members only.
3. THE SYSTEM SHALL never share diffs for excluded paths, secrets, credentials, or
   anything outside the Authorized_Folder, and SHALL apply data-minimization.
4. WHEN Live_Diff is disabled, THE SYSTEM SHALL behave exactly as V1 (metadata only).
5. THE SYSTEM SHALL surface received Live_Diffs in the editor and via MCP as
   read-only context, never applying them to the recipient's files automatically.

---

## Cross-cutting requirements (all phases)

### Requirement X.1 — Security & identity parity
1. THE SYSTEM SHALL sign, validate, replay-protect, and session-scope every new V2
   event exactly as V1 does, and SHALL reject events from unauthorized/revoked
   devices.

### Requirement X.2 — Reconnect-safe & offline behavior
1. THE SYSTEM SHALL deliver missed Messages/Tasks/Notifications/diffs on reconnect
   via the V1 sync-from-revision path and SHALL mark stale state clearly when offline.

### Requirement X.3 — MCP & editor parity
1. THE SYSTEM SHALL expose all new V2 capabilities to AI agents via MCP tools and to
   humans via the editor panel, so agents remain first-class participants (idea.md §2).

### Requirement X.4 — No behavior regression
1. THE SYSTEM SHALL keep every V1 requirement, test, and public contract intact;
   all existing tests SHALL remain green.
