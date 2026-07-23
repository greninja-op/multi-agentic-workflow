/**
 * {@link CoreStateAgentPort} — an in-memory {@link AgentPort} backed by the real
 * `@cfls/core-state` registries.
 *
 * This is NOT the network agent (that is Task 9's `CoordinationAgent`). It is a
 * faithful, dependency-free stand-in that drives the pure core-state engine so
 * the Local_MCP_Server tools can be exercised end-to-end — including offline
 * behaviour — without a host or a socket. It is used by this package's
 * integration and unit tests and doubles as a reference implementation of the
 * port contract.
 *
 * Connectivity is simulated with a simple `online` flag (toggle via
 * {@link CoreStateAgentPort.setOnline}). While offline, every mutating tool
 * returns `OFFLINE_QUEUED` and leaves core-state untouched (Req 4.8); queries
 * still succeed with the locally-cached (possibly stale) view (Req 33.1).
 */

import type {
  CoordinationUpdate,
  DependencyEdge,
  DependencyGraph,
  MemberRef,
  RiskMapEntry,
  SessionId,
} from "@cfls/protocol";
import {
  ALL_SOFT_CONFIG,
  buildRiskMap,
  buildNotification,
  DiffRegistry,
  IntentRegistry,
  LivenessTracker,
  LockRegistry,
  MessageRegistry,
  NotificationRegistry,
  normalizePath,
  normalizePathKey,
  PresenceRegistry,
  type RepositoryRulesConfig,
  resolveMode,
  RevisionCounter,
  RulesLunaBrain,
  sessionKey,
  TaskRegistry,
} from "@cfls/core-state";

import type {
  AgentResult,
  ConnectionSnapshot,
  StalenessSnapshot,
} from "./envelope";
import { offlineQueuedResult } from "./envelope";
import type {
  AcquireLockData,
  AcquireLockRequest,
  AgentPort,
  ConnectionStatusData,
  DeclareIntentData,
  DeclareIntentRequest,
  DependencyImpact,
  GetDependenciesData,
  GetDependenciesRequest,
  GetDependencyImpactData,
  GetDependencyImpactRequest,
  GetDependentsData,
  GetDependentsRequest,
  GetRiskMapData,
  GetRiskMapRequest,
  GetTeamStatusData,
  GetTeamStatusRequest,
  AssignTaskData,
  AssignTaskRequest,
  GetLivenessData,
  GetLivenessRequest,
  GetNotificationsData,
  GetNotificationsRequest,
  ListMessagesData,
  ListMessagesRequest,
  ListOpenQuestionsData,
  ListOpenQuestionsRequest,
  ListTasksData,
  ListTasksRequest,
  MarkMessageReadData,
  MarkMessageReadRequest,
  AskLunaData,
  AskLunaRequest,
  ShareDiffData,
  ShareDiffRequest,
  ListDiffsData,
  ListDiffsRequest,
  ProjectSessionStatusData,
  WakeData,
  WakeRequest,
  RespondTaskData,
  RespondTaskRequest,
  UpdateTaskProgressData,
  UpdateTaskProgressRequest,
  ReleaseLockData,
  ReleaseLockRequest,
  RiskPathEntry,
  SendMessageData,
  SendMessageRequest,
  SubscribeData,
  SubscribeRequest,
  UpdateIntentData,
  UpdateIntentRequest,
  WithdrawIntentData,
  WithdrawIntentRequest,
} from "./port";

