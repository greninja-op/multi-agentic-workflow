# CFLS — The Idea

> **One sentence:** A real-time collaboration fabric that lets many AI coding agents (and their humans) build the same repository in parallel — dividing work up front, seeing each other live, talking to each other, and merging cleanly — so teams move fast without stepping on each other.

This document explains **what** we are building and **why**. It contains no technology choices — the stack is decided later. It is about the problem, the objective, the idea, and the full feature set.

---

## 1. The problem (in detail)

When a team builds or maintains a project together, multiple people work at the same time — 3, 4, 6, or dozens of people, with several actively touching the same codebase in the same window of time.

That creates four concrete pains:

1. **Merge / PR conflicts eat enormous time.** When two people unknowingly edit the same code, the collision only surfaces later — at pull-request or merge time — and untangling it is slow, error-prone, and frustrating. The more people, the worse it gets.
2. **Nobody has live visibility.** A team member usually has no idea which part of the project the others are working on _right now_. You find out after the fact, when it is already too late to avoid the overlap.
3. **It is worst exactly when speed matters most.** In hackathons, fast MVPs, and crunch periods, several people hammer the same codebase at once. That is precisely when conflicts are most likely and most costly.
4. **The world shifted to AI agents.** Today most developers work _through_ AI coding agents. So it is no longer "6 developers" — it is effectively "6 agents building like 6 engineers." The agents are the ones doing the fast, parallel editing.

## 2. The key insight (why this is different)

If everyone is now driving AI agents, then the agents themselves should be **first-class participants in the coordination**, not just the humans.

That means when several agents work together, they should be able to:

- **know, live, exactly what every other agent is doing** — which area, which files, and each other's changes as they happen;
- **actively communicate with each other** — not merely observe a shared board, but _talk_: send messages, ask questions, hand off work;
- **plan together and adjust their own plans** based on what the others are doing;
- **converge fast, without conflicts or mistakes**, without waiting for a pull request to reveal a collision.

In short: a team of agents should behave like a **coordinated engineering team that communicates in real time**, with the humans steering.

## 3. Who it is for

- Teams of any size building or maintaining a shared project, where more than one person/agent works concurrently.
- High-speed contexts especially: hackathons, rapid MVPs, sprints, crunch.
- Teams where each member works through an AI coding agent (the primary, modern case).

## 4. The objective

Make concurrent, multi-agent development **fast, coordinated, and conflict-free**:

- Work is **divided up front**, so two agents rarely choose the same file to begin with.
- Everyone (humans and agents) has **live, real-time awareness** of who is doing what and where.
- Agents can **communicate and coordinate directly**, in real time.
- **Humans stay in control** as directors — they assign the big work and approve what lands on their machine.
- The end result: **far fewer merge/PR conflicts, far less wasted time, and much faster shipping.**

## 5. The core idea

A shared, real-time coordination layer with three kinds of participants:

- **Humans — the directors.** They set direction, assign the big tasks, approve work coming to their machine, watch the live status, and step in when needed.
- **Luna — the orchestrator ("the PM").** A single central orchestrator agent that assigns/routes tasks intelligently (matching task complexity to who is best suited), arbitrates conflicts the plain rules cannot resolve, answers cross-agent questions, and summarizes the team's live state for the humans.
- **Agents — the workers.** Each agent does the actual building. Agents self-coordinate the _small_ things among themselves (who is on which file, quick heads-ups, quick questions) and receive the _big_ things (features, major tasks) from the humans via Luna.

The system watches the workspace live, keeps everyone's picture in sync, carries messages between agents, and keeps a shared, evolving set of tasks. Git still moves the actual files; this layer moves the **coordination**.

## 6. Full feature set

### Awareness (live status)

- Live "who is working on what right now" — files, areas, activity — updated in real time, with **zero effort from the agent** (it is detected automatically).
- Each participant sees other members' changes/diffs live.
- A status view in the IDE (a bar item that expands into a full panel) showing the whole team's live state.

