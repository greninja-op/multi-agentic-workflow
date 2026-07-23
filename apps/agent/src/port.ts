/**
 * {@link AgentCoordinationPort} — the CoordinationAgent's real implementation of
 * the `@cfls/mcp-server` {@link AgentPort} (task 9.3; Req 2.6, 4.x, 31.1–31.5).
 *
 * This is the single object every local client — the embedded Local_MCP_Server
 * and the Editor_Extension — talks to, so all clients under one device identity
 * share one consistent host view (multi-client fan-in, Req 31.1). Queries read
 * the cached {@link AgentView} and succeed even while offline with stale-marked
 * data (Req 33.1); mutations are forwarded to the CoordinationHost through the
 * {@link HostGateway} and return `OFFLINE_QUEUED` while offline, never falsely
 * reporting host acceptance (Req 4.8). The requesting member's own activity is
 * excluded from its own Risk_Map (Req 31.5).
 */

import {
  normalizePath,
  normalizePathKey,
  resolveMode,
  type RepositoryRulesConfig,
} from "@cfls/core-state";
import type {
  CoordinationUpdate,
  DependencyEdge,
  DependencyGraph,
  LiveDiffDto,
  LivenessState,
  MemberRef,
  MessageDto,
  NotificationDto,
  RiskMapEntry,
  SessionId,
  TaskDto,
} from "@cfls/protocol";
import type {
  AcquireLockData,
  AcquireLockRequest,
  AgentPort,
  AgentResult,
  ConnectionSnapshot,
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
  AskLunaData,
  AskLunaRequest,
  ShareDiffData,
  ShareDiffRequest,
  ListDiffsData,
  ListDiffsRequest,
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
  ProjectSessionStatusData,
  RespondTaskData,
  RespondTaskRequest,
  UpdateTaskProgressData,
  UpdateTaskProgressRequest,
  WakeData,
  WakeRequest,
  ReleaseLockData,
  ReleaseLockRequest,
  RiskPathEntry,
  SendMessageData,
  SendMessageRequest,
  StalenessSnapshot,
  SubscribeData,
  SubscribeRequest,
  UpdateIntentData,
  UpdateIntentRequest,
  WithdrawIntentData,
  WithdrawIntentRequest,
} from "@cfls/mcp-server";

import type { HostGateway } from "./gateway";
import { AgentView } from "./view";

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

/** Options for an {@link AgentCoordinationPort}. */
export interface AgentPortOptions {
  session: SessionId;
  self: MemberRef;
  gateway: HostGateway;
  rules: RepositoryRulesConfig;
  view?: AgentView;
  graph?: DependencyGraph;
  authorized?: boolean;
  manualConfig?: boolean;
  connectedMembers?: string[];
  offlineMembers?: string[];
  /**
   * Optional local diff provider for `share_diff` (Phase 5; Req 5.2). When the
   * caller omits an explicit `patch`, the agent computes the current change diff
   * for the path locally (e.g. `git diff -- <path>` in the Authorized_Folder).
   * Absent ⇒ an omitted patch shares nothing (clears any prior diff).
   */
  localDiff?: (path: string) => string | Promise<string>;
}

/** The agent's real, host-backed {@link AgentPort} (design §3.2, §3.4). */
export class AgentCoordinationPort implements AgentPort {
  readonly view: AgentView;
  private readonly session: SessionId;
  private readonly self: MemberRef;
  private readonly gateway: HostGateway;
  private readonly rules: RepositoryRulesConfig;
  /** The shared metadata-only Dependency_Graph; updated as the host shares one. */
  private graph: DependencyGraph | undefined;
  private authorized: boolean;
  private readonly manualConfig: boolean;
  private connectedMembers: string[];
  private offlineMembers: string[];
  private readonly localDiff:
    | ((path: string) => string | Promise<string>)
    | undefined;

