# CFLS — Decision Log

Every decision we made while planning, with the option chosen, the alternatives considered, and the reasoning. This is the "why" companion to `architecture.md`. No technology/stack decisions appear here — those are deferred.

Format: **Decision → Chosen → Alternatives → Rationale.**

---

### D1. Purpose: a live multi-agent _collaboration_ fabric (not just conflict-avoidance)

- **Chosen:** Build a system where agents actively communicate, plan together, hand off work, and see each other live — with humans directing.
- **Alternatives:** A passive "awareness/locking" layer that only shows who's editing what and blocks collisions.
- **Rationale:** The real goal is agents working like a coordinated engineering team, not just avoiding stepping on each other. Passive awareness under-delivers the vision.

### D2. Reuse the existing coordination foundation

- **Chosen:** Keep and build on the central host, strict event ordering, verifiable identity/invitations/revocation, presence, reconnect-and-resync, persistence, and the service/extension/agent-interface skeleton.
- **Alternatives:** Rewrite from scratch to fit the new vision.
- **Rationale:** These are the hard, expensive, easy-to-get-wrong parts and they already work. The new vision is a richer layer _on top_ of the same backbone, not a different backbone.

### D3. Four components; drop the "dependency"

- **Chosen:** Extension, Service, Agent Interface, Host + Luna. **Drop** the separately-installed project "dependency/plugin."
- **Alternatives:** Also ship a project-side plugin (like a lint/format-style dependency) that feeds deep semantic info to the service.
- **Rationale:** The Service already sees everything on disk + git for any language with zero install. A plugin only adds authoritative _semantic_ detail, is language-specific, and adds friction. Deferred until a team actually needs deep semantics.

### D4. Awareness is automatic — no per-file locking

- **Chosen:** The Service + Extension auto-detect which files are being touched. Agents do **not** lock every file.
- **Alternatives:** Require agents to explicitly lock/announce each file they touch.
- **Rationale:** Per-file locking wastes agent time/effort. Detection is free and covers "who's on what" without any agent action.

### D5. Intent = one declaration per task (plus new files)

- **Chosen:** An agent declares its plan once at task start (coarse: an area or short list), including files it plans to create.
- **Alternatives:** No declaration at all (rely purely on detection); or fine-grained per-file declarations.
- **Rationale:** Detection only knows _after_ a change hits disk (too late to prevent) and cannot see files that don't exist yet. One cheap upfront declaration closes both gaps without per-file overhead.

### D6. Content policy: share team work, block secrets

- **Chosen:** Share project diffs/messages/plans within the trusted team; **never** share secrets, credentials, environment files, or anything outside the project folder.
- **Alternatives:** Keep the original "metadata-only, never send content" stance; or share everything with no filter.
- **Rationale:** Agents need to see each other's live diffs/plans to truly collaborate — the original metadata-only rule blocked the vision. But it's still the team's own machines/repo, so sharing team work is fine; secrets and out-of-tree content must always be blocked.

### D7. Capture split: Extension vs. Service

- **Chosen:** Extension = live in-editor signals (unsaved edits with exact ranges, focus, terminal, errors). Service = on-disk + git ground truth + network + routing. Agent Interface = declared intent/messages.
- **Alternatives:** Do everything in the Service (disk watching only); or do everything in the Extension.
- **Rationale:** The Extension sees things earlier and richer (pre-save, focus, terminal) but only while the IDE is open and only IDE-driven; the Service sees authoritative disk/git truth, changes made outside the IDE, and survives IDE restarts. Both are needed; they merge into one picture.

### D8. Luna is a single, central orchestrator (at the host)

- **Chosen:** Exactly one orchestrator ("Luna") per session, living at the host.
- **Alternatives:** One Luna per machine/service.
- **Rationale:** Per-machine orchestrators would make conflicting assignments (split-brain). The host already has all the context (activity, intent, presence) and is the single source of truth — the natural home for the one PM brain.

### D9. Luna is rules-first, LLM only for judgment

- **Chosen:** Deterministic rules handle the mechanical ~90% (ordering, routing, who-holds-what, obvious assignment). Luna (the LLM) handles only judgment calls (complexity-based assignment, arbitration, cross-agent Q&A tie-breaks, priority bumping, human summaries).
- **Alternatives:** Route every decision through Luna.
- **Rationale:** An LLM in the hot path of everything is slow, costly, and non-deterministic. Reserve it for decisions that genuinely need reasoning.

### D10. Luna proposes, humans dispose

- **Chosen:** Luna proposes assignments; the receiving machine's human approves before work lands.
- **Alternatives:** Luna auto-commits assignments.
- **Rationale:** Keeps humans in control, catches any bad proposal, and gives consent for work landing on someone's machine.

### D11. Graceful degradation without Luna/host

- **Chosen:** If Luna/host is unavailable, basic coordination continues via humans + simple rules; orchestration resumes on recovery.
- **Alternatives:** Hard-depend on Luna (system stalls without it).
- **Rationale:** The system must never freeze because a judgment service is down.

### D12. Reliability/quality over cost/latency

- **Chosen:** Prefer reliability and quality even at higher cost/latency — but keep cheap mechanical decisions out of the expensive path (see D9).
- **Alternatives:** Optimize primarily for cost/latency.
- **Rationale:** The user's explicit priority. D9 keeps the cost sane anyway by limiting when Luna is invoked.

### D13. Addressing: systems `C1..`, agents `A1..`

- **Chosen:** Systems are `C1, C2, …`; agents are `A1, A2, …` within a system; global address `C1/A1`. Multiple agents on one machine are `A1, A2, …`. The session can answer "which agents on Cx" and "are Ax, Ay co-located."
- **Alternatives:** Flat global agent ids with no system grouping.
- **Rationale:** Human-readable, groups agents by machine (useful in the panel), and maps cleanly onto the existing device/member identity model.

