/**
 * Unit tests for authoritative-state snapshot serialize/deserialize and
 * revision-counter restore (Req 1.5, 1.6, 9.5, 35.1; design §5.2, §4.6).
 *
 * Covers: projecting live registries into a snapshot, a round-trip that
 * reproduces winning/concurrent claims regardless of order, replace semantics on
 * restore, resuming the revision counter above the max persisted revision (and
 * above any entity revision that trails `highestRevision`), and snapshot
 * independence from live state.
 *
 * The universal round-trip property is covered separately by the fast-check
 * property test in task 4.17 (Property 7).
 */

import { describe, expect, it } from "vitest";

import type {
  DeclaredIntent,
  Lock,
  MemberRef,
  Presence,
  SessionId,
} from "@cfls/protocol";

import { DiffRegistry } from "./diffs";
import { IntentRegistry } from "./intents";
import { LockRegistry } from "./locks";
import { MessageRegistry } from "./messaging";
import { PresenceRegistry } from "./presence";
import { RevisionCounter } from "./revisions";
import { TaskRegistry } from "./tasks";
import {
  restoreSessionState,
  type SessionRegistries,
  serializeSessionState,
} from "./snapshot";

const session: SessionId = {
  repoId: "github.com/acme/app",
  teamId: "team-1",
  branch: "main",
  baseRevision: "abc123",
};

const alice: MemberRef = { memberId: "u-alice", deviceId: "dev-a" };
const bob: MemberRef = { memberId: "u-bob", deviceId: "dev-b" };

function fresh(): SessionRegistries {
  return {
    locks: new LockRegistry(),
    intents: new IntentRegistry(),
    presence: new PresenceRegistry(),
    revisions: new RevisionCounter(),
  };
}

/** Seed a registry set with a lock, an intent, and presence + advance revisions. */
function seed(regs: SessionRegistries): void {
  // Assign revisions through the counter so `highest` reflects reality.
  const r1 = regs.revisions.next(session); // 1
  regs.locks.acquire({
    session,
    lockId: "lk-1",
    scope: "src/api.ts",
    scopeKind: "file",
    mode: "soft",
    holder: alice,
    branch: "main",
    eventRevision: r1,
    acquiredAt: "2024-01-01T00:00:00Z",
  });

  const r2 = regs.revisions.next(session); // 2
  regs.intents.declare({
    session,
    intentId: "int-1",
    owner: bob,
    agentId: "agent-x",
    modifyPaths: ["src/db.ts"],
    createPaths: ["src/new.ts"],
    scopeKind: "file",
    branch: "main",
    description: "refactor",
    eventRevision: r2,
  });

  const r3 = regs.revisions.next(session); // 3
  regs.presence.report({
    session,
    member: alice,
    path: "src/api.ts",
    state: "editing",
    eventRevision: r3,
  });
}

describe("serializeSessionState (Req 1.5, 9.5, 35.1)", () => {
  it("captures locks, intents, presence, and the highest revision", () => {
    const regs = fresh();
    seed(regs);

    const snapshot = serializeSessionState(session, regs);

    expect(snapshot.session).toEqual(session);
    expect(snapshot.locks).toHaveLength(1);
    expect(snapshot.locks[0]?.lockId).toBe("lk-1");
    expect(snapshot.intents).toHaveLength(1);
    expect(snapshot.intents[0]?.intentId).toBe("int-1");
    expect(snapshot.presence).toHaveLength(1);
    expect(snapshot.presence[0]?.state).toBe("editing");
    expect(snapshot.highestRevision).toBe(3);
  });

  it("produces a snapshot independent of live state (deep copy)", () => {
    const regs = fresh();
    seed(regs);

    const snapshot = serializeSessionState(session, regs);
    // Mutating the snapshot must not corrupt the registries.
    snapshot.locks[0]!.holder.memberId = "tampered";
    snapshot.intents[0]!.modifyPaths.push("src/evil.ts");

    const again = serializeSessionState(session, regs);
    expect(again.locks[0]?.holder.memberId).toBe("u-alice");
    expect(again.intents[0]?.modifyPaths).toEqual(["src/db.ts"]);
  });

  it("captures an empty snapshot for an unknown session", () => {
    const regs = fresh();
    const snapshot = serializeSessionState(session, regs);
    expect(snapshot.locks).toEqual([]);
    expect(snapshot.intents).toEqual([]);
    expect(snapshot.presence).toEqual([]);
    expect(snapshot.highestRevision).toBe(0);
  });
});

