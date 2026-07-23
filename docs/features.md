# CFLS — Feature Guide

**Collaborative File Lock Sync (CFLS)** is a real-time coordination layer for teams
(and their AI coding agents) working on the same git repository. Its job is to
answer one question for everyone, continuously:

> "Is it safe for me to touch this file right now, or is a teammate already on it?"

CFLS shares **coordination metadata only** — who is editing what, who plans to,
and what is indirectly at risk. The actual file contents still travel through
**git**. This guide lists every feature, what it's for, and how to use it.

---

## 1. The big picture

There are four moving parts. You don't interact with all of them directly, but
it helps to know what each does:

| Part                         | What it is                                                                                               | Who runs it                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **Coordination Host**        | The central server that everyone connects to. Keeps the single source of truth about who's editing what. | One person (or a small VPS) per team  |
| **Agent**                    | A small program on each teammate's laptop. Talks to the host, watches your folder, exposes a local API.  | Every teammate                        |
| **VS Code / Kiro extension** | Shows coordination status in a clickable CFLS status-bar item and active-team panel.                     | Every teammate                        |
| **MCP bridge**               | Lets an AI coding agent read the same coordination data over the Model Context Protocol.                 | A local `cfls mcp` process per client |

Everything is secured: each device has its own key, teammates join by signed
invitation, and all host traffic is over TLS (`wss://`).

---

## 2. Core coordination features

These are the features that prevent collisions in the first place. They work as
soon as your agent is running and your editor is open.

### 2.1 Live presence

**What it is:** When you open or start editing a file, your teammates see it
immediately — before you've even saved. The CFLS status-bar item shows the current team;
click it (or run **CFLS: Show Coordination Status**) to open the active-team panel and inspect
each member's declared tasks and repository-relative files.

**What it's for:** The cheapest way to avoid a collision — just don't start on a
file you can see someone else is already in.

**How to use it:** Nothing to do. Open the repo with the extension installed and
the agent running; presence is automatic.

The panel is deliberately metadata-only. It can show activity roles such as editing or a soft
lock, but it never sends or displays source text, diffs, or patches.

### 2.2 Soft locks (the default)

**What it is:** When you edit a file, CFLS places a _soft lock_ on it. A soft
lock is a **warning**, not a barrier — teammates are told "someone is here" but
are not blocked.

**What it's for:** Friendly, low-friction awareness for everyday files.

**How to use it:** Automatic. Soft locks are claimed when you start editing and
released when you close the file.

### 2.3 Hard-stop locks (opt-in)

**What it is:** For files you mark as hard-stop, CFLS-aware clients receive a
clear stop decision while someone else holds the lock. In the current VS Code /
Kiro integration this is a pre-save warning: it does not change operating-system
file permissions, silently discard work, or block non-CFLS tools.

**What it's for:** Your hottest, most collision-prone shared files (shared config,
a central router, a schema). This is the single most effective way to prevent
conflicts on a specific file.

**How to use it:** Mark the file or folder as hard-stop in the repository rules
(`.coordination/rules.json`). Everyday files stay soft by default.

### 2.4 Three risk levels

**What it is:** Every file you're about to touch is classified as one of:

- **soft** — someone may be nearby; proceed with awareness.
- **coordination-required** — your change indirectly affects a file a teammate
  holds (via dependencies); talk first.
- **hard** — stop signal; a hard-stop lock is held by someone else. Coordinate
  before proceeding.

**What it's for:** Turning "who's editing what" into a clear go / caution / stop
signal.

**How to use it:** Automatic — surfaced in the extension and to AI agents via MCP.

### 2.5 Dependency awareness

**What it is:** CFLS understands (from a metadata-only dependency graph) that
editing file A can affect file B. If a teammate holds B and you touch A, you get
a **coordination-required** warning even though you're not in the same file.

**What it's for:** Catching the sneaky conflicts that don't look like conflicts.

**How to use it:** Automatic when a dependency graph is available for the repo.

### 2.6 Planned file creations / intents

**What it is:** An agent (or you) can declare "I'm about to create `src/foo.ts`"
before the file exists. Teammates see the _plan_, so two people don't create the
same new file.

**What it's for:** Coordinating brand-new files, not just existing ones.

**How to use it:** Declared by AI agents through the MCP server; visible to
everyone in the coordination view.

### 2.7 Offline mode

**What it is:** If your connection to the host drops, the agent keeps serving the
last-known coordination state from an encrypted local cache, clearly marked as
"stale," and re-syncs automatically when you reconnect. It never claims a
hard-lock is safe while offline.

**What it's for:** Graceful behavior on flaky networks without lying to you.

**How to use it:** Automatic.

### 2.8 Host dashboard

**What it is:** Visit `https://<host>/dashboard` for a read-only live view of
sessions, connected devices, locks, active editing, and planned file creations.
It exposes coordination metadata only and can be disabled in the host
configuration.

### 2.9 Coding-agent team awareness (MCP)

