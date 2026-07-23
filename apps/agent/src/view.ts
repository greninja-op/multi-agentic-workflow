/**
 * The agent's single, consistent cached view of authoritative coordination state
 * (task 9.3, 9.5; Req 9, 31.1–31.5, 33, 35; design §3.2, §4.6).
 *
 * Every local client (the embedded Local_MCP_Server and the Editor_Extension)
 * reads this one view, so multiple clients under one device identity always see
 * the same host state (multi-client fan-in, Req 31.1). The view is the set of
 * active {@link CoordinationUpdate} entries maintained by `@cfls/core-state`'s
 * {@link AgentSyncCache}: it is fed by host broadcasts and reconnect sync, is
 * idempotent/order-preserving (never re-applies an event, never misses one), and
 * exposes a converged, possibly-stale snapshot while offline (Req 33.1).
 *
 * For risk queries the cached entries are reconstructed into the
 * lock/presence/intent shapes {@link buildRiskMap} consumes; the requesting
 * member's own activity is excluded from its own Risk_Map (Req 31.5) by
 * `buildRiskMap` itself.
 */

import {
  AgentSyncCache,
  buildRiskMap,
  DiffRegistry,
  MessageRegistry,
  NotificationRegistry,
  normalizePath,
  resolveMode,
  TaskRegistry,
  type RepositoryRulesConfig,
  type SyncResponse,
} from "@cfls/core-state";
import type {
  CoordinationUpdate,
  DeclaredIntent,
  DependencyGraph,
  LiveDiffDto,
  LivenessState,
  Lock,
  MemberRef,
  MessageDto,
  NotificationDto,
  Presence,
  RiskMapEntry,
  SessionId,
  SessionStateSnapshot,
  TaskDto,
} from "@cfls/protocol";

/** A planned-file-creation surfaced in the Risk_Map (design §3.4 #1). */
export interface PlannedCreation {
  path: string;
  memberId: string;
}

/** A live file-level signal shown in the local team activity projection. */
export interface TeamActivityFile {
  path: string;
  roles: Array<"editing" | "soft-lock" | "intent" | "planned-create">;
}

/** A member-declared task reconstructed from intent coordination updates. */
export interface TeamActivityTask {
  intentId: string;
  description: string;
  modifyPaths: string[];
  createPaths: string[];
}

/** The currently active, metadata-only coordination state for one member. */
export interface TeamMemberActivity {
  memberId: string;
  deviceIds: string[];
  files: TeamActivityFile[];
  tasks: TeamActivityTask[];
  lastEventRevision: number;
}

/**
 * The agent-side converged view of one or more Repository_Sessions. Thin wrapper
 * over {@link AgentSyncCache} that adds risk-map reconstruction and staleness.
 */
export class AgentView {
  private readonly cache = new AgentSyncCache();
  /** V2 messaging view (Phase 1), fed by host `message.update` broadcasts. */
  private readonly messages = new MessageRegistry();
  /** V2 task view (Phase 2), fed by host `task.update` broadcasts. */
  private readonly tasks = new TaskRegistry();
  /** V2 notification view (Phase 3), fed by host `notify.push`. */
  private readonly notifications = new NotificationRegistry();
  /** V2 live-diff view (Phase 5), fed by host `diff.update` broadcasts. */
  private readonly diffs = new DiffRegistry();
  /** V2 liveness view (Phase 3): `session_key` → memberId → state. */
  private readonly liveness = new Map<string, Map<string, LivenessState>>();

  /** Apply a single host broadcast to the view (idempotent by revision). */
  applyUpdate(session: SessionId, update: CoordinationUpdate): void {
    this.cache.applyEvents(session, [update]);
  }

  // ---- V2 messaging (Phase 1; Req 1.1–1.4) ---------------------------------

  /** Apply a host `message.update` (added/updated) to the message view. */
  applyMessage(session: SessionId, message: MessageDto): void {
    this.messages.upsert(session, message);
  }

  /** Locally mark a message read for `memberId` (also sent to the host). */
  markMessageReadLocal(
    session: SessionId,
    messageId: string,
    memberId: string,
  ): void {
    this.messages.markRead(session, messageId, memberId);
  }

