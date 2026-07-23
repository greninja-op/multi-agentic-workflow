/**
 * Pure state→view-model rendering (task 11.3; Req 3.3, 3.4, 3.6, 33.3;
 * design §3.5).
 *
 * {@link buildCoordinationViewModel} is a **pure function**: it maps the agent's
 * `get_risk_map` result plus the connection/staleness snapshots onto a
 * display-oriented {@link CoordinationViewModel}. The VS Code adapter renders the
 * view model; keeping the projection pure makes the rendering rules unit-testable
 * with no editor runtime.
 *
 * Per affected path the view model surfaces active soft / coordination-required /
 * hard locks, presence, declared intents, planned file creations, and indirect
 * dependency risk — each attributed to the contributing member identity
 * (Req 3.4). It also carries an explicit offline/stale indicator (Req 3.6, 33.3).
 */

import type {
  AskLunaData,
  ConnectionSnapshot,
  ConnectionStatusData,
  GetLivenessData,
  GetNotificationsData,
  GetRiskMapData,
  GetTeamStatusData,
  ListDiffsData,
  ListMessagesData,
  ListTasksData,
  RiskEdge,
  StalenessSnapshot,
  TeamActivityFile,
  TeamActivityTask,
  TeamMemberActivity,
} from "@cfls/mcp-server";
import type {
  LivenessState,
  LunaAction,
  MessageKind,
  MessagePriority,
  NotifySeverity,
  NotifySource,
  RiskLevel,
  TaskStatus,
} from "@cfls/protocol";

/** Indirect dependency risk for a path, with its explanation (Req 3.4, 22). */
export interface IndirectRiskView {
  edges: RiskEdge[];
  sharedContracts: string[];
}

/** The rendered coordination state for a single repository-relative path. */
export interface PathView {
  path: string;
  /** The highest resolved Risk_Level for the path (soft/coordination-required/hard). */
  riskLevel: RiskLevel;
  /** Member ids holding an active Soft_Lock on the path. */
  softLockMembers: string[];
  /** Member ids holding an active Coordination_Required_Lock on the path. */
  coordinationRequiredMembers: string[];
  /** Member ids holding an active Hard_Lock on the path. */
  hardLockMembers: string[];
  /** Member ids currently present/editing the path. */
  presenceMembers: string[];
  /** Member ids with a Declared_Intent touching the path. */
  intentMembers: string[];
  /** Member ids contributing indirect dependency risk to the path. */
  dependencyRiskMembers: string[];
  /** Indirect dependency risk explanation, when the path is indirectly at risk. */
  indirectRisk: IndirectRiskView | null;
  /** True for coordination-required paths needing explicit acknowledgement (Req 13.5). */
  acknowledgementRequired: boolean;
}

/** A planned file creation surfaced by another member (Req 3.4). */
export interface PlannedCreationView {
  path: string;
  memberId: string;
}

/** Live membership state as supplied by `get_connection_status`. */
export type TeamMemberConnectionState = "connected" | "offline" | "unknown";

/**
 * One row in the expandable team panel.
 *
 * Activity is deliberately optional rather than inferred from connectivity: an
 * admitted teammate can be live and idle, and a cached activity record can
 * outlive a live roster update. The panel can therefore show both facts
 * without claiming that every connected member is editing a file.
 */
export interface TeamPanelMember {
  memberId: string;
  connectionState: TeamMemberConnectionState;
  /** Whether this member has an activity projection from `get_team_status`. */
  activityKnown: boolean;
  deviceIds: string[];
  files: TeamActivityFile[];
  tasks: TeamActivityTask[];
  /** Null for a roster-only, currently idle member. */
  lastEventRevision: number | null;
  /** Fine-grained liveness (active/idle/gone) when known, else null (Req 3.1). */
  liveness: LivenessState | null;
}

/**
 * A rendered message for the extension's Messages section (V2 Phase 1; Req 1.1–1.4).
 * `priority` drives styling (urgent highlighted); `answered` marks a resolved
 * question. Body is team text only.
 */
export interface MessageView {
  messageId: string;
  kind: MessageKind;
  senderMemberId: string;
  toMemberId: string | null;
  priority: MessagePriority;
  body: string;
  /** True/false for a question; null for non-question kinds. */
  answered: boolean | null;
  sentAt: string;
}

/** A rendered task for the extension's Tasks section (V2 Phase 2; Req 2.1–2.3). */
export interface TaskView {
  taskId: string;
  title: string;
  description: string;
  assigneeMemberId: string;
  assignerMemberId: string;
  status: TaskStatus;
}

