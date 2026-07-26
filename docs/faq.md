# CFLS — Plain-Language Overview & FAQ

A simple, honest explanation of what CFLS is, how it works, what it does **not**
solve, and answers to the objections people most often raise.

## What CFLS is (one line)

A real-time "who's working on what" layer for a team and their AI agents sharing
one Git repo. It shares **activity metadata** (who's touching which file, locks,
plans, messages) — never your source code — so you see a collision *before* it
happens instead of at merge time.

## Explain it like I'm not a programmer

Imagine your team is writing one big book together, and everyone keeps their own
copy of it. The danger is obvious: two people rewrite the same page at the same
time without knowing, and later someone has to painfully stitch the two versions
back together. CFLS is the system that quietly says, out loud, "hey, Alice is
writing on page 42 right now" — *before* you also start on page 42.

Here are the real words this project uses, in plain terms:

- **Repository (repo)** — the shared project folder. Think of it as the whole
  book everyone is working on.
- **Git** — the tool that already keeps every version of the book and stitches
  edits together. It's excellent, but it only notices two people clashed *after*
  they've both written. CFLS does **not** replace Git; it sits next to it.
- **Agent** — a small helper program that runs quietly on *your* computer. Think
  of it as your personal assistant who notices which page you've opened and tells
  the front desk, "my person is now working on page 42." It only reports what
  you're *touching*, never what you're *writing*.
- **Host** — the front desk / receptionist for the whole team. Every assistant
  (Agent) reports to this one desk, and the desk tells everyone else what's going
  on. It's the single place that keeps the shared "who's doing what" board.
- **Lock** — putting a sticky note on a page that says "in use." A **soft lock**
  is a polite note ("someone's here, be aware") — you can still work. A **hard
  lock** is a firmer "please don't touch this fragile page right now."
- **Presence** — the live "green dot" showing who is actively working, like seeing
  which colleagues are online.
- **Intent** — announcing your plan in advance: "I'm about to rewrite chapter 3."
  Others see it before you even start.
- **AI agent / coding agent** — an AI assistant (like an AI that writes code for
  you). More and more, these AIs edit the same project too. They can't "sense"
  that a human or another AI is already on a page — so CFLS gives them the same
  board to check, so they stop overwriting each other.
- **Metadata** — "information about the work," not the work itself. CFLS shares
  things like *which page* and *who* — never the actual sentences on the page.
  Like a library index card that says a book is checked out, without photocopying
  the book.
- **MCP** — simply the "language" the AI assistants use to read that board and to
  claim a page. It's the plug that lets an AI talk to CFLS.
- **Merge conflict** — the mess that happens when two edits to the same spot have
  to be combined by hand. CFLS's whole job is to help you avoid ever getting
  there.

**The one-sentence version for anyone:** CFLS is a shared "who's working on what
right now" board for a team (and their AI helpers), so people stop accidentally
editing the same thing at the same time — and it does this by sharing *only* who
is touching which file, never the actual work.

## The problem it solves

Git tells you about conflicts **after** everyone has already written their code —
at merge/PR time. By then the work is done and someone has to redo it. CFLS gives
an earlier, quieter signal: "Alice is already in `payments.ts` right now." You
coordinate before writing, not after.

## How it works (the pieces)

- **Coordination Host** — the one authority. Verifies identity, orders events,
  stores state, broadcasts updates. Runs on a laptop for a demo or a server for a
  team.
- **Local Agent** — runs on each person's machine. Watches the repo folder, turns
  editor activity into metadata, signs it, sends it to the Host, keeps an
  encrypted local cache.
- **VS Code / Kiro extension** — shows the team panel and status; talks only to
  the local Agent (never the Host directly).
- **MCP bridge** — exposes the same info to AI coding agents as tools
  (`get_risk_map`, `acquire_lock`, `send_message`, `ask_luna`, and more).
- **Shared packages** — `protocol` (message formats), `core-state`
  (locks/presence/risk rules), `security` (keys/invites), `dependency-analyzer`
  (metadata-only import graph).

## The flow (simple)

Alice starts editing → her Agent sends signed "editing `payments.ts`" metadata →
Host assigns an order number and stores it → Host broadcasts it → Bob's Agent and
editor show "`payments.ts` is in play." Bob decides to wait, coordinate, or pick
another file. Git still does all the actual code/commit/merge work.

## What's shared vs. never shared

**Shared:** repo-relative file paths, who's editing, locks, declared intentions,
planned new files, dependency edges, messages/tasks (team text).

**Never shared:** your actual source code, secrets/`.env`, credentials, absolute
paths, anything outside the repo. The one exception is the **opt-in live-diffs**
feature (off by default), which shares change diffs — and even then it scans for
secrets and never auto-applies them.

