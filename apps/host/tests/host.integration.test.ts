/**
 * Integration tests for the host over a real WSS + SQLite (task 8.9; Req 1.1,
 * 1.5, 1.6, 5.4, 7.4, 8.1, 9.3). Exercises the handshake, ingest→broadcast,
 * sync convergence, restart recovery, and revoked/absent-device rejection over
 * an actual TLS WebSocket connection and a file-backed SQLite store.
 */

import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { get, request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  startHost,
  type HostConfigInput,
  type RunningHost,
} from "../src/index";
import {
  deviceIdOf,
  invitationFor,
  makeDevice,
  makeSession,
  signedEvent,
  TestClient,
  type TestDevice,
} from "./support";

const session = makeSession();

let tmp: string;
let dbPath: string;
let host: RunningHost;
let admin: TestDevice;

function url(): string {
  return `wss://127.0.0.1:${host.port}`;
}

async function startFreshHost(
  overrides: HostConfigInput = {},
): Promise<RunningHost> {
  return startHost(
    {
      hostUrl: "wss://127.0.0.1:0",
      tls: { devSelfSigned: true },
      dbPath,
      ...overrides,
    },
    { expirySweepIntervalMs: 0 },
  );
}

interface HttpResponse {
  statusCode: number | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

function getHttp(path: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const request = get(
      {
        hostname: "127.0.0.1",
        port: host.port,
        path,
        rejectUnauthorized: false,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.once("end", () => {
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body,
          });
        });
      },
    );
    request.once("error", reject);
  });
}

function postHttp(
  path: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const outbound = request(
      {
        hostname: "127.0.0.1",
        port: host.port,
        path,
        method: "POST",
        rejectUnauthorized: false,
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
          ...headers,
        },
      },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          responseBody += chunk;
        });
        response.once("end", () => {
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body: responseBody,
          });
        });
      },
    );
    outbound.once("error", reject);
    outbound.end(body);
  });
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cfls-host-"));
  dbPath = join(tmp, "host.db");
  admin = makeDevice("admin");
  host = await startFreshHost();
  host.authority.registerSession(session, [admin.key.publicKey]);
});

afterEach(async () => {
  await host.stop();
  rmSync(tmp, { recursive: true, force: true });
});

