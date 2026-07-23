/**
 * Unit tests for the {@link TaskRegistry} (V2 Phase 2; Req 2.1–2.3).
 */

import { describe, it, expect } from "vitest";
import type { MemberRef, SessionId } from "@cfls/protocol";

import { TaskRegistry } from "./tasks";

const session: SessionId = {
  repoId: "github.com/acme/webapp",
  teamId: "team-1",
  branch: "main",
  baseRevision: null,
};

const alice: MemberRef = { memberId: "alice", deviceId: "dev-a" }; // assigner
const bob: MemberRef = { memberId: "bob", deviceId: "dev-b" }; // assignee
const carol: MemberRef = { memberId: "carol", deviceId: "dev-c" };

function assigned(reg: TaskRegistry, rev = 1): void {
  reg.assign({
    session,
    taskId: "t-1",
    title: "Add logout",
    description: "…",
    assignee: bob,
    assigner: alice,
    eventRevision: rev,
  });
}

describe("TaskRegistry — assignment & approval (Req 2.1, 2.2)", () => {
  it("creates a proposed task that is an incoming approval, not yet in the list", () => {
    const reg = new TaskRegistry();
    assigned(reg);
    expect(reg.incomingProposalsFor(session, "bob").map((t) => t.taskId)).toEqual(["t-1"]);
    expect(reg.taskListFor(session, "bob")).toEqual([]);
  });

  it("lets only the assignee accept, moving it into the task list", () => {
    const reg = new TaskRegistry();
    assigned(reg);
    const notBob = reg.respond({ session, taskId: "t-1", requester: carol, accept: true, eventRevision: 2 });
    expect(notBob.ok).toBe(false);
    if (!notBob.ok) expect(notBob.code).toBe("AUTH_NOT_AUTHORIZED");

    const ok = reg.respond({ session, taskId: "t-1", requester: bob, accept: true, eventRevision: 3 });
    expect(ok.ok).toBe(true);
    expect(reg.taskListFor(session, "bob").map((t) => t.status)).toEqual(["accepted"]);
    expect(reg.incomingProposalsFor(session, "bob")).toEqual([]);
  });

  it("rejects an incoming task without adding it to the list", () => {
    const reg = new TaskRegistry();
    assigned(reg);
    const r = reg.respond({ session, taskId: "t-1", requester: bob, accept: false, eventRevision: 2 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.task.status).toBe("rejected");
    expect(reg.taskListFor(session, "bob")).toEqual([]);
  });

  it("cannot respond twice (proposed → accepted, then respond fails)", () => {
    const reg = new TaskRegistry();
    assigned(reg);
    reg.respond({ session, taskId: "t-1", requester: bob, accept: true, eventRevision: 2 });
    const again = reg.respond({ session, taskId: "t-1", requester: bob, accept: false, eventRevision: 3 });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe("FORMAT_ERROR");
  });
});

describe("TaskRegistry — progress (Req 2.3)", () => {
  it("advances accepted → in_progress → done (assignee only)", () => {
    const reg = new TaskRegistry();
    assigned(reg);
    reg.respond({ session, taskId: "t-1", requester: bob, accept: true, eventRevision: 2 });

    const notAssignee = reg.progress({ session, taskId: "t-1", requester: carol, status: "in_progress", eventRevision: 3 });
    expect(notAssignee.ok).toBe(false);

    expect(reg.progress({ session, taskId: "t-1", requester: bob, status: "in_progress", eventRevision: 4 }).ok).toBe(true);
    expect(reg.progress({ session, taskId: "t-1", requester: bob, status: "done", eventRevision: 5 }).ok).toBe(true);
    expect(reg.get(session, "t-1")?.status).toBe("done");
  });

  it("cannot progress a proposed task", () => {
    const reg = new TaskRegistry();
    assigned(reg);
    const r = reg.progress({ session, taskId: "t-1", requester: bob, status: "in_progress", eventRevision: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("FORMAT_ERROR");
  });
});

describe("TaskRegistry — withdraw (Req 2.2)", () => {
  it("lets the assigner withdraw a proposed task", () => {
    const reg = new TaskRegistry();
    assigned(reg);
    const r = reg.withdraw({ session, taskId: "t-1", requester: alice, eventRevision: 2 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.task.status).toBe("withdrawn");
  });

  it("lets the assignee withdraw an accepted task but not a stranger", () => {
    const reg = new TaskRegistry();
    assigned(reg);
    reg.respond({ session, taskId: "t-1", requester: bob, accept: true, eventRevision: 2 });
    const stranger = reg.withdraw({ session, taskId: "t-1", requester: carol, eventRevision: 3 });
    expect(stranger.ok).toBe(false);
    if (!stranger.ok) expect(stranger.code).toBe("AUTH_NOT_AUTHORIZED");
    expect(reg.withdraw({ session, taskId: "t-1", requester: bob, eventRevision: 4 }).ok).toBe(true);
  });

  it("cannot withdraw a done task", () => {
    const reg = new TaskRegistry();
    assigned(reg);
    reg.respond({ session, taskId: "t-1", requester: bob, accept: true, eventRevision: 2 });
    reg.progress({ session, taskId: "t-1", requester: bob, status: "done", eventRevision: 3 });
    const r = reg.withdraw({ session, taskId: "t-1", requester: alice, eventRevision: 4 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("FORMAT_ERROR");
  });
});

describe("TaskRegistry — restore & unknown", () => {
  it("returns NOT_FOUND for an unknown task", () => {
    const reg = new TaskRegistry();
    const r = reg.respond({ session, taskId: "missing", requester: bob, accept: true, eventRevision: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("NOT_FOUND");
  });

  it("restores a persisted task set", () => {
    const reg = new TaskRegistry();
    reg.restore(session, [
      { taskId: "t-9", title: "x", description: "y", assignee: bob, assigner: alice, status: "in_progress", eventRevision: 7 },
    ]);
    expect(reg.taskListFor(session, "bob").map((t) => t.taskId)).toEqual(["t-9"]);
  });
});
