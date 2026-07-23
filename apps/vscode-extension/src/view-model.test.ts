/**
 * Unit tests for the pure state→view-model rendering (task 11.3, 11.5; Req 3.3,
 * 3.4, 3.6, 33.3). Verifies per-path lock/presence/intent/planned-creation/
 * indirect-risk projection with contributing member identity, and the
 * offline/stale indicator.
 */

import type {
  ConnectionSnapshot,
  ConnectionStatusData,
  GetRiskMapData,
  GetTeamStatusData,
  StalenessSnapshot,
} from "@cfls/mcp-server";
import { describe, expect, it } from "vitest";

import {
  buildConnectionStatusOnlyViewModel,
  buildCoordinationViewModel,
  buildTeamStatusOnlyViewModel,
  findPathView,
  statusLine,
} from "./view-model";

const online: ConnectionSnapshot = {
  status: "online",
  hostUrl: "wss://host.test:8443",
  lastSyncAt: "2024-01-01T00:00:00.000Z",
};
const offline: ConnectionSnapshot = {
  status: "offline",
  hostUrl: "wss://host.test:8443",
  lastSyncAt: null,
};
const fresh: StalenessSnapshot = { stale: false, secondsSinceSync: 1 };
const staleSnap: StalenessSnapshot = { stale: true, secondsSinceSync: 42 };

const riskMap: GetRiskMapData = {
  paths: [
    {
      path: "src/api.ts",
      riskLevel: "hard",
      contributors: [
        { memberId: "bob", kind: "hard_lock" },
        { memberId: "carol", kind: "presence" },
        { memberId: "bob", kind: "hard_lock" }, // duplicate collapses
      ],
      explanation: { type: "direct" },
      acknowledgementRequired: false,
    },
    {
      path: "src/routes.ts",
      riskLevel: "coordination-required",
      contributors: [
        { memberId: "dave", kind: "coordination_required_lock" },
        { memberId: "erin", kind: "intent" },
        { memberId: "frank", kind: "soft_lock" },
        { memberId: "gina", kind: "dependency" },
      ],
      explanation: {
        type: "indirect",
        edges: [
          {
            from: "src/routes.ts",
            to: "src/api.ts",
            kind: "runtime_import",
            confidence: "high",
          },
        ],
        sharedContracts: ["openapi:orders"],
      },
      acknowledgementRequired: true,
    },
  ],
  plannedFileCreations: [{ path: "src/new.ts", memberId: "bob" }],
  highestRevision: 421,
};

const teamStatus: GetTeamStatusData = {
  teamId: "team-demo",
  highestRevision: 422,
  members: [
    {
      memberId: "bob",
      deviceIds: ["device-bob"],
      files: [{ path: "src/shared.ts", roles: ["editing"] }],
      tasks: [],
      lastEventRevision: 422,
    },
  ],
};

const connectionStatus: ConnectionStatusData = {
  status: "online",
  participants: {
    connected: ["alice", "bob"],
    offline: ["carol"],
  },
  manualCoordinationRequired: false,
};

describe("buildCoordinationViewModel (Req 3.4)", () => {
  it("projects per-path locks, presence, intents, and dependency risk by member", () => {
    const vm = buildCoordinationViewModel({
      riskMap,
      connection: online,
      staleness: fresh,
    });

    const api = findPathView(vm, "src/api.ts");
    expect(api?.riskLevel).toBe("hard");
    expect(api?.hardLockMembers).toEqual(["bob"]); // de-duplicated
    expect(api?.presenceMembers).toEqual(["carol"]);
    expect(api?.indirectRisk).toBeNull();

    const routes = findPathView(vm, "src/routes.ts");
    expect(routes?.coordinationRequiredMembers).toEqual(["dave"]);
    expect(routes?.intentMembers).toEqual(["erin"]);
    expect(routes?.softLockMembers).toEqual(["frank"]);
    expect(routes?.dependencyRiskMembers).toEqual(["gina"]);
    expect(routes?.acknowledgementRequired).toBe(true);
  });

  it("surfaces the indirect dependency explanation (Req 3.4, 22)", () => {
    const vm = buildCoordinationViewModel({
      riskMap,
      connection: online,
      staleness: fresh,
    });
    const routes = findPathView(vm, "src/routes.ts");
    expect(routes?.indirectRisk?.edges[0]).toMatchObject({
      from: "src/routes.ts",
      to: "src/api.ts",
      kind: "runtime_import",
    });
    expect(routes?.indirectRisk?.sharedContracts).toEqual(["openapi:orders"]);
  });

  it("surfaces planned file creations with the contributing member", () => {
    const vm = buildCoordinationViewModel({
      riskMap,
      connection: online,
      staleness: fresh,
    });
    expect(vm.plannedFileCreations).toEqual([
      { path: "src/new.ts", memberId: "bob" },
    ]);
  });
});