describe("authentication handshake (Req 5.3, 5.4)", () => {
  it("admits an admin device presenting a self-issued invitation", async () => {
    const client = await TestClient.open(url());
    const result = await client.handshake(
      session,
      admin,
      invitationFor(session, admin.key, admin),
    );
    expect(result).toEqual({ ok: true });
    expect(client.highestRevision).toBe(0);
    client.close();
  });

  it("admits a second device invited by the admin", async () => {
    const bob = makeDevice("bob");
    const client = await TestClient.open(url());
    const result = await client.handshake(
      session,
      bob,
      invitationFor(session, admin.key, bob),
    );
    expect(result).toEqual({ ok: true });
    client.close();
  });

  it("rejects a device whose invitation is not signed by an admin (absent device)", async () => {
    const impostorAdmin = makeDevice("not-admin");
    const bob = makeDevice("bob");
    const client = await TestClient.open(url());
    // Invitation signed by a non-admin issuer.
    const result = await client.handshake(
      session,
      bob,
      invitationFor(session, impostorAdmin.key, bob),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("AUTH_ISSUER_NOT_ADMIN");
    client.close();
  });

  it("rejects a revoked device (Req 5.6)", async () => {
    const bob = makeDevice("bob");
    // First admit bob so a membership entry exists, then revoke it.
    const first = await TestClient.open(url());
    expect(
      (
        await first.handshake(
          session,
          bob,
          invitationFor(session, admin.key, bob),
        )
      ).ok,
    ).toBe(true);
    first.close();

    host.authority.revoke(session, bob.key.publicKey);

    const second = await TestClient.open(url());
    const result = await second.handshake(
      session,
      bob,
      invitationFor(session, admin.key, bob),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("AUTH_INVALID_DEVICE");
    second.close();
  });
});

describe("dashboard HTTP", () => {
  it("serves a live metadata-only page and API by default", async () => {
    expect(host.config.dashboard).toBe(true);
    const root = await getHttp("/");
    const page = await getHttp("/dashboard");
    expect(root.statusCode).toBe(200);
    expect(String(root.headers["content-type"])).toMatch(/^text\/html/);
    expect(root.headers["cache-control"]).toBe("no-store");
    expect(page.statusCode).toBe(200);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.body).toContain("CFLS Coordination Dashboard");

    const client = await TestClient.open(url());
    expect(
      (
        await client.handshake(
          session,
          admin,
          invitationFor(session, admin.key, admin),
        )
      ).ok,
    ).toBe(true);

    const initial = await getHttp("/api/coordination");
    expect(initial.statusCode).toBe(200);
    expect(String(initial.headers["content-type"])).toMatch(
      /^application\/json/,
    );
    const initialState = JSON.parse(initial.body) as {
      sessions: Array<{
        repoId: string;
        branch: string;
        connectedDevices: string[];
      }>;
    };
    const initialSession = initialState.sessions.find(
      (entry) =>
        entry.repoId === session.repoId && entry.branch === session.branch,
    );
    expect(initialSession?.connectedDevices).toContain(deviceIdOf(admin));

    client.sendEvent(
      signedEvent(
        "lock.acquire",
        { scope: "src/dashboard-live.ts", scopeKind: "file", mode: "soft" },
        {
          session,
          device: admin,
          counter: client.nextCounter(),
          eventId: "evt-dashboard-live-lock",
        },
      ),
    );
    await client.waitFor(
      (message) =>
        message?.type === "coordination.update" &&
        message.payload.path === "src/dashboard-live.ts",
    );

    const live = await getHttp("/api/coordination");
    const liveState = JSON.parse(live.body) as {
      sessions: Array<{
        repoId: string;
        branch: string;
        locks: Array<{
          path: string;
          holder: string;
          mode: string;
          eventRevision: number;
        }>;
      }>;
    };
    const liveSession = liveState.sessions.find(
      (entry) =>
        entry.repoId === session.repoId && entry.branch === session.branch,
    );
    expect(liveSession?.locks).toContainEqual({
      path: "src/dashboard-live.ts",
      holder: "admin",
      mode: "soft",
      eventRevision: 1,
    });
    client.close();
  });

  it("returns 404 for dashboard routes when disabled without affecting health endpoints", async () => {
    await host.stop();
    host = await startFreshHost({ dashboard: false });
    expect(host.config.dashboard).toBe(false);

    for (const path of ["/", "/dashboard", "/api/coordination"]) {
      expect((await getHttp(path)).statusCode).toBe(404);
    }

    const health = await getHttp("/health");
    const diagnostics = await getHttp("/diagnostics");
    expect(health.statusCode).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({ status: "ok" });
    expect(diagnostics.statusCode).toBe(200);
    expect(JSON.parse(diagnostics.body)).toMatchObject({ status: "ok" });
  });
});

describe("demo short-code pairing", () => {
  it("mints ordinary device-bound invitations and consumes each join code once", async () => {
    await host.stop();
    host = await startFreshHost({
      demoPairing: {
        session,
        issuerPublicKey: admin.key.publicKey,
        issuerPrivateKey: admin.key.privateKey,
      },
    });
    host.authority.registerSession(session, [admin.key.publicKey]);
    const workspaceSession = makeSession({
      repoId: "github.com/acme/idea",
      branch: "demo-work",
      baseRevision: "workspace-revision",
    });

    const first = makeDevice("alice");
    const issued = await postHttp("/demo-pair/host", {
      devicePublicKey: first.key.publicKey,
      memberId: first.memberId,
      session: workspaceSession,
    });
    expect(issued.statusCode).toBe(201);
    const hosted = JSON.parse(issued.body) as {
      code: string;
      invitation: unknown;
    };
    expect(hosted.code).toMatch(/^\d{8}$/u);
    expect(
      (hosted.invitation as { claims: { session: SessionId } }).claims.session,
    ).toEqual(workspaceSession);

    const second = makeDevice("bob");
    const joined = await postHttp("/demo-pair/join", {
      code: hosted.code,
      devicePublicKey: second.key.publicKey,
      memberId: second.memberId,
    });
    expect(joined.statusCode).toBe(201);
    const joinedInvitation = Buffer.from(
      JSON.stringify(
        (JSON.parse(joined.body) as { invitation: unknown }).invitation,
      ),
      "utf8",
    ).toString("base64");
    const client = await TestClient.open(url());
    expect(
      await client.handshake(workspaceSession, second, joinedInvitation),
    ).toEqual({ ok: true });
    client.close();

    const replay = await postHttp("/demo-pair/join", {
      code: hosted.code,
      devicePublicKey: makeDevice("mallory").key.publicKey,
      memberId: "mallory",
    });
    expect(replay.statusCode).toBe(404);
  });
});

describe("hosted read-only MCP", () => {
  const mcpToken = "cfls-hosted-mcp-test-token-0123456789";
  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "cfls-host-test", version: "1.0.0" },
    },
  };

  async function startMcpHost(): Promise<void> {
    await host.stop();
    host = await startFreshHost({
      remoteMcp: {
        token: mcpToken,
        session,
        publicHostUrl: "wss://sync.example.test",
      },
    });
    host.authority.registerSession(session, [admin.key.publicKey]);
  }

  it("requires a bearer token before MCP initialization", async () => {
    await startMcpHost();
    const response = await postHttp("/mcp", initialize);
    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toContain("Bearer");
    expect(JSON.parse(response.body)).toEqual({ error: "unauthorized" });
  });

  it("serves only the scoped metadata session over a stateful MCP handshake", async () => {
    await startMcpHost();
    const initialized = await postHttp("/mcp", initialize, {
      authorization: `Bearer ${mcpToken}`,
      accept: "application/json, text/event-stream",
    });
    expect(initialized.statusCode).toBe(200);
    const mcpSessionId = initialized.headers["mcp-session-id"];
    expect(typeof mcpSessionId).toBe("string");

    const response = await postHttp(
      "/mcp",
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "get_project_session_status",
          arguments: {},
        },
      },
      {
        authorization: `Bearer ${mcpToken}`,
        accept: "application/json, text/event-stream",
        "mcp-session-id": String(mcpSessionId),
      },
    );
    expect(response.statusCode).toBe(200);
    const wire = JSON.parse(response.body) as {
      result: { content: Array<{ text: string }> };
    };
    const result = JSON.parse(wire.result.content[0]!.text) as {
      ok: boolean;
      data: { session: typeof session };
      connection: { hostUrl: string };
    };
    expect(result).toMatchObject({
      ok: true,
      data: { session },
      connection: { hostUrl: "wss://sync.example.test" },
    });
  });
});

