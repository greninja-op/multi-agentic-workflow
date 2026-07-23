/**
 * Integration tests for opt-in V2 Live_Diffs over real WSS + SQLite
 * (Phase 5; Req 5.1–5.5). Exercises the two behaviors that matter for parity:
 *
 *  - DISABLED (default): a `diff.share` is rejected and nothing is broadcast —
 *    the host behaves exactly as V1 (metadata only) (Req 5.4).
 *  - ENABLED (team opt-in): a `diff.share` is accepted, broadcast to the trusted
 *    session, an empty patch removes it, and a reconnecting member is resent the
 *    currently-shared diffs (Req 5.1–5.3, X.2).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startHost, type RunningHost } from "../src/index";
import {
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

async function connect(device: TestDevice): Promise<TestClient> {
  const client = await TestClient.open(url());
  const result = await client.handshake(
    session,
    device,
    invitationFor(session, admin.key, device),
  );
  expect(result).toEqual({ ok: true });
  return client;
}

async function startWith(liveDiffsEnabled: boolean): Promise<void> {
  host = await startHost(
    { hostUrl: "wss://127.0.0.1:0", tls: { devSelfSigned: true }, dbPath },
    { expirySweepIntervalMs: 0, liveDiffsEnabled },
  );
  host.authority.registerSession(session, [admin.key.publicKey]);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cfls-diffs-"));
  dbPath = join(tmp, "host.db");
  admin = makeDevice("admin");
});

afterEach(async () => {
  await host.stop();
  rmSync(tmp, { recursive: true, force: true });
});

describe("V2 live diffs over WSS — DISABLED (V1 parity; Req 5.4)", () => {
  it("rejects diff.share and broadcasts nothing when the opt-in is off", async () => {
    await startWith(false);
    const alice = makeDevice("alice");
    const bob = makeDevice("bob");
    const a = await connect(alice);
    const b = await connect(bob);

    a.sendEvent(
      signedEvent(
        "diff.share",
        { path: "src/api.ts", patch: "@@ -1 +1 @@\n-old\n+new" },
        { session, device: alice, counter: a.nextCounter(), eventId: "d-1" },
      ),
    );

    // Alice gets a correlated rejection; the host stays V1 (metadata only).
    const err = await a.waitFor(
      (m) => m?.type === "error" && m.payload.refEventId === "d-1",
    );
    expect(err.payload.code).toBe("AUTH_NOT_AUTHORIZED");

    // Bob must never receive a diff.update.
    await expect(b.waitForType("diff.update", 400)).rejects.toThrow();

    a.close();
    b.close();
  });
});

describe("V2 live diffs over WSS — ENABLED (opt-in; Req 5.1–5.3, X.2)", () => {
  it("broadcasts a shared diff to the trusted session and removes it on empty patch", async () => {
    await startWith(true);
    const alice = makeDevice("alice");
    const bob = makeDevice("bob");
    const a = await connect(alice);
    const b = await connect(bob);

    a.sendEvent(
      signedEvent(
        "diff.share",
        { path: "src/api.ts", patch: "@@ -1 +1 @@\n-old\n+new" },
        { session, device: alice, counter: a.nextCounter(), eventId: "d-1" },
      ),
    );

    const shared = await b.waitFor(
      (m) => m?.type === "diff.update" && m.payload.op === "shared",
    );
    expect(shared.payload.diff.path).toBe("src/api.ts");
    expect(shared.payload.diff.member.memberId).toBe("alice");
    expect(shared.payload.diff.patch).toContain("+new");

    // An empty patch clears it (Req 5.2, 5.3).
    a.sendEvent(
      signedEvent(
        "diff.share",
        { path: "src/api.ts", patch: "" },
        { session, device: alice, counter: a.nextCounter(), eventId: "d-2" },
      ),
    );
    const removed = await b.waitFor(
      (m) => m?.type === "diff.update" && m.payload.op === "removed",
    );
    expect(removed.payload.diff.path).toBe("src/api.ts");

    a.close();
    b.close();
  });

  it("resends a currently-shared diff to a member on reconnect sync (Req X.2)", async () => {
    await startWith(true);
    const alice = makeDevice("alice");
    const bob = makeDevice("bob");
    const a = await connect(alice);

    a.sendEvent(
      signedEvent(
        "diff.share",
        { path: "src/db.ts", patch: "@@ -2 +2 @@\n-a\n+b" },
        { session, device: alice, counter: a.nextCounter(), eventId: "d-3" },
      ),
    );
    // Give the host time to persist the shared diff.
    await new Promise((r) => setTimeout(r, 80));

    // Bob connects late and syncs from revision 0; the host resends the diff.
    const b = await connect(bob);
    b.sendEvent(
      signedEvent(
        "sync.request",
        { fromRevision: 0 },
        { session, device: bob, counter: b.nextCounter(), eventId: "sync-1" },
      ),
    );
    const shared = await b.waitFor(
      (m) => m?.type === "diff.update" && m.payload.diff.path === "src/db.ts",
    );
    expect(shared.payload.diff.patch).toContain("+b");

    a.close();
    b.close();
  });
});