## The V2 collaboration layer (what got added)

Beyond "see the collision," V2 lets the team **act**:

- **Messaging** — direct/broadcast messages, questions & answers, priorities.
- **Tasks & approvals** — assign a task; the receiver approves before it lands.
- **Liveness & wake** — active/idle/gone status; nudge an idle teammate.
- **Luna** — a coordinator that assigns work, arbitrates conflicts, answers
  questions, and summarizes team state. Rules-based by default — no AI key needed.
- **Live diffs (opt-in, off by default)** — the only feature that shares
  code-derived content.

## What it lacks / can't solve (honest)

- **It's not a lock at the OS level.** A plain text editor, a script, or `git`
  itself can still change a "hard-locked" file. CFLS only stops tools that choose
  to cooperate (the extension, MCP agents). It's a *coordination* lock, not a
  filesystem permission.
- **It doesn't eliminate merge conflicts.** It reduces the avoidable ones. Two
  people editing the same function seconds apart, or offline, can still collide.
- **It needs the Host reachable.** Offline, it serves cached (clearly-stale) info
  and refuses to pretend a lock is safe. No Host = no live coordination.
- **Everyone has to actually run it.** A teammate who doesn't run the Agent is
  invisible to the system — and invisible to everyone else's safety signal.
- **It's host-based, not peer-to-peer / serverless.** Someone runs and maintains
  the Host.
- **Metadata is still sensitive.** File names and activity leak *intent*. It's
  minimized, but it's not "nothing leaves your machine."
- **MVP-level polish.** Storage is SQLite behind an interface (Postgres is future
  work); some flaky timing tests on Windows; deeper dependency-impact UX and
  broader editor support are still product work.
- **Not a replacement for review, CI, or branching discipline.**

## FAQ — the objections people raise

### "Isn't this just what Git is for?"

No. Git manages *code history and merging* — it's fundamentally **after-the-fact**:
it finds conflicts when you merge, once the work already exists. CFLS is
**before-the-fact**: it tells you someone is *currently* in that file so you never
write the conflicting code in the first place. They're complementary — Git stays
the source of truth; CFLS is the early-warning radar around it.

### "Why not just use branches and pull requests?"

Branches isolate you *until* merge, which is exactly when the collision surfaces.
PRs review code that's already written. Neither tells you, in the moment, that a
teammate is editing the same lines right now. CFLS fills that live-awareness gap.

### "Can't we just message each other — 'I'm working on X'?"

That's exactly the manual behavior CFLS automates. Manual pings are easy to
forget, get buried, and AI agents can't read your intent from them. CFLS makes
"who's on what" automatic, live, and machine-readable so both humans *and* coding
agents respect it.

### "Google Docs / Live Share already do real-time co-editing — why not that?"

Live co-editing merges everyone into one shared buffer and shares content. That's
great for pairing on one file, but it doesn't scale to a whole repo, doesn't
respect Git branches, and shares your actual code. CFLS coordinates the *whole
project* by metadata and leaves the code in Git where it belongs.

### "Doesn't file locking make teams slower, like old exclusive-lock VCS?"

CFLS defaults to **soft** (awareness only) — it doesn't block you, it informs you.
Hard locks are opt-in for genuinely fragile files. It's designed as a nudge, not
a gate, precisely to avoid the "locked out, can't work" pain.

### "If it doesn't actually prevent edits, what's the point?"

The point is the *decision*, not enforcement. Most conflicts happen because people
simply didn't know. Remove the not-knowing and most avoidable collisions
disappear — the same reason a turn signal works even though it can't physically
stop the other car.

### "Why do AI agents matter here?"

Multiple AI coding agents (and humans) now edit the same repo simultaneously.
Agents can't sense "someone's already here" — they'll happily overwrite each
other. CFLS gives agents a machine-readable way to check, claim, message, and
coordinate via MCP tools, so they behave like considerate teammates instead of
stomping on each other.

### "Is my code safe? Is this a security risk?"

Source code never goes through CFLS (except the explicit, off-by-default
live-diffs feature). Traffic is TLS + signed per-device; only invited members
join; secrets and paths outside the repo are rejected. The honest caveat: file
names and activity *are* shared with the team and Host, so treat that metadata as
operationally sensitive.

### "What happens if the server goes down?"

You keep working — Git is untouched. CFLS just goes quiet: it shows cached,
clearly-marked-stale info and never falsely claims a lock is safe. Coordination
resumes when the Host is back.

### "Does this lock me into a vendor?"

No. It sits *beside* your existing Git workflow. Stop running it and everything
works exactly as it did before — you just lose the live awareness.
