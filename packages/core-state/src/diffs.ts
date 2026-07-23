/**
 * Live-diff registry — the opt-in, team-only store of members' current change
 * diffs (V2 Phase 5; Req 5.1–5.3; idea.md §6 Liveness & live diffs).
 *
 * The {@link DiffRegistry} keeps the **latest** {@link LiveDiffDto} per
 * `(memberId, path)` for a `Repository_Session`. It is the only V2 registry that
 * holds source-derived content, so it is written to only when the team has
 * enabled Live_Diff sharing — the gating decision lives in the host/agent; the
 * registry itself is a pure, dependency-free store like the messaging and
 * notification registries.
 *
 * Sharing an **empty** patch clears any previously shared diff for that
 * `(member, path)` — this is how "I stopped editing / this path is now excluded"
 * is represented (Req 5.2, 5.3). Ordering across the session is by the per-session
 * Event_Revision total order.
 */

import type { LiveDiffDto, MemberRef, SessionId } from "@cfls/protocol";

import { sessionKey } from "./session";

/** A stable composite key for one member's diff of one path. */
function diffKey(memberId: string, path: string): string {
  return `${memberId}\u0000${path}`;
}

/** Pure in-memory registry of the latest Live_Diff per member/path (Req 5.2). */
export class DiffRegistry {
  /** `session_key` → `diffKey` → the latest diff for that (member, path). */
  private readonly sessions = new Map<string, Map<string, LiveDiffDto>>();

  private mapFor(session: SessionId): Map<string, LiveDiffDto> {
    const key = sessionKey(session);
    let map = this.sessions.get(key);
    if (map === undefined) {
      map = new Map();
      this.sessions.set(key, map);
    }
    return map;
  }

  /**
   * Store (or replace) the latest diff for `(member, path)`. An empty `patch`
   * removes any previously shared diff for that pair (Req 5.2, 5.3). Returns the
   * resulting op so callers can broadcast `shared` vs `removed`.
   */
  share(session: SessionId, diff: LiveDiffDto): "shared" | "removed" {
    const map = this.mapFor(session);
    const key = diffKey(diff.member.memberId, diff.path);
    if (diff.patch.length === 0) {
      map.delete(key);
      return "removed";
    }
    map.set(key, { ...diff, member: { ...diff.member } });
    return "shared";
  }

  /** Remove the shared diff for `(memberId, path)`, if any. */
  remove(session: SessionId, memberId: string, path: string): void {
    this.mapFor(session).delete(diffKey(memberId, path));
  }

  /** Drop every shared diff owned by `memberId` (member stopped / left) (Req 5.3). */
  removeMember(session: SessionId, memberId: string): void {
    const map = this.mapFor(session);
    for (const [key, diff] of [...map.entries()]) {
      if (diff.member.memberId === memberId) {
        map.delete(key);
      }
    }
  }

  /** The current diff for `(memberId, path)`, or `undefined`. */
  get(
    session: SessionId,
    memberId: string,
    path: string,
  ): LiveDiffDto | undefined {
    const diff = this.mapFor(session).get(diffKey(memberId, path));
    return diff === undefined ? undefined : { ...diff, member: { ...diff.member } };
  }

  /** Every current diff for a path, ordered by `eventRevision` then memberId. */
  diffsForPath(session: SessionId, path: string): LiveDiffDto[] {
    return this.allDiffs(session).filter((d) => d.path === path);
  }

  /** Every current shared diff in the session, ordered deterministically. */
  allDiffs(session: SessionId): LiveDiffDto[] {
    return [...this.mapFor(session).values()]
      .map((d) => ({ ...d, member: { ...d.member } }))
      .sort(
        (a, b) =>
          a.eventRevision - b.eventRevision ||
          a.member.memberId.localeCompare(b.member.memberId) ||
          a.path.localeCompare(b.path),
      );
  }

  /** Current diffs with an Event_Revision greater than `fromRevision` (reconnect). */
  since(session: SessionId, fromRevision: number): LiveDiffDto[] {
    return this.allDiffs(session).filter((d) => d.eventRevision > fromRevision);
  }

  /**
   * Replace a session's diffs with a persisted set (restart / sync-snapshot
   * restore). Deep-copied; the latest revision per (member, path) wins.
   */
  restore(session: SessionId, diffs: readonly LiveDiffDto[]): void {
    const map = new Map<string, LiveDiffDto>();
    for (const diff of [...diffs].sort(
      (a, b) => a.eventRevision - b.eventRevision,
    )) {
      map.set(diffKey(diff.member.memberId, diff.path), {
        ...diff,
        member: { ...diff.member },
      });
    }
    this.sessions.set(sessionKey(session), map);
  }
}

/** Convenience: the member id from a {@link MemberRef}. */
export function diffMemberId(member: MemberRef): string {
  return member.memberId;
}