describe("offline / stale indicator (Req 3.6, 33.3)", () => {
  it("marks the view model offline and stale when the agent is offline", () => {
    const vm = buildCoordinationViewModel({
      riskMap,
      connection: offline,
      staleness: staleSnap,
    });
    expect(vm.offline).toBe(true);
    expect(vm.stale).toBe(true);
    expect(vm.statusText).toMatch(/Offline/);
    expect(vm.statusText).toMatch(/manual coordination/i);
    expect(vm.secondsSinceSync).toBe(42);
  });

  it("reports online when connected and fresh", () => {
    const vm = buildCoordinationViewModel({
      riskMap,
      connection: online,
      staleness: fresh,
    });
    expect(vm.offline).toBe(false);
    expect(vm.stale).toBe(false);
    expect(vm.statusText).toBe("Online");
  });

  it("reports stale when online but data has not synced", () => {
    expect(statusLine(online, staleSnap)).toMatch(/Stale/);
  });

  it("keeps a successful team-only response online and fresh when risk data is unavailable", () => {
    const vm = buildTeamStatusOnlyViewModel({
      teamStatus,
      teamId: "team-demo",
      connection: online,
      staleness: fresh,
    });

    expect(vm.paths).toEqual([]);
    expect(vm.members).toEqual([
      {
        ...teamStatus.members[0],
        connectionState: "unknown",
        activityKnown: true,
        liveness: null,
      },
    ]);
    expect(vm.offline).toBe(false);
    expect(vm.stale).toBe(false);
    expect(vm.statusText).toBe("Online");
  });

  it("merges idle live-roster members with metadata-only active work", () => {
    const vm = buildCoordinationViewModel({
      riskMap,
      teamStatus,
      connectionStatus,
      connection: online,
      staleness: fresh,
    });

    expect(
      vm.members.map((member) => ({
        memberId: member.memberId,
        connectionState: member.connectionState,
        activityKnown: member.activityKnown,
        files: member.files,
        tasks: member.tasks,
        lastEventRevision: member.lastEventRevision,
      })),
    ).toEqual([
      {
        memberId: "alice",
        connectionState: "connected",
        activityKnown: false,
        files: [],
        tasks: [],
        lastEventRevision: null,
      },
      {
        memberId: "bob",
        connectionState: "connected",
        activityKnown: true,
        files: [{ path: "src/shared.ts", roles: ["editing"] }],
        tasks: [],
        lastEventRevision: 422,
      },
      {
        memberId: "carol",
        connectionState: "offline",
        activityKnown: false,
        files: [],
        tasks: [],
        lastEventRevision: null,
      },
    ]);
  });

  it("renders a live roster even while the activity query is unavailable", () => {
    const vm = buildConnectionStatusOnlyViewModel({
      connectionStatus,
      teamId: "team-demo",
      connection: online,
      staleness: fresh,
    });

    expect(vm.paths).toEqual([]);
    expect(vm.members).toHaveLength(3);
    expect(
      vm.members.find((member) => member.memberId === "alice"),
    ).toMatchObject({
      connectionState: "connected",
      activityKnown: false,
      files: [],
      tasks: [],
      lastEventRevision: null,
    });
  });

  it("never presents cached peers as connected when the local agent is offline", () => {
    const vm = buildCoordinationViewModel({
      riskMap,
      teamStatus,
      connectionStatus,
      connection: offline,
      staleness: staleSnap,
    });

    expect(vm.members.map((member) => member.connectionState)).toEqual([
      "offline",
      "offline",
      "offline",
    ]);
  });

  it("honors an offline roster verdict if another response races its envelope", () => {
    const vm = buildCoordinationViewModel({
      riskMap,
      teamStatus,
      connectionStatus: { ...connectionStatus, status: "offline" },
      connection: online,
      staleness: fresh,
    });

    expect(vm.offline).toBe(true);
    expect(vm.stale).toBe(true);
    expect(vm.statusText).toMatch(/^Offline/);
    expect(vm.members.map((member) => member.connectionState)).toEqual([
      "offline",
      "offline",
      "offline",
    ]);
  });
});