/** Options controlling a {@link CoreStateAgentPort}. */
export interface CoreStateAgentOptions {
  /** The single Repository_Session this fake agent represents. */
  session: SessionId;
  /** The Team_Member/device this agent acts as (its own activity is excluded from risk). */
  self: MemberRef;
  /** AI_Agent identifier stamped on declared intents. */
  agentId?: string;
  /** Whether the agent starts connected to the host (default: true). */
  online?: boolean;
  /** The configured Host_URL surfaced in the connection envelope. */
  hostUrl?: string;
  /** ISO-8601 last-successful-sync time (default: now). */
  lastSyncAt?: string | null;
  /** Repository_Rules_Config used to resolve path modes (default: all-soft). */
  rules?: RepositoryRulesConfig;
  /** Optional metadata-only Dependency_Graph for dependency/risk queries. */
  graph?: DependencyGraph;
  /** Whether this agent is authorized for the session (default: true). */
  authorized?: boolean;
  /** Whether the session was derived from the manual-config fallback (default: false). */
  manualConfig?: boolean;
  /** Member ids currently connected (for get_connection_status). */
  connectedMembers?: string[];
  /** Member ids currently offline (for get_connection_status). */
  offlineMembers?: string[];
  /** Injectable clock for deterministic timestamps/staleness. */
  now?: () => number;
  /** Optional shared-contract identifiers per path (for get_dependency_impact). */
  contractsByPath?: Record<string, string[]>;
}

/** True when a glob pattern is malformed (unbalanced brackets or empty) (Req 32.4). */
function isMalformedGlob(glob: string): boolean {
  if (glob.trim().length === 0) {
    return true;
  }
  let depth = 0;
  for (const ch of glob) {
    if (ch === "[") {
      depth += 1;
    } else if (ch === "]") {
      depth -= 1;
      if (depth < 0) {
        return true;
      }
    }
  }
  return depth !== 0;
}

/** An in-memory {@link AgentPort} backed by the core-state registries. */
export class CoreStateAgentPort implements AgentPort {
  private readonly session: SessionId;
  private readonly self: MemberRef;
  private readonly agentId: string;
  private readonly hostUrl: string;
  private readonly rules: RepositoryRulesConfig;
  private readonly graph: DependencyGraph | undefined;
  private readonly manualConfig: boolean;
  private readonly connectedMembers: string[];
  private readonly offlineMembers: string[];
  private readonly now: () => number;
  private readonly contractsByPath: Record<string, string[]>;

  private online: boolean;
  private authorized: boolean;
  private lastSyncAt: string | null;

  private readonly locks = new LockRegistry();
  private readonly intents = new IntentRegistry();
  private readonly presence = new PresenceRegistry();
  private readonly messages = new MessageRegistry();
  private readonly tasks = new TaskRegistry();
  private readonly liveness = new LivenessTracker();
  private readonly notificationsRegistry = new NotificationRegistry();
  private readonly luna = new RulesLunaBrain();
  private readonly diffs = new DiffRegistry();
  private readonly revisions = new RevisionCounter();

  private lockSeq = 0;
  private intentSeq = 0;
  private messageSeq = 0;
  private taskSeq = 0;
  private notificationSeq = 0;
  private subscriptionSeq = 0;
  private readonly subscribers = new Map<
    string,
    (update: CoordinationUpdate) => void
  >();

  constructor(options: CoreStateAgentOptions) {
    this.session = options.session;
    this.self = options.self;
    this.agentId = options.agentId ?? "agent-1";
    this.online = options.online ?? true;
    this.hostUrl = options.hostUrl ?? "wss://host.example:8443";
    this.rules = options.rules ?? ALL_SOFT_CONFIG;
    this.graph = options.graph;
    this.authorized = options.authorized ?? true;
    this.manualConfig = options.manualConfig ?? false;
    this.connectedMembers = options.connectedMembers ?? [options.self.memberId];
    this.offlineMembers = options.offlineMembers ?? [];
    this.now = options.now ?? (() => Date.now());
    this.contractsByPath = options.contractsByPath ?? {};
    this.lastSyncAt =
      options.lastSyncAt === undefined
        ? new Date(this.now()).toISOString()
        : options.lastSyncAt;
  }

  // ---- Test controls --------------------------------------------------------

  /** Simulate connectivity changes; on reconnect the last-sync time advances. */
  setOnline(online: boolean): void {
    this.online = online;
    if (online) {
      this.lastSyncAt = new Date(this.now()).toISOString();
    }
  }

  /** Toggle authorization for the session (drives NOT_AUTHORIZED paths). */
  setAuthorized(authorized: boolean): void {
    this.authorized = authorized;
  }

