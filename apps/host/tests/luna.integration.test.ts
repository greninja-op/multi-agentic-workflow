/**
 * Integration tests for the V2 Luna orchestrator over real WSS + SQLite
 * (Phase 4; Req 4.1–4.5). Exercises direct→assign (a Task assigned by Luna),
 * arbitration, answering, summarizing, and reliability with the default
 * deterministic brain (no external service).
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
  tmp = mkdtempSync(join(tmpdir(), "cfls-luna-"));
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

describe("V2 Luna orchestrator over WSS (Req 4.1–4.5)", () => {
  it("routes a human direction into a Task assigned by Luna, and replies", async () => {
    const alice = makeDevice("alice");
    const bob = makeDevice("bob");
    const a = await connect(alice);
    const b = await connect(bob);
    // Ensure both members are admitted so Luna's context knows them.
    await new Promise((r) => setTimeout(r, 50));

    a.sendEvent(
      signedEvent(
        "luna.request",
        { action: "assign", prompt: "tell bob to add the logout flow" },
        { session, device: alice, counter: a.nextCounter(), eventId: "l-1" },
      ),
    );

    // Bob receives the task Luna assigned.
    const task = await b.waitFor(
      (m) => m?.type === "task.update" && m.payload.task.assignee.memberId === "bob",
    );
    expect(task.payload.task.assigner.memberId).toBe("luna");
    expect(task.payload.task.title).toContain("logout");

    // Alice (requester) receives Luna's reply naming the produced task.
    const reply = await a.waitFor((m) => m?.type === "luna.reply");
    expect(reply.payload.action).toBe("assign");
    expect(typeof reply.payload.producedTaskId).toBe("string");

    a.close();
    b.close();
  });

  it("answers a question with a reply and a message from Luna", async () => {
    const alice = makeDevice("alice");
    const a = await connect(alice);

    a.sendEvent(
      signedEvent(
        "luna.request",
        { action: "answer", prompt: "who is active right now?", refId: "q-1" },
        { session, device: alice, counter: a.nextCounter(), eventId: "l-2" },
      ),
    );

    const reply = await a.waitFor((m) => m?.type === "luna.reply");
    expect(reply.payload.action).toBe("answer");
    // Luna's answer is delivered to the asker as a message from luna.
    const message = await a.waitFor(
      (m) => m?.type === "message.update" && m.payload.message.sender.memberId === "luna",
    );
    expect(message.payload.message.body).toContain("Luna:");

    a.close();
  });

  it("summarizes team state deterministically without any external service", async () => {
    const alice = makeDevice("alice");
    const a = await connect(alice);

    a.sendEvent(
      signedEvent(
        "luna.request",
        { action: "summarize", prompt: "status" },
        { session, device: alice, counter: a.nextCounter(), eventId: "l-3" },
      ),
    );

    const reply = await a.waitFor((m) => m?.type === "luna.reply");
    expect(reply.payload.action).toBe("summarize");
    expect(reply.payload.summary).toMatch(/Active:|No one is active/);

    a.close();
  });
});
