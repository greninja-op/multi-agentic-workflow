# CFLS — Architecture & Plan (A → Z)

> This is the complete blueprint of the system: every component, every mechanism, every decision we made, and how it all fits together. It intentionally contains **no technology/stack choices** — those are decided in a later phase. Everything here is architecture and behavior.

**Read `idea.md` first** for the problem and vision. **See `decisions.md`** for the decision log (chosen option + alternatives + rationale) and **`glossary.md`** for terms.

---

## 0. How to read this

The system has three kinds of participants (humans, the orchestrator "Luna", and worker agents) and four building blocks (the **Service**, the **Extension**, the **Agent Interface**, and the **Host + Luna**). The rest of the document describes what each captures, what flows between them, how messages and tasks work, how delivery works given that agents are turn-based, and how it all prevents merge conflicts.

---

## 1. System overview & mental model

```
        MACHINE C1                         MACHINE C2
 ┌───────────────────────┐         ┌───────────────────────┐
 │  IDE + Extension       │         │  IDE + Extension       │
 │  Agent(s) A1, A2 ──────┤         │  Agent A1 ─────────────┤
 │      │ (Agent Interface)│         │      │                 │
 │      ▼                  │         │      ▼                 │
 │   SERVICE (always on)   │         │   SERVICE (always on)  │
 └──────────┬──────────────┘         └──────────┬─────────────┘
            │                                    │
            └───────────────┬────────────────────┘
                            ▼
                 ┌─────────────────────────┐
                 │   HOST  (single, central)│
                 │   + LUNA (orchestrator)  │
                 │   truth · order · route  │
                 └─────────────────────────┘
```

**Mental model:**

- Each **machine** runs an always-awake **Service** — the local muscle that watches the workspace, holds the one connection outward, and routes messages/mail.
- Each **IDE** runs an **Extension** — the live sensor inside the editor and the human's control panel.
- Each **agent** talks to its local Service through the **Agent Interface** (a tool-based protocol) — this is the agent's "voice."
- One central **Host** is the single source of truth (ordering, identity, broadcast, persistence). **Luna**, the orchestrator agent, lives here as the team's project manager.

The critical fact that shapes the whole design: **a machine is always awake, but an agent sleeps between turns.** Agents only perceive things when they act. Everything about delivery is built around that truth.

---

## 2. Actors

- **Humans (directors).** Set direction, assign big work, approve incoming assignments, watch live status, wake idle agents, step in on conflicts.
- **Luna (orchestrator / PM).** One central orchestrator agent. Assigns/routes tasks by judgment, arbitrates conflicts rules can't settle, answers cross-agent questions, and summarizes team state for humans. It _proposes_; humans _approve_.
- **Agents (workers).** Do the building. Self-coordinate small things; receive big things from humans via Luna. Follow a fixed "playbook" (§13) that makes coordination part of their normal work loop.

---

## 3. The four components

### 3.1 Service (per machine — "C1", "C2", …)

Always-on background process. **The local hub.** Responsibilities:

- Watch the workspace on disk: file create/modify/delete/rename — **including changes made outside the IDE**.
- Read git ground truth: current branch, HEAD, working-tree changes, staged/unstaged, ahead/behind.
- Hold the **single connection** to the Host; send/receive all coordination traffic.
- Hold each local agent's **mailbox**; route messages in/out.
- Merge the Extension's live signals + disk/git truth + agent declarations into one local view and publish it.
- Keep a local cache so it can serve a (marked-stale) view while offline, and re-sync on reconnect.
- Run even when the IDE is closed.

> The Service is deliberately "dumb muscle": sensing, routing, persistence. It does not make orchestration decisions — Luna does.

### 3.2 Extension (per IDE)

The **live sensor inside the editor** and the **human's control surface**. Responsibilities:

- Observe editor activity in real time (see §5 for the exact list): focused file, live _unsaved_ edits with exact ranges, open tabs, terminal commands + output, errors/warnings.
- Stream those signals to the local Service.
- Render the **status bar item** (compact live status) and the **panel** (full status, chat to Luna, notifications, approvals).
- Play notifications (with sound, by severity) and offer the "resume this agent" action.
- Talk **only** to the local Service — never directly to the Host.