  private subscriptionSeq = 0;
  private readonly subscriptions = new Map<
    string,
    (update: CoordinationUpdate) => void
  >();
  private readonly onGatewayUpdate = (update: CoordinationUpdate): void => {
    this.view.applyUpdate(this.session, update);
  };
  private readonly onGatewayMessage = (payload: {
    op: "added" | "updated";
    message: MessageDto;
  }): void => {
    this.view.applyMessage(this.session, payload.message);
  };
  private readonly onGatewayTask = (payload: {
    op: "added" | "updated";
    task: TaskDto;
  }): void => {
    this.view.applyTask(this.session, payload.task);
  };
  private readonly onGatewayLiveness = (payload: {
    memberId: string;
    state: LivenessState;
  }): void => {
    this.view.applyLiveness(this.session, payload.memberId, payload.state);
  };
  private readonly onGatewayNotification = (
    payload: NotificationDto,
  ): void => {
    this.view.applyNotification(this.session, payload);
  };
  private readonly onGatewayDiff = (payload: {
    op: "shared" | "removed";
    diff: LiveDiffDto;
  }): void => {
    this.view.applyDiff(this.session, payload.op, payload.diff);
  };

  constructor(options: AgentPortOptions) {
    this.session = options.session;
    this.self = options.self;
    this.gateway = options.gateway;
    this.rules = options.rules;
    this.view = options.view ?? new AgentView();
    this.graph = options.graph;
    this.authorized = options.authorized ?? true;
    this.manualConfig = options.manualConfig ?? false;
    this.connectedMembers = options.connectedMembers ?? [options.self.memberId];
    this.offlineMembers = options.offlineMembers ?? [];
    this.localDiff = options.localDiff;

    // One shared view fed by every host broadcast (multi-client fan-in, Req 31.1).
    this.gateway.on("update", this.onGatewayUpdate);
    // V2 messaging (Phase 1): converge the message view from host deliveries.
    this.gateway.on("message", this.onGatewayMessage);
    // V2 tasks (Phase 2): converge the task view from host deliveries.
    this.gateway.on("task", this.onGatewayTask);
    // V2 liveness + notifications (Phase 3): converge those views.
    this.gateway.on("liveness", this.onGatewayLiveness);
    this.gateway.on("notification", this.onGatewayNotification);
    // V2 live diffs (Phase 5): converge the diff view from host deliveries.
    this.gateway.on("diff", this.onGatewayDiff);
  }

  // ---- Envelope inputs ------------------------------------------------------

  getConnection(): ConnectionSnapshot {
    return this.gateway.getConnection();
  }

  getStaleness(): StalenessSnapshot {
    const transport = this.gateway.getStaleness();
    return {
      ...transport,
      // A successful TLS handshake is not enough to declare data fresh: a
      // reconnect sync can fail while the socket remains online. The shared
      // AgentView is authoritative for that cache-level stale marker.
      stale: transport.stale || this.view.isStale(),
    };
  }

  // ---- Guards ---------------------------------------------------------------

