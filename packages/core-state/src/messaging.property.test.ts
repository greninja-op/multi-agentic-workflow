/**
 * Property-based tests for the {@link MessageRegistry} (V2 Phase 1; Req 1.1–1.4).
 *
 * Property 16: message ordering is the per-session Event_Revision total order,
 *   independent of the order in which messages are appended.
 * Property 17: a member's unread count never counts its own sent messages.
 */

import { test } from "vitest";
import { assertProperty, fc, propertyTag } from "@cfls/test-utils";
import type { SessionId } from "@cfls/protocol";

import { MessageRegistry } from "./messaging";

const session: SessionId = {
  repoId: "github.com/acme/webapp",
  teamId: "team-1",
  branch: "main",
  baseRevision: null,
};

const memberIds = ["alice", "bob", "carol"] as const;

/** A generator of distinct-revision message append inputs in arbitrary order. */
const messagesArb = fc
  .uniqueArray(fc.integer({ min: 1, max: 100000 }), {
    minLength: 1,
    maxLength: 25,
  })
  .chain((revisions) =>
    fc.tuple(
      ...revisions.map((rev) =>
        fc.record({
          eventRevision: fc.constant(rev),
          senderIdx: fc.integer({ min: 0, max: memberIds.length - 1 }),
          toIdx: fc.integer({ min: 0, max: memberIds.length - 1 }),
          kind: fc.constantFrom("direct" as const, "broadcast" as const),
        }),
      ),
    ),
  );

test(
  propertyTag(16, "message ordering follows Event_Revision, not append order"),
  () => {
    assertProperty(
      fc.property(messagesArb, fc.array(fc.nat()), (specs, shuffle) => {
        const reg = new MessageRegistry();
        // Append in a shuffled order derived from `shuffle`.
        const order = specs
          .map((s, i) => ({ s, k: shuffle[i] ?? i }))
          .sort((a, b) => a.k - b.k)
          .map((x) => x.s);
        for (let i = 0; i < order.length; i += 1) {
          const s = order[i]!;
          reg.append({
            session,
            messageId: `m-${s.eventRevision}`,
            kind: s.kind,
            sender: { memberId: memberIds[s.senderIdx]!, deviceId: "d" },
            ...(s.kind === "direct"
              ? { toMemberId: memberIds[s.toIdx]! }
              : {}),
            priority: "normal",
            body: "x",
            eventRevision: s.eventRevision,
            sentAt: "t",
          });
        }
        const revs = reg.allMessages(session).map((m) => m.eventRevision);
        const sorted = [...revs].sort((a, b) => a - b);
        return JSON.stringify(revs) === JSON.stringify(sorted);
      }),
    );
  },
);

test(
  propertyTag(17, "unread count never includes a member's own sent messages"),
  () => {
    assertProperty(
      fc.property(messagesArb, (specs) => {
        const reg = new MessageRegistry();
        for (const s of specs) {
          reg.append({
            session,
            messageId: `m-${s.eventRevision}`,
            kind: s.kind,
            sender: { memberId: memberIds[s.senderIdx]!, deviceId: "d" },
            ...(s.kind === "direct"
              ? { toMemberId: memberIds[s.toIdx]! }
              : {}),
            priority: "normal",
            body: "x",
            eventRevision: s.eventRevision,
            sentAt: "t",
          });
        }
        // For every member, its unread count must not exceed the number of
        // messages addressed to it that it did NOT send.
        for (const member of memberIds) {
          const addressedByOthers = reg
            .allMessages(session)
            .filter(
              (m) =>
                m.sender.memberId !== member &&
                (m.kind === "broadcast" ||
                  m.kind === "heads_up" ||
                  m.toMemberId === member),
            ).length;
          if (reg.unreadCountFor(session, member) !== addressedByOthers) {
            return false;
          }
        }
        return true;
      }),
    );
  },
);
