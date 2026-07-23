/**
 * Notification registry — severity-tagged alerts and wake requests
 * (V2 Phase 3; Req 3.2, 3.3; idea.md §6 Direction & Control).
 *
 * The {@link NotificationRegistry} is the pure, in-memory store of
 * {@link NotificationDto}s per `Repository_Session`. A **wake request** is
 * modeled as a notification with `source: "wake"`, so "pending wakes for a
 * member" is simply a filter over that member's notifications (Req 3.3).
 *
 * Like the messaging store it is dependency-free and ordered by the per-session
 * Event_Revision total order. Notifications addressed to a member are delivered
 * live by the host and resent on reconnect; the store also underpins a
 * `get_notifications` query.
 */

import type { NotificationDto, SessionId } from "@cfls/protocol";

import { sessionKey } from "./session";

/** Pure in-memory registry of notifications and wakes (Req 3.2, 3.3). */
export class NotificationRegistry {
  /** `session_key` → notifications ordered by `eventRevision`. */
  private readonly sessions = new Map<string, NotificationDto[]>();

  private listFor(session: SessionId): NotificationDto[] {
    const key = sessionKey(session);
    let list = this.sessions.get(key);
    if (list === undefined) {
      list = [];
      this.sessions.set(key, list);
    }
    return list;
  }

  /** Append a notification, keeping the per-session list ordered by revision. */
  add(session: SessionId, notification: NotificationDto): void {
    const list = this.listFor(session);
    const copy: NotificationDto = { ...notification };
    let i = list.length;
    while (i > 0 && list[i - 1]!.eventRevision > copy.eventRevision) {
      i -= 1;
    }
    list.splice(i, 0, copy);
  }

  /** Notifications addressed to `memberId`, ordered by `eventRevision`. */
  forMember(session: SessionId, memberId: string): NotificationDto[] {
    return this.listFor(session)
      .filter((n) => n.toMemberId === memberId)
      .map((n) => ({ ...n }));
  }

  /** Notifications for `memberId` with an Event_Revision greater than `fromRevision`. */
  since(
    session: SessionId,
    memberId: string,
    fromRevision: number,
  ): NotificationDto[] {
    return this.forMember(session, memberId).filter(
      (n) => n.eventRevision > fromRevision,
    );
  }

  /** Pending wake requests addressed to `memberId` (Req 3.3). */
  pendingWakesFor(session: SessionId, memberId: string): NotificationDto[] {
    return this.forMember(session, memberId).filter(
      (n) => n.source === "wake",
    );
  }

  /** Every notification recorded for a session (ordered by `eventRevision`). */
  allNotifications(session: SessionId): NotificationDto[] {
    return this.listFor(session).map((n) => ({ ...n }));
  }

  /**
   * Replace a session's notifications with a persisted set (restart /
   * sync-snapshot restore). Deep-copied and re-sorted by revision.
   */
  restore(session: SessionId, notifications: readonly NotificationDto[]): void {
    const sorted = [...notifications]
      .map((n) => ({ ...n }))
      .sort((a, b) => a.eventRevision - b.eventRevision);
    this.sessions.set(sessionKey(session), sorted);
  }
}