  private sameSession(session: SessionId): boolean {
    return (
      session.repoId === this.session.repoId &&
      session.teamId === this.session.teamId &&
      session.branch === this.session.branch &&
      (session.baseRevision ?? null) === (this.session.baseRevision ?? null)
    );
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
      error: { code: "NOT_FOUND", message: "Unknown Repository_Session." },
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
    const entries = this.view.riskMap(
      this.session,
      this.self,
      this.rules,
      this.graph,
    );
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
    return {
      ok: true,
      data: {
        paths,
        plannedFileCreations: this.view.plannedCreations(
          this.session,
          this.self,
        ),
        highestRevision: this.view.highestApplied(this.session),
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
    return {
      ok: true,
      data: {
        teamId: this.session.teamId,
        members: this.view.teamActivity(this.session),
        highestRevision: this.view.highestApplied(this.session),
      },
    };
  }

  getDependencyImpact(
    req: GetDependencyImpactRequest,
  ): AgentResult<GetDependencyImpactData> {
    const impacts: DependencyImpact[] = req.paths.map((rawPath) => {
      const path = normalizePath(rawPath);
      if (!this.presentInGraph(path)) {
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
        sharedContracts: [],
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
    const online = this.gateway.online();
    // A locally disconnected agent cannot authoritatively claim any peer is
    // still connected. Preserve the last known roster, but surface every known
    // member as offline until the Host provides a fresh participants.update.
    const knownMembers = new Set([
      this.self.memberId,
      ...this.connectedMembers,
      ...this.offlineMembers,
    ]);
    return {
      ok: true,
      data: {
        status: online ? "online" : "offline",
        participants: {
          connected: online ? [...this.connectedMembers] : [],
          offline: online
            ? [...this.offlineMembers]
            : [...knownMembers].sort((a, b) => a.localeCompare(b)),
        },
        manualCoordinationRequired: !online,
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

  async acquireLock(
    req: AcquireLockRequest,
  ): Promise<AgentResult<AcquireLockData>> {
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
    const result = await this.gateway.transmit({
      type: "lock.acquire",
      payload: {
        scope: req.scope,
        scopeKind: req.scopeKind,
        mode: resolveMode(req.scope, this.rules),
      },
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    // A direct, Event_ID-correlated acknowledgement reports an accepted losing
    // claim even when the host emits no winner-only cache broadcast (Req 12.4).
    if (result.lockConflict !== undefined) {
      return {
        ok: true,
        data: {
          eventRevision: result.eventRevision,
          granted: false,
          concurrentClaim: true,
          winner: result.lockConflict.winner,
        },
      };
    }
    return {
      ok: true,
      data: {
        lockId: result.eventId,
        eventRevision: result.eventRevision,
        granted: true,
      },
    };
  }

  async releaseLock(
    req: ReleaseLockRequest,
  ): Promise<AgentResult<ReleaseLockData>> {
    const result = await this.gateway.transmit({
      type: "lock.release",
      payload: {
        ...(req.lockId !== undefined ? { lockId: req.lockId } : {}),
        ...(req.scope !== undefined ? { scope: req.scope } : {}),
      },
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return {
      ok: true,
      data: { released: true, eventRevision: result.eventRevision },
    };
  }

  async declareIntent(
    req: DeclareIntentRequest,
  ): Promise<AgentResult<DeclareIntentData>> {
    if (!this.sameSession(req.session)) {
      return this.sessionNotFound();
    }
    if (!this.authorized) {
      return this.notAuthorized();
    }
    const result = await this.gateway.transmit({
      type: "intent.declare",
      payload: {
        modifyPaths: req.modifyPaths,
        createPaths: req.createPaths,
        description: req.description,
      },
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return {
      ok: true,
      data: {
        intentId: result.eventId,
        eventRevision: result.eventRevision,
        reclassified: [],
      },
    };
  }

  async updateIntent(
    req: UpdateIntentRequest,
  ): Promise<AgentResult<UpdateIntentData>> {
    const result = await this.gateway.transmit({
      type: "intent.update",
      payload: {
        intentId: req.intentId,
        modifyPaths: req.modifyPaths,
        createPaths: req.createPaths,
        description: req.description,
      },
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return { ok: true, data: { eventRevision: result.eventRevision } };
  }

  async withdrawIntent(
    req: WithdrawIntentRequest,
  ): Promise<AgentResult<WithdrawIntentData>> {
    const result = await this.gateway.transmit({
      type: "intent.withdraw",
      payload: { intentId: req.intentId },
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return { ok: true, data: { eventRevision: result.eventRevision } };
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
      this.subscriptions.set(subscriptionId, onUpdate);
      this.gateway.on("update", onUpdate);
    }
    return {
      ok: true,
      data: { subscriptionId },
    };
  }

  /**
   * Remove a local client's update listener. This is deliberately idempotent:
   * Local_API close/error/agent-stop paths can race without leaving listeners
   * on the host gateway.
   */
  unsubscribeFromCoordinationUpdates(subscriptionId: string): void {
    const onUpdate = this.subscriptions.get(subscriptionId);
    if (onUpdate === undefined) {
      return;
    }
    this.gateway.off("update", onUpdate);
    this.subscriptions.delete(subscriptionId);
  }

  // ---- V2 messaging (Phase 1; Req 1.1–1.4) ---------------------------------

  async sendMessage(
    req: SendMessageRequest,
  ): Promise<AgentResult<SendMessageData>> {
    if (!this.sameSession(req.session)) {
      return this.sessionNotFound();
    }
    if (!this.authorized) {
      return this.notAuthorized();
    }
    const result = await this.gateway.transmit({
      type: "message.send",
      payload: {
        kind: req.kind,
        ...(req.toMemberId !== undefined
          ? { toMemberId: req.toMemberId }
          : {}),
        ...(req.priority !== undefined ? { priority: req.priority } : {}),
        body: req.body,
        ...(req.correlationId !== undefined
          ? { correlationId: req.correlationId }
          : {}),
      },
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return {
      ok: true,
      data: { messageId: result.eventId, eventRevision: result.eventRevision },
    };
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
        messages: this.view.messagesForMember(
          this.session,
          this.self.memberId,
        ),
        unreadCount: this.view.unreadForMember(
          this.session,
          this.self.memberId,
        ),
      },
    };
  }

  async markMessageRead(
    req: MarkMessageReadRequest,
  ): Promise<AgentResult<MarkMessageReadData>> {
    const result = await this.gateway.transmit({
      type: "message.read",
      payload: { messageId: req.messageId },
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    this.view.markMessageReadLocal(
      this.session,
      req.messageId,
      this.self.memberId,
    );
    return { ok: true, data: { eventRevision: result.eventRevision } };
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
        questions: this.view.openQuestionsForMember(
          this.session,
          this.self.memberId,
        ),
      },
    };
  }

  // ---- V2 tasks (Phase 2; Req 2.1–2.3) -------------------------------------

  async assignTask(
    req: AssignTaskRequest,
  ): Promise<AgentResult<AssignTaskData>> {
    if (!this.sameSession(req.session)) {
      return this.sessionNotFound();
    }
    if (!this.authorized) {
      return this.notAuthorized();
    }
    const result = await this.gateway.transmit({
      type: "task.assign",
      payload: {
        title: req.title,
        description: req.description,
        assigneeMemberId: req.assigneeMemberId,
      },
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return {
      ok: true,
      data: { taskId: result.eventId, eventRevision: result.eventRevision },
    };
  }

  async respondTask(
    req: RespondTaskRequest,
  ): Promise<AgentResult<RespondTaskData>> {
    const result = await this.gateway.transmit({
      type: "task.respond",
      payload: { taskId: req.taskId, accept: req.accept },
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return { ok: true, data: { eventRevision: result.eventRevision } };
  }

  async updateTaskProgress(
    req: UpdateTaskProgressRequest,
  ): Promise<AgentResult<UpdateTaskProgressData>> {
    const result = await this.gateway.transmit({
      type: "task.progress",
      payload: { taskId: req.taskId, status: req.status },
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return { ok: true, data: { eventRevision: result.eventRevision } };
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
        tasks: this.view.allTasks(this.session),
        myTaskList: this.view.taskListForMember(
          this.session,
          this.self.memberId,
        ),
        incomingProposals: this.view.incomingProposalsForMember(
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
    return { ok: true, data: { members: this.view.livenessStates(this.session) } };
  }

  async wake(req: WakeRequest): Promise<AgentResult<WakeData>> {
    if (!this.sameSession(req.session)) {
      return this.sessionNotFound();
    }
    if (!this.authorized) {
      return this.notAuthorized();
    }
    const result = await this.gateway.transmit({
      type: "wake.request",
      payload: {
        targetMemberId: req.targetMemberId,
        ...(req.reason !== undefined ? { reason: req.reason } : {}),
      },
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
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
        notifications: this.view.notificationsForMember(
          this.session,
          this.self.memberId,
        ),
      },
    };
  }

  // ---- V2 Luna orchestrator (Phase 4; Req 4.1–4.5) -------------------------

  async askLuna(req: AskLunaRequest): Promise<AgentResult<AskLunaData>> {
    if (!this.sameSession(req.session)) {
      return this.sessionNotFound();
    }
    if (!this.authorized) {
      return this.notAuthorized();
    }
    // Only the real WSS gateway orchestrates Luna; when absent (in-process
    // fan-in gateway or offline), surface an OFFLINE_QUEUED-style failure.
    if (this.gateway.askLuna === undefined) {
      return {
        ok: false,
        error: {
          code: "OFFLINE_QUEUED",
          message:
            "The CoordinationAgent cannot reach Luna (no orchestrator on this connection).",
        },
      };
    }
    const result = await this.gateway.askLuna({
      action: req.action,
      prompt: req.prompt,
      ...(req.refId !== undefined ? { refId: req.refId } : {}),
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return { ok: true, data: result.reply };
  }

  // ---- V2 live diffs (Phase 5; Req 5.1–5.5) --------------------------------

  async shareDiff(req: ShareDiffRequest): Promise<AgentResult<ShareDiffData>> {
    if (!this.sameSession(req.session)) {
      return this.sessionNotFound();
    }
    if (!this.authorized) {
      return this.notAuthorized();
    }
    // Prefer an explicit patch; otherwise compute the local git diff for the
    // path when a provider is configured, else share nothing (clears the diff).
    // The provider only runs while online so an offline share never does I/O.
    let patch = req.patch;
    if (
      patch === undefined &&
      this.localDiff !== undefined &&
      this.gateway.online()
    ) {
      patch = await this.localDiff(req.path);
    }
    const result = await this.gateway.transmit({
      type: "diff.share",
      payload: { path: req.path, patch: patch ?? "" },
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return {
      ok: true,
      data: {
        eventRevision: result.eventRevision,
        shared: (patch ?? "").length > 0,
      },
    };
  }

  listDiffs(req: ListDiffsRequest): AgentResult<ListDiffsData> {
    if (!this.sameSession(req.session)) {
      return this.sessionNotFound();
    }
    if (!this.authorized) {
      return this.notAuthorized();
    }
    return { ok: true, data: { diffs: this.view.allDiffs(this.session) } };
  }

  /** Release all gateway listeners owned by this port during agent shutdown. */
  dispose(): void {
    this.gateway.off("update", this.onGatewayUpdate);
    this.gateway.off("message", this.onGatewayMessage);
    this.gateway.off("task", this.onGatewayTask);
    this.gateway.off("liveness", this.onGatewayLiveness);
    this.gateway.off("notification", this.onGatewayNotification);
    this.gateway.off("diff", this.onGatewayDiff);
    for (const subscriptionId of this.subscriptions.keys()) {
      this.unsubscribeFromCoordinationUpdates(subscriptionId);
    }
  }

  // ---- Authorization / participant controls ---------------------------------

  setAuthorized(authorized: boolean): void {
    this.authorized = authorized;
  }

  setParticipants(
    connected: readonly string[],
    offline: readonly string[],
  ): void {
    const live = new Set(connected);
    const disconnected = new Set(
      offline.filter((memberId) => !live.has(memberId)),
    );
    this.connectedMembers = [...live].sort((a, b) => a.localeCompare(b));
    this.offlineMembers = [...disconnected].sort((a, b) => a.localeCompare(b));
  }

  /**
   * Replace the shared metadata-only Dependency_Graph used for dependency/risk
   * queries (Req 19, 20). Called when the agent builds a local graph from the
   * Authorized_Folder and when the host shares an updated graph for the session.
   */
  setGraph(graph: DependencyGraph): void {
    this.graph = graph;
  }

  /** The current shared Dependency_Graph, or `undefined` when none is known. */
  currentGraph(): DependencyGraph | undefined {
    return this.graph;
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
