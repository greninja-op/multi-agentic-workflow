/**
 * Local multi-agent simulation — scenario 11: the end-to-end V2 collaboration
 * flow (Phases 1–5) across the real host + in-process agents over WSS.
 *
 * One human/agent (agent-0) messages a teammate (agent-1), assigns them a task,
 * the teammate approves it and reports progress, agent-0 asks Luna for a
 * plain-language summary, and — with the opt-in Live_Diff feature enabled — shares
 * a change diff the teammate then sees read-only. This proves the messaging,
 * task-approval, Luna-orchestration, and live-diff verticals interoperate over
 * the real transport, exactly as a two-person team would use them.
 */

import { afterEach, describe, expect, it } from "vitest";

import type { AgentResult, MaybePromise } from "@cfls/mcp-server";

import { Simulation } from "./harness";

let sim: Simulation | undefined;

afterEach(async () => {
  await sim?.stop();
  sim = undefined;
});

async function ok<T>(result: MaybePromise<AgentResult<T>>): Promise<T> {
  const resolved = await result;
  if (!resolved.ok) {
    throw new Error(`${resolved.error.code}: ${resolved.error.message}`);
  }
  return resolved.data;
}

/** Poll an async predicate until it holds or the timeout elapses. */
async function pollUntil(
  predicate: () => Promise<boolean>,
  label: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}.`);
}

describe("Scenario 11 — end-to-end V2 collaboration (messages → task → approval → Luna → live diff)", () => {
  it("drives the full collaboration flow across two teammates over real WSS", async () => {
    // Two teammates are enough for the flow; enable the opt-in Live_Diff feature.
    sim = await Simulation.start({ agentCount: 2, liveDiffs: true });
    const session = sim.session;
    const alicePort = sim.agentAt(0).agent.agentPort();
    const bobPort = sim.agentAt(1).agent.agentPort();
    const alice = sim.agentAt(0).member.memberId; // "agent-0"
    const bob = sim.agentAt(1).member.memberId; // "agent-1"

    // 1) Phase 1 — Alice sends Bob a direct message; Bob's view converges on it.
    await ok(
      alicePort.sendMessage({
        session,
        kind: "direct",
        toMemberId: bob,
        body: "starting on the auth refactor, heads up",
      }),
    );
    await pollUntil(async () => {
      const list = await ok(bobPort.listMessages({ session }));
      return list.messages.some((m) => m.sender.memberId === alice);
    }, "Bob receives Alice's message");

    // 2) Phase 2 — Alice assigns Bob a task; it arrives as a proposal for approval.
    const assigned = await ok(
      alicePort.assignTask({
        session,
        title: "Add logout endpoint",
        description: "Wire POST /logout to clear the session",
        assigneeMemberId: bob,
      }),
    );
    await pollUntil(async () => {
      const tasks = await ok(bobPort.listTasks({ session }));
      return tasks.incomingProposals.some((t) => t.taskId === assigned.taskId);
    }, "Bob sees the incoming task proposal");

    // 3) Phase 2 — Bob approves it, then reports progress; it enters his task list.
    await ok(bobPort.respondTask({ taskId: assigned.taskId, accept: true }));
    await ok(
      bobPort.updateTaskProgress({ taskId: assigned.taskId, status: "in_progress" }),
    );
    await pollUntil(async () => {
      const tasks = await ok(bobPort.listTasks({ session }));
      return tasks.myTaskList.some(
        (t) => t.taskId === assigned.taskId && t.status === "in_progress",
      );
    }, "the approved task is in Bob's accepted list, in progress");

    // 4) Phase 4 — Alice asks Luna for a plain-language team summary (rules brain).
    const reply = await ok(
      alicePort.askLuna({ session, action: "summarize", prompt: "status" }),
    );
    expect(reply.action).toBe("summarize");
    expect(reply.summary.length).toBeGreaterThan(0);

    // 5) Phase 5 — Alice shares a change diff (opt-in); Bob sees it read-only.
    await ok(
      alicePort.shareDiff({
        session,
        path: "src/auth.ts",
        patch: "@@ -1 +1 @@\n-legacy\n+refactored",
      }),
    );
    await pollUntil(async () => {
      const listed = await ok(bobPort.listDiffs({ session }));
      return listed.diffs.some(
        (d) => d.path === "src/auth.ts" && d.member.memberId === alice,
      );
    }, "Bob sees Alice's shared live diff");

    // Sanity: Alice's own unread count excludes her own message (Req 1.4).
    const aliceInbox = await ok(alicePort.listMessages({ session }));
    expect(aliceInbox.unreadCount).toBe(0);
  });
});