describe("ingest → broadcast (Req 7, 8.1, 25)", () => {
  it("broadcasts an accepted lock to every device in the session with a revision", async () => {
    const alice = admin;
    const bob = makeDevice("bob");

    const a = await TestClient.open(url());
    expect(
      (
        await a.handshake(
          session,
          alice,
          invitationFor(session, admin.key, alice),
        )
      ).ok,
    ).toBe(true);
    const b = await TestClient.open(url());
    expect(
      (await b.handshake(session, bob, invitationFor(session, admin.key, bob)))
        .ok,
    ).toBe(true);

    a.sendEvent(
      signedEvent(
        "lock.acquire",
        { scope: "src/api.ts", scopeKind: "file", mode: "soft" },
        {
          session,
          device: alice,
          counter: a.nextCounter(),
          eventId: "evt-lock-1",
        },
      ),
    );

    const update = await b.waitFor(
      (m) =>
        m?.type === "coordination.update" &&
        m.payload.entryType === "soft_lock",
    );
    expect(update.payload.op).toBe("added");
    expect(update.payload.path).toBe("src/api.ts");
    expect(update.payload.member.memberId).toBe("admin");
    expect(update.payload.eventRevision).toBe(1);

    a.close();
    b.close();
  });

  it("directly acknowledges each mutation by Event_ID, including a losing lock claim", async () => {
    const bob = makeDevice("bob");
    const a = await TestClient.open(url());
    const b = await TestClient.open(url());
    await a.handshake(session, admin, invitationFor(session, admin.key, admin));
    await b.handshake(session, bob, invitationFor(session, admin.key, bob));

    a.sendEvent(
      signedEvent(
        "lock.acquire",
        { scope: "src/ack.ts", scopeKind: "file", mode: "soft" },
        {
          session,
          device: admin,
          counter: a.nextCounter(),
          eventId: "evt-ack-winner",
        },
      ),
    );
    const winningAck = await a.waitFor(
      (m) =>
        m?.type === "event.applied" && m.payload?.eventId === "evt-ack-winner",
    );
    expect(winningAck.payload).toMatchObject({
      eventId: "evt-ack-winner",
      eventRevision: 1,
    });
    expect(winningAck.payload.lockConflict).toBeUndefined();

    b.sendEvent(
      signedEvent(
        "lock.acquire",
        { scope: "src/ack.ts", scopeKind: "file", mode: "soft" },
        {
          session,
          device: bob,
          counter: b.nextCounter(),
          eventId: "evt-ack-loser",
        },
      ),
    );
    const losingAck = await b.waitFor(
      (m) =>
        m?.type === "event.applied" && m.payload?.eventId === "evt-ack-loser",
    );
    expect(losingAck.payload).toMatchObject({
      eventId: "evt-ack-loser",
      eventRevision: 2,
      lockConflict: {
        scope: "src/ack.ts",
        winner: { memberId: "admin", eventRevision: 1 },
      },
    });

    b.sendEvent(
      signedEvent(
        "lock.release",
        { scope: "src/missing.ts" },
        {
          session,
          device: bob,
          counter: b.nextCounter(),
          eventId: "evt-ack-error",
        },
      ),
    );
    const rejected = await b.waitFor(
      (m) => m?.type === "error" && m.payload?.refEventId === "evt-ack-error",
    );
    expect(rejected.payload).toMatchObject({
      code: "NO_ACTIVE_LOCK",
      refEventId: "evt-ack-error",
    });

    a.close();
    b.close();
  });

  it("returns a correlated STORAGE_ERROR rather than a false acknowledgement when persistence fails", async () => {
    const client = await TestClient.open(url());
    await client.handshake(
      session,
      admin,
      invitationFor(session, admin.key, admin),
    );
    const commit = vi
      .spyOn(host.store, "commitMutation")
      .mockImplementationOnce(() => {
        throw new Error("injected storage failure");
      });

    client.sendEvent(
      signedEvent(
        "lock.acquire",
        { scope: "src/durable.ts", scopeKind: "file", mode: "soft" },
        {
          session,
          device: admin,
          counter: client.nextCounter(),
          eventId: "evt-storage-failure",
        },
      ),
    );

    const error = await client.waitFor(
      (m) =>
        m?.type === "error" && m.payload?.refEventId === "evt-storage-failure",
    );
    expect(error.payload).toMatchObject({
      code: "STORAGE_ERROR",
      refEventId: "evt-storage-failure",
    });
    expect(host.authority.snapshot(session).locks).toEqual([]);
    expect(host.store.hasAppliedEventId(session, "evt-storage-failure")).toBe(
      null,
    );

    commit.mockRestore();
    client.close();
  });

  it("keeps a retried domain rejection as an error instead of event.applied", async () => {
    const bob = makeDevice("bob");
    const aliceClient = await TestClient.open(url());
    const bobClient = await TestClient.open(url());
    await aliceClient.handshake(
      session,
      admin,
      invitationFor(session, admin.key, admin),
    );
    await bobClient.handshake(
      session,
      bob,
      invitationFor(session, admin.key, bob),
    );

    aliceClient.sendEvent(
      signedEvent(
        "lock.acquire",
        { scope: "src/rejected-wire.ts", scopeKind: "file", mode: "soft" },
        {
          session,
          device: admin,
          counter: aliceClient.nextCounter(),
          eventId: "evt-wire-owner",
        },
      ),
    );
    await aliceClient.waitFor(
      (m) =>
        m?.type === "event.applied" && m.payload?.eventId === "evt-wire-owner",
    );

    const rejectedEvent = signedEvent(
      "lock.release",
      { scope: "src/rejected-wire.ts" },
      {
        session,
        device: bob,
        counter: bobClient.nextCounter(),
        eventId: "evt-wire-rejected",
      },
    );
    bobClient.sendEvent(rejectedEvent);
    const firstError = await bobClient.waitFor(
      (m) =>
        m?.type === "error" &&
        m.payload?.refEventId === "evt-wire-rejected" &&
        m.payload?.code === "NOT_LOCK_HOLDER",
    );
    expect(firstError.payload.code).toBe("NOT_LOCK_HOLDER");

    // Simulate a retry after the original error was lost in transit. The same
    // signed event must not receive a synthetic event.applied acknowledgement.
    bobClient.sendEvent(rejectedEvent);
    const retryError = await bobClient.waitFor(
      (m) =>
        m?.type === "error" &&
        m.payload?.refEventId === "evt-wire-rejected" &&
        m.payload?.code === "FORMAT_ERROR",
    );
    expect(retryError.payload.code).toBe("FORMAT_ERROR");

    aliceClient.close();
    bobClient.close();
  });

  it("returns an idempotent result for a duplicate Event_ID (Req 7.4)", async () => {
    const alice = admin;
    const a = await TestClient.open(url());
    await a.handshake(session, alice, invitationFor(session, admin.key, alice));

    const event = signedEvent(
      "lock.acquire",
      { scope: "src/dup.ts", scopeKind: "file", mode: "soft" },
      { session, device: alice, counter: a.nextCounter(), eventId: "evt-dup" },
    );
    a.sendEvent(event);
    await a.waitFor((m) => m?.type === "coordination.update");
    // Re-send the exact same signed event; it must not produce a second lock.
    a.sendEvent(event);
    // Give the host a moment; then assert the authoritative state has one lock.
    await new Promise((r) => setTimeout(r, 100));
    const snap = host.authority.snapshot(session);
    expect(snap.locks.filter((l) => l.scope === "src/dup.ts")).toHaveLength(1);
    a.close();
  });
});