### D14. Our own diff _pipeline_, not our own diff _math_

- **Chosen:** Build a custom diff pipeline with a live layer (stream the editor's unsaved change ranges, reconcile against the git baseline). Use a proven approach for the underlying text-diff computation.
- **Alternatives:** Poll `git diff` only; or hand-roll a diff algorithm from scratch.
- **Rationale:** Polling git only sees saved files after the fact; hand-rolling diff math reinvents a hard, solved problem. Streaming live editor edits gives a real-time layer nobody else has, while proven math handles the hard part.

### D15. Message model: kinds + priority + addressing

- **Chosen:** Kinds = `fyi`, `question`, `answer`, `task`. Priority = `fyi`/`normal`/`urgent`. Addressing = directed (to an agent), system-wide, or broadcast. Delivered at-least-once with de-dup, in strict order.
- **Alternatives:** A single generic message type; no priority.
- **Rationale:** Distinct kinds and priority let the system alert appropriately (D23) and let agents/Luna reason about what needs a reply and what's blocking.

### D16. Delivery: three modes, honest about the turn-model limit

- **Chosen:** (1) checkpoint piggyback (default), (2) ask-and-wait (bounded blocking), (3) idle bridge (queue + notify human to wake). Accept that a sleeping agent can't be interrupted; deliver at its next action.
- **Alternatives:** Poll every N seconds/minute; or claim real-time push into any agent.
- **Rationale:** Polling is slow and wasteful; true push into a stopped model is impossible. The three modes give near-instant delivery during active work, instant handshakes when waiting, and a human-bridged path for idle agents.

### D17. Agent playbook baked into a rules file

- **Chosen:** Ship a fixed playbook (checkpoint before edits, sync after tasks, ask-and-wait when blocked, declare intent at task start) as agent rules/instructions.
- **Alternatives:** Hope agents call coordination tools on their own.
- **Rationale:** Agents won't spontaneously call our tools often enough. Baking the checkpoint into their operating rules turns their frequent, natural file-editing into frequent, well-timed coordination — guaranteeing delivery timing instead of hoping for it.

### D18. Tasks are files, synced live through the host (not git)

- **Chosen:** Each agent has a task file; task state is synced live via the host and shown in the panel; optionally mirrored read-only to disk for agents. Not committed to git.
- **Alternatives:** Commit task files into the repo; or build a bespoke task database/UI.
- **Rationale:** Files reuse the agents' natural "read files" behavior (no new subsystem to teach them). Committing to git would create churn and self-inflicted conflicts, so sync live instead.

### D19. Scope split: agents self-coordinate small; humans direct big

- **Chosen:** Agents coordinate only small things among themselves; big features/major tasks always come from humans via Luna.
- **Alternatives:** Let agents autonomously carve up big features.
- **Rationale:** Autonomous macro-planning by agents is chaotic and risky. Humans own the macro; agents own the micro. Also naturally reduces overlap/conflicts.

### D20. Human = director

- **Chosen:** Humans set direction, assign big work via a panel chat to Luna, approve incoming work, get notifications, and wake idle agents.
- **Alternatives:** Fully autonomous agents with humans as passive observers.
- **Rationale:** The user's explicit stance ("the human is everything"). Keeps control and accountability with people.

### D21. Approval by the _receiving_ machine's human

- **Chosen:** Work assigned to a machine is approved by that machine's human.
- **Alternatives:** A single lead human approves everything; or no approval.
- **Rationale:** Consent for what runs on your machine; distributes control naturally. (Solo/hackathon mode may auto-approve.)

### D22. No fixed roles/labels

- **Chosen:** No mandatory frontend/backend/etc. labels. Luna + humans assign dynamically from actual context (who's been doing what).
- **Alternatives:** Label each system with a fixed role; or have a designated "PM machine."
- **Rationale:** Fixed labels are premature rigidity; dynamic assignment from real activity is smarter. And since Luna (central) is the PM, no PM _machine_ is needed.

### D23. Idle-agent handling: liveness + severity notifications + wake

- **Chosen:** Track system liveness (`online`/`offline`) and agent liveness (`active`/`idle`/`gone`), visible to all. Notifications alert the target machine's human by priority (silent / soft sound / loud alert); the human can resume the agent; Luna can bump priority when the team is blocked.
- **Alternatives:** Silently queue messages with no alerting; or attempt to auto-restart agents.
- **Rationale:** A sleeping agent can't be pushed to; the always-on system + a well-signaled human is the honest, reliable bridge. Visible liveness lets others plan around availability.

### D24. Deadlock handling (ask/ask)

- **Chosen:** Prevent via (a) checkpoint delivery breaking symmetry, (b) a timeout on every ask-and-wait, (c) Luna arbitration for genuine simultaneous conflicts.
- **Alternatives:** Ignore the edge case; or a fixed lock ordering scheme.
- **Rationale:** The stacked approach makes deadlock effectively impossible without added complexity.

### D25. PR-conflict solution = prevent by design

- **Chosen:** Reduce conflicts by dividing work up front + live awareness + serializing the rare same-file case; keep big features human-managed. Optional future: coordinate merge order via per-member branches.
- **Alternatives:** Focus on better _conflict resolution_ tooling after the fact.
- **Rationale:** The root cause is unknowing simultaneous edits; preventing them beats untangling them later, which was the original pain.

### D26. No technology/stack in the docs

- **Chosen:** Keep all planning documents free of implementation tech (languages, transport, storage, identity mechanism, orchestrator model/vendor).
- **Alternatives:** Specify the stack now.
- **Rationale:** The user's explicit instruction — the stack is a later, separate planning phase. Deciding architecture/behavior first keeps options open.
