/**
 * Integration tests for the V2 task channel over real WSS + SQLite
 * (Phase 2; Req 2.1–2.3, X.2). Exercises assign→broadcast, assignee-only
 * approval, progress, and offline reconnect delivery of task changes.
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
  tmp = mkdtempSync(join(tmpdir(), "cfls-task-"));
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

describe("V2 tasks over WSS (Req 2.1–2.3)", () => {
  it("assigns a proposed task and broadcasts it to the whole team", async () => {
    const alice = makeDevice("alice");
    const bob = makeDevice("bob");
    const a = await connect(alice);
    const b = await connect(bob);

    a.sendEvent(
      signedEvent(
        "task.assign",
        { title: "Add logout", description: "wire /logout", assigneeMemberId: "bob" },
        { session, device: alice, counter: a.nextCounter(), eventId: "t-1" },
      ),
    );

    const received = await b.waitFor(
      (m) => m?.type === "task.update" && m.payload.task.taskId === "t-1",
    );
    expect(received.payload.op).toBe("added");
    expect(received.payload.task.status).toBe("proposed");
    expect(received.payload.task.assignee.memberId).toBe("bob");
    expect(received.payload.task.assigner.memberId).toBe("alice");

    a.close();
    b.close();
  });

  it("lets only the assignee accept an incoming task", async () => {
    const alice = makeDevice("alice");
    const bob = makeDevice("bob");
    const a = await connect(alice);
    const b = await connect(bob);

    a.sendEvent(
      signedEvent(
        "task.assign",
        { title: "T", description: "d", assigneeMemberId: "bob" },
        { session, device: alice, counter: a.nextCounter(), eventId: "t-1" },
      ),
    );
    await b.waitFor((m) => m?.type === "task.update");

    // Alice (assigner, not assignee) cannot accept — expect a correlated error.
    a.sendEvent(
      signedEvent(
        "task.respond",
        { taskId: "t-1", accept: true },
        { session, device: alice, counter: a.nextCounter(), eventId: "r-bad" },
      ),
    );
    const err = await a.waitFor(
      (m) => m?.type === "error" && m.payload.refEventId === "r-bad",
    );
    expect(err.payload.code).toBe("AUTH_NOT_AUTHORIZED");

    // Bob (assignee) accepts.
    b.sendEvent(
      signedEvent(
        "task.respond",
        { taskId: "t-1", accept: true },
        { session, device: bob, counter: b.nextCounter(), eventId: "r-ok" },
      ),
    );
    const accepted = await b.waitFor(
      (m) =>
        m?.type === "task.update" &&
        m.payload.task.taskId === "t-1" &&
        m.payload.task.status === "accepted",
    );
    expect(accepted.payload.task.status).toBe("accepted");

    a.close();
    b.close();
  });

  it("delivers a task change made while a member was offline, on reconnect", async () => {
    const alice = makeDevice("alice");
    const bob = makeDevice("bob");
    const a = await connect(alice);

    const b1 = await connect(bob);
    const bobFromRevision = b1.highestRevision;
    b1.close();
    await new Promise((r) => setTimeout(r, 100));

    a.sendEvent(
      signedEvent(
        "task.assign",
        { title: "Offline task", description: "d", assigneeMemberId: "bob" },
        { session, device: alice, counter: a.nextCounter(), eventId: "t-off" },
      ),
    );
    await new Promise((r) => setTimeout(r, 150));

    const b2 = await connect(bob);
    b2.sendEvent(
      signedEvent(
        "sync.request",
        { fromRevision: bobFromRevision },
        { session, device: bob, counter: b2.nextCounter(), eventId: "sync-1" },
      ),
    );
    const delivered = await b2.waitFor(
      (m) => m?.type === "task.update" && m.payload.task.taskId === "t-off",
    );
    expect(delivered.payload.task.title).toBe("Offline task");

    a.close();
    b2.close();
  });
});