  /** Messages visible to `memberId` (sent by or addressed to it). */
  messagesForMember(session: SessionId, memberId: string): MessageDto[] {
    return this.messages.messagesFor(session, memberId);
  }

  /** Count of messages addressed to `memberId` that it has not read (Req 1.4). */
  unreadForMember(session: SessionId, memberId: string): number {
    return this.messages.unreadCountFor(session, memberId);
  }

  /** Unanswered questions addressed to `memberId` (Req 1.3). */
  openQuestionsForMember(session: SessionId, memberId: string): MessageDto[] {
    return this.messages.openQuestionsFor(session, memberId);
  }

  /** Restore the message view from a snapshot's messages (reconnect, Req X.2). */
  loadMessages(
    session: SessionId,
    messages: readonly MessageDto[],
  ): void {
    this.messages.restore(session, messages);
  }

  // ---- V2 tasks (Phase 2; Req 2.1–2.3) -------------------------------------

  /** Apply a host `task.update` (added/updated) to the task view. */
  applyTask(session: SessionId, task: TaskDto): void {
    this.tasks.upsert(session, task);
  }

  /** Every task in the session (ordered by eventRevision). */
  allTasks(session: SessionId): TaskDto[] {
    return this.tasks.allTasks(session);
  }

  /** `memberId`'s accepted Task_List (accepted/in_progress/done). */
  taskListForMember(session: SessionId, memberId: string): TaskDto[] {
    return this.tasks.taskListFor(session, memberId);
  }

  /** Proposed tasks awaiting `memberId`'s approval (Req 2.2). */
  incomingProposalsForMember(
    session: SessionId,
    memberId: string,
  ): TaskDto[] {
    return this.tasks.incomingProposalsFor(session, memberId);
  }

  // ---- V2 liveness & notifications (Phase 3; Req 3.1–3.3) ------------------

  /** Apply a host `liveness.update` to the liveness view. */
  applyLiveness(
    session: SessionId,
    memberId: string,
    state: LivenessState,
  ): void {
    const key = `${session.repoId}\u0000${session.teamId}\u0000${session.branch}`;
    let states = this.liveness.get(key);
    if (states === undefined) {
      states = new Map();
      this.liveness.set(key, states);
    }
    states.set(memberId, state);
  }

  /** Current liveness states for a session (sorted by memberId). */
  livenessStates(
    session: SessionId,
  ): { memberId: string; state: LivenessState }[] {
    const key = `${session.repoId}\u0000${session.teamId}\u0000${session.branch}`;
    const states = this.liveness.get(key);
    if (states === undefined) {
      return [];
    }
    return [...states.entries()]
      .map(([memberId, state]) => ({ memberId, state }))
      .sort((a, b) => a.memberId.localeCompare(b.memberId));
  }

  /** Apply a host `notify.push` to the notification view. */
  applyNotification(session: SessionId, notification: NotificationDto): void {
    this.notifications.add(session, notification);
  }

  /** Notifications addressed to `memberId` (Req 3.2). */
  notificationsForMember(
    session: SessionId,
    memberId: string,
  ): NotificationDto[] {
    return this.notifications.forMember(session, memberId);
  }

  // ---- V2 live diffs (Phase 5; Req 5.1–5.3) --------------------------------

  /** Apply a host `diff.update` (shared/removed) to the live-diff view. */
  applyDiff(session: SessionId, op: "shared" | "removed", diff: LiveDiffDto): void {
    if (op === "removed") {
      this.diffs.remove(session, diff.member.memberId, diff.path);
      return;
    }
    this.diffs.share(session, diff);
  }

  /** Every currently-shared Live_Diff in the session (Req 5.5). */
  allDiffs(session: SessionId): LiveDiffDto[] {
    return this.diffs.allDiffs(session);
  }

  /** Apply a batch of host broadcasts to the view. */
  applyUpdates(
    session: SessionId,
    updates: readonly CoordinationUpdate[],
  ): void {
    this.cache.applyEvents(session, updates);
  }