describe("sync-from-revision (Req 9.3)", () => {
  it("serves incremental events after a known revision", async () => {
    const alice = admin;
    const a = await TestClient.open(url());
    await a.handshake(session, alice, invitationFor(session, admin.key, alice));

    a.sendEvent(
      signedEvent(
        "lock.acquire",
        { scope: "src/one.ts", scopeKind: "file", mode: "soft" },
        { session, device: alice, counter: a.nextCounter(), eventId: "evt-s1" },
      ),
    );
    await a.waitFor((m) => m?.type === "coordination.update");

    // Request sync from revision 0 — should receive the lock event.
    a.sendEvent(
      signedEvent(
        "sync.request",
        { fromRevision: 0 },
        {
          session,
          device: alice,
          counter: a.nextCounter(),
          eventId: "evt-sync",
        },
      ),
    );
    const sync = await a.waitFor(
      (m) => m?.type === "sync.events" || m?.type === "sync.snapshot",
    );
    if (sync.type === "sync.events") {
      const paths = sync.payload.events.map((e: { path?: string }) => e.path);
      expect(paths).toContain("src/one.ts");
    } else {
      expect(
        sync.payload.state.locks.map((l: { scope: string }) => l.scope),
      ).toContain("src/one.ts");
    }
    a.close();
  });
});

