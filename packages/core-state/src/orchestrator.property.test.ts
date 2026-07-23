/**
 * Property-based tests for {@link RulesLunaBrain} (V2 Phase 4; Req 4.2).
 *
 * Property 20: assignment is safe and deterministic — Luna never assigns work
 *   back to the requester, always picks a known member when candidates exist,
 *   and yields the same assignee for identical inputs.
 */

import { test } from "vitest";
import { assertProperty, fc, propertyTag } from "@cfls/test-utils";
import type { LivenessState, MemberRef, SessionId } from "@cfls/protocol";

import { RulesLunaBrain, type LunaContext } from "./orchestrator";

const session: SessionId = {
  repoId: "github.com/acme/webapp",
  teamId: "team-1",
  branch: "main",
  baseRevision: null,
};

const memberPool = ["alice", "bob", "carol", "dave"];
const liveStates: LivenessState[] = ["active", "idle", "gone"];

test(
  propertyTag(20, "Luna assignment never targets the requester and is deterministic"),
  () => {
    assertProperty(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...memberPool), { minLength: 1, maxLength: 4 }),
        fc.integer({ min: 0, max: 3 }),
        fc.array(fc.constantFrom(...liveStates), { maxLength: 4 }),
        (members, requesterIdx, states) => {
          const requesterId = members[requesterIdx % members.length]!;
          const requester: MemberRef = { memberId: requesterId, deviceId: "d" };
          const context: LunaContext = {
            session,
            requester,
            members,
            liveness: members.map((m, i) => ({
              memberId: m,
              state: states[i] ?? "idle",
            })),
            tasks: [],
          };
          const brain = new RulesLunaBrain();
          const d1 = brain.decide({ action: "assign", prompt: "do the work" }, context);
          const d2 = brain.decide({ action: "assign", prompt: "do the work" }, context);

          // Determinism.
          if (d1.assignment?.assigneeMemberId !== d2.assignment?.assigneeMemberId) {
            return false;
          }
          const others = members.filter((m) => m !== requesterId);
          if (others.length === 0) {
            // No candidate → no assignment.
            return d1.assignment === undefined;
          }
          // Assigned to a known member that is not the requester.
          const assignee = d1.assignment?.assigneeMemberId;
          return (
            assignee !== undefined &&
            assignee !== requesterId &&
            members.includes(assignee)
          );
        },
      ),
    );
  },
);