### 3.3 Agent Interface (per machine)

The **agent's voice** — a tool-based protocol the AI agents call. It exposes the coordination tools (checkpoint, sync, send message, ask-and-wait, declare intent, get status, etc.). It talks only to the local Service, which routes to the Host. It carries the things that **cannot be observed**: the agent's plans, intended new files, and messages.

### 3.4 Host + Luna (one, central)

The **single source of truth**:

- Assigns a strict, total order to every coordination event (so everyone converges on one identical picture).
- Owns identity, membership (who may join), and broadcast (fan changes out to the right participants).
- Persists state; restores it after a restart; serves reconnecting machines the events they missed.
- Hosts **Luna**, the orchestrator (§14).

There is exactly **one** Host + Luna per session. Never one per machine — that would cause conflicting decisions (split-brain).

---

## 4. Identity & addressing

- **System id:** `C1`, `C2`, … — one per machine.
- **Agent id:** `A1`, `A2`, … — one per agent, numbered within its system. Multiple agents on one machine are `A1`, `A2`, … on that system.
- **Global address:** `C1/A1`. This is unique across the whole session. `C1/A2` is a second agent on the same machine as `C1/A1`.
- **Queries the whole session can answer:**
  - "Which agents are on C1?" → list.
  - "Are A3 and A4 on the same system?" → yes/no (compare their system id).
  - The status panel shows, per system, which agents it hosts.
- Every message, task, edit, and event is attributed to a `C?/A?` address (or to a human on a system, or to Luna).

---

## 5. What we capture, and from where

Two sensors feed the picture. They overlap on file edits on purpose: the Extension gives the _fast, live, pre-save_ nuance; the Service gives the _authoritative, on-disk, git_ truth.

### 5.1 Extension captures (live, in-IDE, often before save)

- Focused file; open tabs; visible editors; tab switches.
- **Live unsaved edits** with exact changed line ranges; cursor position; selection → "actively editing `auth.ts`, around line 40, right now."
- Open / close / save events.
- Errors & warnings (diagnostics) per file, as they appear.
- Terminal commands and their output.
- Debug sessions and running tasks.

### 5.2 Service captures (ground truth, whole folder, even IDE closed)

- Every on-disk change (create/modify/delete/rename), including changes made outside the IDE.
- Git truth: branch, HEAD, working-tree diff (the actual changes), staged/unstaged, ahead/behind vs remote.
- Repo structure (for risk/impact hints), if enabled.

### 5.3 Agent-declared (via the Agent Interface — the unobservable stuff)

- **Intent:** "I'm about to work on the auth area" (one declaration per task, coarse).
- **Planned new files:** files that don't exist yet and therefore can't be observed.
- **Messages** to other agents.
- **Task updates:** picking up / completing tasks.

### 5.4 Division rule of thumb

> **Extension = "what's happening in the editor right now."** **Service = "what's true on disk and in git."** **Agent Interface = "what the agent intends and says."**

The Service is the authority; the Extension is the fast, rich sensor; the Agent Interface fills the observability gap. The Service merges all three into one **live workspace state** and publishes it.

---

## 6. The live workspace state

The single merged picture, kept in sync for every participant, contains:

- **Per file / area:** who is active on it, live changes forming, errors present.
- **Per agent:** its address (`C?/A?`), current activity, declared intent, liveness (§15), current task.
- **Per system:** which agents it hosts, connectivity.
- **Team-wide:** the shared task set, open questions, recent messages.

Because the Host assigns a strict order to every change, every machine's copy converges to the exact same state, and "what changed since I last looked" is always answerable — which is the backbone of message delivery (§12).

---

## 7. Awareness vs. Intent vs. Locks (the "no per-file locking" decision)

We do **not** make agents lock every file — that would waste time and effort. Instead:

- **Awareness = automatic & free.** The Service + Extension detect which files are being touched. No agent action required. This answers "who's working on what right now" for the whole team.
- **Intent = one cheap declaration per task.** The agent states its plan once at the start of a task (a folder or a short list). This is _proactive_ (prevents collisions before they form) and also covers **new files that don't exist yet** (which detection can't see).
- **Explicit locks = rare.** Only for the handful of files where two people editing simultaneously is catastrophic (e.g., a migration, a shared config). Used only when flagged as high-risk.

Why intent on top of auto-detection: detection only knows _after_ a change hits disk (too late to prevent), and cannot know about files not yet created. The single upfront intent declaration closes both gaps cheaply.

---

## 8. The diff mechanism

We build **our own diff pipeline** (not our own diff _math_ — the underlying text-diff computation uses a proven approach). Ours is better than polling git because it has a **live layer**:

Three layers, from freshest to most durable:

1. **Unsaved edits (from the Extension):** exact change ranges as the agent types — the freshest, real-time layer. This is the "live diff" nobody else has.
2. **Saved-on-disk (from the Service):** what actually hit the file.
3. **Committed (from git, via the Service):** the baseline everyone shares.

The pipeline **streams the live editor changes** and **reconciles them against the git baseline**, so participants see changes forming in real time and also know the committed truth. Details still to specify: exact granularity (full-file vs. hunk), publish cadence (debounced on change vs. on save), and size caps.

---

## 9. Content sharing policy

The system shares **team content** — this is a deliberate choice, because it is the team's own machines, own repo, and invited members only:

- **Shared within the team:** project diffs/changes, messages, plans, task lists, status.
- **Never shared (always blocked):** secrets, credentials, environment files, keys, and anything **outside the project folder**.

So the rule is: **"share team work, never leak secrets or out-of-tree content."**

---

## 10. Messaging model

- **Message kinds:**
  - `fyi` — a heads-up (directed to one agent, or broadcast to all). No reply expected.
  - `question` — expects a reply.
  - `answer` — a reply to a question.
  - `task` — an assignment (see §11).
- **Addressing:** by agent address (`C1/A2`), by system (all agents on `C2`), or broadcast (everyone). Messages come from an agent, a human, or Luna.
- **Priority:** `fyi` / `normal` / `urgent`. Priority drives how the recipient is alerted (§15) and can be raised by Luna when something blocks the team.
- **Guarantees:** delivered at-least-once with de-duplication, and applied in the Host's strict order, so nothing is lost or double-applied.

---

## 11. Task model

- **Tasks are files.** Each agent has its own task list (a simple task file the agent already reads). This reuses the agents' natural "read files" behavior — no exotic new subsystem.
- **Where they live:** synced **live through the Host** and rendered in the panel — **not committed into git** (to avoid git churn and self-inflicted conflicts). Optionally mirrored to disk read-only so agents can read them.
- **Scope split:**
  - **Small things** — agents self-coordinate among themselves (quick handoffs, "you take this file, I'll take that").
  - **Big things (features, major tasks)** — always come from **humans via Luna**. Agents never autonomously carve up big features.
- **Assignment flow (human-directed):**
  1. A human opens the panel chat and types plain language, e.g. _"tell C2 to do the WhatsApp integration."_
  2. **Luna** interprets it, picks the best agent on C2 (by workload/complexity/context), and drafts a task.
  3. **The receiving machine's human (C2's human) is notified and approves** — consent for work landing on their machine. (In solo/hackathon mode this can be auto-approve.)
  4. On approval, the task is written to that agent's task file and picked up on its next checkpoint (§13).

---

## 12. Delivery model (how messages actually arrive)

**The hard truth:** an agent that has finished its turn and is idle cannot be interrupted — you cannot push a thought into a model that isn't running. So the best achievable is **"instant at the agent's next action,"** and we engineer around making that next action happen at the right moments. No busy-polling every minute.

Three delivery modes, matched to urgency:

1. **Checkpoint piggyback (the default, near-free).** The agent's playbook (§13) makes it call `checkpoint(files)` before editing. The reply carries, stapled on: pending mail, tasks, and "who else is on these files." Because editing is frequent, delivery is frequent — and it lands _exactly_ when it matters (right before touching a file). No separate "check messages" step, no wasted turns.
2. **Ask-and-wait (needs an answer now).** When an agent needs a decision before proceeding, it sends the question and _chooses_ to wait. The call **returns the instant the reply lands** (not on a fixed poll interval). Always bounded by a timeout — never an infinite block.
3. **Idle bridge (reach a sleeping agent).** A message to an idle agent is queued to its mailbox (delivered on its next checkpoint) **and** raises a notification to that machine's human (§15). The human can resume the agent. Other agents can _see_ the agent is idle and plan around it (do other work, escalate to Luna, or ask the human).

**Latency reasoning:** the network is fast (sub-second). The real latency is "when does the receiver next act." During active work that is seconds; for urgent handshakes, ask-and-wait is effectively instant; for idle agents, it is bounded by the human's response to the alert.

---

## 13. The agent playbook

This is the behavior contract shipped as a rules/instructions file so **every** agent follows it. It makes coordination part of the agent's normal work loop rather than an optional extra.

**Before editing any file → `checkpoint(files)`:**

1. If a teammate is live-editing one of these files → **don't touch it**; work elsewhere or coordinate.
2. Read any pending messages/tasks addressed to me; act on them.
3. If my planned change conflicts with someone's declared intent → send a heads-up, or ask Luna.

**After finishing a task → `sync()`:**

- Publish what I did, mark my task done, pull my next task.

**When I need someone else's decision → `ask_and_wait` (bounded):**

- If no answer in time → Luna decides.

**When I start a task → declare intent once** (the area / short file list, plus any new files I plan to create).

This playbook is what turns "we can observe collisions" into "we prevent them," because the check happens at the exact moment before an edit.

---

## 14. Luna — the orchestrator

### 14.1 Placement

**One Luna per session, at the Host.** The Host already has every agent's activity, intent, and presence — exactly the context Luna needs — and being central avoids conflicting decisions. Each machine's Service stays dumb; Luna is the single brain / PM.

### 14.2 Rules-first hybrid (do NOT put the LLM in the hot path of everything)

- **Deterministic rules handle the mechanical ~90%** (instant, free): event ordering, who-holds-what, presence, simple routing ("deliver this to C2"), obvious "whoever is already in that area takes it."
- **Luna handles only the judgment calls** (worth an LLM's reasoning):
  - **Task assignment** by workload/complexity — e.g., a complex task → the agent already deep in complex work; a simple task → an agent doing simple things; balance load; match context.
  - **Conflict arbitration** when the rules can't decide (including the rare simultaneous ask/ask edge case).
  - **Cross-agent question tie-breaks / answers.**
  - **Priority bumping** when something is blocking the team.
  - **Summarizing** the live team state for humans in plain language.

### 14.3 Proposes, humans dispose

Luna **proposes**; the receiving machine's human **approves** assignments (§11). Luna never silently commits big work to someone's machine.

### 14.4 Graceful degradation

If Luna / the Host is unreachable, the system must **not freeze**. It falls back to **humans + simple rules**: awareness, messaging queues, and manual assignment keep working; Luna's judgment layer resumes when it returns. Luna is an _enhancer_, never a hard single point of failure for basic coordination.

### 14.5 Cost/quality stance

We accept Luna's cost and latency where they buy reliability and quality (an explicit decision). We keep costs sane by (a) rules-first so Luna is only invoked for real judgment, and (b) human approval catching any bad proposal.

---

## 15. Liveness & notifications

### 15.1 Two layers of liveness

- **System liveness (C1):** is the machine's Service connected? `online` / `offline` (via heartbeat).
- **Agent liveness (A1):** inferred from activity —
  - `active` — recent edits/checkpoints;
  - `idle` — connected but the agent's turn ended (asleep, waiting for its human / next invocation);
  - `gone` — its system is offline.

The whole session sees each agent's liveness, so a sender **knows** "A1 is idle, a reply may lag" and plans around it.

### 15.2 Priority → alert (with sound)

| Priority | Example                            | On the target machine                                  |
| -------- | ---------------------------------- | ------------------------------------------------------ |
| `fyi`    | "renamed getUser"                  | silent badge in the panel                              |
| `normal` | task assigned / a question         | soft sound + panel highlight                           |
| `urgent` | someone is _blocked_ on this agent | loud/repeating alert + prominent "resume agent" prompt |

### 15.3 Wake flow (reaching an idle agent)

1. Message/task targets an idle `A1` on `C1`.
2. It is queued to `A1`'s mailbox (delivered on `A1`'s next checkpoint — the normal path) **and** the Service raises a notification to `C1`'s human, at a severity/sound matching the message priority.
3. The human hears/sees it and clicks **"resume A1"** → the agent is re-invoked and picks up its mail.
4. Luna can **bump priority to `urgent`** if the team is blocked, making the alert louder to pull the human in faster.

