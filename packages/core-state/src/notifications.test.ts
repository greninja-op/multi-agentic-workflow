/**
 * Unit tests for the {@link NotificationRegistry} (V2 Phase 3; Req 3.2, 3.3).
 */

import { describe, it, expect } from "vitest";
import type { NotificationDto, SessionId } from "@cfls/protocol";

import { NotificationRegistry } from "./notifications";

const session: SessionId = {
  repoId: "github.com/acme/webapp",
  teamId: "team-1",
  branch: "main",
  baseRevision: null,
};

function notif(
  partial: Partial<NotificationDto> &
    Pick<NotificationDto, "notificationId" | "toMemberId" | "source" | "eventRevision">,
): NotificationDto {
  return {
    severity: "info",
    refId: "r-1",
    summary: "s",
    ...partial,
  };
}

describe("NotificationRegistry (Req 3.2, 3.3)", () => {
  it("filters notifications by recipient, ordered by revision", () => {
    const reg = new NotificationRegistry();
    reg.add(session, notif({ notificationId: "n2", toMemberId: "bob", source: "task", eventRevision: 2 }));
    reg.add(session, notif({ notificationId: "n1", toMemberId: "bob", source: "message", eventRevision: 1 }));
    reg.add(session, notif({ notificationId: "n3", toMemberId: "alice", source: "task", eventRevision: 3 }));

    expect(reg.forMember(session, "bob").map((n) => n.notificationId)).toEqual(["n1", "n2"]);
    expect(reg.forMember(session, "alice").map((n) => n.notificationId)).toEqual(["n3"]);
  });

  it("returns notifications since a revision (reconnect resend)", () => {
    const reg = new NotificationRegistry();
    reg.add(session, notif({ notificationId: "n1", toMemberId: "bob", source: "task", eventRevision: 1 }));
    reg.add(session, notif({ notificationId: "n2", toMemberId: "bob", source: "task", eventRevision: 5 }));
    expect(reg.since(session, "bob", 3).map((n) => n.notificationId)).toEqual(["n2"]);
  });

  it("surfaces pending wakes as source==='wake' notifications (Req 3.3)", () => {
    const reg = new NotificationRegistry();
    reg.add(session, notif({ notificationId: "w1", toMemberId: "bob", source: "wake", eventRevision: 1 }));
    reg.add(session, notif({ notificationId: "t1", toMemberId: "bob", source: "task", eventRevision: 2 }));
    expect(reg.pendingWakesFor(session, "bob").map((n) => n.notificationId)).toEqual(["w1"]);
  });

  it("restores a persisted set", () => {
    const reg = new NotificationRegistry();
    reg.restore(session, [
      notif({ notificationId: "n1", toMemberId: "bob", source: "task", eventRevision: 7 }),
    ]);
    expect(reg.forMember(session, "bob").map((n) => n.notificationId)).toEqual(["n1"]);
  });
});
