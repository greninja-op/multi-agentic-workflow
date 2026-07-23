/**
 * Unit tests for the {@link LivenessTracker} and notification severity
 * (V2 Phase 3; Req 3.1–3.3).
 */

import { describe, it, expect } from "vitest";
import type { SessionId } from "@cfls/protocol";

import {
  LivenessTracker,
  buildNotification,
  notificationSeverity,
} from "./liveness";

const session: SessionId = {
  repoId: "github.com/acme/webapp",
  teamId: "team-1",
  branch: "main",
  baseRevision: null,
};

describe("LivenessTracker — active/idle/gone (Req 3.1)", () => {
  it("reports gone for a member with no live connection", () => {
    const t = new LivenessTracker(60_000);
    t.recordActivity(session, "bob", 1000);
    // bob acted but is not in the connected roster → gone.
    expect(t.stateOf(session, "bob", 1000)).toBe("gone");
  });

  it("reports active within the window and idle beyond it", () => {
    const t = new LivenessTracker(60_000);
    t.setConnected(session, ["bob"]);
    t.recordActivity(session, "bob", 10_000);
    expect(t.stateOf(session, "bob", 20_000)).toBe("active"); // 10s later
    expect(t.stateOf(session, "bob", 90_000)).toBe("idle"); // 80s later
  });

  it("reports idle for a connected member that has never acted", () => {
    const t = new LivenessTracker(60_000);
    t.setConnected(session, ["carol"]);
    expect(t.stateOf(session, "carol", 5000)).toBe("idle");
  });

  it("lists all known members' states sorted by id", () => {
    const t = new LivenessTracker(60_000);
    t.setConnected(session, ["alice", "bob"]);
    t.recordActivity(session, "alice", 1000);
    const states = t.states(session, 2000);
    expect(states).toEqual([
      { memberId: "alice", state: "active" },
      { memberId: "bob", state: "idle" },
    ]);
  });

  it("does not rewind activity for an out-of-order timestamp", () => {
    const t = new LivenessTracker(60_000);
    t.setConnected(session, ["bob"]);
    t.recordActivity(session, "bob", 50_000);
    t.recordActivity(session, "bob", 10_000); // stale, ignored
    expect(t.stateOf(session, "bob", 100_000)).toBe("active"); // 50s since 50k
  });
});

describe("notification severity (Req 3.2)", () => {
  it("maps sources to severities", () => {
    expect(notificationSeverity("wake")).toBe("urgent");
    expect(notificationSeverity("conflict")).toBe("urgent");
    expect(notificationSeverity("question")).toBe("warn");
    expect(notificationSeverity("task")).toBe("warn");
    expect(notificationSeverity("message", "urgent")).toBe("urgent");
    expect(notificationSeverity("message", "normal")).toBe("info");
    expect(notificationSeverity("message")).toBe("info");
  });

  it("builds a notification with the derived severity", () => {
    const n = buildNotification({
      notificationId: "n-1",
      toMemberId: "bob",
      source: "task",
      refId: "t-1",
      summary: "Alice assigned you a task",
      eventRevision: 9,
    });
    expect(n.severity).toBe("warn");
    expect(n.toMemberId).toBe("bob");
    expect(n.refId).toBe("t-1");
  });
});
