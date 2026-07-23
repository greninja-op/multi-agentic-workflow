# Onboarding: joining a shared repo session across laptops

> How a team goes from "clone the repo" to "CFLS is Online" on separate laptops,
> using the `cfls` CLI (`@cfls/cli`). Related docs:
> [deployment.md](./deployment.md) · [architecture.md](./architecture.md) ·
> [threat-model.md](./threat-model.md)

## What CFLS does and does not share

CFLS shares **coordination metadata only** — presence, soft/hard locks, declared
intents, and risk. It does **not** move file contents. Your **files are shared
through git**: everyone clones the same remote, and you `push`/`pull` as usual.

Because coordination is keyed by the **git remote** (canonical `repoId`) and uses
**repository-relative paths**, it does not matter where each teammate keeps the
repo on disk or what the folder is named. `C:\work\app` on one laptop and
`~/dev/app` on another coordinate as the same session, as long as they share the
same git `origin` and branch.

Session identity is the tuple `(repoId, teamId, branch, baseRevision)`. The `cfls`
tool derives it automatically:

- `repoId` — canonical form of `git remote get-url origin`
- `teamId` — configured (`--team`), defaulting to `default-team`
- `branch` — `git rev-parse --abbrev-ref HEAD`
- `baseRevision` — `git rev-parse HEAD`

If git metadata is unavailable, `cfls` falls back to a manual
`.coordination/session.json` (`{ repoId, teamId, branch, baseRevision }`) and
errors clearly if neither source exists.

> The **invitation** a teammate receives embeds the authoritative session, so the
> agent always coordinates against exactly the session the host accepts.

## Roles

- **Team admin** — runs the CoordinationHost and issues invitations. Holds the
  team's admin signing key (stored in the OS secret store / encrypted-file
  fallback, never on disk in plaintext, never committed).
- **Teammate** — runs a local CoordinationAgent and the VS Code extension.

## Prerequisites

- Node.js ≥ 20, dependencies installed with `pnpm install --frozen-lockfile`,
  and the built CLI (`pnpm -r build`). From a source checkout, run
  `node apps/cli/dist/index.js <command>` from the repository root. The
  shorthand `cfls <command>` below means an installed standalone CLI.
- Everyone has cloned the **same git remote** and checked out the **same branch**.
- The admin's host must be reachable from each teammate (see
  [deployment.md](./deployment.md) for laptop vs VPS reachability).

## End-to-end flow

### 1. Admin: one-time key + host setup

```bash
# Create and securely store the team admin key; registers its public key in ~/.cfls/host.json
cfls admin-init --team my-team

# Start the CoordinationHost for this repo's session (run from inside the repo)
cfls host --url wss://0.0.0.0:8730 --insecure-tls
#   dev uses a self-signed cert (teammates pass --insecure-tls)
#   production: pass --cert <pem> --key <pem> (or set CFLS_TLS_CERT / CFLS_TLS_KEY)
```

`cfls host` prints the reachable `Host_URL` and the session it is serving. Keep it
running (Ctrl+C stops it). For an always-on setup, deploy the host on a VPS — see
[deployment.md](./deployment.md).

### 2. Teammate: register this device and share its public key

```bash
# From inside the cloned repo
cfls id                     # prints this device's Device_Public_Key + deviceId
# (optional) also record the host + your name for later:
cfls join --host wss://<host-ip>:8730 --name alice --team my-team
```

Send the printed **Device_Public_Key** to the admin (chat, email — it is public,
not a secret).

### 3. Admin: issue an invitation for that device

```bash
# Run from inside the repo (same session the host serves)
cfls invite alice <alice-device-public-key>
```

This prints a **base64 invitation string**. Send it back to the teammate.

### 4. Teammate: connect and go online

```bash
cfls connect <invitation-string>     # validates + stores the invitation
cfls agent --insecure-tls            # starts the local agent (Ctrl+C to stop)
```

`cfls agent`:

- loads this device's key from the secret store,
- watches the repo root as the Authorized_Folder,
- loads team rules from `.coordination/rules.json` (or all-soft by default),
- picks a fixed loopback Local_API port (default `8750`, override `--local-port`),
- writes `.coordination/local-api.json` (`{ url, token }`) so the VS Code
  extension **auto-discovers** the agent with zero manual settings.

### 5. Teammate: install the extension and open the repo

- Install the CFLS extension (`.vsix` — see the extension's `package:vsix`
  script) into VS Code.
- Open the repo folder. With `cfls agent` running, the extension reads
  `.coordination/local-api.json`, connects to the local agent, and the status bar
  goes **Online**. No `cfls.localApi.*` settings needed.

When two teammates edit the same tracked file, each sees the other's presence,
soft locks, and (where configured) hard-lock coordination live.

## Files this creates

| Path                                       | Scope                 | Committed?            | Contents                                                |
| ------------------------------------------ | --------------------- | --------------------- | ------------------------------------------------------- |
| `~/.cfls/host.json`                        | per-machine (admin)   | no                    | authorized admin public keys + teamId                   |
| OS secret store / `~/.cfls` encrypted file | per-machine           | no                    | admin private key, device private key                   |
| `.coordination/agent.json`                 | per-repo, per-machine | no (gitignored)       | hostUrl, memberName, teamId, invitation                 |
| `.coordination/local-api.json`             | per-repo, per-machine | no (gitignored)       | loopback Local_API url + per-session token              |
| `.coordination/session.json`               | per-repo              | optional              | manual session fallback when git is unavailable         |
| `.coordination/rules.json`                 | per-repo              | **yes** (team-shared) | Repository_Rules_Config                                 |
| `.coordination/config.json`                | per-repo              | **yes** (team-shared) | optional `autoSync` block (opt-in git sync; no secrets) |