describe("restoreSessionState round-trip (Req 1.5, 9.5)", () => {
  it("reproduces locks, intents, and presence in a fresh registry set", () => {
    const source = fresh();
    seed(source);
    const snapshot = serializeSessionState(session, source);

    const target = fresh();
    restoreSessionState(snapshot, target);

    expect(target.locks.allLocks(session)).toHaveLength(1);
    expect(
      target.locks.winningLock(session, "src/api.ts", "file", "main")?.holder
        .memberId,
    ).toBe("u-alice");
    expect(target.intents.allIntents(session)).toHaveLength(1);
    expect(target.presence.all(session)[0]?.state).toBe("editing");
  });

  it("re-serializes to an equal snapshot (idempotent round-trip)", () => {
    const source = fresh();
    seed(source);
    const snapshot = serializeSessionState(session, source);

    const target = fresh();
    restoreSessionState(snapshot, target);
    const reserialized = serializeSessionState(session, target);

    expect(reserialized).toEqual(snapshot);
  });

  it("replaces existing session state wholesale (Req 9.5)", () => {
    const target = fresh();
    // Pre-existing, unrelated state that must be discarded on restore.
    target.locks.acquire({
      session,
      lockId: "stale",
      scope: "src/old.ts",
      scopeKind: "file",
      mode: "soft",
      holder: bob,
      branch: "main",
      eventRevision: 1,
      acquiredAt: "2024-01-01T00:00:00Z",
    });

    const source = fresh();
    seed(source);
    const snapshot = serializeSessionState(session, source);

    restoreSessionState(snapshot, target);

    const locks = target.locks.allLocks(session);
    expect(locks).toHaveLength(1);
    expect(locks[0]?.lockId).toBe("lk-1");
  });
});

describe("restore recomputes winners independent of order (Req 8.2)", () => {
  it("selects the earliest-revision lock as winner regardless of snapshot order", () => {
    const base = "2024-01-01T00:00:00Z";
    const winner: Lock = {
      lockId: "lk-early",
      scope: "src/api.ts",
      scopeKind: "file",
      mode: "soft",
      holder: alice,
      branch: "main",
      eventRevision: 5,
      acquiredAt: base,
      concurrent: true, // deliberately wrong; restore must recompute
    };
    const loser: Lock = {
      lockId: "lk-late",
      scope: "src/api.ts",
      scopeKind: "file",
      mode: "soft",
      holder: bob,
      branch: "main",
      eventRevision: 9,
      acquiredAt: base,
      concurrent: false, // deliberately wrong
    };

    const regs = fresh();
    // Provide the later-revision claim first to prove order-independence.
    restoreSessionState(
      {
        session,
        locks: [loser, winner],
        presence: [],
        intents: [],
        highestRevision: 9,
      },
      regs,
    );

    const won = regs.locks.winningLock(session, "src/api.ts", "file", "main");
    expect(won?.lockId).toBe("lk-early");
    expect(won?.holder.memberId).toBe("u-alice");
  });

  it("recomputes Planned_File_Creation winners from revisions", () => {
    const intentEarly: DeclaredIntent = {
      intentId: "int-early",
      owner: alice,
      agentId: "agent-a",
      modifyPaths: [],
      createPaths: [{ path: "src/new.ts" }],
      scopeKind: "file",
      branch: "main",
      description: "a",
      eventRevision: 4,
    };
    const intentLate: DeclaredIntent = {
      intentId: "int-late",
      owner: bob,
      agentId: "agent-b",
      modifyPaths: [],
      createPaths: [{ path: "src/new.ts" }],
      scopeKind: "file",
      branch: "main",
      description: "b",
      eventRevision: 8,
    };

    const regs = fresh();
    restoreSessionState(
      {
        session,
        locks: [],
        presence: [],
        intents: [intentLate, intentEarly],
        highestRevision: 8,
      },
      regs,
    );

    const winner = regs.intents.creationWinner(session, "src/new.ts", "main");
    expect(winner?.intentId).toBe("int-early");
  });
});

describe("revision-counter restore (Req 1.6)", () => {
  it("resumes above the snapshot highestRevision", () => {
    const regs = fresh();
    restoreSessionState(
      { session, locks: [], presence: [], intents: [], highestRevision: 42 },
      regs,
    );
    expect(regs.revisions.highest(session)).toBe(42);
    expect(regs.revisions.next(session)).toBe(43);
  });

  it("resumes above the max entity revision when it exceeds highestRevision", () => {
    const lock: Lock = {
      lockId: "lk-1",
      scope: "src/api.ts",
      scopeKind: "file",
      mode: "soft",
      holder: alice,
      branch: "main",
      eventRevision: 100,
      acquiredAt: "2024-01-01T00:00:00Z",
      concurrent: false,
    };
    const presence: Presence = {
      member: bob,
      path: "src/db.ts",
      state: "editing",
      eventRevision: 250,
    };

    const regs = fresh();
    // highestRevision deliberately trails the presence revision.
    restoreSessionState(
      {
        session,
        locks: [lock],
        presence: [presence],
        intents: [],
        highestRevision: 10,
      },
      regs,
    );

    expect(regs.revisions.next(session)).toBe(251);
  });

  it("never rewinds a counter that is already ahead of the snapshot", () => {
    const regs = fresh();
    regs.revisions.resume(session, 500);

    restoreSessionState(
      { session, locks: [], presence: [], intents: [], highestRevision: 10 },
      regs,
    );

    expect(regs.revisions.highest(session)).toBe(500);
    expect(regs.revisions.next(session)).toBe(501);
  });

  it("guarantees no restored revision collides after a simulated restart", () => {
    const source = fresh();
    seed(source);
    const snapshot = serializeSessionState(session, source);

    const restarted = fresh();
    restoreSessionState(snapshot, restarted);

    const nextRevision = restarted.revisions.next(session);
    const persistedMax = Math.max(
      snapshot.highestRevision,
      ...snapshot.locks.map((l) => l.eventRevision),
      ...snapshot.intents.map((i) => i.eventRevision),
      ...snapshot.presence.map((p) => p.eventRevision),
    );
    expect(nextRevision).toBeGreaterThan(persistedMax);
  });
});

