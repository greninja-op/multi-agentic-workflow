/**
 * Authoritative-state snapshot serialize/deserialize with revision-counter
 * restore (Req 1.5, 1.6, 9.5, 35.1; design §5.2, §4.6).
 *
 * The CoordinationHost is the definitive authority for every
 * `Repository_Session` and must survive a restart: it persists coordination
 * metadata durably and, on restart, restores the last authoritative state and
 * resumes assigning Event_Revisions strictly greater than every previously
 * assigned one (Req 1.5, 1.6). The same {@link SessionStateSnapshot} shape is
 * the reconnect *sync-snapshot fallback* an agent replaces its cached state with
 * when the host cannot serve incremental events (Req 9.5), and the shape the
 * agent persists to its local encrypted cache (Req 35.1).
 *
 * This module is the pure bridge between the in-memory registries — the
 * {@link LockRegistry}, {@link IntentRegistry}, and {@link PresenceRegistry} —
 * and the serializable {@link SessionStateSnapshot} DTO from `@cfls/protocol`.
 * It has no I/O: callers own reading/writing the bytes (SQLite on the host, the
 * encrypted cache on the agent). {@link serializeSessionState} projects the live
 * registries for one session into a plain snapshot; {@link restoreSessionState}
 * loads a snapshot back into fresh (or to-be-replaced) registries and resumes
 * the shared {@link RevisionCounter} above the snapshot's max persisted revision
 * so no post-restart revision can ever collide with one issued before (Req 1.6).
 *
 * Restore is *replace* semantics (Req 9.5): the session's prior lock, intent,
 * and presence state is discarded wholesale. Because every winner (contended
 * locks, Planned_File_Creation claims) is recomputed deterministically from
 * Event_Revisions rather than insertion order, a serialize→restore round-trip
 * reproduces the same authoritative winners regardless of the order entities
 * appear in the snapshot.
 */

import type { SessionId, SessionStateSnapshot } from "@cfls/protocol";

import type { IntentRegistry } from "./intents";
import type { DiffRegistry } from "./diffs";
import type { LockRegistry } from "./locks";
import type { MessageRegistry } from "./messaging";
import type { NotificationRegistry } from "./notifications";
import type { PresenceRegistry } from "./presence";
import type { RevisionCounter } from "./revisions";
import type { TaskRegistry } from "./tasks";

/**
 * The per-session in-memory authorities projected into / restored from a
 * {@link SessionStateSnapshot}. The {@link RevisionCounter} is shared across all
 * sessions; the lock/intent/presence registries are the coordination
 * authorities whose state a snapshot captures.
 */
export interface SessionRegistries {
  locks: LockRegistry;
  intents: IntentRegistry;
  presence: PresenceRegistry;
  revisions: RevisionCounter;
  /**
   * V2 messaging registry (Phase 1). Optional so V1 callers that do not
   * coordinate messages are unaffected; when present, messages are captured in
   * and restored from the snapshot (Req 1.4, X.2).
   */
  messages?: MessageRegistry;
  /**
   * V2 task registry (Phase 2). Optional; when present, tasks are captured in
   * and restored from the snapshot (Req 2.1, X.2).
   */
  tasks?: TaskRegistry;
  /**
   * V2 notification registry (Phase 3). Optional; when present, notifications
   * are captured in and restored from the snapshot (Req 3.2, X.2).
   */
  notifications?: NotificationRegistry;
  /**
   * V2 live-diff registry (Phase 5). Optional and used only when Live_Diff
   * sharing is enabled; when present, currently-shared diffs are captured in and
   * restored from the snapshot (Req 5.1–5.3, X.2).
   */
  diffs?: DiffRegistry;
}

/**
 * Project the live registries for a single `Repository_Session` into a
 * serializable {@link SessionStateSnapshot} (Req 1.5, 9.5, 35.1). Captures every
 * recorded lock (winning and concurrent), every presence entry (including
 * `stopped` records), every active Declared_Intent, and the session's highest
 * assigned Event_Revision. The returned snapshot is a deep, independent copy: it
 * shares no mutable structure with the registries, so persisting or mutating it
 * never affects live state.
 */
