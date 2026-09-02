# CFLS — Technology Stack (A → Z)

> The complete, concrete technology plan. Decision: **full rewrite, Rust core, top-tier, latency-first, complexity is acceptable.** The **design** (protocol shape, identity model, ordering/conflict logic) carries over from the current implementation; the **implementation** is rebuilt natively.

Companion to `architecture.md` (behavior) and `decisions.md` (rationale). This document is _only_ about technology.

---

## 1. Principles behind the choices

- **Native where it lives long or fans out wide.** The Service is an always-on per-machine daemon; the Host fans out to everyone. Both go **Rust** — single static binary, tiny memory, no runtime to install, no GC pauses.
- **One source of truth across languages.** Host and Service **share Rust crates** (protocol + core logic), so the wire format and coordination rules can never drift between them.
- **Latency comes from transport and topology, not from the language.** The real wins are **QUIC** on the WAN, **OS IPC** locally, and an **in-process MCP endpoint**.
- **Two constraints are fixed:** the **Extension is TypeScript** (VS Code's extension host runs JS), and **C is excluded** (memory-unsafe with no advantage over Rust).
- **The existing verified test suite becomes the behavioral spec** for the Rust port — we re-express proven logic, we don't reinvent it.

---

## 2. Language map

| Component                    | Language                          | Notes                                                                         |
| ---------------------------- | --------------------------------- | ----------------------------------------------------------------------------- |
| Host (central)               | **Rust**                          | tokio; shares crates with Service.                                            |
| Service (per-machine daemon) | **Rust**                          | Single binary; also hosts the MCP bridge and local IPC.                       |
| Agent Interface (MCP)        | **Rust** (`rmcp`)                 | In-process with the Service; exposed to agents via a stdio bridge subcommand. |
| Luna (orchestrator)          | **Rust**                          | Rules engine + model-API client at the Host.                                  |
| Extension                    | **TypeScript**                    | VS Code extension host.                                                       |
| Panel (webview UI)           | **TypeScript + Svelte**           | Compiles to tiny, fast JS.                                                    |
| Shared protocol/types        | **Rust (`serde`) → generated TS** | One schema, generated TypeScript for the Extension.                           |

---

## 3. Rust workspace layout (cargo workspace)

A single cargo workspace with focused crates. `[bin]` crates at the edges, pure `[lib]` crates in the middle.

- **`cfls-protocol`** _(lib)_ — the single source of truth for the wire: message catalog, envelope, DTOs, error codes, all as `serde` types. Annotated for TypeScript generation.
- **`cfls-core`** _(lib, pure, no I/O)_ — coordination logic: monotonic revision/ordering, conflict resolution (earliest-revision), lock/intent/presence registries, risk/impact, reconnect-sync, the task model, the mailbox model. _This is the Rust re-expression of today's `core-state`; the existing tests are its acceptance spec._
- **`cfls-crypto`** _(lib)_ — Ed25519 device identity, signing/verification, signed invitations, revocation, replay guard, the encrypted-cache primitives.
- **`cfls-transport`** _(lib)_ — QUIC + WSS fallback, connection lifecycle, stream multiplexing, framing, the MessagePack codec, backpressure.
- **`cfls-diff`** _(lib)_ — the diff pipeline: live change-stream reconciliation over a proven text-diff engine.
- **`cfls-mcp`** _(lib)_ — the MCP tool definitions and handlers (`rmcp`).
- **`cfls-luna`** _(lib)_ — the orchestrator: deterministic rules engine + model-API client + decision points.
- **`cfls-service`** _(bin)_ — the daemon: file watcher, git reader, local IPC server, in-process MCP, mailbox, encrypted cache, host connection. Also the CLI entrypoint (`service` / `mcp` / `install` subcommands).
- **`cfls-host`** _(bin)_ — the central server: session authority, ordering, broadcast, persistence, Luna integration, diagnostics.
- **`cfls-sim`** _(bin/test)_ — the multi-agent simulation harness (one Host + N Services over real loopback transport).

---

## 4. Async runtime & concurrency model

- **Runtime:** `tokio` (multi-threaded).
- **Host concurrency:**
  - One **single-writer ordering task** per session guarantees the strict total order (no locks on the hot path).
  - Per-session **broadcast channels** (`tokio::sync::broadcast`) fan events out to connected Services.
  - A **mailbox** (bounded `mpsc`) per agent.
  - The durable-log writer is its own task; state lives in memory and is rebuilt from the log/snapshot on restart.
- **Service concurrency:** independent tasks for the file watcher, the git poller, the Host connection (with reconnect/backoff), the local IPC server, and the MCP bridge — all coordinated through channels, no shared locks on hot paths.
- **Backpressure everywhere:** bounded channels; coalescing of bursty signals (presence/edit streams) before they hit the wire.

---

## 5. Transport & connectivity (the latency core)

Three hops, each optimized:

### 5.1 Extension ↔ Service (local, same machine)

- **Transport:** OS IPC — **Unix domain socket** (Linux/macOS) / **named pipe** (Windows). No TCP port, no loopback overhead.
- **Framing:** length-prefixed **MessagePack** frames (JSON debug mode toggle).
- **Auth:** per-session loopback token; the socket is user-private.

### 5.2 Agent ↔ Service (MCP)

- **Transport:** the agent spawns **`cfls mcp`** (a subcommand of the same binary) which speaks **MCP over stdio** to the agent and forwards to the running daemon over the local IPC socket. The MCP protocol logic itself is **in-process** in `cfls-mcp` — the lowest-latency path.
- **SDK:** `rmcp` (official Rust MCP SDK).

### 5.3 Service ↔ Host (WAN — the important one)

- **Primary: QUIC** (`quinn`, TLS 1.3 via `rustls`):
  - **0-RTT / fast reconnect** — resuming a dropped link is near-instant.
  - **No head-of-line blocking** — independent streams for control, events, and bulk (diffs) so a big diff never stalls a small message.
  - **Connection migration** — survives network/IP changes (laptop moves Wi-Fi ↔ tether).
- **Fallback: WSS/TLS** (`tokio-tungstenite` over `rustls`) — auto-used when UDP/QUIC is blocked by a network.
- **Stream design (QUIC):** a **control stream** (auth, heartbeats, acks), an ordered **event stream** (coordination updates), and on-demand **bulk streams** (live diffs, snapshots) so large payloads never block coordination.
- **Codec:** MessagePack; per-message envelope with the strict revision from the Host.

---

## 6. Serialization & cross-language schema

- **In Rust:** `serde` everywhere. On the wire: **MessagePack** (`rmp-serde`) for compactness and speed; **JSON** (`serde_json`) as a debug/inspection toggle.
- **Single schema, zero drift:** the `cfls-protocol` `serde` types are the one definition. **`typeshare`** generates the **TypeScript types** the Extension uses, so Rust and TS can never diverge. The Extension decodes MessagePack with `@msgpack/msgpack` (or JSON in debug).
- **Versioning:** an explicit message-format version in the envelope; the Host rejects unsupported versions (same discipline as today).

---

## 7. Data & persistence

### 7.1 Host

- **Authoritative state in memory** (from `cfls-core`), for real-time speed.
- **Durability:** an embedded, ACID, pure-Rust store — **`redb`** — holds the append-only event log, periodic state snapshots, membership, and the dependency/task data. On restart the in-memory state is rebuilt from the latest snapshot + log tail; ordering resumes strictly above the last revision.
- **Scale path (deferred):** swap the store behind a trait for **Postgres** (`sqlx`) if multi-host/large-scale is ever needed. Not built now.

### 7.2 Service

- **Device private key:** OS keychain via the **`keyring`** crate; encrypted-file fallback.
- **Encrypted local cache** (last-known state per session): **ChaCha20-Poly1305** (or AES-256-GCM) with **Argon2id** key derivation. Metadata-only content (never secrets/source outside the boundary).

---

## 8. Cryptography & security stack

- **Identity/signing:** `ed25519-dalek` (same design: device keypair, signed events, signed invitations, revocation, replay guard).
- **TLS:** `rustls` (TLS 1.3), used by both QUIC and the WSS fallback.
- **KDF / symmetric:** `argon2` (Argon2id) + `chacha20poly1305` (or `aes-gcm`) for the cache.
- **Randomness:** `getrandom`.
- **Content boundary filter:** runs in the Service before anything leaves the machine — blocks secrets, credentials, environment files, and out-of-project paths; allows team work (diffs/messages/plans).
- **Supply chain:** `cargo-deny` (license + advisory + ban checks) in CI.

---

## 9. File watching & git integration

- **File watching:** `notify` (cross-platform FS events) with debounce/coalescing.
- **Git:** `git2` (libgit2 bindings) — in-process reads of branch, HEAD, working-tree status, diffs, ahead/behind. No shelling out.

---

## 10. Diff engine

- **Text diff:** `similar` (Myers-based) for the underlying computation.
- **Live pipeline (`cfls-diff`):** consumes the Extension's real-time change ranges, reconciles them against the git baseline, and emits incremental, hunk-level diffs on the QUIC bulk stream (debounced, size-capped).

---

## 11. MCP layer

- **SDK:** `rmcp`.
- **Topology:** MCP handlers live in `cfls-mcp`, in-process in the Service. Agents connect via the **`cfls mcp`** stdio bridge (configured in the agent's MCP settings).
- **Tools exposed:** `checkpoint`, `sync`, `declare_intent`, `send_message`, `ask_and_wait`, `get_status`, `get_tasks`, plus dependency/risk queries — each returns the standard envelope with piggybacked mail/tasks (see `architecture.md` §12–13).

---

## 12. Luna stack (orchestrator)

- **Rules engine:** deterministic Rust — handles ordering/routing/obvious assignment (the ~90% that needs no LLM).
- **Model client:** `reqwest` (async) with streaming (SSE parsing) for the judgment calls (assignment, arbitration, Q&A tie-breaks, human summaries).
- **Prompt/guards:** versioned prompt templates + input guards in `cfls-luna`.
- **Degradation:** if the model API is unreachable, the rules engine + human approval keep the system running.
- **Model/vendor:** a **deferred, swappable config choice** — the client is provider-agnostic behind a trait.

---

## 13. Extension stack

- **Language:** TypeScript, VS Code Extension API.
- **Bundler:** `esbuild` (fast).
- **Types:** generated from `cfls-protocol` via `typeshare` — no hand-maintained duplicates.
- **Transport to Service:** the local socket/named pipe with MessagePack (`@msgpack/msgpack`).
- **Responsibilities (unchanged from architecture):** live editor sensing (edits/focus/terminal/diagnostics), status bar, and hosting the panel webview.
- **Package manager / tooling:** `pnpm`, `eslint`, `prettier`, `vitest`.

---

## 14. Panel UI stack

- **Framework:** **Svelte** (compiles away; tiny, fast, reactive — ideal for a live-updating status board).
- **Build:** `vite`, bundled into the extension's webview.
- **Comms:** the VS Code webview messaging bridge to the extension host (which relays to the Service).
- **Content:** live team status board, chat-to-Luna, task board, approvals, notifications.

---

## 15. Build, tooling & CI

- **Rust:** `cargo` workspace; `clippy` (lint), `rustfmt` (format), `cargo-nextest` (fast tests), `cargo-deny` (supply chain), `proptest` (property tests).
- **Cross-compilation:** `cargo-zigbuild` (or `cross`) for Windows/macOS/Linux targets; Linux static via `musl`.
- **TypeScript:** `pnpm`, `esbuild`/`tsup`, `vitest`, `eslint`, `prettier`.
- **CI:** matrix build/test across the three OSes for the Rust binaries + the extension; artifact publishing (binaries + VSIX).

---

## 16. Packaging & distribution

- **Service:** one **self-contained binary per OS** (Linux static via musl; native macOS/Windows). Auto-start at login without admin — `systemd --user` (Linux), `launchd` LaunchAgent (macOS), `HKCU\...\Run` (Windows).
- **CLI:** the same binary provides `cfls service` (daemon), `cfls mcp` (agent bridge), `cfls host` (central server), and install/onboarding subcommands.
- **Extension:** packaged as a **VSIX**, published to the marketplace.
- **Host:** single binary on a VPS or laptop; optional **distroless container image** for server deployment.

---

## 17. Observability

- **Logging:** `tracing` + `tracing-subscriber` (structured, leveled), secret-safe.
- **Metrics:** `metrics` crate with a Prometheus exporter on the Host.
- **Tracing (optional):** OpenTelemetry export for cross-component latency analysis.
- **Diagnostics:** metadata-only health/diagnostics endpoints on the Host (uptime, sessions, connected devices, revisions).

---

## 18. Testing stack

- **Rust unit + property:** `cargo-nextest` + `proptest` (the Rust counterpart to today's fast-check property tests — the same correctness properties are re-expressed).
- **Integration:** real QUIC/loopback round-trips (handshake → ingest → broadcast → sync → restart recovery).
- **Simulation:** `cfls-sim` — one Host + N Services over real transport, exercising presence, intent, conflict resolution, messaging, tasks, liveness, reconnect.
- **TypeScript:** `vitest` for the extension's pure logic and the webview components.
- **End-to-end:** Host + Services + a fake agent driving the MCP tools.
- **Acceptance spec:** the existing TS test suite (698+ tests) is the behavioral checklist the Rust port must satisfy.

---

## 19. Concrete dependency map (primary)

| Concern             | Rust crate(s)                                                                    | TS package(s)                    |
| ------------------- | -------------------------------------------------------------------------------- | -------------------------------- |
| Async runtime       | `tokio`                                                                          | —                                |
| QUIC + TLS          | `quinn`, `rustls`                                                                | —                                |
| WSS fallback        | `tokio-tungstenite`                                                              | `ws` (only if needed)            |
| Serialization       | `serde`, `rmp-serde`, `serde_json`                                               | `@msgpack/msgpack`               |
| Cross-lang types    | `typeshare`                                                                      | (generated)                      |
| Identity/crypto     | `ed25519-dalek`, `argon2`, `chacha20poly1305`, `getrandom`                       | —                                |
| Persistence (Host)  | `redb` (later: `sqlx`+Postgres)                                                  | —                                |
| Keychain            | `keyring`                                                                        | —                                |
| File watching       | `notify`                                                                         | —                                |
| Git                 | `git2`                                                                           | —                                |
| Diff                | `similar`                                                                        | —                                |
| MCP                 | `rmcp`                                                                           | —                                |
| Model client (Luna) | `reqwest`                                                                        | —                                |
| Logging/metrics     | `tracing`, `tracing-subscriber`, `metrics`                                       | —                                |
| Local IPC           | `interprocess` (or tokio UDS/pipe)                                               | node `net`                       |
| Extension           | —                                                                                | VS Code API, `esbuild`, `vitest` |
| Panel UI            | —                                                                                | `svelte`, `vite`                 |
| Tooling             | `clippy`, `rustfmt`, `cargo-nextest`, `cargo-deny`, `proptest`, `cargo-zigbuild` | `pnpm`, `eslint`, `prettier`     |

---

## 20. The rewrite / migration path

Phased, with the existing tests as the spec at each step:

1. **Workspace + protocol + crypto.** Stand up the cargo workspace; port `cfls-protocol` and `cfls-crypto`; generate TS types via `typeshare`.
2. **Core logic.** Port `cfls-core` (ordering, conflict resolution, registries, sync, task/mailbox models), validated against the ported property/unit tests.
3. **Transport.** `cfls-transport`: QUIC + WSS fallback + MessagePack framing, with loopback integration tests.
4. **Host.** `cfls-host`: authority, broadcast, `redb` persistence, restart recovery.
5. **Service.** `cfls-service`: watcher (`notify`), git (`git2`), local IPC, encrypted cache, host connection, reconnect.
6. **MCP.** `cfls-mcp` + `cfls mcp` bridge; wire the tools + playbook.
7. **Extension.** Rebuild the TS extension against the new protocol/socket; add the Svelte panel.
8. **Luna.** `cfls-luna`: rules engine + model client + decision points + human-approval flow.
9. **New collaboration layer.** Messaging, tasks-as-files, live diffs, liveness/notifications/wake — the features that don't exist yet.
10. **Simulation + E2E + packaging.** `cfls-sim`, cross-OS binaries, VSIX, host container.

---

## 21. Deferred / open technology choices

- **Luna's model/vendor** — swappable behind a trait; chosen later.
- **Host store at scale** — `redb` now; `sqlx`+Postgres only if multi-host scale is ever required.
- **QUIC vs. WSS default per environment** — QUIC-primary; the fallback threshold/detection is tuned during implementation.
- **Diff granularity & cadence** — hunk-level, debounced, size-capped; exact thresholds tuned with real data.
- **Deep project plugin** — still dropped (the Service covers it); would be a separate language-specific add-on if ever revisited.