// ---------------------------------------------------------------------------
// V2 Phase 1 — messaging in the snapshot (Req 1.4, X.2)
// ---------------------------------------------------------------------------

describe("snapshot — V2 messaging round-trip", () => {
  it("captures and restores messages, resuming the counter above their revision", () => {
    const source: SessionRegistries = { ...fresh(), messages: new MessageRegistry() };
    const rev = source.revisions.next(session); // 1
    source.messages!.append({
      session,
      messageId: "m-1",
      kind: "direct",
      sender: alice,
      toMemberId: "u-bob",
      priority: "urgent",
      body: "check payments.ts",
      eventRevision: rev,
      sentAt: "2024-01-01T00:00:00Z",
    });

    const snapshot = serializeSessionState(session, source);
    expect(snapshot.messages?.map((m) => m.messageId)).toEqual(["m-1"]);

    const target: SessionRegistries = { ...fresh(), messages: new MessageRegistry() };
    restoreSessionState(snapshot, target);

    expect(target.messages!.allMessages(session).map((m) => m.messageId)).toEqual(["m-1"]);
    // bob still sees it as unread after restore.
    expect(target.messages!.unreadCountFor(session, "u-bob")).toBe(1);
    // the counter resumed above the message revision.
    expect(target.revisions.next(session)).toBeGreaterThan(rev);
  });

  it("omits the messages field entirely when no message registry is provided (V1 back-compat)", () => {
    const snapshot = serializeSessionState(session, fresh());
    expect(snapshot.messages).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// V2 Phase 2 — tasks in the snapshot (Req 2.1, X.2)
// ---------------------------------------------------------------------------

describe("snapshot — V2 tasks round-trip", () => {
  it("captures and restores tasks, resuming the counter above their revision", () => {
    const source: SessionRegistries = { ...fresh(), tasks: new TaskRegistry() };
    const rev = source.revisions.next(session); // 1
    source.tasks!.assign({
      session,
      taskId: "t-1",
      title: "Add logout",
      description: "…",
      assignee: bob,
      assigner: alice,
      eventRevision: rev,
    });
    source.tasks!.respond({
      session,
      taskId: "t-1",
      requester: bob,
      accept: true,
      eventRevision: source.revisions.next(session),
    });

    const snapshot = serializeSessionState(session, source);
    expect(snapshot.tasks?.map((t) => t.taskId)).toEqual(["t-1"]);

    const target: SessionRegistries = { ...fresh(), tasks: new TaskRegistry() };
    restoreSessionState(snapshot, target);
    expect(target.tasks!.taskListFor(session, "u-bob").map((t) => t.status)).toEqual([
      "accepted",
    ]);
    expect(target.revisions.next(session)).toBeGreaterThan(rev);
  });

  it("omits the tasks field when no task registry is provided (V1 back-compat)", () => {
    const snapshot = serializeSessionState(session, fresh());
    expect(snapshot.tasks).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// V2 Phase 5 — live diffs in the snapshot (Req 5.1–5.3, X.2)
// ---------------------------------------------------------------------------

describe("snapshot — V2 live-diffs round-trip", () => {
  it("captures and restores shared diffs, resuming the counter above their revision", () => {
    const source: SessionRegistries = { ...fresh(), diffs: new DiffRegistry() };
    const rev = source.revisions.next(session); // 1
    source.diffs!.share(session, {
      path: "src/api.ts",
      member: alice,
      patch: "@@ -1 +1 @@\n-old\n+new",
      eventRevision: rev,
    });

    const snapshot = serializeSessionState(session, source);
    expect(snapshot.diffs?.map((d) => d.path)).toEqual(["src/api.ts"]);

    const target: SessionRegistries = { ...fresh(), diffs: new DiffRegistry() };
    restoreSessionState(snapshot, target);
    expect(target.diffs!.get(session, "u-alice", "src/api.ts")?.patch).toContain("+new");
    expect(target.revisions.next(session)).toBeGreaterThan(rev);
  });

  it("omits the diffs field when no diff registry is provided (opt-in off)", () => {
    const snapshot = serializeSessionState(session, fresh());
    expect(snapshot.diffs).toBeUndefined();
  });
});
