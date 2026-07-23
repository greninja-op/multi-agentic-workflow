/**
 * Unit tests for the {@link DiffRegistry} (V2 Phase 5; Req 5.1–5.3).
 */

import { describe, it, expect } from "vitest";
import type { LiveDiffDto, SessionId } from "@cfls/protocol";

import { DiffRegistry } from "./diffs";

const session: SessionId = {
  repoId: "github.com/acme/webapp",
  teamId: "team-1",
  branch: "main",
  baseRevision: null,
};

function diff(
  partial: Partial<LiveDiffDto> &
    Pick<LiveDiffDto, "path" | "eventRevision"> & { memberId: string },
): LiveDiffDto {
  const { memberId, ...rest } = partial;
  return {
    member: { memberId, deviceId: "d-1" },
    patch: "@@ -1 +1 @@\n-old\n+new",
    ...rest,
  };
}

describe("DiffRegistry (Req 5.1–5.3)", () => {
  it("stores the latest diff per (member, path)", () => {
    const reg = new DiffRegistry();
    reg.share(session, diff({ memberId: "alice", path: "src/a.ts", eventRevision: 1 }));
    reg.share(session, diff({ memberId: "alice", path: "src/a.ts", patch: "newer", eventRevision: 4 }));
    const current = reg.get(session, "alice", "src/a.ts");
    expect(current?.patch).toBe("newer");
    expect(current?.eventRevision).toBe(4);
    expect(reg.allDiffs(session)).toHaveLength(1);
  });

  it("keeps distinct diffs for different members and paths", () => {
    const reg = new DiffRegistry();
    reg.share(session, diff({ memberId: "alice", path: "src/a.ts", eventRevision: 1 }));
    reg.share(session, diff({ memberId: "bob", path: "src/a.ts", eventRevision: 2 }));
    reg.share(session, diff({ memberId: "alice", path: "src/b.ts", eventRevision: 3 }));
    expect(reg.allDiffs(session)).toHaveLength(3);
    expect(reg.diffsForPath(session, "src/a.ts").map((d) => d.member.memberId)).toEqual([
      "alice",
      "bob",
    ]);
  });

  it("clears a shared diff when an empty patch is shared (Req 5.2, 5.3)", () => {
    const reg = new DiffRegistry();
    expect(reg.share(session, diff({ memberId: "alice", path: "src/a.ts", eventRevision: 1 }))).toBe(
      "shared",
    );
    expect(
      reg.share(session, diff({ memberId: "alice", path: "src/a.ts", patch: "", eventRevision: 2 })),
    ).toBe("removed");
    expect(reg.get(session, "alice", "src/a.ts")).toBeUndefined();
    expect(reg.allDiffs(session)).toHaveLength(0);
  });

  it("drops every diff owned by a member that stopped (Req 5.3)", () => {
    const reg = new DiffRegistry();
    reg.share(session, diff({ memberId: "alice", path: "src/a.ts", eventRevision: 1 }));
    reg.share(session, diff({ memberId: "alice", path: "src/b.ts", eventRevision: 2 }));
    reg.share(session, diff({ memberId: "bob", path: "src/c.ts", eventRevision: 3 }));
    reg.removeMember(session, "alice");
    expect(reg.allDiffs(session).map((d) => d.member.memberId)).toEqual(["bob"]);
  });

  it("returns diffs since a revision for reconnect resend", () => {
    const reg = new DiffRegistry();
    reg.share(session, diff({ memberId: "alice", path: "src/a.ts", eventRevision: 1 }));
    reg.share(session, diff({ memberId: "bob", path: "src/b.ts", eventRevision: 5 }));
    expect(reg.since(session, 3).map((d) => d.member.memberId)).toEqual(["bob"]);
  });

  it("restores a persisted set, latest revision per (member, path) winning", () => {
    const reg = new DiffRegistry();
    reg.restore(session, [
      diff({ memberId: "alice", path: "src/a.ts", patch: "old", eventRevision: 1 }),
      diff({ memberId: "alice", path: "src/a.ts", patch: "new", eventRevision: 9 }),
    ]);
    expect(reg.get(session, "alice", "src/a.ts")?.patch).toBe("new");
    expect(reg.allDiffs(session)).toHaveLength(1);
  });
});
