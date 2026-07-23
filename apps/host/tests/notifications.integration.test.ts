/**
 * Integration tests for V2 notifications, liveness & wake over real WSS + SQLite
 * (Phase 3; Req 3.1–3.3). Exercises task/urgent-message/wake notifications
 * delivered to the target member, and liveness.update broadcasts on connect and
 * disconnect.
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

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cfls-notif-"));
  dbPath = join(tmp, "host.db");
  admin = makeDevice("admin");
  host = await startHost(
    { hostUrl: "wss://127.0.0.1:0", tls: { devSelfSigned: true }, dbPath },
    { expirySweepIntervalMs: 0 },
  );
  host.authority.registerSession(session, [admin.key.publicKey]);
});

afterEach(async () => {
  await host.stop();
  rmSync(tmp, { recursive: true, force: true });
});

describe("V2 notifications & wake over WSS (Req 3.2, 3.3)", () => {
  it("notifies the assignee of an incoming task (severity warn)", async () => {
    const alice = makeDevice("alice");
    const bob = makeDevice("bob");
    const a = await connect(alice);
    const b = await connect(bob);

    a.sendEvent(
      signedEvent(
        "task.assign",
        { title: "Add logout", description: "d", assigneeMemberId: "bob" },
        { session, device: alice, counter: a.nextCounter(), eventId: "t-1" },
      ),
    );

    const notif = await b.waitFor((m) => m?.type === "notify.push");
    expect(notif.payload.source).toBe("task");
    expect(notif.payload.severity).toBe("warn");
    expect(notif.payload.toMemberId).toBe("bob");

    a.close();
    b.close();
  });

  it("notifies the recipient of an urgent direct message (severity urgent)", async () => {
    const alice = makeDevice("alice");
    const bob = makeDevice("bob");
    const a = await connect(alice);
    const b = await connect(bob);

    a.sendEvent(
      signedEvent(
        "message.send",
        { kind: "direct", toMemberId: "bob", priority: "urgent", body: "prod is down" },
        { session, device: alice, counter: a.nextCounter(), eventId: "m-1" },
      ),
    );

    const notif = await b.waitFor((m) => m?.type === "notify.push");
    expect(notif.payload.source).toBe("message");
    expect(notif.payload.severity).toBe("urgent");

    a.close();
    b.close();
  });

  it("delivers a wake request as an urgent notification to the target (Req 3.3)", async () => {
    const alice = makeDevice("alice");
    const bob = makeDevice("bob");
    const a = await connect(alice);
    const b = await connect(bob);

    a.sendEvent(
      signedEvent(
        "wake.request",
        { targetMemberId: "bob", reason: "PR is blocked on you" },
        { session, device: alice, counter: a.nextCounter(), eventId: "w-1" },
      ),
    );

    const notif = await b.waitFor((m) => m?.type === "notify.push");
    expect(notif.payload.source).toBe("wake");
    expect(notif.payload.severity).toBe("urgent");
    expect(notif.payload.summary).toContain("PR is blocked");

    a.close();
    b.close();
  });
});

describe("V2 liveness over WSS (Req 3.1)", () => {
  it("broadcasts a liveness.update when a member connects and when it disconnects", async () => {
    const alice = makeDevice("alice");
    const bob = makeDevice("bob");
    const a = await connect(alice);

    // Bob connects → Alice sees bob become live.
    const b = await connect(bob);
    const connected = await a.waitFor(
      (m) => m?.type === "liveness.update" && m.payload.memberId === "bob",
    );
    expect(["active", "idle"]).toContain(connected.payload.state);

    // Bob disconnects → Alice sees bob become gone.
    b.close();
    const gone = await a.waitFor(
      (m) =>
        m?.type === "liveness.update" &&
        m.payload.memberId === "bob" &&
        m.payload.state === "gone",
    );
    expect(gone.payload.state).toBe("gone");

    a.close();
  });
});
