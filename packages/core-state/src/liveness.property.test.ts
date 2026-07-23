/**
 * Property-based tests for the {@link LivenessTracker} (V2 Phase 3; Req 3.1).
 *
 * Property 19: liveness derivation is well-defined and consistent — a member
 *   without a live connection is always `gone`; a connected member is `active`
 *   iff it acted within the window, else `idle`.
 */

import { test } from "vitest";
import { assertProperty, fc, propertyTag } from "@cfls/test-utils";
import type { SessionId } from "@cfls/protocol";

import { LivenessTracker } from "./liveness";

const session: SessionId = {
  repoId: "github.com/acme/webapp",
  teamId: "team-1",
  branch: "main",
  baseRevision: null,
};

const WINDOW = 60_000;

test(
  propertyTag(19, "liveness is gone without connection, else active/idle by window"),
  () => {
    assertProperty(
      fc.property(
        fc.boolean(), // connected?
        fc.option(fc.integer({ min: 0, max: 1_000_000 }), { nil: undefined }), // lastActivity
        fc.integer({ min: 0, max: 1_000_000 }), // now
        (connected, lastActivity, rawNow) => {
          const t = new LivenessTracker(WINDOW);
          if (connected) {
            t.setConnected(session, ["m"]);
          }
          if (lastActivity !== undefined) {
            t.recordActivity(session, "m", lastActivity);
          }
          // Ensure now is not before the activity for a meaningful window test.
          const now = Math.max(rawNow, lastActivity ?? 0);
          const state = t.stateOf(session, "m", now);

          if (!connected) {
            return state === "gone";
          }
          if (lastActivity !== undefined && now - lastActivity <= WINDOW) {
            return state === "active";
          }
          return state === "idle";
        },
      ),
    );
  },
);