export function serializeSessionState(
  session: SessionId,
  registries: SessionRegistries,
): SessionStateSnapshot {
  const locks = registries.locks.allLocks(session).map((lock) => ({
    ...lock,
    holder: { ...lock.holder },
  }));
  const presence = registries.presence.all(session).map((entry) => ({
    ...entry,
    member: { ...entry.member },
  }));
  const intents = registries.intents.allIntents(session).map((intent) => ({
    ...intent,
    owner: { ...intent.owner },
    modifyPaths: [...intent.modifyPaths],
    createPaths: intent.createPaths.map((creation) => ({ ...creation })),
  }));

  const snapshot: SessionStateSnapshot = {
    session,
    locks,
    presence,
    intents,
    highestRevision: registries.revisions.highest(session),
  };

  if (registries.messages !== undefined) {
    // Deep, independent copies so persisting/mutating the snapshot never
    // touches live registry state (Req 1.4, X.2).
    snapshot.messages = registries.messages
      .allMessages(session)
      .map((message) => ({ ...message, sender: { ...message.sender } }));
  }

  if (registries.tasks !== undefined) {
    snapshot.tasks = registries.tasks.allTasks(session).map((task) => ({
      ...task,
      assignee: { ...task.assignee },
      assigner: { ...task.assigner },
    }));
  }

  if (registries.notifications !== undefined) {
    snapshot.notifications = registries.notifications.allNotifications(session);
  }

  if (registries.diffs !== undefined) {
    snapshot.diffs = registries.diffs
      .allDiffs(session)
      .map((diff) => ({ ...diff, member: { ...diff.member } }));
  }

  return snapshot;
}

/**
 * The highest Event_Revision referenced anywhere in a snapshot — the snapshot's
 * `highestRevision` and every lock/presence/intent revision. Guards against a
 * `highestRevision` that trails an entity revision so the resumed counter can
 * never re-issue a persisted revision (Req 1.6).
 */
function maxPersistedRevision(snapshot: SessionStateSnapshot): number {
  let max = snapshot.highestRevision;
  for (const lock of snapshot.locks) {
    if (lock.eventRevision > max) {
      max = lock.eventRevision;
    }
  }
  for (const entry of snapshot.presence) {
    if (entry.eventRevision > max) {
      max = entry.eventRevision;
    }
  }
  for (const intent of snapshot.intents) {
    if (intent.eventRevision > max) {
      max = intent.eventRevision;
    }
  }
  for (const message of snapshot.messages ?? []) {
    if (message.eventRevision > max) {
      max = message.eventRevision;
    }
  }
  for (const task of snapshot.tasks ?? []) {
    if (task.eventRevision > max) {
      max = task.eventRevision;
    }
  }
  for (const notification of snapshot.notifications ?? []) {
    if (notification.eventRevision > max) {
      max = notification.eventRevision;
    }
  }
  for (const diff of snapshot.diffs ?? []) {
    if (diff.eventRevision > max) {
      max = diff.eventRevision;
    }
  }
  return max;
}

/**
 * Restore a {@link SessionStateSnapshot} into the registries, replacing any
 * existing state for the snapshot's session (Req 1.5, 1.6, 9.5). Locks, intents,
 * and presence are reinstalled with their winners recomputed deterministically
 * from Event_Revisions, then the shared {@link RevisionCounter} is resumed above
 * the max persisted revision so the next assignment for the session is strictly
 * greater than anything issued before the restart (Req 1.6). Resume only ever
 * raises the counter, so restoring a stale snapshot can never rewind it.
 */
export function restoreSessionState(
  snapshot: SessionStateSnapshot,
  registries: SessionRegistries,
): void {
  registries.locks.restore(snapshot.session, snapshot.locks);
  registries.intents.restore(snapshot.session, snapshot.intents);
  registries.presence.restore(snapshot.session, snapshot.presence);
  if (registries.messages !== undefined) {
    registries.messages.restore(snapshot.session, snapshot.messages ?? []);
  }
  if (registries.tasks !== undefined) {
    registries.tasks.restore(snapshot.session, snapshot.tasks ?? []);
  }
  if (registries.notifications !== undefined) {
    registries.notifications.restore(
      snapshot.session,
      snapshot.notifications ?? [],
    );
  }
  if (registries.diffs !== undefined) {
    registries.diffs.restore(snapshot.session, snapshot.diffs ?? []);
  }
  registries.revisions.resume(snapshot.session, maxPersistedRevision(snapshot));
}
