/**
 * Unit tests for the Luna orchestrator brains (V2 Phase 4; Req 4.1–4.4).
 */

import { describe, it, expect } from "vitest";
import type { MemberRef, SessionId, TaskDto } from "@cfls/protocol";

import { LlmLunaBrain, RulesLunaBrain, type LunaContext } from "./orchestrator";

const session: SessionId = {
  repoId: "github.com/acme/webapp",
  teamId: "team-1",
  branch: "main",
  baseRevision: null,
};

const alice: MemberRef = { memberId: "alice", deviceId: "d-a" };

function ctx(partial: Partial<LunaContext> = {}): LunaContext {
  return {
    session,
    requester: alice,
    members: ["alice", "bob", "carol"],
    liveness: [
      { memberId: "alice", state: "active" },
      { memberId: "bob", state: "active" },
      { memberId: "carol", state: "idle" },
    ],
    tasks: [],
    ...partial,
  };
}

describe("RulesLunaBrain — assign (Req 4.2)", () => {
  it("assigns to an explicitly named member", () => {
    const brain = new RulesLunaBrain();
    const d = brain.decide(
      { action: "assign", prompt: "tell carol to add the logout flow" },
      ctx(),
    );
    expect(d.assignment?.assigneeMemberId).toBe("carol");
    expect(d.assignment?.title).toContain("logout");
  });

  it("never assigns to the requester and prefers the least-busy active member", () => {
    const brain = new RulesLunaBrain();
    const tasks: TaskDto[] = [
      { taskId: "t1", title: "x", description: "", assignee: { memberId: "bob", deviceId: "" }, assigner: alice, status: "in_progress", eventRevision: 1 },
    ];
    const d = brain.decide(
      { action: "assign", prompt: "build the payments page" },
      ctx({ tasks }),
    );
    // bob is busy (1 active task), carol is idle but has 0 tasks; active bob has 1.
    // ranking: active(bob rank0,load1) vs idle(carol rank1,load0) → bob rank lower → bob.
    // But requester alice excluded. So candidate set {bob, carol}. bob active(0) load1; carol idle(1) load0.
    // state rank dominates: bob(0) < carol(1) → bob. So bob chosen despite load.
    expect(d.assignment?.assigneeMemberId).toBe("bob");
  });

  it("reports when no assignee is available", () => {
    const brain = new RulesLunaBrain();
    const d = brain.decide(
      { action: "assign", prompt: "do something" },
      ctx({ members: ["alice"] }),
    );
    expect(d.assignment).toBeUndefined();
    expect(d.summary).toMatch(/no suitable/i);
  });
});

describe("RulesLunaBrain — arbitrate/answer/summarize (Req 4.3, 4.4)", () => {
  it("arbitrate states the deterministic earliest-revision rule", () => {
    const brain = new RulesLunaBrain();
    const d = brain.decide(
      { action: "arbitrate", prompt: "who wins src/api.ts?", refId: "src/api.ts" },
      ctx(),
    );
    expect(d.action).toBe("arbitrate");
    expect(d.summary).toContain("src/api.ts");
    expect(d.summary).toMatch(/earliest/i);
    expect(d.message?.body).toBe(d.summary);
  });

  it("answer replies to the asker with a state-based summary", () => {
    const brain = new RulesLunaBrain();
    const d = brain.decide(
      { action: "answer", prompt: "who is active?", refId: "q-1" },
      ctx(),
    );
    expect(d.message?.toMemberId).toBe("alice");
    expect(d.summary).toMatch(/Active:/);
  });

  it("summarize produces a plain-language team summary", () => {
    const brain = new RulesLunaBrain();
    const d = brain.decide({ action: "summarize", prompt: "status" }, ctx());
    expect(d.action).toBe("summarize");
    expect(d.summary).toMatch(/Active: alice, bob/);
    expect(d.summary).toMatch(/Idle: carol/);
  });
});

describe("LlmLunaBrain (Req 4.1.3, 4.1.4)", () => {
  it("delegates structure to rules and enriches the summary text", async () => {
    const brain = new LlmLunaBrain(async () => "Assigning the logout work to Carol.");
    const d = await brain.decide(
      { action: "assign", prompt: "tell carol to add logout" },
      ctx(),
    );
    // Structural decision (assignee) still comes from the rules.
    expect(d.assignment?.assigneeMemberId).toBe("carol");
    expect(d.summary).toBe("Assigning the logout work to Carol.");
  });

  it("falls back to the deterministic decision if the LLM call fails", async () => {
    const brain = new LlmLunaBrain(async () => {
      throw new Error("no network");
    });
    const d = await brain.decide(
      { action: "summarize", prompt: "status" },
      ctx(),
    );
    expect(d.summary).toMatch(/Active:/);
  });
});