describe("view-model — V2 messages projection (Phase 1; Req 1.1–1.4)", () => {
  const emptyRisk: GetRiskMapData = {
    paths: [],
    plannedFileCreations: [],
    highestRevision: 0,
  };

  it("projects messages with priority and marks answered questions", () => {
    const vm = buildCoordinationViewModel({
      riskMap: emptyRisk,
      messages: {
        messages: [
          {
            messageId: "m-1",
            kind: "broadcast",
            sender: { memberId: "alice", deviceId: "d-a" },
            priority: "urgent",
            body: "deploy freeze",
            eventRevision: 5,
            sentAt: "2024-01-01T00:00:00Z",
          },
          {
            messageId: "q-1",
            kind: "question",
            sender: { memberId: "bob", deviceId: "d-b" },
            toMemberId: "me",
            priority: "normal",
            body: "which branch?",
            answered: false,
            correlationId: "c-1",
            eventRevision: 6,
            sentAt: "2024-01-01T00:01:00Z",
          },
        ],
        unreadCount: 1,
      },
      connection: online,
      staleness: fresh,
    });

    expect(vm.messages.map((m) => m.messageId)).toEqual(["m-1", "q-1"]);
    expect(vm.messages[0]?.priority).toBe("urgent");
    expect(vm.messages[0]?.answered).toBeNull(); // broadcast is not a question
    expect(vm.messages[1]?.answered).toBe(false); // open question
    expect(vm.unreadCount).toBe(1);
  });

  it("defaults to no messages and zero unread when messaging data is absent", () => {
    const vm = buildCoordinationViewModel({
      riskMap: emptyRisk,
      connection: online,
      staleness: fresh,
    });
    expect(vm.messages).toEqual([]);
    expect(vm.unreadCount).toBe(0);
  });
});

describe("view-model — V2 tasks projection (Phase 2; Req 2.1–2.3)", () => {
  const emptyRisk: GetRiskMapData = {
    paths: [],
    plannedFileCreations: [],
    highestRevision: 0,
  };

  it("projects my task list, incoming proposals, and all tasks", () => {
    const mk = (taskId: string, status: string) => ({
      taskId,
      title: `T-${taskId}`,
      description: "d",
      assignee: { memberId: "me", deviceId: "" },
      assigner: { memberId: "alice", deviceId: "d-a" },
      status: status as never,
      eventRevision: 1,
    });
    const vm = buildCoordinationViewModel({
      riskMap: emptyRisk,
      tasks: {
        tasks: [mk("t-1", "in_progress"), mk("t-2", "proposed")],
        myTaskList: [mk("t-1", "in_progress")],
        incomingProposals: [mk("t-2", "proposed")],
      },
      connection: online,
      staleness: fresh,
    });

    expect(vm.myTasks.map((t) => t.taskId)).toEqual(["t-1"]);
    expect(vm.myTasks[0]?.status).toBe("in_progress");
    expect(vm.incomingTasks.map((t) => t.taskId)).toEqual(["t-2"]);
    expect(vm.allTasks.map((t) => t.taskId)).toEqual(["t-1", "t-2"]);
    expect(vm.myTasks[0]?.assignerMemberId).toBe("alice");
  });

  it("defaults to empty task arrays when task data is absent", () => {
    const vm = buildCoordinationViewModel({
      riskMap: emptyRisk,
      connection: online,
      staleness: fresh,
    });
    expect(vm.myTasks).toEqual([]);
    expect(vm.incomingTasks).toEqual([]);
    expect(vm.allTasks).toEqual([]);
  });
});