  /** Emit a Coordination_Update to all registered subscribers (test helper). */
  emit(update: CoordinationUpdate): void {
    for (const listener of this.subscribers.values()) {
      listener(update);
    }
  }

  // ---- Envelope inputs ------------------------------------------------------

  getConnection(): ConnectionSnapshot {
    return {
      status: this.online ? "online" : "offline",
      hostUrl: this.hostUrl,
      lastSyncAt: this.lastSyncAt,
    };
  }

  getStaleness(): StalenessSnapshot {
    const secondsSinceSync =
      this.lastSyncAt === null
        ? null
        : Math.max(
            0,
            Math.floor((this.now() - Date.parse(this.lastSyncAt)) / 1000),
          );
    return { stale: !this.online, secondsSinceSync };
  }

  // ---- Guards ---------------------------------------------------------------

  private sameSession(session: SessionId): boolean {
    return sessionKey(session) === sessionKey(this.session);
  }

  private notAuthorized<T>(): AgentResult<T> {
    return {
      ok: false,
      error: {
        code: "AUTH_NOT_AUTHORIZED",
        message: "The agent is not authorized for this Repository_Session.",
      },
    };
  }

  private sessionNotFound<T>(): AgentResult<T> {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "Unknown Repository_Session.",
      },
    };
  }

  // ---- Queries --------------------------------------------------------------

  getRiskMap(req: GetRiskMapRequest): AgentResult<GetRiskMapData> {
    if (!this.sameSession(req.session)) {
      return this.sessionNotFound();
    }
    if (!this.authorized) {
      return this.notAuthorized();
    }
    const entries = buildRiskMap({
      requester: this.self,
      branch: this.session.branch,
      // Match the real agent's synchronized projection: concurrent claims are
      // retained by the host for promotion, while the client-facing Risk_Map
      // and team status expose the current winning lock only.
      locks: this.locks
        .allLocks(this.session)
        .filter((lock) => !lock.concurrent),
      presence: this.presence.all(this.session),
      intents: this.intents.allIntents(this.session),
      rules: this.rules,
      ...(this.graph !== undefined ? { graph: this.graph } : {}),
    });

    const paths: RiskPathEntry[] = entries.map((entry: RiskMapEntry) => {
      const explanation: RiskPathEntry["explanation"] = {
        type: entry.explanation.type,
      };
      if (entry.explanation.edges !== undefined) {
        explanation.edges = entry.explanation.edges;
      }
      if (entry.explanation.sharedContracts !== undefined) {
        explanation.sharedContracts = entry.explanation.sharedContracts;
      }
      return {
        path: entry.path,
        riskLevel: entry.riskLevel,
        contributors: entry.contributors.map((c) => ({
          memberId: c.member.memberId,
          kind: c.kind,
        })),
        explanation,
        acknowledgementRequired: entry.acknowledgementRequired,
      };
    });

    const planned = new Map<string, { path: string; memberId: string }>();
    for (const intent of this.intents.allIntents(this.session)) {
      if (intent.owner.memberId === this.self.memberId) {
        continue; // own activity excluded (Req 31.5).
      }
      for (const creation of intent.createPaths) {
        const path = normalizePath(creation.path);
        planned.set(`${path}\u0000${intent.owner.memberId}`, {
          path,
          memberId: intent.owner.memberId,
        });
      }
    }

    return {
      ok: true,
      data: {
        paths,
        plannedFileCreations: [...planned.values()].sort((a, b) =>
          a.path.localeCompare(b.path),
        ),
        highestRevision: this.revisions.highest(this.session),
      },
    };
  }

  getTeamStatus(req: GetTeamStatusRequest): AgentResult<GetTeamStatusData> {
    if (!this.sameSession(req.session)) {
      return this.sessionNotFound();
    }
    if (!this.authorized) {
      return this.notAuthorized();
    }

    type Role = "editing" | "soft-lock" | "intent" | "planned-create";
    interface MutableTask {
      intentId: string;
      description: string;
      modifyPaths: Set<string>;
      createPaths: Set<string>;
    }
    interface MutableMember {
      memberId: string;
      deviceIds: Set<string>;
      files: Map<string, Set<Role>>;
      tasks: Map<string, MutableTask>;
      lastEventRevision: number;
    }

    const members = new Map<string, MutableMember>();
    const memberFor = (member: MemberRef, revision: number): MutableMember => {
      let item = members.get(member.memberId);
      if (item === undefined) {
        item = {
          memberId: member.memberId,
          deviceIds: new Set(),
          files: new Map(),
          tasks: new Map(),
          lastEventRevision: 0,
        };
        members.set(item.memberId, item);
      }
      item.deviceIds.add(member.deviceId);
      item.lastEventRevision = Math.max(item.lastEventRevision, revision);
      return item;
    };
    const addFile = (item: MutableMember, path: string, role: Role): void => {
      const normalized = normalizePath(path);
      const roles = item.files.get(normalized) ?? new Set<Role>();
      roles.add(role);
      item.files.set(normalized, roles);
    };

    for (const lock of this.locks.allLocks(this.session)) {
      if (lock.concurrent) {
        continue;
      }
      const item = memberFor(lock.holder, lock.eventRevision);
      addFile(item, lock.scope, "soft-lock");
    }
    for (const presence of this.presence.all(this.session)) {
      if (presence.state === "stopped") {
        continue;
      }
      const item = memberFor(presence.member, presence.eventRevision);
      addFile(item, presence.path, "editing");
    }
    for (const intent of this.intents.allIntents(this.session)) {
      const item = memberFor(intent.owner, intent.eventRevision);
      const task: MutableTask = {
        intentId: intent.intentId,
        description: intent.description,
        modifyPaths: new Set(intent.modifyPaths.map(normalizePath)),
        createPaths: new Set(
          intent.createPaths.map((entry) => normalizePath(entry.path)),
        ),
      };
      item.tasks.set(task.intentId, task);
      for (const path of task.modifyPaths) {
        addFile(item, path, "intent");
      }
      for (const path of task.createPaths) {
        addFile(item, path, "planned-create");
      }
    }

    return {
      ok: true,
      data: {
        teamId: this.session.teamId,
        members: [...members.values()]
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
          .sort((a, b) => a.memberId.localeCompare(b.memberId)),
        highestRevision: this.revisions.highest(this.session),
      },
    };
  }

  getDependencyImpact(
    req: GetDependencyImpactRequest,
  ): AgentResult<GetDependencyImpactData> {
    const impacts: DependencyImpact[] = req.paths.map((rawPath) => {
      const path = normalizePath(rawPath);
      const present = this.presentInGraph(path);
      if (!present) {
        // Absent from the graph => empty result (Req 23.5).
        return {
          path,
          directDependencies: [],
          reverseDependencies: [],
          sharedContracts: [],
          riskLevel: resolveMode(path, this.rules),
          explanationPaths: [],
          presentInGraph: false,
        };
      }
      const reverse = this.dependedOnBy(path);
      return {
        path,
        directDependencies: this.dependsOn(path),
        reverseDependencies: reverse,
        sharedContracts: this.contractsByPath[path] ?? [],
        riskLevel: resolveMode(path, this.rules),
        explanationPaths: reverse.map((target) => ({
          target,
          via: this.edgesBetween(target, path),
        })),
        presentInGraph: true,
      };
    });
    return { ok: true, data: { impacts } };
  }

  getDependencies(
    req: GetDependenciesRequest,
  ): AgentResult<GetDependenciesData> {
    const path = normalizePath(req.path);
    return {
      ok: true,
      data: {
        dependsOn: this.dependsOn(path),
        presentInGraph: this.presentInGraph(path),
      },
    };
  }

  getDependents(req: GetDependentsRequest): AgentResult<GetDependentsData> {
    const path = normalizePath(req.path);
    return {
      ok: true,
      data: {
        dependedOnBy: this.dependedOnBy(path),
        presentInGraph: this.presentInGraph(path),
      },
    };
  }

  getConnectionStatus(): AgentResult<ConnectionStatusData> {
    return {
      ok: true,
      data: {
        status: this.online ? "online" : "offline",
        participants: {
          connected: [...this.connectedMembers],
          offline: [...this.offlineMembers],
        },
        manualCoordinationRequired: !this.online,
      },
    };
  }

  getProjectSessionStatus(): AgentResult<ProjectSessionStatusData> {
    return {
      ok: true,
      data: {
        session: {
          repoId: this.session.repoId,
          teamId: this.session.teamId,
          branch: this.session.branch,
          baseRevision: this.session.baseRevision,
          manualConfig: this.manualConfig,
        },
        authorized: this.authorized,
        memberId: this.self.memberId,
      },
    };
  }

  // ---- Mutations ------------------------------------------------------------

  declareIntent(req: DeclareIntentRequest): AgentResult<DeclareIntentData> {
    if (!this.online) {
      return offlineQueuedResult("declare_intent");
    }
    if (!this.sameSession(req.session)) {
      return this.sessionNotFound();
    }
    if (!this.authorized) {
      return this.notAuthorized();
    }
    const eventRevision = this.revisions.next(this.session);
    const intentId = `int-${(this.intentSeq += 1)}`;
    const result = this.intents.declare({
      session: this.session,
      intentId,
      owner: this.self,
      agentId: this.agentId,
      modifyPaths: req.modifyPaths,
      createPaths: req.createPaths,
      scopeKind: req.scopeKind ?? "file",
      branch: this.session.branch,
      description: req.description,
      eventRevision,
    });
    if (!result.ok) {
      return {
        ok: false,
        error: {
          code: result.code,
          message: (result.errors ?? []).join("; ") || "Invalid intent.",
        },
      };
    }
    return {
      ok: true,
      data: {
        intentId,
        eventRevision,
        reclassified: result.reclassified,
      },
    };
  }

  updateIntent(req: UpdateIntentRequest): AgentResult<UpdateIntentData> {
    if (!this.online) {
      return offlineQueuedResult("update_intent");
    }
    const eventRevision = this.revisions.next(this.session);
    const result = this.intents.update({
      session: this.session,
      intentId: req.intentId,
      requester: this.self,
      modifyPaths: req.modifyPaths,
      createPaths: req.createPaths,
      description: req.description,
      eventRevision,
    });
    if (!result.ok) {
      return {
        ok: false,
        error: {
          code: result.code,
          message: (result.errors ?? []).join("; ") || "Update rejected.",
        },
      };
    }
    return { ok: true, data: { eventRevision } };
  }

  withdrawIntent(req: WithdrawIntentRequest): AgentResult<WithdrawIntentData> {
    if (!this.online) {
      return offlineQueuedResult("withdraw_intent");
    }
    const result = this.intents.withdraw({
      session: this.session,
      intentId: req.intentId,
      requester: this.self,
    });
    if (!result.ok) {
      return {
        ok: false,
        error: { code: result.code, message: "Withdraw rejected." },
      };
    }
    const eventRevision = this.revisions.next(this.session);
    return { ok: true, data: { eventRevision } };
  }

  acquireLock(req: AcquireLockRequest): AgentResult<AcquireLockData> {
    if (!this.online) {
      return offlineQueuedResult("acquire_lock");
    }
    if (!this.sameSession(req.session)) {
      return this.sessionNotFound();
    }
    if (!this.authorized) {
      return this.notAuthorized();
    }
    if (req.scopeKind === "glob" && isMalformedGlob(req.scope)) {
      return {
        ok: false,
        error: {
          code: "FORMAT_ERROR",
          message: `Malformed glob: '${req.scope}'.`,
        },
      };
    }
    const eventRevision = this.revisions.next(this.session);
    const lockId = `lk-${(this.lockSeq += 1)}`;
    const outcome = this.locks.acquire({
      session: this.session,
      lockId,
      scope: req.scope,
      scopeKind: req.scopeKind,
      mode: resolveMode(req.scope, this.rules),
      holder: this.self,
      branch: this.session.branch,
      eventRevision,
      acquiredAt: new Date(this.now()).toISOString(),
    });
    if (outcome.contended) {
      return {
        ok: true,
        data: {
          eventRevision,
          granted: false,
          concurrentClaim: true,
          winner: {
            memberId: outcome.winner.holder.memberId,
            eventRevision: outcome.winner.eventRevision,
          },
        },
      };
    }
    return { ok: true, data: { lockId, eventRevision, granted: true } };
  }

  releaseLock(req: ReleaseLockRequest): AgentResult<ReleaseLockData> {
    if (!this.online) {
      return offlineQueuedResult("release_lock");
    }
    const result = this.locks.release({
      session: this.session,
      requester: this.self,
      branch: this.session.branch,
      ...(req.lockId !== undefined ? { lockId: req.lockId } : {}),
      ...(req.scope !== undefined ? { scope: req.scope } : {}),
    });
    if (!result.ok) {
      return {
        ok: false,
        error: { code: result.code, message: "Release rejected." },
      };
    }
    const eventRevision = this.revisions.next(this.session);
    return { ok: true, data: { released: true, eventRevision } };
  }

  subscribeToCoordinationUpdates(
    req: SubscribeRequest,
    onUpdate?: (update: CoordinationUpdate) => void,
  ): AgentResult<SubscribeData> {
    if (!this.sameSession(req.session)) {
      return this.sessionNotFound();
    }
    if (!this.authorized) {
      return this.notAuthorized();
    }
    const subscriptionId = `sub-${(this.subscriptionSeq += 1)}`;
    if (onUpdate !== undefined) {
      this.subscribers.set(subscriptionId, onUpdate);
    }
    return { ok: true, data: { subscriptionId } };
  }

  // ---- V2 messaging (Phase 1; Req 1.1–1.4) ---------------------------------

  sendMessage(req: SendMessageRequest): AgentResult<SendMessageData> {
    if (!this.online) {
      return offlineQueuedResult("send_message");
    }
    if (!this.sameSession(req.session)) {
      return this.sessionNotFound();
    }
    if (!this.authorized) {
      return this.notAuthorized();
    }
    const eventRevision = this.revisions.next(this.session);
    const messageId = `msg-${(this.messageSeq += 1)}`;
    const { message } = this.messages.append({
      session: this.session,
      messageId,
      kind: req.kind,
      sender: this.self,
      ...(req.toMemberId !== undefined ? { toMemberId: req.toMemberId } : {}),
      priority: req.priority ?? "normal",
      body: req.body,
      ...(req.correlationId !== undefined
        ? { correlationId: req.correlationId }
        : {}),
      eventRevision,
      sentAt: new Date(this.now()).toISOString(),
    });
    return { ok: true, data: { messageId: message.messageId, eventRevision } };
  }

  listMessages(req: ListMessagesRequest): AgentResult<ListMessagesData> {
    if (!this.sameSession(req.session)) {
      return this.sessionNotFound();
    }
    if (!this.authorized) {
      return this.notAuthorized();
    }
    return {
      ok: true,
      data: {
        messages: this.messages.messagesFor(this.session, this.self.memberId),
        unreadCount: this.messages.unreadCountFor(
          this.session,
          this.self.memberId,
        ),
      },
    };
  }

  markMessageRead(
    req: MarkMessageReadRequest,
  ): AgentResult<MarkMessageReadData> {
    if (!this.online) {
      return offlineQueuedResult("mark_message_read");
    }
    this.messages.markRead(this.session, req.messageId, this.self.memberId);
    const eventRevision = this.revisions.next(this.session);
    return { ok: true, data: { eventRevision } };
  }

  listOpenQuestions(
    req: ListOpenQuestionsRequest,
  ): AgentResult<ListOpenQuestionsData> {
    if (!this.sameSession(req.session)) {
      return this.sessionNotFound();
    }
    if (!this.authorized) {
      return this.notAuthorized();
    }
    return {
      ok: true,
      data: {
        questions: this.messages.openQuestionsFor(
          this.session,
          this.self.memberId,
        ),
      },
    };
  }

  // ---- V2 tasks (Phase 2; Req 2.1–2.3) -------------------------------------

  assignTask(req: AssignTaskRequest): AgentResult<AssignTaskData> {
    if (!this.online) {
      return offlineQueuedResult("assign_task");
    }
    if (!this.sameSession(req.session)) {
      return this.sessionNotFound();
    }
    if (!this.authorized) {
      return this.notAuthorized();
    }
    const eventRevision = this.revisions.next(this.session);
    const taskId = `task-${(this.taskSeq += 1)}`;
    this.tasks.assign({
      session: this.session,
      taskId,
      title: req.title,
      description: req.description,
      assignee: { memberId: req.assigneeMemberId, deviceId: "" },
      assigner: this.self,
      eventRevision,
    });
    return { ok: true, data: { taskId, eventRevision } };
  }

  respondTask(req: RespondTaskRequest): AgentResult<RespondTaskData> {
    if (!this.online) {
      return offlineQueuedResult("respond_to_task");
    }
    const eventRevision = this.revisions.next(this.session);
    const result = this.tasks.respond({
      session: this.session,
      taskId: req.taskId,
      requester: this.self,
      accept: req.accept,
      eventRevision,
    });
    if (!result.ok) {
      return { ok: false, error: { code: result.code, message: result.reason } };
    }
    return { ok: true, data: { eventRevision } };
  }

  updateTaskProgress(
    req: UpdateTaskProgressRequest,
  ): AgentResult<UpdateTaskProgressData> {
    if (!this.online) {
      return offlineQueuedResult("update_task_progress");
    }
    const eventRevision = this.revisions.next(this.session);
    const result = this.tasks.progress({
      session: this.session,
      taskId: req.taskId,
      requester: this.self,
      status: req.status,
      eventRevision,
    });
    if (!result.ok) {
      return { ok: false, error: { code: result.code, message: result.reason } };
    }
    return { ok: true, data: { eventRevision } };
  }

  listTasks(req: ListTasksRequest): AgentResult<ListTasksData> {
    if (!this.sameSession(req.session)) {
      return this.sessionNotFound();
    }
    if (!this.authorized) {
      return this.notAuthorized();
    }
    return {
      ok: true,
      data: {
        tasks: this.tasks.allTasks(this.session),
        myTaskList: this.tasks.taskListFor(this.session, this.self.memberId),
        incomingProposals: this.tasks.incomingProposalsFor(
          this.session,
          this.self.memberId,
        ),
      },
    };
  }

  // ---- V2 liveness, notifications & wake (Phase 3; Req 3.1–3.3) ------------

  getLiveness(req: GetLivenessRequest): AgentResult<GetLivenessData> {
    if (!this.sameSession(req.session)) {
      return this.sessionNotFound();
    }
    if (!this.authorized) {
      return this.notAuthorized();
    }
    const now = this.now();
    // Seed the tracker from the simulated roster; treat self as recently active.
    this.liveness.setConnected(this.session, [
      ...this.connectedMembers,
      this.self.memberId,
    ]);
    this.liveness.recordActivity(this.session, this.self.memberId, now);
    return { ok: true, data: { members: this.liveness.states(this.session, now) } };
  }

  wake(req: WakeRequest): AgentResult<WakeData> {
    if (!this.online) {
      return offlineQueuedResult("wake_member");
    }
    if (!this.sameSession(req.session)) {
      return this.sessionNotFound();
    }
    if (!this.authorized) {
      return this.notAuthorized();
    }
    const eventRevision = this.revisions.next(this.session);
    this.notificationsRegistry.add(
      this.session,
      buildNotification({
        notificationId: `notif-${(this.notificationSeq += 1)}`,
        toMemberId: req.targetMemberId,
        source: "wake",
        refId: req.targetMemberId,
        summary:
          req.reason !== undefined && req.reason.length > 0
            ? `${this.self.memberId}: ${req.reason}`
            : `${this.self.memberId} asked you to resume`,
        eventRevision,
      }),
    );
    return { ok: true, data: { targetMemberId: req.targetMemberId } };
  }

  getNotifications(
    req: GetNotificationsRequest,
  ): AgentResult<GetNotificationsData> {
    if (!this.sameSession(req.session)) {
      return this.sessionNotFound();
    }
    if (!this.authorized) {
      return this.notAuthorized();
    }
    return {
      ok: true,
      data: {
        notifications: this.notificationsRegistry.forMember(
          this.session,
          this.self.memberId,
        ),
      },
    };
  }

  // ---- V2 Luna orchestrator (Phase 4; Req 4.1–4.5) -------------------------

  askLuna(req: AskLunaRequest): AgentResult<AskLunaData> {
    if (!this.online) {
      return offlineQueuedResult("ask_luna");
    }
    if (!this.sameSession(req.session)) {
      return this.sessionNotFound();
    }
    if (!this.authorized) {
      return this.notAuthorized();
    }
    const decision = this.luna.decide(
      {
        action: req.action,
        prompt: req.prompt,
        ...(req.refId !== undefined ? { refId: req.refId } : {}),
      },
      {
        session: this.session,
        requester: this.self,
        members: [...this.connectedMembers, this.self.memberId],
        liveness: [{ memberId: this.self.memberId, state: "active" }],
        tasks: this.tasks.allTasks(this.session),
      },
    );
    return {
      ok: true,
      data: { action: decision.action, summary: decision.summary },
    };
  }

  // ---- V2 live diffs (Phase 5; Req 5.1–5.5) --------------------------------

  shareDiff(req: ShareDiffRequest): AgentResult<ShareDiffData> {
    if (!this.online) {
      return offlineQueuedResult("share_diff");
    }
    if (!this.sameSession(req.session)) {
      return this.sessionNotFound();
    }
    if (!this.authorized) {
      return this.notAuthorized();
    }
    const eventRevision = this.revisions.next(this.session);
    const patch = req.patch ?? "";
    const op = this.diffs.share(this.session, {
      path: normalizePath(req.path),
      member: this.self,
      patch,
      eventRevision,
    });
    return { ok: true, data: { eventRevision, shared: op === "shared" } };
  }

  listDiffs(req: ListDiffsRequest): AgentResult<ListDiffsData> {
    if (!this.sameSession(req.session)) {
      return this.sessionNotFound();
    }
    if (!this.authorized) {
      return this.notAuthorized();
    }
    return { ok: true, data: { diffs: this.diffs.allDiffs(this.session) } };
  }

  // ---- Dependency-graph helpers --------------------------------------------

  private allEdges(): DependencyEdge[] {
    if (this.graph === undefined) {
      return [];
    }
    return this.graph.modules.flatMap((module) => module.edges);
  }

  private dependsOn(path: string): string[] {
    const key = normalizePathKey(path);
    const out = new Set<string>();
    for (const edge of this.allEdges()) {
      if (normalizePathKey(edge.from) === key) {
        out.add(normalizePath(edge.to));
      }
    }
    return [...out].sort((a, b) => a.localeCompare(b));
  }

  private dependedOnBy(path: string): string[] {
    const key = normalizePathKey(path);
    const out = new Set<string>();
    for (const edge of this.allEdges()) {
      if (normalizePathKey(edge.to) === key) {
        out.add(normalizePath(edge.from));
      }
    }
    return [...out].sort((a, b) => a.localeCompare(b));
  }

  private edgesBetween(from: string, to: string): DependencyEdge[] {
    const fromKey = normalizePathKey(from);
    const toKey = normalizePathKey(to);
    return this.allEdges().filter(
      (edge) =>
        normalizePathKey(edge.from) === fromKey &&
        normalizePathKey(edge.to) === toKey,
    );
  }

  private presentInGraph(path: string): boolean {
    if (this.graph === undefined) {
      return false;
    }
    const key = normalizePathKey(path);
    for (const module of this.graph.modules) {
      if (normalizePathKey(module.sourceFile) === key) {
        return true;
      }
      for (const edge of module.edges) {
        if (
          normalizePathKey(edge.from) === key ||
          normalizePathKey(edge.to) === key
        ) {
          return true;
        }
      }
    }
    return false;
  }
}
