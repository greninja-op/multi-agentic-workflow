/**
 * Integration tests for the agent's WSS connection lifecycle over a real host
 * (task 9.8; Req 2.5, 6.4, 6.6, 9.4). Exercises connect → acquire (host records
 * it), Offline_State + OFFLINE_QUEUED while disconnected, and reconnect
 * sync-from-revision convergence with re-assert of held locks.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ALL_SOFT_CONFIG } from "@cfls/core-state";
import type { MemberRef, SessionId } from "@cfls/protocol";
import { deriveDeviceId } from "@cfls/security";
import type { RunningHost } from "@cfls/host";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CoordinationAgent } from "../src/agent";
import {
  invitationFor,
  makeDevice,
  makeSession,
  startDevHost,
  waitUntil,
  type TestDevice,
} from "./support";

const session: SessionId = makeSession();

let host: RunningHost;
let admin: TestDevice;
let cacheDir: string;
let agents: CoordinationAgent[];

function selfOf(device: TestDevice): MemberRef {
  return {
    memberId: device.memberId,
    deviceId: deriveDeviceId(device.key.publicKey),
  };
}

async function startAgent(
  device: TestDevice,
  overrides: {
    autoReconnect?: boolean;
    cacheDir?: string;
    watcherActivityTtlMs?: number;
    onCreated?: (agent: CoordinationAgent) => void;
  } = {},
): Promise<CoordinationAgent> {
  const agent = new CoordinationAgent({
    session,
    self: selfOf(device),
    hostUrl: `wss://127.0.0.1:${host.port}`,
    invitation: invitationFor(session, admin.key, device),
    rules: ALL_SOFT_CONFIG,
    cacheDir: overrides.cacheDir ?? cacheDir,
    deviceKey: device.key,
    insecureTls: true,
    localApiPort: 0,
    enableNamedPipe: false,
    ...(overrides.watcherActivityTtlMs !== undefined
      ? { watcherActivityTtlMs: overrides.watcherActivityTtlMs }
      : {}),
    connection: {
      heartbeatIntervalMs: 0,
      autoReconnect: overrides.autoReconnect ?? true,
      backoff: { baseMs: 100, maxMs: 300 },
    },
  });
  overrides.onCreated?.(agent);
  agents.push(agent);
  await agent.start();
  return agent;
}

beforeEach(async () => {
  cacheDir = mkdtempSync(join(tmpdir(), "cfls-agent-"));
  admin = makeDevice("admin");
  host = await startDevHost();
  host.authority.registerSession(session, [admin.key.publicKey]);
  agents = [];
});

afterEach(async () => {
  for (const agent of agents) {
    await agent.stop();
  }
  await host.stop();
  rmSync(cacheDir, { recursive: true, force: true });
});

describe("connect + acquire (Req 6.1, 8.1)", () => {
  it("connects, acquires a lock, and the host records it", async () => {
    const agent = await startAgent(admin);
    await waitUntil(() => agent.hostConnection().isOnline());

    const result = await agent.agentPort().acquireLock({
      session,
      scope: "src/api.ts",
      scopeKind: "file",
    });
    expect(result.ok).toBe(true);

    await waitUntil(() =>
      agent.view.entries(session).some((e) => e.path === "src/api.ts"),
    );
    const locks = host.authority.snapshot(session).locks.map((l) => l.scope);
    expect(locks).toContain("src/api.ts");
  });

  it("returns the real winner for an accepted but contended lock claim", async () => {
    const alice = await startAgent(admin, {
      cacheDir: join(cacheDir, "alice"),
    });
    const bobDevice = makeDevice("bob");
    const bob = await startAgent(bobDevice, {
      cacheDir: join(cacheDir, "bob"),
    });
    await waitUntil(
      () =>
        alice.hostConnection().isOnline() && bob.hostConnection().isOnline(),
    );

    const winner = await alice.agentPort().acquireLock({
      session,
      scope: "src/contended.ts",
      scopeKind: "file",
    });
    expect(winner).toMatchObject({ ok: true, data: { granted: true } });

    const loser = await bob.agentPort().acquireLock({
      session,
      scope: "src/contended.ts",
      scopeKind: "file",
    });
    expect(loser).toEqual({
      ok: true,
      data: {
        eventRevision: 2,
        granted: false,
        concurrentClaim: true,
        winner: { memberId: "admin", eventRevision: 1 },
      },
    });

    // The losing claim remains available to the host for future promotion, but
    // neither client's cache is polluted with it as an active winner.
    await waitUntil(() =>
      bob.view
        .entries(session)
        .some(
          (entry) =>
            entry.entryType === "soft_lock" &&
            entry.path === "src/contended.ts" &&
            entry.member.memberId === "admin",
        ),
    );
    expect(
      bob.view
        .entries(session)
        .filter(
          (entry) =>
            entry.entryType === "soft_lock" &&
            entry.path === "src/contended.ts",
        ),
    ).toHaveLength(1);
  });
});

describe("Offline_State (Req 6.4, 33.1)", () => {
  it("refuses mutations with OFFLINE_QUEUED and serves a stale view while offline", async () => {
    const agent = await startAgent(admin, { autoReconnect: false });
    await waitUntil(() => agent.hostConnection().isOnline());

    agent.hostConnection().simulateDrop();
    await waitUntil(() => !agent.hostConnection().isOnline());

    expect(agent.view.isStale()).toBe(true);

    // A mutation while offline must be refused, never falsely accepted (Req 4.8).
    const mutation = await agent.agentPort().acquireLock({
      session,
      scope: "src/x.ts",
      scopeKind: "file",
    });
    expect(mutation.ok).toBe(false);
    if (!mutation.ok) {
      expect(mutation.error.code).toBe("OFFLINE_QUEUED");
    }

    // Queries still succeed (stale-marked) while offline (Req 33.1).
    const risk = agent.agentPort().getRiskMap({ session });
    expect(risk.ok).toBe(true);
    expect(agent.agentPort().getStaleness().stale).toBe(true);
  });

  it("stays stale when an online reconnect cannot complete synchronization", async () => {
    let initiallySynced = false;
    const agent = await startAgent(admin, {
      autoReconnect: true,
      onCreated: (created) => {
        created.on("synced", () => {
          initiallySynced = true;
        });
      },
    });
    await waitUntil(() => initiallySynced);

    const connection = agent.hostConnection();
    connection.requestSync = async () => {
      throw new Error("test sync failure");
    };
    let syncFailed = false;
    agent.on("sync-failed", () => {
      syncFailed = true;
    });
    connection.simulateDrop();

    await waitUntil(() => syncFailed, 6000);
    expect(connection.isOnline()).toBe(true);
    expect(agent.view.isStale()).toBe(true);
    expect(agent.agentPort().getStaleness().stale).toBe(true);
  });

  it("rejects absolute and escaping Local_API editor paths before host coordination", async () => {
    const agent = await startAgent(admin, { autoReconnect: false });
    await waitUntil(() => agent.hostConnection().isOnline());
    const internal = agent as unknown as {
      handleEditorEvent(event: unknown): void;
      flushOutbound(): void;
    };

    internal.handleEditorEvent({ kind: "file_opened", path: "../outside.ts" });
    internal.handleEditorEvent({
      kind: "file_opened",
      path: "/tmp/outside.ts",
    });
    internal.handleEditorEvent({
      kind: "file_opened",
      path: "C:\\outside.ts",
    });
    internal.handleEditorEvent({ kind: "file_opened", path: ".env.local" });
    internal.handleEditorEvent({
      kind: "file_opened",
      path: ".coordination/local-api.json",
    });
    internal.handleEditorEvent({
      kind: "file_opened",
      path: "certs/demo.pem",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(host.authority.snapshot(session).locks).toHaveLength(0);

    internal.handleEditorEvent({
      kind: "file_opened",
      path: "./src/inside.ts",
    });
    internal.flushOutbound();
    await waitUntil(() =>
      host.authority
        .snapshot(session)
        .presence.some(
          (entry) =>
            entry.path === "src/inside.ts" && entry.state === "editing",
        ),
    );
    // Passive opening remains a bounded presence signal; only an active editor
    // claims the long-lived coordination lock.
    expect(
      host.authority
        .snapshot(session)
        .locks.some((lock) => lock.scope === "src/inside.ts"),
    ).toBe(false);
  });

  it("treats background editing notifications as bounded activity", async () => {
    const agent = await startAgent(admin, {
      autoReconnect: false,
      watcherActivityTtlMs: 500,
    });
    await waitUntil(() => agent.hostConnection().isOnline());
    const internal = agent as unknown as {
      handleEditorEvent(event: unknown): void;
      flushOutbound(): void;
    };

    // VS Code can report a change for a background/programmatically edited
    // document. It is useful activity metadata but must not claim ownership.
    internal.handleEditorEvent({
      kind: "editing_started",
      path: "src/background.ts",
    });
    internal.flushOutbound();
    await waitUntil(() =>
      host.authority
        .snapshot(session)
        .presence.some(
          (entry) =>
            entry.path === "src/background.ts" && entry.state === "editing",
        ),
    );
    expect(
      host.authority
        .snapshot(session)
        .locks.some((lock) => lock.scope === "src/background.ts"),
    ).toBe(false);
    await waitUntil(
      () =>
        host.authority
          .snapshot(session)
          .presence.some(
            (entry) =>
              entry.path === "src/background.ts" && entry.state === "stopped",
          ),
      1_000,
    );
  });

  it("reconciles active-editor snapshots after missed local transitions", async () => {
    const agent = await startAgent(admin, { autoReconnect: false });
    await waitUntil(() => agent.hostConnection().isOnline());
    const internal = agent as unknown as {
      handleEditorEvent(event: unknown): void;
    };

    internal.handleEditorEvent({
      kind: "active_editor_changed",
      path: "src/before-reconnect.ts",
    });
    await waitUntil(() =>
      host.authority
        .snapshot(session)
        .locks.some((lock) => lock.scope === "src/before-reconnect.ts"),
    );

    // The extension does not replay each offline tab change. Its one current
    // snapshot replaces the old durable scope with the currently focused file.
    internal.handleEditorEvent({
      kind: "active_editor_changed",
      activeEditorSnapshot: true,
      path: "src/after-reconnect.ts",
    });
    await waitUntil(() => {
      const snapshot = host.authority.snapshot(session);
      return (
        !snapshot.locks.some(
          (lock) => lock.scope === "src/before-reconnect.ts",
        ) &&
        snapshot.locks.some((lock) => lock.scope === "src/after-reconnect.ts")
      );
    });

    // An oldPath-only snapshot represents a closed/deleted/moved-away editor.
    internal.handleEditorEvent({
      kind: "active_editor_changed",
      activeEditorSnapshot: true,
      oldPath: "src/after-reconnect.ts",
    });
    await waitUntil(
      () =>
        !host.authority
          .snapshot(session)
          .locks.some((lock) => lock.scope === "src/after-reconnect.ts"),
    );
  });

  it("retires a switched-away editor while retaining bounded saved-file activity", async () => {
    const agent = await startAgent(admin, {
      autoReconnect: false,
      watcherActivityTtlMs: 500,
    });
    await waitUntil(() => agent.hostConnection().isOnline());
    const internal = agent as unknown as {
      handleEditorEvent(event: unknown): void;
      onFileChange(event: { kind: "saved"; path: string }): void;
      flushOutbound(): void;
    };

    internal.handleEditorEvent({
      kind: "active_editor_changed",
      path: "src/first.ts",
    });
    await waitUntil(() =>
      host.authority
        .snapshot(session)
        .locks.some((lock) => lock.scope === "src/first.ts"),
    );

    internal.handleEditorEvent({
      kind: "active_editor_changed",
      oldPath: "src/first.ts",
      path: "src/second.ts",
    });
    await waitUntil(() => {
      const snapshot = host.authority.snapshot(session);
      return (
        !snapshot.locks.some((lock) => lock.scope === "src/first.ts") &&
        snapshot.locks.some((lock) => lock.scope === "src/second.ts") &&
        snapshot.presence.some(
          (entry) => entry.path === "src/first.ts" && entry.state === "stopped",
        ) &&
        snapshot.presence.some(
          (entry) =>
            entry.path === "src/second.ts" && entry.state === "editing",
        )
      );
    });

    // A persisted save after the switch still emits a short-lived watcher
    // signal, but the timer retires it rather than recreating a lock.
    internal.onFileChange({ kind: "saved", path: "src/first.ts" });
    internal.flushOutbound();
    await waitUntil(
      () =>
        host.authority
          .snapshot(session)
          .presence.some(
            (entry) =>
              entry.path === "src/first.ts" && entry.state === "editing",
          ),
      4000,
    );
    await waitUntil(
      () =>
        host.authority
          .snapshot(session)
          .presence.some(
            (entry) =>
              entry.path === "src/first.ts" && entry.state === "stopped",
          ),
      4000,
    );
    expect(
      host.authority
        .snapshot(session)
        .locks.some((lock) => lock.scope === "src/first.ts"),
    ).toBe(false);
  });

  it("moves active editor ownership on rename and retires it on deletion", async () => {
    const agent = await startAgent(admin, { autoReconnect: false });
    await waitUntil(() => agent.hostConnection().isOnline());
    const internal = agent as unknown as {
      handleEditorEvent(event: unknown): void;
    };

    internal.handleEditorEvent({
      kind: "active_editor_changed",
      path: "src/old-name.ts",
    });
    await waitUntil(() =>
      host.authority
        .snapshot(session)
        .locks.some((lock) => lock.scope === "src/old-name.ts"),
    );

    internal.handleEditorEvent({
      kind: "file_renamed",
      oldPath: "src/old-name.ts",
      path: "src/new-name.ts",
    });
    await waitUntil(() => {
      const snapshot = host.authority.snapshot(session);
      return (
        !snapshot.locks.some((lock) => lock.scope === "src/old-name.ts") &&
        snapshot.locks.some((lock) => lock.scope === "src/new-name.ts") &&
        snapshot.presence.some(
          (entry) =>
            entry.path === "src/old-name.ts" && entry.state === "stopped",
        ) &&
        snapshot.presence.some(
          (entry) =>
            entry.path === "src/new-name.ts" && entry.state === "editing",
        )
      );
    });

    internal.handleEditorEvent({
      kind: "file_deleted",
      path: "src/new-name.ts",
    });
    await waitUntil(() => {
      const snapshot = host.authority.snapshot(session);
      return (
        !snapshot.locks.some((lock) => lock.scope === "src/new-name.ts") &&
        snapshot.presence.some(
          (entry) =>
            entry.path === "src/new-name.ts" && entry.state === "stopped",
        )
      );
    });
  });

  it("ends watcher-confirmed editing after its bounded activity TTL", async () => {
    const agent = await startAgent(admin, {
      autoReconnect: false,
      watcherActivityTtlMs: 500,
    });
    await waitUntil(() => agent.hostConnection().isOnline());
    const internal = agent as unknown as {
      onFileChange(event: { kind: "saved"; path: string }): void;
      flushOutbound(): void;
    };

    internal.onFileChange({ kind: "saved", path: "src/idle.ts" });
    // Drive the normal coalescer immediately; the later TTL must send stopped.
    internal.flushOutbound();
    await waitUntil(
      () =>
        host.authority
          .snapshot(session)
          .presence.some(
            (entry) =>
              entry.path === "src/idle.ts" && entry.state === "editing",
          ),
      4000,
    );
    await waitUntil(
      () =>
        host.authority
          .snapshot(session)
          .presence.some(
            (entry) =>
              entry.path === "src/idle.ts" && entry.state === "stopped",
          ),
      4000,
    );
    await waitUntil(
      () =>
        !agent.view
          .entries(session)
          .some(
            (entry) =>
              entry.entryType === "presence" && entry.path === "src/idle.ts",
          ),
      1000,
    );

    // A new save after the stop is a new bounded activity window, not a
    // coalescer duplicate of the earlier editing report.
    internal.onFileChange({ kind: "saved", path: "src/idle.ts" });
    internal.flushOutbound();
    await waitUntil(
      () =>
        host.authority
          .snapshot(session)
          .presence.some(
            (entry) =>
              entry.path === "src/idle.ts" && entry.state === "editing",
          ),
      1000,
    );
  });

  it("does not revive editing when a watcher save is deleted before coalescing flushes", async () => {
    const agent = await startAgent(admin, { autoReconnect: false });
    await waitUntil(() => agent.hostConnection().isOnline());
    const internal = agent as unknown as {
      onFileChange(event: { kind: "saved" | "deleted"; path: string }): void;
      flushOutbound(): void;
    };

    internal.onFileChange({ kind: "saved", path: "src/gone-before-flush.ts" });
    internal.onFileChange({
      kind: "deleted",
      path: "src/gone-before-flush.ts",
    });
    // This represents the next coalescing window: stopped must replace the
    // buffered editing event, never revive it after the deletion.
    internal.flushOutbound();

    await waitUntil(
      () =>
        host.authority
          .snapshot(session)
          .presence.some(
            (entry) =>
              entry.path === "src/gone-before-flush.ts" &&
              entry.state === "stopped",
          ),
      1000,
    );
    expect(
      host.authority
        .snapshot(session)
        .presence.some(
          (entry) =>
            entry.path === "src/gone-before-flush.ts" &&
            entry.state === "editing",
        ),
    ).toBe(false);
  });
});

describe("reconnect sync-from-revision convergence (Req 9.4, 6.6)", () => {
  it("reconnects after a transient drop and converges the cached view", async () => {
    const agent = await startAgent(admin, { autoReconnect: true });
    await waitUntil(() => agent.hostConnection().isOnline());

    let onlineCount = 0;
    agent.hostConnection().on("online", () => {
      onlineCount += 1;
    });

    await agent
      .agentPort()
      .acquireLock({ session, scope: "src/api.ts", scopeKind: "file" });
    await waitUntil(() =>
      agent.view.entries(session).some((e) => e.path === "src/api.ts"),
    );

    // Transient network drop → the connection auto-reconnects with backoff.
    agent.hostConnection().simulateDrop();
    await waitUntil(() => onlineCount >= 1, 6000);

    // After reconnect the agent re-syncs and re-asserts its held lock; the
    // cached view converges to the authoritative host state and clears staleness.
    await waitUntil(() => !agent.view.isStale(), 6000);
    await waitUntil(
      () =>
        agent.view.highestApplied(session) ===
        host.authority.snapshot(session).highestRevision,
      6000,
    );

    expect(
      agent.view.entries(session).some((e) => e.path === "src/api.ts"),
    ).toBe(true);
    expect(
      host.authority.snapshot(session).locks.map((l) => l.scope),
    ).toContain("src/api.ts");
  });

  it("retains active task metadata and resumes the device replay counter after a clean service restart", async () => {
    const first = await startAgent(admin, { autoReconnect: false });
    await waitUntil(() => first.hostConnection().isOnline());

    const declared = await first.agentPort().declareIntent({
      session,
      modifyPaths: ["src/restart.ts"],
      createPaths: ["src/restart.test.ts"],
      description: "Keep restart coordination visible",
    });
    expect(declared.ok).toBe(true);
    await waitUntil(() =>
      first.view
        .teamActivity(session)
        .some((member) =>
          member.tasks.some(
            (task) => task.description === "Keep restart coordination visible",
          ),
        ),
    );
    const cachedRevision = first.view.highestApplied(session);

    // A normal service stop writes the encrypted snapshot and device counter.
    await first.stop();
    agents = agents.filter((agent) => agent !== first);

    // Advance the host while the service is down. The restarted agent must ask
    // for this suffix, rather than being forced through a snapshot fallback.
    const peer = makeDevice("peer");
    const peerAgent = await startAgent(peer, {
      autoReconnect: false,
      cacheDir: join(cacheDir, "peer-device"),
    });
    await waitUntil(() => peerAgent.hostConnection().isOnline());
    const peerLock = await peerAgent.agentPort().acquireLock({
      session,
      scope: "src/peer.ts",
      scopeKind: "file",
    });
    expect(peerLock.ok).toBe(true);
    await waitUntil(
      () => host.authority.snapshot(session).highestRevision > cachedRevision,
    );

    const syncKinds: string[] = [];
    const restarted = await startAgent(admin, {
      autoReconnect: false,
      onCreated: (agent) => {
        agent.on("synced", (kind: string) => syncKinds.push(kind));
      },
    });
    await waitUntil(() => syncKinds.includes("events"));

    // The unchanged intent was reconstructed from the encrypted snapshot before
    // the incremental suffix arrived, retaining its description and path roles
    // for the team panel/MCP status view.
    const status = restarted.agentPort().getTeamStatus({ session });
    expect(status.ok).toBe(true);
    if (status.ok) {
      const own = status.data.members.find(
        (member) => member.memberId === admin.memberId,
      );
      expect(own?.tasks).toContainEqual({
        intentId: declared.ok ? declared.data.intentId : expect.any(String),
        description: "Keep restart coordination visible",
        modifyPaths: ["src/restart.ts"],
        createPaths: ["src/restart.test.ts"],
      });
    }

    // `sync.request` itself consumes a counter. A succeeding later mutation
    // proves the restarted process advanced beyond the host's persisted
    // per-device replay counter instead of replaying from zero.
    const resumedLock = await restarted.agentPort().acquireLock({
      session,
      scope: "src/resumed.ts",
      scopeKind: "file",
    });
    expect(resumedLock.ok).toBe(true);
    await waitUntil(() =>
      host.authority
        .snapshot(session)
        .locks.some((lock) => lock.scope === "src/resumed.ts"),
    );
  });
});