describe("authentication liveness baseline (Req 26)", () => {
  it("expires work created before the first periodic heartbeat after a client stops", async () => {
    const client = await TestClient.open(url());
    await client.handshake(
      session,
      admin,
      invitationFor(session, admin.key, admin),
    );

    // Do not send heartbeat.ping: the successful handshake itself must have
    // established liveness for this newly declared work.
    client.sendEvent(
      signedEvent(
        "intent.declare",
        {
          modifyPaths: ["src/abrupt-stop.ts"],
          createPaths: [],
          description: "short-lived task",
        },
        {
          session,
          device: admin,
          counter: client.nextCounter(),
          eventId: "evt-before-first-heartbeat",
        },
      ),
    );
    await client.waitFor(
      (m) =>
        m?.type === "event.applied" &&
        m.payload?.eventId === "evt-before-first-heartbeat",
    );
    client.close();

    const removals = host.authority.sweepExpiry(session, Date.now() + 60_000);
    expect(removals).toContainEqual(
      expect.objectContaining({
        entryType: "intent",
        op: "removed",
        path: "src/abrupt-stop.ts",
      }),
    );
    expect(host.authority.snapshot(session).intents).toHaveLength(0);
  });
});

describe("restart recovery (Req 1.5, 1.6)", () => {
  it("restores authoritative locks and resumes the revision counter", async () => {
    const alice = admin;
    const a = await TestClient.open(url());
    await a.handshake(session, alice, invitationFor(session, admin.key, alice));
    a.sendEvent(
      signedEvent(
        "lock.acquire",
        { scope: "src/persist.ts", scopeKind: "file", mode: "soft" },
        {
          session,
          device: alice,
          counter: a.nextCounter(),
          eventId: "evt-persist",
        },
      ),
    );
    await a.waitFor((m) => m?.type === "coordination.update");
    a.close();

    const revisionBefore = host.authority.snapshot(session).highestRevision;
    expect(revisionBefore).toBeGreaterThanOrEqual(1);

    // Restart the host against the same database file.
    await host.stop();
    host = await startFreshHost();

    const restored = host.authority.snapshot(session);
    expect(restored.locks.map((l) => l.scope)).toContain("src/persist.ts");
    // The revision counter resumes strictly above the persisted highest.
    host.authority.registerSession(session, [admin.key.publicKey]);
    const reconnect = await TestClient.open(url());
    const result = await reconnect.handshake(
      session,
      alice,
      invitationFor(session, admin.key, alice),
    );
    expect(result.ok).toBe(true);
    expect(reconnect.highestRevision).toBeGreaterThanOrEqual(revisionBefore);
    reconnect.close();
  });
});