describe("view-model — V2 liveness & notifications projection (Phase 3; Req 3.1–3.3)", () => {
  const emptyRisk: GetRiskMapData = {
    paths: [],
    plannedFileCreations: [],
    highestRevision: 0,
  };

  it("attaches fine-grained liveness to team members", () => {
    const vm = buildCoordinationViewModel({
      riskMap: emptyRisk,
      connectionStatus: {
        status: "online",
        participants: { connected: ["alice", "bob"], offline: [] },
        manualCoordinationRequired: false,
      },
      liveness: {
        members: [
          { memberId: "alice", state: "active" },
          { memberId: "bob", state: "idle" },
        ],
      },
      connection: online,
      staleness: fresh,
    });
    const bob = vm.members.find((m) => m.memberId === "bob");
    expect(bob?.liveness).toBe("idle");
    const alice = vm.members.find((m) => m.memberId === "alice");
    expect(alice?.liveness).toBe("active");
  });

  it("projects notifications and counts urgent ones", () => {
    const vm = buildCoordinationViewModel({
      riskMap: emptyRisk,
      notifications: {
        notifications: [
          { notificationId: "n1", toMemberId: "me", severity: "warn", source: "task", refId: "t-1", summary: "task", eventRevision: 1 },
          { notificationId: "n2", toMemberId: "me", severity: "urgent", source: "wake", refId: "me", summary: "wake", eventRevision: 2 },
        ],
      },
      connection: online,
      staleness: fresh,
    });
    expect(vm.notifications.map((n) => n.notificationId)).toEqual(["n1", "n2"]);
    expect(vm.urgentNotificationCount).toBe(1);
  });

  it("defaults to empty notifications and null liveness when absent", () => {
    const vm = buildCoordinationViewModel({
      riskMap: emptyRisk,
      connectionStatus: {
        status: "online",
        participants: { connected: ["alice"], offline: [] },
        manualCoordinationRequired: false,
      },
      connection: online,
      staleness: fresh,
    });
    expect(vm.notifications).toEqual([]);
    expect(vm.urgentNotificationCount).toBe(0);
    expect(vm.members.find((m) => m.memberId === "alice")?.liveness).toBeNull();
  });
});

describe("view-model — V2 Luna projection (Phase 4; Req 4.5)", () => {
  const emptyRisk: GetRiskMapData = {
    paths: [],
    plannedFileCreations: [],
    highestRevision: 0,
  };

  it("projects Luna's last reply with any produced task/message ids", () => {
    const vm = buildCoordinationViewModel({
      riskMap: emptyRisk,
      luna: {
        action: "assign",
        summary: "Assigned the parser work to bob.",
        producedTaskId: "task-7",
      },
      connection: online,
      staleness: fresh,
    });
    expect(vm.lunaLastReply).toEqual({
      action: "assign",
      summary: "Assigned the parser work to bob.",
      producedTaskId: "task-7",
      producedMessageId: null,
    });
  });

  it("defaults lunaLastReply to null when Luna has not been asked", () => {
    const vm = buildCoordinationViewModel({
      riskMap: emptyRisk,
      connection: online,
      staleness: fresh,
    });
    expect(vm.lunaLastReply).toBeNull();
  });
});

describe("view-model — V2 live-diff projection (Phase 5; Req 5.5)", () => {
  const emptyRisk: GetRiskMapData = {
    paths: [],
    plannedFileCreations: [],
    highestRevision: 0,
  };

  it("projects shared Live_Diffs read-only with member and patch", () => {
    const vm = buildCoordinationViewModel({
      riskMap: emptyRisk,
      diffs: {
        diffs: [
          {
            path: "src/api.ts",
            member: { memberId: "alice", deviceId: "d-1" },
            patch: "@@ -1 +1 @@\n-old\n+new",
            eventRevision: 3,
          },
        ],
      },
      connection: online,
      staleness: fresh,
    });
    expect(vm.liveDiffs).toEqual([
      { path: "src/api.ts", memberId: "alice", patch: "@@ -1 +1 @@\n-old\n+new" },
    ]);
  });

  it("defaults to no live diffs when the opt-in is off / data absent", () => {
    const vm = buildCoordinationViewModel({
      riskMap: emptyRisk,
      connection: online,
      staleness: fresh,
    });
    expect(vm.liveDiffs).toEqual([]);
  });
});
