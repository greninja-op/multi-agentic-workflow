/**
 * Property-based tests for the {@link TaskRegistry} (V2 Phase 2; Req 2.1–2.3).
 *
 * Property 18: the task lifecycle is a well-formed state machine — every status
 *   is always one of the six valid values, and the terminal statuses
 *   (`rejected`, `done`, `withdrawn`) are never left once reached, regardless of
 *   the sequence of (possibly unauthorized / illegal) actions applied.
 */

import { test } from "vitest";
import { assertProperty, fc, propertyTag } from "@cfls/test-utils";
import type { MemberRef, SessionId, TaskStatus } from "@cfls/protocol";

import { TaskRegistry } from "./tasks";

const session: SessionId = {
  repoId: "github.com/acme/webapp",
  teamId: "team-1",
  branch: "main",
  baseRevision: null,
};

const alice: MemberRef = { memberId: "alice", deviceId: "d-a" }; // assigner
const bob: MemberRef = { memberId: "bob", deviceId: "d-b" }; // assignee
const actors = [alice, bob, { memberId: "carol", deviceId: "d-c" }];

const VALID: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "proposed",
  "accepted",
  "rejected",
  "in_progress",
  "done",
  "withdrawn",
]);
const TERMINAL: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "rejected",
  "done",
  "withdrawn",
]);

/** A random action against the single task t-1. */
const actionArb = fc.record({
  kind: fc.constantFrom(
    "respond" as const,
    "progress" as const,
    "withdraw" as const,
  ),
  actorIdx: fc.integer({ min: 0, max: actors.length - 1 }),
  accept: fc.boolean(),
  progressStatus: fc.constantFrom("in_progress" as const, "done" as const),
});

test(
  propertyTag(18, "task lifecycle is a valid state machine; terminals are sticky"),
  () => {
    assertProperty(
      fc.property(fc.array(actionArb, { maxLength: 30 }), (actions) => {
        const reg = new TaskRegistry();
        let rev = 1;
        reg.assign({
          session,
          taskId: "t-1",
          title: "t",
          description: "d",
          assignee: bob,
          assigner: alice,
          eventRevision: rev,
        });

        for (const action of actions) {
          const before = reg.get(session, "t-1")!.status;
          const requester = actors[action.actorIdx]!;
          rev += 1;
          if (action.kind === "respond") {
            reg.respond({
              session,
              taskId: "t-1",
              requester,
              accept: action.accept,
              eventRevision: rev,
            });
          } else if (action.kind === "progress") {
            reg.progress({
              session,
              taskId: "t-1",
              requester,
              status: action.progressStatus,
              eventRevision: rev,
            });
          } else {
            reg.withdraw({
              session,
              taskId: "t-1",
              requester,
              eventRevision: rev,
            });
          }

          const after = reg.get(session, "t-1")!.status;
          // Invariant 1: status is always valid.
          if (!VALID.has(after)) {
            return false;
          }
          // Invariant 2: a terminal status is never left.
          if (TERMINAL.has(before) && after !== before) {
            return false;
          }
        }
        return true;
      }),
    );
  },
);
