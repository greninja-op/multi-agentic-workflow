/**
 * Integration tests for the V2 messaging channel over real WSS + SQLite
 * (Phase 1; Req 1.1–1.4, X.2). Exercises directed delivery, broadcast delivery,
 * audience isolation, question→answer, and offline reconnect delivery of a
 * message sent while the recipient was disconnected.
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

/** Connect + authenticate a device, returning the ready client. */
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
  tmp = mkdtempSync(join(tmpdir(), "cfls-msg-"));
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

describe("V2 messaging over WSS (Req 1.1–1.4)", () => {
  it("delivers a directed message to the recipient but not to a third party", async () => {
    const alice = makeDevice("alice");
    const bob = makeDevice("bob");
    const carol = makeDevice("carol");
    const a = await connect(alice);
    const b = await connect(bob);
    const c = await connect(carol);

    a.sendEvent(
      signedEvent(
        "message.send",
        { kind: "direct", toMemberId: "bob", priority: "urgent", body: "check payments.ts" },
        { session, device: alice, counter: a.nextCounter(), eventId: "m-1" },
      ),
    );

    const received = await b.waitForType("message.update");
    expect(received.payload.message.body).toBe("check payments.ts");
    expect(received.payload.message.sender.memberId).toBe("alice");
    expect(received.payload.message.priority).toBe("urgent");

    // Carol is not in the audience and must not receive it.
    await expect(c.waitForType("message.update", 400)).rejects.toThrow();

    a.close();
    b.close();
    c.close();
  });

  it("delivers a broadcast to everyone in the session", async () => {
    const alice = makeDevice("alice");
    const bob = makeDevice("bob");
    const a = await connect(alice);
    const b = await connect(bob);

    a.sendEvent(
      signedEvent(
        "message.send",
        { kind: "broadcast", body: "standup in 5" },
        { session, device: alice, counter: a.nextCounter(), eventId: "m-2" },
      ),
    );

    const received = await b.waitForType("message.update");
    expect(received.payload.message.kind).toBe("broadcast");
    expect(received.payload.message.body).toBe("standup in 5");

    a.close();
    b.close();
  });

  it("marks a question answered when a correlated answer is sent", async () => {
    const alice = makeDevice("alice");
    const bob = makeDevice("bob");
    const a = await connect(alice);
    const b = await connect(bob);

    a.sendEvent(
      signedEvent(
        "message.send",
        { kind: "question", toMemberId: "bob", body: "which branch is prod?", correlationId: "c-1" },
        { session, device: alice, counter: a.nextCounter(), eventId: "q-1" },
      ),
    );
    await b.waitFor((m) => m?.type === "message.update" && m.payload.message.messageId === "q-1");

    b.sendEvent(
      signedEvent(
        "message.send",
        { kind: "answer", toMemberId: "alice", body: "main", correlationId: "c-1" },
        { session, device: bob, counter: b.nextCounter(), eventId: "a-1" },
      ),
    );

    // Alice sees the answer AND the question flipped to answered.
    const answered = await a.waitFor(
      (m) =>
        m?.type === "message.update" &&
        m.payload.op === "updated" &&
        m.payload.message.messageId === "q-1",
    );
    expect(answered.payload.message.answered).toBe(true);

    a.close();
    b.close();
  });

  it("delivers a message sent while the recipient was offline, on reconnect sync (Req X.2)", async () => {
    const alice = makeDevice("alice");
    const bob = makeDevice("bob");
    const a = await connect(alice);

    // Bob connects, records the current revision, then disconnects.
    const b1 = await connect(bob);
    const bobFromRevision = b1.highestRevision;
    b1.close();
    await new Promise((r) => setTimeout(r, 100));

    // Alice sends Bob a directed message while Bob is offline.
    a.sendEvent(
      signedEvent(
        "message.send",
        { kind: "direct", toMemberId: "bob", body: "offline note" },
        { session, device: alice, counter: a.nextCounter(), eventId: "m-off" },
      ),
    );
    // Give the host time to persist it.
    await new Promise((r) => setTimeout(r, 150));

    // Bob reconnects and syncs from where he left off.
    const b2 = await connect(bob);
    b2.sendEvent(
      signedEvent(
        "sync.request",
        { fromRevision: bobFromRevision },
        { session, device: bob, counter: b2.nextCounter(), eventId: "sync-1" },
      ),
    );

    const delivered = await b2.waitFor(
      (m) => m?.type === "message.update" && m.payload.message.messageId === "m-off",
    );
    expect(delivered.payload.message.body).toBe("offline note");

    a.close();
    b2.close();
  });
});