  /** Apply a reconnect {@link SyncResponse}, converging + clearing staleness. */
  applySync(session: SessionId, response: SyncResponse): void {
    this.cache.applySync(session, response);
    // A snapshot fallback carries the full message history; restore it so
    // messages sent while offline are delivered (Req X.2). Incremental syncs
    // deliver missed messages over the separate message channel instead.
    if (response.kind === "snapshot") {
      this.messages.restore(session, response.snapshot.messages ?? []);
      this.tasks.restore(session, response.snapshot.tasks ?? []);
      this.notifications.restore(session, response.snapshot.notifications ?? []);
      this.diffs.restore(session, response.snapshot.diffs ?? []);
    }
  }

  /** Seed the view from a locally-cached snapshot (offline start, Req 35.4). */
  loadSnapshot(session: SessionId, snapshot: SessionStateSnapshot): void {
    this.cache.applySnapshot(session, snapshot);
    this.messages.restore(session, snapshot.messages ?? []);
    this.tasks.restore(session, snapshot.tasks ?? []);
    this.notifications.restore(session, snapshot.notifications ?? []);
    this.diffs.restore(session, snapshot.diffs ?? []);
  }

  /** Mark the view stale on connectivity loss (Req 33.2). */
  markStale(): void {
    this.cache.markStale();
  }

  /** Whether the cached view is currently stale (Offline_State). */
  isStale(): boolean {
    return this.cache.isStale();
  }

  /** The highest Event_Revision applied for a session (reconnect `fromRevision`). */
  highestApplied(session: SessionId): number {
    return this.cache.highestApplied(session);
  }

  /** The raw active coordination entries for a session (converged state). */
  entries(session: SessionId): CoordinationUpdate[] {
    return this.cache.cachedEntries(session);
  }

  /**
   * Reconstruct the lock/presence/intent projections needed to build a Risk_Map
   * from the cached entries. Lock modes are resolved from the shared rules
   * config (the broadcast carries only the path), matching how the host itself
   * classifies risk (design §10.1).
   */
  private reconstruct(
    session: SessionId,
    rules: RepositoryRulesConfig,
  ): { locks: Lock[]; presence: Presence[]; intents: DeclaredIntent[] } {
    const locks: Lock[] = [];
    const presence: Presence[] = [];
    const intents: DeclaredIntent[] = [];
    let seq = 0;
    for (const entry of this.entries(session)) {
      const path = entry.path === undefined ? "" : normalizePath(entry.path);
      switch (entry.entryType) {
        case "soft_lock":
          locks.push({
            lockId: `cached-${(seq += 1)}`,
            scope: path,
            scopeKind: "file",
            mode: resolveMode(path, rules),
            holder: entry.member,
            branch: session.branch,
            eventRevision: entry.eventRevision,
            acquiredAt: "",
            concurrent: false,
          });
          break;
        case "presence":
          presence.push({
            member: entry.member,
            path,
            state: "editing",
            eventRevision: entry.eventRevision,
          });
          break;
        case "intent":
          intents.push({
            intentId: entry.intent?.intentId ?? `cached-intent-${(seq += 1)}`,
            owner: entry.member,
            agentId: entry.member.deviceId,
            modifyPaths: [path],
            createPaths: [],
            scopeKind: "file",
            branch: session.branch,
            description: entry.intent?.description ?? "",
            eventRevision: entry.eventRevision,
          });
          break;
        case "planned_file_creation":
          intents.push({
            intentId: entry.intent?.intentId ?? `cached-planned-${(seq += 1)}`,
            owner: entry.member,
            agentId: entry.member.deviceId,
            modifyPaths: [],
            createPaths: [{ path }],
            scopeKind: "file",
            branch: session.branch,
            description: entry.intent?.description ?? "",
            eventRevision: entry.eventRevision,
          });
          break;
        default:
          break; // dependency_risk is derived from the graph, not cached entries.
      }
    }
    return { locks, presence, intents };
  }

  /**
   * Project the Risk_Map for `requester`, excluding its own activity (Req 31.5).
   * `graph` supplies indirect/reverse-dependency/shared-contract risk (Req 22).
   */
  riskMap(
    session: SessionId,
    requester: MemberRef,
    rules: RepositoryRulesConfig,
    graph?: DependencyGraph,
  ): RiskMapEntry[] {
    const { locks, presence, intents } = this.reconstruct(session, rules);
    return buildRiskMap({
      requester,
      branch: session.branch,
      locks,
      presence,
      intents,
      rules,
      ...(graph !== undefined ? { graph } : {}),
    });
  }