**What it is:** `get_team_status` gives a coding agent the active-work projection: members,
their declared task descriptions, repository-relative files, and current activity roles.
`get_connection_status` provides the live connected/offline team roster, including idle
teammates. The editor panel combines both projections so the team list remains visible even
before someone edits a file. They are part of the MCP surface alongside the risk, intent,
lock, and live-update tools, and the V2 collaboration tools described in section 2b.

**How to use it:** Start the local Agent, then configure the coding-agent client to run:

```bash
cfls mcp --workspace /absolute/repo/path
```

The bridge authenticates to the already-running local Agent; it does not connect directly to
the Host. The returned activity is coordination metadata, never source files or diffs.

---

## 2b. Collaboration layer (V2)

V2 extends coordination *awareness* into coordination *action*. Every feature reuses the V1
authority, identity, ordering, and persistence, and each is available to coding agents through
MCP tools. Nothing here shares source content except the explicitly opt-in live diffs.

### 2b.1 Messaging

Teammates and agents exchange directed or broadcast messages, ask questions and get answers
(correlated by id), set a priority (`fyi`/`normal`/`urgent`), and track read state. Message
bodies are **team text**, not source: the Host still value-scans them and rejects secrets,
credentials, and paths outside the repository. MCP: `send_message`, `list_messages`,
`mark_message_read`, `ask_question`, `answer_question`, `list_open_questions`.

### 2b.2 Tasks & approvals

A task is assigned to a member as a *proposal*; the assignee approves or rejects it before it
enters their task list, then advances it to `in_progress`/`done`. Only the assignee responds
and reports progress. MCP: `assign_task`, `respond_to_task`, `update_task_progress`,
`list_tasks`.

### 2b.3 Notifications, liveness & wake

Each member has a derived liveness state — `active`, `idle`, or `gone`. Incoming tasks,
questions, and urgent messages raise severity-tagged notifications. A **wake** asks an idle
teammate to resume; it is delivered at their next action rather than interrupting mid-task.
MCP: `get_liveness`, `wake_member`, `get_notifications`.

### 2b.4 Luna orchestrator

Luna is a coordination orchestrator that can assign work, arbitrate an ambiguous conflict,
answer a cross-agent question, or summarize the team's state in plain language. It is
**rules-based and deterministic by default and needs no external service or API key**; an
optional LLM adapter exists but is off unless configured. MCP: `ask_luna`.

### 2b.5 Live diffs (opt-in)

The only feature that shares source-derived content. It is **disabled by default** and enabled
per team by setting `liveDiffs.enabled` to `true` in `.coordination/config.json`. When enabled,
a member can share their current change diff for a path; the Host value-scans the patch for
secrets/excluded paths and broadcasts it to the trusted team, where it is shown **read-only** —
never applied to a recipient's files automatically. MCP: `share_diff`, `list_diffs`.

---

## 3. Onboarding — the `cfls` command-line tool

The `cfls` CLI sets up a team across multiple laptops. It only moves coordination
metadata and public keys; **your repo files always come from git.**

### Admin (one person, once)

| Command                          | What it does                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------- |
| `cfls admin-init`                | Creates and securely stores the team admin key.                                   |
| `cfls host`                      | Starts the Coordination Host for the repo. Add `--cert/--key` for production TLS. |
| `cfls invite <name> <publicKey>` | Issues a signed invitation for a teammate's device.                               |

### Each teammate

| Command                                   | What it does                                                   |
| ----------------------------------------- | -------------------------------------------------------------- |
| `cfls id`                                 | Shows this device's public key to send to the admin.           |
| `cfls join --host <wss-url> --name <you>` | Saves the host address + your name.                            |
| `cfls connect <invitation>`               | Stores the invitation the admin sent back.                     |
| `cfls agent --insecure-tls`               | Runs your local agent. The editor extension auto-discovers it. |
| `cfls mcp --workspace <absolute-path>`    | Exposes the running local Agent to an MCP client over stdio.   |
| `cfls service install`                    | Installs the per-user Agent service for the current workspace. |

On Linux, `cfls service install` creates a `systemd --user` service. On Windows it creates a
per-user Task Scheduler task and requires `--windows-user <DOMAIN\User-or-SID>`. Use
`cfls service status` to inspect it or `cfls service uninstall` to remove it.

Full step-by-step onboarding (including different-laptop setup) is in
[`onboarding.md`](./onboarding.md).

---

## 4. Automatic git sync (optional, Model A)

This is the layer that makes file _contents_ move automatically, on top of the
coordination signal. It is **opt-in and OFF by default** — nothing changes unless
your team turns it on.

### 4.1 How it works

- **Producer:** while your agent runs, every ~20 seconds it commits your changes
  and pushes them to your own branch `cfls/<you>` (e.g. `cfls/alice`). It never
  switches your checked-out branch and never force-pushes.
- **Consumer:** every ~20 seconds it fetches and tells you when a teammate's
  branch moved ("bob published 2 commits"). If `autoMerge` is on, it merges their
  changes when there's no conflict.
- **Non-agent users** just use plain git — nothing breaks for them.

### 4.2 Turning it on

Edit the team-shared, committed file `.coordination/config.json`:

```json
{
  "autoSync": {
    "enabled": true,
    "remote": "origin",
    "branchPrefix": "cfls/",
    "commitIntervalSec": 20,
    "fetchIntervalSec": 20,
    "autoMerge": false
  }
}
```