/** A rendered notification for the extension (V2 Phase 3; Req 3.2). */
export interface NotificationView {
  notificationId: string;
  severity: NotifySeverity;
  source: NotifySource;
  summary: string;
  refId: string;
}

/**
 * A shared Live_Diff rendered for the extension's read-only diff view (V2
 * Phase 5; Req 5.5). It is display-only — the extension NEVER applies a received
 * diff to the recipient's files automatically. Empty unless the team opted in.
 */
export interface LiveDiffView {
  path: string;
  memberId: string;
  patch: string;
}

/**
 * Luna's most recent reply, rendered for the extension's Luna panel (V2 Phase 4;
 * Req 4.5). Read-only summary of a decision, answer, or team summary.
 */
export interface LunaReplyView {
  action: LunaAction;
  summary: string;
  /** The task Luna produced (e.g. from an `assign`), when any. */
  producedTaskId: string | null;
  /** The message Luna produced (e.g. an `answer`/arbitration notice), when any. */
  producedMessageId: string | null;
}

/** The full rendered coordination view for a Repository_Session. */
export interface CoordinationViewModel {
  paths: PathView[];
  plannedFileCreations: PlannedCreationView[];
  /** Messages visible to this member, oldest first (V2 Phase 1). */
  messages: MessageView[];
  /** Count of messages addressed to this member that it has not read (Req 1.4). */
  unreadCount: number;
  /** This member's accepted task list (accepted/in_progress/done) (V2 Phase 2). */
  myTasks: TaskView[];
  /** Proposed tasks awaiting this member's approval (Req 2.2). */
  incomingTasks: TaskView[];
  /** All tasks in the session. */
  allTasks: TaskView[];
  /** This member's notifications, oldest first (V2 Phase 3; Req 3.2). */
  notifications: NotificationView[];
  /** Count of urgent notifications (drives a sound cue) (Req 3.2). */
  urgentNotificationCount: number;
  /** Luna's most recent reply, or null when Luna has not been asked (V2 Phase 4; Req 4.5). */
  lunaLastReply: LunaReplyView | null;
  /** Read-only shared Live_Diffs; empty unless the team opted in (V2 Phase 5; Req 5.5). */
  liveDiffs: LiveDiffView[];
  /** True while the local agent is in Offline_State (Req 3.6, 33.3). */
  offline: boolean;
  /** True when served coordination data may be stale (Req 33.2, 33.3). */
  stale: boolean;
  /** Seconds since the last successful host sync, or null when never synced. */
  secondsSinceSync: number | null;
  /** A short human-readable status line for the offline/stale indicator. */
  statusText: string;
  /** Team identifier supplied by the agent's live team-status projection. */
  teamId: string | null;
  /** Live roster merged with metadata-only member/task/file coordination state. */
  members: TeamPanelMember[];
}

/** The inputs the extension holds to render coordination state. */
export interface CoordinationSnapshot {
  riskMap: GetRiskMapData;
  /** Optional so the extension can still render an offline state before auth. */
  teamStatus?: GetTeamStatusData;
  /** Optional live roster; supplied independently of activity snapshots. */
  connectionStatus?: ConnectionStatusData;
  /** Optional messaging projection from `list_messages` (V2 Phase 1). */
  messages?: ListMessagesData;
  /** Optional task projection from `list_tasks` (V2 Phase 2). */
  tasks?: ListTasksData;
  /** Optional liveness projection from `get_liveness` (V2 Phase 3). */
  liveness?: GetLivenessData;
  /** Optional notifications projection from `get_notifications` (V2 Phase 3). */
  notifications?: GetNotificationsData;
  /** Optional last Luna reply from `ask_luna` (V2 Phase 4; Req 4.5). */
  luna?: AskLunaData;
  /** Optional shared Live_Diffs from `list_diffs` (V2 Phase 5; Req 5.5). */
  diffs?: ListDiffsData;
  /** Known from the local Repository_Session before activity is available. */
  teamId?: string;
  connection: ConnectionSnapshot;
  staleness: StalenessSnapshot;
}

/**
 * Build the active-team panel model when the independent Risk_Map query is
 * unavailable. A successful team-status response still carries its own
 * authoritative connection and staleness snapshots, so the UI must preserve
 * those facts rather than presenting a live team as offline.
 */
export function buildTeamStatusOnlyViewModel(input: {
  teamStatus: GetTeamStatusData;
  /** Optional live roster, fetched independently of `get_team_status`. */
  connectionStatus?: ConnectionStatusData;
  /** Known from the current Repository_Session. */
  teamId?: string;
  connection: ConnectionSnapshot;
  staleness: StalenessSnapshot;
}): CoordinationViewModel {
  return buildCoordinationViewModel({
    riskMap: {
      paths: [],
      plannedFileCreations: [],
      highestRevision: input.teamStatus.highestRevision,
    },
    teamStatus: input.teamStatus,
    ...(input.connectionStatus !== undefined
      ? { connectionStatus: input.connectionStatus }
      : {}),
    ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
    connection: input.connection,
    staleness: input.staleness,
  });
}