  /** Planned file creations by OTHER members (own excluded, Req 31.5). */
  plannedCreations(
    session: SessionId,
    requester: MemberRef,
  ): PlannedCreation[] {
    const out = new Map<string, PlannedCreation>();
    for (const entry of this.entries(session)) {
      if (
        entry.entryType !== "planned_file_creation" ||
        entry.path === undefined ||
        entry.member.memberId === requester.memberId
      ) {
        continue;
      }
      const path = normalizePath(entry.path);
      out.set(`${path}\u0000${entry.member.memberId}`, {
        path,
        memberId: entry.member.memberId,
      });
    }
    return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Build the live, metadata-only team projection used by the Local API, MCP,
   * and editor panel. Only members with active coordination entries appear;
   * membership/idle roster data remains a host concern rather than being
   * invented by this cache.
   */
  teamActivity(session: SessionId): TeamMemberActivity[] {
    interface MutableTask {
      intentId: string;
      description: string;
      modifyPaths: Set<string>;
      createPaths: Set<string>;
    }
    interface MutableMember {
      memberId: string;
      deviceIds: Set<string>;
      files: Map<string, Set<TeamActivityFile["roles"][number]>>;
      tasks: Map<string, MutableTask>;
      lastEventRevision: number;
    }

    const members = new Map<string, MutableMember>();
    const memberFor = (update: CoordinationUpdate): MutableMember => {
      let member = members.get(update.member.memberId);
      if (member === undefined) {
        member = {
          memberId: update.member.memberId,
          deviceIds: new Set(),
          files: new Map(),
          tasks: new Map(),
          lastEventRevision: 0,
        };
        members.set(member.memberId, member);
      }
      member.deviceIds.add(update.member.deviceId);
      member.lastEventRevision = Math.max(
        member.lastEventRevision,
        update.eventRevision,
      );
      return member;
    };

    const addFileRole = (
      member: MutableMember,
      path: string,
      role: TeamActivityFile["roles"][number],
    ): void => {
      const normalized = normalizePath(path);
      const roles = member.files.get(normalized) ?? new Set();
      roles.add(role);
      member.files.set(normalized, roles);
    };

    for (const update of this.entries(session)) {
      if (update.path === undefined) {
        continue;
      }
      const member = memberFor(update);
      switch (update.entryType) {
        case "presence":
          addFileRole(member, update.path, "editing");
          break;
        case "soft_lock":
          addFileRole(member, update.path, "soft-lock");
          break;
        case "intent":
        case "planned_file_creation": {
          const role =
            update.entryType === "intent" ? "intent" : "planned-create";
          addFileRole(member, update.path, role);
          const intentId = update.intent?.intentId ?? `path:${update.path}`;
          const task = member.tasks.get(intentId) ?? {
            intentId,
            description: update.intent?.description ?? "",
            modifyPaths: new Set<string>(),
            createPaths: new Set<string>(),
          };
          if (update.entryType === "intent") {
            task.modifyPaths.add(normalizePath(update.path));
          } else {
            task.createPaths.add(normalizePath(update.path));
          }
          member.tasks.set(intentId, task);
          break;
        }
        default:
          break;
      }
    }

    return [...members.values()]
      .map((member) => ({
        memberId: member.memberId,
        deviceIds: [...member.deviceIds].sort((a, b) => a.localeCompare(b)),
        files: [...member.files.entries()]
          .map(([path, roles]) => ({
            path,
            roles: [...roles].sort((a, b) => a.localeCompare(b)),
          }))
          .sort((a, b) => a.path.localeCompare(b.path)),
        tasks: [...member.tasks.values()]
          .map((task) => ({
            intentId: task.intentId,
            description: task.description,
            modifyPaths: [...task.modifyPaths].sort((a, b) =>
              a.localeCompare(b),
            ),
            createPaths: [...task.createPaths].sort((a, b) =>
              a.localeCompare(b),
            ),
          }))
          .sort((a, b) => a.intentId.localeCompare(b.intentId)),
        lastEventRevision: member.lastEventRevision,
      }))
      .sort((a, b) => a.memberId.localeCompare(b.memberId));
  }
}
