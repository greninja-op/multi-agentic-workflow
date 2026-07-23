/**
 * Unit tests for the {@link MessageRegistry} (V2 Phase 1; Req 1.1–1.4).
 */

import { describe, it, expect } from "vitest";
import type { MemberRef, SessionId } from "@cfls/protocol";

import { MessageRegistry, type AppendMessageInput } from "./messaging";

const session: SessionId = {
  repoId: "github.com/acme/webapp",
  teamId: "team-1",
  branch: "main",
  baseRevision: null,
};

const alice: MemberRef = { memberId: "alice", deviceId: "dev-a" };
const bob: MemberRef = { memberId: "bob", deviceId: "dev-b" };

function base(
  partial: Partial<AppendMessageInput> & Pick<AppendMessageInput, "messageId" | "kind" | "sender" | "eventRevision">,
): AppendMessageInput {
  return {
    session,
    priority: "normal",
    body: "hello",
    sentAt: "2024-01-01T00:00:00Z",
    ...partial,
  };
}

describe("MessageRegistry — addressing & visibility (Req 1.1)", () => {
  it("delivers a direct message only to sender and recipient", () => {
    const reg = new MessageRegistry();
    reg.append(base({ messageId: "m1", kind: "direct", sender: alice, toMemberId: "bob", eventRevision: 1 }));

    expect(reg.messagesFor(session, "alice").map((m) => m.messageId)).toEqual(["m1"]);
    expect(reg.messagesFor(session, "bob").map((m) => m.messageId)).toEqual(["m1"]);
    expect(reg.messagesFor(session, "carol")).toEqual([]);
  });

  it("delivers a broadcast to everyone", () => {
    const reg = new MessageRegistry();
    reg.append(base({ messageId: "m1", kind: "broadcast", sender: alice, eventRevision: 1 }));
    expect(reg.messagesFor(session, "bob").map((m) => m.messageId)).toEqual(["m1"]);
    expect(reg.messagesFor(session, "carol").map((m) => m.messageId)).toEqual(["m1"]);
  });
});

describe("MessageRegistry — priority (Req 1.2)", () => {
  it("records the given priority verbatim", () => {
    const reg = new MessageRegistry();
    const r = reg.append(base({ messageId: "m1", kind: "broadcast", sender: alice, priority: "urgent", eventRevision: 1 }));
    expect(r.message.priority).toBe("urgent");
  });
});

describe("MessageRegistry — questions & answers (Req 1.3)", () => {
  it("marks a question answered when a correlated answer arrives", () => {
    const reg = new MessageRegistry();
    reg.append(base({ messageId: "q1", kind: "question", sender: alice, toMemberId: "bob", correlationId: "c1", eventRevision: 1 }));
    expect(reg.openQuestionsFor(session, "bob").map((m) => m.messageId)).toEqual(["q1"]);

    const answer = reg.append(base({ messageId: "a1", kind: "answer", sender: bob, toMemberId: "alice", correlationId: "c1", eventRevision: 2 }));
    expect(answer.answeredQuestion?.messageId).toBe("q1");
    expect(reg.openQuestionsFor(session, "bob")).toEqual([]);
  });
});

describe("MessageRegistry — read state & unread count (Req 1.4)", () => {
  it("only lets a recipient mark a message read", () => {
    const reg = new MessageRegistry();
    reg.append(base({ messageId: "m1", kind: "direct", sender: alice, toMemberId: "bob", eventRevision: 1 }));
    expect(reg.markRead(session, "m1", "carol")).toBe(false);
    expect(reg.markRead(session, "m1", "bob")).toBe(true);
    expect(reg.isRead(session, "m1", "bob")).toBe(true);
  });

  it("excludes a member's own sent messages from its unread count", () => {
    const reg = new MessageRegistry();
    // alice broadcasts — must not count toward alice's own unread.
    reg.append(base({ messageId: "m1", kind: "broadcast", sender: alice, eventRevision: 1 }));
    // bob directs a message at alice — counts until read.
    reg.append(base({ messageId: "m2", kind: "direct", sender: bob, toMemberId: "alice", eventRevision: 2 }));

    expect(reg.unreadCountFor(session, "alice")).toBe(1);
    reg.markRead(session, "m2", "alice");
    expect(reg.unreadCountFor(session, "alice")).toBe(0);
  });
});

describe("MessageRegistry — ordering & restore", () => {
  it("keeps messages ordered by eventRevision regardless of append order", () => {
    const reg = new MessageRegistry();
    reg.append(base({ messageId: "m3", kind: "broadcast", sender: alice, eventRevision: 3 }));
    reg.append(base({ messageId: "m1", kind: "broadcast", sender: alice, eventRevision: 1 }));
    reg.append(base({ messageId: "m2", kind: "broadcast", sender: alice, eventRevision: 2 }));
    expect(reg.allMessages(session).map((m) => m.eventRevision)).toEqual([1, 2, 3]);
  });

  it("restores a persisted set and rederives open questions", () => {
    const reg = new MessageRegistry();
    reg.restore(session, [
      { messageId: "q1", kind: "question", sender: alice, toMemberId: "bob", priority: "normal", body: "?", correlationId: "c1", answered: false, eventRevision: 1, sentAt: "t" },
    ]);
    expect(reg.openQuestionsFor(session, "bob").map((m) => m.messageId)).toEqual(["q1"]);
  });
});