/**
 * Build a roster-only panel while the richer activity query is unavailable.
 * This keeps idle participants visible even if `get_team_status` is delayed or
 * temporarily fails, without inventing files, tasks, or device metadata.
 */
export function buildConnectionStatusOnlyViewModel(input: {
  connectionStatus: ConnectionStatusData;
  /** Known from the current Repository_Session. */
  teamId?: string;
  connection: ConnectionSnapshot;
  staleness: StalenessSnapshot;
}): CoordinationViewModel {
  return buildCoordinationViewModel({
    riskMap: {
      paths: [],
      plannedFileCreations: [],
      highestRevision: 0,
    },
    connectionStatus: input.connectionStatus,
    ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
    connection: input.connection,
    staleness: input.staleness,
  });
}

/**
 * Collect the member ids for contributors of any of the given kinds,
 * de-duplicated. The producer (`buildRiskMap`) emits an exact kind per
 * contribution — `soft_lock` / `coordination_required_lock` / `hard_lock` for
 * locks, `dependency` / `reverse-dependency` / `shared-contract` for indirect
 * risk — so a bucket may accept more than one kind.
 */
function membersOfKind(
  contributors: { memberId: string; kind: string }[],
  ...kinds: string[]
): string[] {
  const accept = new Set(kinds);
  const seen = new Set<string>();
  for (const c of contributors) {
    if (accept.has(c.kind)) {
      seen.add(c.memberId);
    }
  }
  return [...seen];
}

/** Merge the independent roster and activity projections for the team panel. */
function mergeTeamMembers(
  teamStatus: GetTeamStatusData | undefined,
  connectionStatus: ConnectionStatusData | undefined,
  forceOffline: boolean,
  liveness: GetLivenessData | undefined,
): TeamPanelMember[] {
  const livenessByMember = new Map<string, LivenessState>();
  for (const entry of liveness?.members ?? []) {
    livenessByMember.set(entry.memberId, entry.state);
  }
  const activityByMember = new Map<string, TeamMemberActivity>();
  for (const activity of teamStatus?.members ?? []) {
    if (activity.memberId !== "") {
      activityByMember.set(activity.memberId, activity);
    }
  }

  const connected = new Set(
    connectionStatus?.participants.connected.filter(
      (memberId) => memberId !== "",
    ) ?? [],
  );
  const offline = new Set(
    connectionStatus?.participants.offline.filter(
      (memberId) => memberId !== "",
    ) ?? [],
  );
  const memberIds = new Set([
    ...activityByMember.keys(),
    ...connected,
    ...offline,
  ]);
  const rosterIsOffline =
    forceOffline || connectionStatus?.status === "offline";

  const connectionStateFor = (memberId: string): TeamMemberConnectionState => {
    // A local agent without host connectivity cannot authoritatively report a
    // peer as connected. Prefer the conservative offline state for malformed
    // overlapping roster entries as well.
    if (rosterIsOffline || offline.has(memberId)) {
      return "offline";
    }
    if (connected.has(memberId)) {
      return "connected";
    }
    return "unknown";
  };

  const connectionRank: Record<TeamMemberConnectionState, number> = {
    connected: 0,
    unknown: 1,
    offline: 2,
  };
  return [...memberIds]
    .map((memberId) => {
      const activity = activityByMember.get(memberId);
      return {
        memberId,
        connectionState: connectionStateFor(memberId),
        activityKnown: activity !== undefined,
        deviceIds: activity?.deviceIds ?? [],
        files: activity?.files ?? [],
        tasks: activity?.tasks ?? [],
        lastEventRevision: activity?.lastEventRevision ?? null,
        liveness: livenessByMember.get(memberId) ?? null,
      };
    })
    .sort(
      (left, right) =>
        connectionRank[left.connectionState] -
          connectionRank[right.connectionState] ||
        left.memberId.localeCompare(right.memberId),
    );
}

/** Compose the offline/stale status line (Req 3.6, 33.3). */
export function statusLine(
  connection: ConnectionSnapshot,
  staleness: StalenessSnapshot,
): string {
  if (connection.status === "offline") {
    return "Offline — coordination data may be stale; manual coordination required";
  }
  if (staleness.stale) {
    return "Stale — reconnecting to the coordination agent";
  }
  return "Online";
}