This converts the unavoidable "sleeping agent" limit into a clean human-in-the-loop wake.

---

## 16. Human role

The human is the **director**:

- Watches the whole team's live status in the panel.
- Chats to Luna in plain language to assign big work and ask about state.
- **Approves** work being assigned to their own machine.
- Receives notifications (by severity, with sound) and resumes idle agents.
- Steps in to resolve anything the agents/Luna escalate.

Humans own the **macro** (features, direction, approvals); agents own the **micro** (local, small coordination).

---

## 17. How this prevents merge/PR conflicts (the original goal)

Merge/PR conflicts form when two people unknowingly edit the same code. This design attacks the root cause:

1. **Work is divided up front** (humans + Luna assign scoped tasks; agents declare intent). Two agents rarely pick the same file to begin with.
2. **Everyone sees who's where, live.** An agent about to touch a file learns at its checkpoint that someone else is already there, and picks different work or coordinates.
3. **The rare same-file case is serialized** by the playbook (one waits/coordinates) instead of both charging ahead.
4. **Big features stay human-managed**, so no chaotic autonomous overlap.

Result: collisions mostly never form, so merges stay clean **by construction** — and the expensive PR-conflict-untangling step largely disappears.

> **Optional later extension:** coordinate merge _order_ (per-member branches + coordinated integration) so even sequential merges never surprise each other. Not required for the core; noted for the future.

---

## 18. Failure & edge cases