### Communication (agent ↔ agent)

- Directed messages (agent → a specific agent) and broadcasts (agent → everyone).
- Questions that need a reply, with a fast "wait for the answer" mode.
- Heads-ups / FYIs ("I renamed this function, update your calls").
- Message **priority** (fyi / normal / urgent) that controls how loudly the recipient is alerted.

### Orchestration (Luna)

- Intelligent task assignment based on what each agent has been doing and how complex the task is (complex work → the agent already deep in complex work; simple work → an agent doing simple things, etc.).
- Conflict arbitration when the mechanical rules cannot decide.
- Answering/tie-breaking cross-agent questions.
- Summarizing the live team state for humans in plain language.

### Task management

- A shared, evolving set of tasks — each agent has its own task list.
- Humans assign big work by chatting to Luna in plain language (e.g., "tell C2 to do the WhatsApp integration").
- The receiving machine's human approves incoming assignments before they land.
- Agents self-coordinate only the small things; big features are always human-directed.

### Direction & control (human)

- A chat in the status panel to direct Luna and the team.
- Approvals for work being assigned to your machine.
- Notifications (with sound, by severity) for incoming tasks, questions, and blocking situations.
- The ability to resume/wake an idle agent when it has pending work.

### Liveness & reliability

- Live "is this agent active / idle / gone" status for every agent, so others plan around availability.
- Automatic handling when someone disconnects and reconnects (nothing missed, nothing double-applied).
- The system keeps working even if the orchestrator is temporarily unavailable (humans + simple rules take over).

### Safety

- Only invited members can join; members can be removed.
- Every action is attributable to a verifiable identity.
- Team content (project diffs, messages, plans) is shared within the trusted team, but secrets, credentials, and anything outside the project are never shared.

## 7. What each feature solves

| Feature                             | Pain it removes                                                        |
| ----------------------------------- | ---------------------------------------------------------------------- |
| Live "who's on what"                | You no longer discover overlaps at PR time — you see them instantly.   |
| Divide work up front (Luna + human) | Two agents rarely pick the same file, so conflicts don't form.         |
| Agent ↔ agent messaging             | Agents coordinate directly instead of colliding silently.              |
| Task files + human direction        | Clear ownership; no two agents grabbing the same task.                 |
| Priority + notifications + wake     | Urgent/blocking issues reach a human fast, even if an agent is asleep. |
| Live diffs                          | Everyone sees the actual changes forming, not just file names.         |
| Liveness status                     | The team plans around who is available right now.                      |

## 8. Guiding principles

- **Humans direct, Luna orchestrates, agents execute.** Big decisions stay with humans; agents own only the small, local coordination.
- **Awareness should be free.** Detect what agents are doing automatically; make agents "speak up" only for things that cannot be observed (their plans, new files, and messages).
- **Reliability and quality over cost and latency** where they conflict — but keep the cheap, mechanical decisions out of the expensive path.
- **Be honest about hard limits.** An idle agent cannot be interrupted mid-sleep; we bridge that with the always-on system and the human, not with magic.
- **Prevent conflicts by design**, not by cleaning them up afterward.

## 9. Non-goals

- We do **not** replace git; git still moves file contents and handles branches/PRs.
- We do **not** try to autonomously carve up big features between agents — humans own the macro plan.
- We do **not** attempt to read the internals of other AI tools' chats; we observe _effects_ (edits, commands, files) and rely on agents _declaring_ their intentions.
- We do **not** promise "instant push into a sleeping agent" — that is physically impossible with turn-based agents; we deliver at the agent's next action and bridge the idle case via the human.

## 10. Success criteria

- Two or more agents can work the same repository at once and **almost never touch the same file unknowingly**.
- When they would collide, the system **surfaces it before damage**, not at PR time.
- Agents can **message, ask, and hand off** work to each other, with delivery that feels real-time during active work.
- Humans can **direct the whole team** from one panel and always know the live state.
- Merge/PR conflict time drops dramatically compared to working without it.