/**
 * Project a {@link CoordinationSnapshot} onto the display-oriented
 * {@link CoordinationViewModel} (Req 3.3, 3.4, 3.6). Pure and deterministic.
 */
export function buildCoordinationViewModel(
  snapshot: CoordinationSnapshot,
): CoordinationViewModel {
  // `get_connection_status` is the roster query's own live gateway verdict.
  // Honor it defensively if a concurrent request races an older envelope, so
  // the panel never labels the host live while marking every participant down.
  const offline =
    snapshot.connection.status === "offline" ||
    snapshot.connectionStatus?.status === "offline";
  const stale = snapshot.staleness.stale || offline;
  const displayConnection = offline
    ? { ...snapshot.connection, status: "offline" as const }
    : snapshot.connection;

  const paths: PathView[] = snapshot.riskMap.paths.map((entry) => {
    const indirect =
      entry.explanation.type === "indirect"
        ? {
            edges: entry.explanation.edges ?? [],
            sharedContracts: entry.explanation.sharedContracts ?? [],
          }
        : null;
    return {
      path: entry.path,
      riskLevel: entry.riskLevel,
      softLockMembers: membersOfKind(entry.contributors, "soft_lock"),
      coordinationRequiredMembers: membersOfKind(
        entry.contributors,
        "coordination_required_lock",
      ),
      hardLockMembers: membersOfKind(entry.contributors, "hard_lock"),
      presenceMembers: membersOfKind(entry.contributors, "presence"),
      intentMembers: membersOfKind(entry.contributors, "intent"),
      dependencyRiskMembers: membersOfKind(
        entry.contributors,
        "dependency",
        "reverse-dependency",
        "shared-contract",
      ),
      indirectRisk: indirect,
      acknowledgementRequired: entry.acknowledgementRequired,
    };
  });

  const messages: MessageView[] = (snapshot.messages?.messages ?? []).map(
    (m) => ({
      messageId: m.messageId,
      kind: m.kind,
      senderMemberId: m.sender.memberId,
      toMemberId: m.toMemberId ?? null,
      priority: m.priority,
      body: m.body,
      answered: m.kind === "question" ? (m.answered ?? false) : null,
      sentAt: m.sentAt,
    }),
  );

  const toTaskView = (t: {
    taskId: string;
    title: string;
    description: string;
    assignee: { memberId: string };
    assigner: { memberId: string };
    status: TaskStatus;
  }): TaskView => ({
    taskId: t.taskId,
    title: t.title,
    description: t.description,
    assigneeMemberId: t.assignee.memberId,
    assignerMemberId: t.assigner.memberId,
    status: t.status,
  });

  return {
    paths,
    plannedFileCreations: snapshot.riskMap.plannedFileCreations.map((p) => ({
      path: p.path,
      memberId: p.memberId,
    })),
    messages,
    unreadCount: snapshot.messages?.unreadCount ?? 0,
    myTasks: (snapshot.tasks?.myTaskList ?? []).map(toTaskView),
    incomingTasks: (snapshot.tasks?.incomingProposals ?? []).map(toTaskView),
    allTasks: (snapshot.tasks?.tasks ?? []).map(toTaskView),
    notifications: (snapshot.notifications?.notifications ?? []).map((n) => ({
      notificationId: n.notificationId,
      severity: n.severity,
      source: n.source,
      summary: n.summary,
      refId: n.refId,
    })),
    urgentNotificationCount: (snapshot.notifications?.notifications ?? []).filter(
      (n) => n.severity === "urgent",
    ).length,
    lunaLastReply:
      snapshot.luna !== undefined
        ? {
            action: snapshot.luna.action,
            summary: snapshot.luna.summary,
            producedTaskId: snapshot.luna.producedTaskId ?? null,
            producedMessageId: snapshot.luna.producedMessageId ?? null,
          }
        : null,
    liveDiffs: (snapshot.diffs?.diffs ?? []).map((d) => ({
      path: d.path,
      memberId: d.member.memberId,
      patch: d.patch,
    })),
    offline,
    stale,
    secondsSinceSync: snapshot.staleness.secondsSinceSync,
    statusText: statusLine(displayConnection, snapshot.staleness),
    teamId: snapshot.teamStatus?.teamId ?? snapshot.teamId ?? null,
    members: mergeTeamMembers(
      snapshot.teamStatus,
      snapshot.connectionStatus,
      offline,
      snapshot.liveness,
    ),
  };
}

/** Find the rendered view for a specific path, or `undefined`. */
export function findPathView(
  vm: CoordinationViewModel,
  path: string,
): PathView | undefined {
  return vm.paths.find((p) => p.path === path);
}