- **Two agents ask-and-wait on each other (deadlock).** Prevented three ways, stacked: (a) delivery-at-checkpoint usually breaks symmetry (whoever checks first sees the other's question); (b) every ask-and-wait has a **timeout** (no infinite block); (c) genuine simultaneous conflict → **Luna arbitrates**.
- **An agent crashes / disconnects mid-task.** Its liveness flips to `gone`; others see it and re-plan. Any exclusive claim it held is released after a timeout; its unfinished task remains visible on the board for reassignment.
- **Host / Luna down.** Basic coordination degrades gracefully (§14.4): humans + simple rules continue; full orchestration resumes on recovery.
- **Message to a `gone` agent.** Held in the mailbox; delivered when it returns; if urgent and blocking, escalated to the human (and Luna can reassign).
- **Reconnect after offline.** The Service re-syncs the exact events it missed (nothing lost, nothing double-applied) and clears its stale marker.
- **Duplicate/replayed events.** De-duplicated; a repeat resolves to the original outcome, never a second effect.

---

## 19. Security & trust model (conceptual — no stack here)

- **Membership:** only invited members can join a session; membership can be revoked, after which that member is refused.
- **Attribution:** every action carries a verifiable identity, so the team always knows who did what (which system, which agent, or which human).
- **Integrity:** messages/events are authenticated and cannot be forged or silently replayed.
- **Content boundary:** team work (diffs/messages/plans) is shared within the trusted team; **secrets, credentials, environment files, and anything outside the project folder are never shared** — enforced by a filter on everything that leaves a machine.
- **Human consent:** work assigned to a machine is approved by that machine's human before it lands.

---

## 20. What we reuse vs. build new

### Foundation already in place (reuse)

- The central Host: strict event ordering, single-source-of-truth, broadcast, persistence, restart recovery.
- Verifiable identity, invitation, and revocation.
- Presence ("who's connected / on what").
- Reconnect-and-resync (nothing missed, nothing double-applied).
- The always-on Service, the live local channel between Extension/Agent-Interface and Service, and the packaging to run the Service in the background.
- The Extension/Service/Agent-Interface skeleton and the status-bar entry point.

### New work (build)

- **Luna** the orchestrator (central) + the rules-first decision layer.
- The **message & task model**: message kinds, priority, mailboxes, task files synced live.
- The **live change-stream diff pipeline** (unsaved-edit stream reconciled with the git baseline).
- **Agent liveness** + the **notification/sound/wake** system.
- The **full panel**: live team status board, chat-to-Luna, approvals, notifications.
- The shipped **agent playbook** rules file.
- The **content-policy** update (share team work, still block secrets/out-of-tree).
- Richer **Extension capture** (terminal, diagnostics, live edit ranges) feeding the state.

---

## 21. Build order (phased)

1. **Messaging core** — message/task model, mailboxes, and checkpoint/piggyback delivery.
2. **Live state + panel** — merge Extension + Service feeds into the live workspace state; render the status board.
3. **Tasks + human direction** — task files, human→Luna chat, receiving-human approval flow.
4. **Luna orchestration** — task assignment and conflict arbitration.
5. **Live diffs** — the change-stream diff pipeline.
6. **Liveness & notifications** — agent liveness states, severity/sound alerts, wake flow.
7. **Ask-and-wait + content policy** — the blocking handshake and the share-team-work/block-secrets update.

Each phase rides the existing foundation (§20) and is independently demonstrable.

---

## 22. Open questions & deferred items

- **Deferred: the "deep dependency plugin."** An installed, project-side plugin could give authoritative semantic project info (real import graph, symbols, build/test status). **Dropped for now** — the Service (external watching + git) already covers any language with zero install. Revisit only if a team needs deep semantic detail.
- **To specify later (behavioral, not stack):** exact diff granularity (full-file vs. hunk) and publish cadence; the precise wording of the shipped agent playbook / prompt guards; exact notification sounds and thresholds; solo/hackathon "auto-approve" toggle behavior; whether/when to add the optional coordinated merge-order (§17) git integration.
- **Explicitly out of scope now:** the technology stack (languages, transport, storage, identity mechanism, the orchestrator model/vendor) — chosen in a later planning phase.

---

## 23. End-to-end walkthroughs

### 23.1 Two agents, one file (collision prevented)

1. `C1/A1` starts a task; declares intent: "working on the login flow: `auth/`."
2. `C1/A1` edits `auth/login.ts`; the Extension + Service detect it and publish live status.
3. `C2/A1`, about to touch `auth/session.ts`, calls `checkpoint(["auth/session.ts"])`.
4. The reply says: "`C1/A1` declared the auth flow and is live-editing `session.ts` — here is the live diff."
5. `C2/A1` picks different work or sends `C1/A1` a heads-up. **No collision forms; no PR conflict later.**

### 23.2 Human assigns a big task

1. `C1`'s human types in the panel: "tell C2 to do the WhatsApp integration."
2. Luna picks the best agent on `C2`, drafts the task.
3. `C2`'s human gets a `normal` notification (soft sound): "Approve WhatsApp integration for `C2/A1`?" → approves.
4. The task is written to `C2/A1`'s task file; `C2/A1` picks it up at its next checkpoint and starts.

### 23.3 Urgent question to an idle agent

1. `C1/A1` is blocked: "changing the login API — `C2/A1`, safe to proceed?" → `ask_and_wait`, priority `urgent`.
2. `C2/A1` is idle. The message is queued to its mailbox **and** `C2`'s human gets a loud alert: "resume `C2/A1` — teammate blocked."
3. `C2`'s human resumes the agent; at its checkpoint it sees the question and answers.
4. `C1/A1`'s `ask_and_wait` returns the instant the answer lands; it proceeds. (If the timeout hits first, Luna arbitrates.)