Secrets never land in `.coordination/*`. Private keys live only in the OS secret
store or the encrypted-file fallback under `~/.cfls`. The `.gitignore` already
excludes `.cfls/`, `.coordination/local-api.json`, `.coordination/agent.json`, and
`.coordination/.cache/`.

## Automatic git sync (optional)

CFLS coordinates **metadata only** — git is still what moves file bytes. On top
of that, the CLI offers an **opt-in** layer that automates the git side so
teammates' coordinated changes flow between laptops without manual `push`/`pull`.
It is **disabled by default**: with no config (or `enabled: false`), nothing new
runs and `cfls agent` behaves exactly as before.

### Model A: per-user branches (and why)

Each teammate's agent publishes **only their own** coordinated working-tree
changes to their **own** branch `cfls/<memberName>` and never touches anyone
else's branch automatically. This was chosen over a single fully-shared,
real-time branch **for safety**: a shared branch invites silent clobbering,
force-pushes, and half-applied conflicting writes. With per-user branches:

- **Producer (automatic):** if your working tree has non-ignored changes, the
  agent stages exactly those known paths (never `git add .`), commits them as
  `cfls: <member> sync <n> file(s)`, and publishes with
  `git push <remote> HEAD:refs/heads/cfls/<member>`. This publishes **without
  switching or resetting your checked-out branch** — the safest possible push.
  A rejected (non-fast-forward) or unauthenticated push logs a concise notice and
  retries next cycle; it **never force-pushes**.
- **Consumer (fetch + notify):** the agent periodically `git fetch`es and, when
  another `cfls/*` branch advances, notifies e.g. _"alice published 2 commit(s)"_.
  Applying those changes is a **safe, explicit** step (`cfls sync merge alice`)
  unless you enable `autoMerge`.
- **Optional `autoMerge` (conflict-free only):** when enabled, the consumer
  attempts a merge and applies it **only** when it is clean/fast-forward.
  On **any** conflict it runs `git merge --abort` (your tree is left untouched)
  and notifies _"manual merge needed"_. It **never auto-resolves conflicts**.

> Honest caveat: real conflicts still require a manual merge or a PR. The
> automatic layer safely moves conflict-free work and gets out of your way the
> moment human judgement is needed. Fully-shared-branch real-time sync was
> intentionally **not** chosen.

### Enabling it

Add an `autoSync` block to the **committed, team-shared** `.coordination/config.json`
(no secrets ever go here):

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

Any missing field falls back to a safe default; a missing file or block means
**disabled**. With `enabled: true`, `cfls agent` starts the background sync loop
(cancelled cleanly on Ctrl+C alongside the agent).

### Commands

```bash
cfls sync status            # current branch, your cfls/<you> publish branch,
                            # teammate cfls/* branches with ahead/behind, tree state
cfls sync push              # manual: stage coordinated changes, commit, push cfls/<you>
                            # (skips cleanly when the tree is clean)
cfls sync merge <member>    # safe merge of <remote>/cfls/<member> into your branch;
                            # aborts cleanly on conflict AND lists the conflicting files
cfls sync merge <m> --resolve
                            # merge and, on conflict, open the conflicted files in your
                            # editor's 3-way merge UI to resolve them, then `git commit`
```

### Conflict handling

Auto-sync is built to make conflicts rare and safe:

- **Live-edit pre-warning:** before an auto-merge touches a file a teammate is
  editing _right now_ (from the live coordination view), you're warned — and with
  `autoMerge` on, that branch's merge is **deferred** so live work is never
  clobbered.
- **`git rerere`** is turned on automatically when auto-sync is enabled, so a
  conflict you resolve once is replayed automatically next time.
- **`cfls sync merge <member> --resolve`** opens the conflicted files in your
  editor's merge editor for point-and-click resolution.

See [`features.md`](./features.md) for the full feature guide.

### Convenience clone

```bash
cfls clone <repo-url> [--host <wss>] [--name <you>] [--team <id>]
```

`cfls clone` runs `git clone` and scaffolds `.coordination/agent.json` (host, name,
team) so you can jump straight to `cfls id` → `cfls connect` → `cfls agent`. It
still uses **your own** GitHub access (SSH key / credential helper / PAT); cfls
stores no git tokens.

## Troubleshooting

- **Status bar stays Offline** — is `cfls agent` running in the repo? Does
  `.coordination/local-api.json` exist? Is the host reachable at the configured
  `Host_URL`?
- **Handshake rejected / "Invitation is for a different session"** — the admin
  and teammate must be on the **same branch/commit** so the session matches, and
  the invitation must be for the public key from `cfls id` on **that** machine.
- **"No secure secret store is available"** — the agent fails closed by design; a
  usable OS credential store or the encrypted-file fallback under `~/.cfls` is
  required.
- **Self-signed TLS** — dev hosts use a self-signed certificate, so teammates must
  pass `--insecure-tls`. Use a real certificate in production (see
  [deployment.md](./deployment.md)).