- `enabled` — master switch (leave `false` to keep everything off).
- `autoMerge: false` — safest: you're _notified_ and merge when ready.
- `autoMerge: true` — conflict-free changes merge automatically; anything that
  would conflict is left for you.

### 4.3 The sync commands

| Command                                               | What it does                                                                                                            |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `cfls clone <repo-url> [--host <wss>] [--name <you>]` | Clones the repo (with _your_ GitHub access) and scaffolds the coordination config in one step.                          |
| `cfls sync status`                                    | Shows your branch, your publish branch, working-tree state, and each teammate's ahead/behind.                           |
| `cfls sync push`                                      | Commits your coordinated changes and publishes them to `cfls/<you>` right now.                                          |
| `cfls sync merge <member>`                            | Safely merges a teammate's branch. Aborts cleanly on conflict (your tree is untouched) and lists the conflicting files. |
| `cfls sync merge <member> --resolve`                  | Merges and, on conflict, **opens the conflicted files in your editor's merge UI** so you can resolve them by hand.      |

> **Honest limitation:** git is what moves the bytes. CFLS automates the push and
> pull; it does not replace your GitHub access, and genuine conflicts still need a
> human.

---

## 5. Conflict avoidance & resolution

Conflicts are best _prevented_ (sections 2.1–2.5). When they can still happen,
these three features make them safe and easy to handle.

### 5.1 Live-edit pre-warning (coordination-aware merges)

**What it is:** Before the auto-sync consumer merges a teammate's branch, it
checks the files that merge would touch against the files people are editing
**right now** (from the live coordination view). If they overlap, it warns:

> ⚠ heads-up: bob's changes touch 1 file(s) a teammate is editing now
> (src/shared.ts) — coordinate before merging.

With `autoMerge` on, it goes further and **defers** the auto-merge for that
branch so it never overwrites live work — you merge it deliberately when ready.

**What it's for:** Stopping an automatic merge from landing on top of something
someone is actively typing into.

**How to use it:** Automatic whenever auto-sync is enabled and your agent is
running. No configuration.

### 5.2 Reuse recorded resolution (git rerere)

**What it is:** When auto-sync is enabled, CFLS turns on git's `rerere` feature.
The first time you resolve a particular conflict by hand, git _remembers_ how you
resolved it and replays the same resolution automatically the next time the same
conflict appears.

**What it's for:** Recurring conflicts in the same file stop being repetitive
busywork.

**How to use it:** Automatic when auto-sync is on. (You can also enable it
yourself anywhere with `git config rerere.enabled true`.)

### 5.3 In-editor conflict resolution (`--resolve`)

**What it is:** `cfls sync merge <member> --resolve` performs the merge, and if
there are conflicts it **leaves the conflict markers in place** and opens the
conflicted files in VS Code / Kiro. Your editor then shows its 3-way "Accept
Incoming / Current / Both" merge editor.

**What it's for:** The easiest path for resolving a real conflict without knowing
git internals — click through it in the editor, then commit.

**How to use it:**

1. Run `cfls sync merge alice --resolve`.
2. The conflicted files open in your editor. Use the merge editor to pick the
   right content for each conflict.
3. Run `git add -A` then `git commit`.
4. Changed your mind? `git merge --abort` throws the whole merge away.

### 5.4 Good habits (recommended)

- Put **hard-stop locks** on your few hottest shared files (2.3).
- **Sync small and often** — the 20-second interval keeps diffs tiny, and tiny
  diffs rarely conflict.
- Prefer **many small files** over one giant file.
- Honor the **presence** and **risk** signals before starting on a file.

---

## 6. Trying it out

### On one laptop (no teammates needed)

- `pnpm demo` — a narrated, headless run: one host + three simulated agents
  (alice/bob/carol) showing coordination as it happens.
- `pnpm playground` — an interactive run: starts a host and three agents on fixed
  ports, then you open separate editor windows for each teammate and watch the
  status bar update live as you edit shared files.

See [`onboarding.md`](./onboarding.md) for the exact click-by-click steps.

### Across multiple laptops

Follow the onboarding flow in section 3 (admin runs `cfls admin-init` + `cfls
host` + `cfls invite`; each teammate runs `cfls clone`/`cfls id`/`cfls
connect`/`cfls agent`). For a shared host reachable by everyone, deploy it on a
small VPS as described in [`deployment.md`](./deployment.md).

---

## 7. Security summary

- **Per-device keys** — every laptop has its own key; there is no shared password.
- **Signed invitations** — you can only join a team the admin invited your device to.
- **TLS everywhere** — all host traffic is `wss://`. The dev self-signed cert is
  for local testing only; production uses a real cert.
- **Metadata only** — the host never sees your source code, only coordination
  facts (paths, who, when). File contents move through git.
- **No credential handling** — `cfls clone`/push/pull use _your own_ GitHub
  access (SSH key / credential helper). CFLS stores no GitHub tokens.
- **Loopback-only local API** — the agent's local API is bound to `127.0.0.1`
  and protected by a per-session token; the editor auto-discovers it.
