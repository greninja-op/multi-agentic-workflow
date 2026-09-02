# CFLS — Documentation

This folder is the complete, technology-free plan for CFLS: a **real-time collaboration fabric for many AI coding agents (and their humans) working the same repository at once** — dividing work up front, seeing each other live, talking to each other, and merging cleanly.

> **Status: planning / blueprint.** `idea.md`, `architecture.md`, and `decisions.md` define _what_ the system is and _how it behaves_ (technology-free). **`stack.md`** defines the chosen technology: a **full rewrite with a Rust core** (Host + Service), a **TypeScript + Svelte** extension, an **in-process MCP** bridge, and **QUIC** on the wire.

## Read in this order

1. **[idea.md](./idea.md)** — the problem, the objective, the core idea, the full feature set, what each feature solves, principles, non-goals, and success criteria. _Start here._
2. **[architecture.md](./architecture.md)** — the full A→Z blueprint: components, actors, identity/addressing, what's captured and from where, awareness vs. intent, the diff mechanism, messaging, tasks, the delivery model, the agent playbook, Luna the orchestrator, liveness & notifications, the human role, how it prevents PR conflicts, failure/edge cases, security model, reuse vs. build, build order, open items, and end-to-end walkthroughs.
3. **[decisions.md](./decisions.md)** — the decision log: every decision we made, the option chosen, the alternatives considered, and the reasoning.
4. **[stack.md](./stack.md)** — the complete technology stack (A→Z): languages, the Rust workspace, transport/connectivity (QUIC + local IPC), serialization, persistence, crypto, MCP, Luna, the extension/panel, build/CI, packaging, testing, the dependency map, and the rewrite path. _(Decision: full rewrite, Rust core, top-tier, latency-first.)_
5. **[glossary.md](./glossary.md)** — plain definitions of every term.

## The idea in one paragraph

Teams building together — especially fast (hackathons, MVPs) and especially now that everyone works through AI agents — lose huge time to merge/PR conflicts and have no live view of who's touching what. CFLS makes the agents first-class collaborators: they see each other's work live, talk to each other, hand off tasks, and are orchestrated by one central "PM" agent (**Luna**) while **humans direct** the big picture and approve work on their own machines. Git still moves the files; CFLS moves the **coordination** — so collisions rarely form, and merges stay clean by construction.

## The shape of the system (at a glance)

- **Service** (per machine, always on) — watches the workspace, holds the connection, routes messages.
- **Extension** (per IDE) — live editor sensor + the human's status panel.
- **Agent Interface** — the tool protocol agents use to speak (plans, messages, checkpoints).
- **Host + Luna** (one, central) — single source of truth + the orchestrator/PM.

Addressing: systems are `C1, C2, …`; agents are `A1, A2, …`; a global address is `C1/A1`.

## Chosen technology (see stack.md for the full A→Z)

- **Rust core:** Host + Service as native single binaries (tokio), sharing one protocol/logic crate so the two can never drift.
- **QUIC** (with a WSS fallback) on the WAN; **OS IPC** (Unix socket / named pipe) locally; **in-process MCP** bridge.
- **TypeScript** extension (forced by VS Code) + a **Svelte** webview panel; types generated from the Rust schema so there's no cross-language drift.
- **Luna** = a Rust rules engine + a swappable model-API client at the Host.
- Full rewrite; the existing verified test suite becomes the behavioral spec for the Rust port.

## What is intentionally NOT here

- No "deep project dependency plugin" — dropped for now (the Service already covers it).
- No autonomous carving-up of big features by agents — humans own the macro plan.
- Luna's specific model/vendor and the host-store-at-scale choice are deferred (swappable behind traits).
