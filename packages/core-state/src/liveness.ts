/**
 * Liveness tracking and notification-severity derivation
 * (V2 Phase 3; Req 3.1–3.3; idea.md §6 Liveness & Direction/Control).
 *
 * The {@link LivenessTracker} is the pure, in-memory authority for each member's
 * `active` / `idle` / `gone` state (Req 3.1). It is dependency-free: the caller
 * supplies the current live roster (who has a host connection) and records
 * activity timestamps; the tracker derives the state deterministically:
 *
 * ```
 * gone   ⇐ the member has no live host connection
 * active ⇐ connected AND acted within `activeWindowMs`
 * idle   ⇐ connected but quiet for longer than `activeWindowMs`
 * ```
 *
 * {@link notificationSeverity} and {@link buildNotification} map a coordination
 * event to a {@link NotifySeverity} so clients can alert proportionally (Req 3.2)
 * — `urgent` for wakes/conflicts/urgent messages, `warn` for questions and task
 * assignments, `info` otherwise.
 */

import type {
  LivenessState,
  MemberRef,
  MessagePriority,
  NotificationDto,
  NotifySeverity,
  NotifySource,
  SessionId,
} from "@cfls/protocol";

import { sessionKey } from "./session";

/** Default window within which a connected member counts as `active` (Req 3.1). */
export const DEFAULT_ACTIVE_WINDOW_MS = 60_000;

/** Per-session liveness state. */
interface LivenessSessionState {
  /** memberId → last activity time (epoch ms). */
  lastActivity: Map<string, number>;
  /** The current live roster (members with a host connection). */
  connected: Set<string>;
}

/** Pure in-memory tracker of member liveness (Req 3.1). */
export class LivenessTracker {
  private readonly sessions = new Map<string, LivenessSessionState>();

  constructor(
    private readonly activeWindowMs: number = DEFAULT_ACTIVE_WINDOW_MS,
  ) {}

  private stateFor(session: SessionId): LivenessSessionState {
    const key = sessionKey(session);
    let state = this.sessions.get(key);
    if (state === undefined) {
      state = { lastActivity: new Map(), connected: new Set() };
      this.sessions.set(key, state);
    }
    return state;
  }

  /** Record that `memberId` acted at `atMs` (a heartbeat, edit, or event). */
  recordActivity(session: SessionId, memberId: string, atMs: number): void {
    const state = this.stateFor(session);
    const prior = state.lastActivity.get(memberId);
    // Record the first activity (even at epoch 0) and otherwise only advance
    // forward, so out-of-order timestamps never rewind activity.
    if (prior === undefined || atMs > prior) {
      state.lastActivity.set(memberId, atMs);
    }
  }

  /** Replace the live roster (members with a host connection) (Req 3.1). */
  setConnected(session: SessionId, connectedMemberIds: Iterable<string>): void {
    this.stateFor(session).connected = new Set(connectedMemberIds);
  }

  /** Derive `memberId`'s liveness at `nowMs` (Req 3.1). */
  stateOf(
    session: SessionId,
    memberId: string,
    nowMs: number,
  ): LivenessState {
    const state = this.sessions.get(sessionKey(session));
    if (state === undefined || !state.connected.has(memberId)) {
      return "gone";
    }
    const last = state.lastActivity.get(memberId);
    if (last !== undefined && nowMs - last <= this.activeWindowMs) {
      return "active";
    }
    return "idle";
  }

  /**
   * Derive the liveness state of every known member (connected members plus any
   * member with a recorded activity), at `nowMs`. Sorted by memberId.
   */
  states(session: SessionId, nowMs: number): { memberId: string; state: LivenessState }[] {
    const state = this.sessions.get(sessionKey(session));
    if (state === undefined) {
      return [];
    }
    const members = new Set<string>([
      ...state.connected,
      ...state.lastActivity.keys(),
    ]);
    return [...members]
      .map((memberId) => ({
        memberId,
        state: this.stateOf(session, memberId, nowMs),
      }))
      .sort((a, b) => a.memberId.localeCompare(b.memberId));
  }
}

/**
 * The severity a notification should carry given its source and (for messages)
 * the message priority (Req 3.2). Wakes, conflicts, and urgent messages are
 * `urgent`; questions and task assignments are `warn`; everything else is `info`.
 */
export function notificationSeverity(
  source: NotifySource,
  priority?: MessagePriority,
): NotifySeverity {
  switch (source) {
    case "wake":
    case "conflict":
      return "urgent";
    case "question":
    case "task":
      return "warn";
    case "message":
      return priority === "urgent" ? "urgent" : "info";
  }
}

/** Inputs to {@link buildNotification}. */
export interface BuildNotificationInput {
  notificationId: string;
  toMemberId: string;
  source: NotifySource;
  refId: string;
  summary: string;
  eventRevision: number;
  /** Message priority when `source === "message"`, used to raise severity. */
  priority?: MessagePriority;
}

/**
 * Build a {@link NotificationDto} with its severity derived from the source
 * (Req 3.2). Carries only coordination metadata — never source content.
 */
export function buildNotification(
  input: BuildNotificationInput,
): NotificationDto {
  return {
    notificationId: input.notificationId,
    toMemberId: input.toMemberId,
    severity: notificationSeverity(input.source, input.priority),
    source: input.source,
    refId: input.refId,
    summary: input.summary,
    eventRevision: input.eventRevision,
  };
}

/** Convenience: the member id from a {@link MemberRef}. */
export function memberIdOf(member: MemberRef): string {
  return member.memberId;
}
