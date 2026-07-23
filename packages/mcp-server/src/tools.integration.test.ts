/**
 * Integration tests for MCP tool round-trips (task 7.3; Req 4.3–4.6, 4.8, 33.1).
 *
 * Exercises the real `@modelcontextprotocol/sdk` client/server over an in-memory
 * transport, against the core-state-backed {@link CoreStateAgentPort}. Covers
 * query tools, a mutating tool, and an offline-queued mutation end-to-end,
 * asserting the common {@link McpEnvelope} is returned on every response.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { DependencyGraph, MemberRef, SessionId } from "@cfls/protocol";
import { afterEach, describe, expect, it } from "vitest";

import type { McpEnvelope } from "./envelope";
import { CoreStateAgentPort } from "./fake-agent";
import { createMcpServer } from "./server";
import {
  COORDINATION_UPDATE_LOGGER,
  COORDINATION_UPDATE_NOTIFICATION_TYPE,
  type CoordinationUpdateNotificationData,
  TOOL_NAMES,
} from "./tools";

const session: SessionId = {
  repoId: "repo-1",
  teamId: "team-1",
  branch: "main",
  baseRevision: "base-9",
};
const self: MemberRef = { memberId: "u-1", deviceId: "d-1" };

// A tiny metadata-only dependency graph: routes.ts -> api.ts -> db.ts.
const graph: DependencyGraph = {
  snapshot: {
    sessionId: session,
    graphVersion: 1,
    analyzerVersion: "test",
  },
  packages: [],
  modules: [
    {
      sourceFile: "src/routes.ts",
      edges: [
        {
          from: "src/routes.ts",
          to: "src/api.ts",
          kind: "runtime_import",
          confidence: "high",
        },
      ],
    },
    {
      sourceFile: "src/api.ts",
      edges: [
        {
          from: "src/api.ts",
          to: "src/db.ts",
          kind: "runtime_import",
          confidence: "high",
        },
      ],
    },
  ],
  contracts: [],
};

interface Harness {
  client: Client;
  agent: CoreStateAgentPort;
  call: <T>(
    name: string,
    args: Record<string, unknown>,
  ) => Promise<McpEnvelope<T>>;
  close: () => Promise<void>;
}

async function connectHarness(online = true): Promise<Harness> {
  const agent = new CoreStateAgentPort({ session, self, online, graph });
  const server = createMcpServer(agent);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);

  const call = async <T>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpEnvelope<T>> => {
    const result = await client.callTool({ name, arguments: args });
    return result.structuredContent as unknown as McpEnvelope<T>;
  };

  return {
    client,
    agent,
    call,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("MCP tool round-trips over the SDK in-memory transport", () => {
  let harness: Harness;

  afterEach(async () => {
    await harness.close();
  });

  it("exposes every named coordination tool", async () => {
    harness = await connectHarness();
    const listed = await harness.client.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    expect(names).toEqual([...TOOL_NAMES].sort());
  });

  it("get_project_session_status returns the session identity + envelope (Req 4.6)", async () => {
    harness = await connectHarness();
    const env = await harness.call<{
      session: { repoId: string; branch: string };
      authorized: boolean;
    }>("get_project_session_status", {});

    expect(env.ok).toBe(true);
    expect(env.data?.session.repoId).toBe("repo-1");
    expect(env.data?.session.branch).toBe("main");
    expect(env.data?.authorized).toBe(true);
    // Every response carries connection + staleness (Req 4.7, 33.2).
    expect(env.connection.status).toBe("online");
    expect(env.staleness.stale).toBe(false);
  });

  it("get_connection_status reports connectivity + participants (Req 4.6)", async () => {
    harness = await connectHarness();
    const env = await harness.call<{
      status: string;
      manualCoordinationRequired: boolean;
    }>("get_connection_status", {});
    expect(env.ok).toBe(true);
    expect(env.data?.status).toBe("online");
    expect(env.data?.manualCoordinationRequired).toBe(false);
  });

  it("get_dependencies / get_dependents return metadata-only edges (Req 4.5)", async () => {
    harness = await connectHarness();

    const deps = await harness.call<{
      dependsOn: string[];
      presentInGraph: boolean;
    }>("get_dependencies", { path: "src/api.ts" });
    expect(deps.ok).toBe(true);
    expect(deps.data?.presentInGraph).toBe(true);
    expect(deps.data?.dependsOn).toEqual(["src/db.ts"]);

    const dependents = await harness.call<{ dependedOnBy: string[] }>(
      "get_dependents",
      { path: "src/api.ts" },
    );
    expect(dependents.data?.dependedOnBy).toEqual(["src/routes.ts"]);
  });

  it("get_dependency_impact returns an empty result for a path absent from the graph (Req 23.5)", async () => {
    harness = await connectHarness();
    const env = await harness.call<{
      impacts: {
        path: string;
        presentInGraph: boolean;
        directDependencies: string[];
      }[];
    }>("get_dependency_impact", { paths: ["src/unknown.ts"] });
    expect(env.ok).toBe(true);
    const impact = env.data?.impacts[0];
    expect(impact?.presentInGraph).toBe(false);
    expect(impact?.directDependencies).toEqual([]);
  });

  it("get_risk_map returns a machine-readable Risk_Map envelope (Req 4.3)", async () => {
    harness = await connectHarness();
    const env = await harness.call<{
      paths: unknown[];
      plannedFileCreations: unknown[];
      highestRevision: number;
    }>("get_risk_map", { session });
    expect(env.ok).toBe(true);
    expect(Array.isArray(env.data?.paths)).toBe(true);
    expect(Array.isArray(env.data?.plannedFileCreations)).toBe(true);
  });

  it("get_team_status returns active task and file metadata for local tools", async () => {
    harness = await connectHarness();
    await harness.call("declare_intent", {
      session,
      modifyPaths: ["src/api.ts"],
      createPaths: ["src/new.ts"],
      description: "Refine API response handling",
    });
    await harness.call("acquire_lock", {
      session,
      scope: "src/api.ts",
      scopeKind: "file",
    });

    const env = await harness.call<{
      teamId: string;
      members: Array<{
        memberId: string;
        files: Array<{ path: string; roles: string[] }>;
        tasks: Array<{
          description: string;
          modifyPaths: string[];
          createPaths: string[];
        }>;
      }>;
    }>("get_team_status", { session });

    expect(env.ok).toBe(true);
    expect(env.data?.teamId).toBe("team-1");
    expect(env.data?.members).toMatchObject([
      {
        memberId: "u-1",
        tasks: [
          {
            description: "Refine API response handling",
            modifyPaths: ["src/api.ts"],
            createPaths: ["src/new.ts"],
          },
        ],
      },
    ]);
    expect(env.data?.members[0]?.files).toContainEqual({
      path: "src/api.ts",
      roles: expect.arrayContaining(["intent", "soft-lock"]),
    });
  });

  it("acquire_lock (mutating tool) is granted and assigns an event revision (Req 12.1)", async () => {
    harness = await connectHarness();
    const env = await harness.call<{
      granted: boolean;
      lockId?: string;
      eventRevision: number;
    }>("acquire_lock", { session, scope: "src/api.ts", scopeKind: "file" });

    expect(env.ok).toBe(true);
    expect(env.data?.granted).toBe(true);
    expect(typeof env.data?.lockId).toBe("string");
    expect(env.data?.eventRevision).toBe(1);
  });

  it("declare_intent round-trips and echoes the recorded intent (Req 4.4)", async () => {
    harness = await connectHarness();
    const env = await harness.call<{ intentId: string; eventRevision: number }>(
      "declare_intent",
      {
        session,
        modifyPaths: ["src/api.ts"],
        createPaths: [],
        description: "refactor api",
      },
    );
    expect(env.ok).toBe(true);
    expect(env.data?.intentId).toMatch(/^int-/);
    expect(env.data?.eventRevision).toBeGreaterThan(0);
  });

  it("an offline mutation returns OFFLINE_QUEUED without host acceptance (Req 4.8, 33.1)", async () => {
    harness = await connectHarness(false);
    const env = await harness.call<unknown>("declare_intent", {
      session,
      modifyPaths: ["src/api.ts"],
      createPaths: [],
      description: "while offline",
    });

    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe("OFFLINE_QUEUED");
    // Connectivity/staleness still reported on the failed response.
    expect(env.connection.status).toBe("offline");
    expect(env.staleness.stale).toBe(true);
  });

  it("queries still succeed while offline, serving stale data (Req 33.1)", async () => {
    harness = await connectHarness(false);
    const env = await harness.call<{ dependsOn: string[] }>(
      "get_dependencies",
      {
        path: "src/api.ts",
      },
    );
    expect(env.ok).toBe(true);
    expect(env.data?.dependsOn).toEqual(["src/db.ts"]);
    expect(env.connection.status).toBe("offline");
    expect(env.staleness.stale).toBe(true);
  });

  it("streams a deduplicated subscription through standard MCP notifications", async () => {
    harness = await connectHarness();
    const updates: CoordinationUpdateNotificationData[] = [];
    harness.client.setNotificationHandler(
      LoggingMessageNotificationSchema,
      (notification) => {
        if (
          notification.params.logger === COORDINATION_UPDATE_LOGGER &&
          isCoordinationUpdateNotification(notification.params.data)
        ) {
          updates.push(notification.params.data);
        }
      },
    );

    const first = await harness.call<{ subscriptionId: string }>(
      "subscribe_to_coordination_updates",
      { session },
    );
    const repeated = await harness.call<{ subscriptionId: string }>(
      "subscribe_to_coordination_updates",
      { session },
    );
    expect(first.ok).toBe(true);
    expect(first.data?.subscriptionId).toMatch(/^sub-/);
    expect(repeated.data?.subscriptionId).toBe(first.data?.subscriptionId);

    const update = {
      entryType: "presence",
      op: "added",
      path: "src/team.ts",
      member: { memberId: "u-2", deviceId: "d-2" },
      eventRevision: 42,
    } as const;
    harness.agent.emit(update);

    await expect
      .poll(() => updates)
      .toEqual([
        {
          type: COORDINATION_UPDATE_NOTIFICATION_TYPE,
          update,
        },
      ]);
  });
});

function isCoordinationUpdateNotification(
  value: unknown,
): value is CoordinationUpdateNotificationData {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === COORDINATION_UPDATE_NOTIFICATION_TYPE &&
    "update" in value
  );
}

describe("V2 messaging tools (Phase 1; Req 1.1–1.4)", () => {
  let harness: Harness;

  afterEach(async () => {
    await harness.close();
  });

  it("sends a message and lists it back (own message not counted unread)", async () => {
    harness = await connectHarness();
    const sent = await harness.call<{ messageId: string; eventRevision: number }>(
      "send_message",
      { session, kind: "broadcast", body: "standup in 5" },
    );
    expect(sent.ok).toBe(true);
    expect(typeof sent.data?.messageId).toBe("string");

    const listed = await harness.call<{
      messages: Array<{ body: string }>;
      unreadCount: number;
    }>("list_messages", { session });
    expect(listed.ok).toBe(true);
    expect(listed.data?.messages.map((m) => m.body)).toContain("standup in 5");
    // The sender's own broadcast is excluded from its unread count (Req 1.4).
    expect(listed.data?.unreadCount).toBe(0);
  });

  it("asks and answers a question through the tools", async () => {
    harness = await connectHarness();
    const asked = await harness.call("ask_question", {
      session,
      toMemberId: "u-2",
      body: "which branch is prod?",
      correlationId: "c-1",
    });
    expect(asked.ok).toBe(true);

    const answered = await harness.call("answer_question", {
      session,
      toMemberId: "u-2",
      body: "main",
      correlationId: "c-1",
    });
    expect(answered.ok).toBe(true);

    const open = await harness.call("list_open_questions", { session });
    expect(open.ok).toBe(true);
  });

  it("marks a message read", async () => {
    harness = await connectHarness();
    const sent = await harness.call<{ messageId: string }>("send_message", {
      session,
      kind: "broadcast",
      body: "note",
    });
    const read = await harness.call("mark_message_read", {
      messageId: sent.data!.messageId,
    });
    expect(read.ok).toBe(true);
  });

  it("returns OFFLINE_QUEUED for send_message while offline (Req 4.8)", async () => {
    harness = await connectHarness(false);
    const sent = await harness.call("send_message", {
      session,
      kind: "broadcast",
      body: "offline",
    });
    expect(sent.ok).toBe(false);
    expect(sent.error?.code).toBe("OFFLINE_QUEUED");
  });
});

describe("V2 task tools (Phase 2; Req 2.1–2.3)", () => {
  let harness: Harness;

  afterEach(async () => {
    await harness.close();
  });

  it("assigns a task and lists it as an incoming proposal for the assignee", async () => {
    // self is u-1; assign to u-1 so the same fake agent sees it as incoming.
    harness = await connectHarness();
    const assigned = await harness.call<{ taskId: string }>("assign_task", {
      session,
      title: "Add logout",
      description: "wire /logout",
      assigneeMemberId: "u-1",
    });
    expect(assigned.ok).toBe(true);

    const listed = await harness.call<{
      tasks: Array<{ status: string }>;
      incomingProposals: Array<{ taskId: string }>;
    }>("list_tasks", { session });
    expect(listed.ok).toBe(true);
    expect(listed.data?.incomingProposals.map((t) => t.taskId)).toContain(
      assigned.data!.taskId,
    );
  });

  it("accepts then progresses a task via the tools", async () => {
    harness = await connectHarness();
    const assigned = await harness.call<{ taskId: string }>("assign_task", {
      session,
      title: "T",
      description: "d",
      assigneeMemberId: "u-1",
    });
    const taskId = assigned.data!.taskId;

    expect((await harness.call("respond_to_task", { taskId, accept: true })).ok).toBe(true);
    expect(
      (await harness.call("update_task_progress", { taskId, status: "in_progress" })).ok,
    ).toBe(true);

    const listed = await harness.call<{ myTaskList: Array<{ status: string }> }>(
      "list_tasks",
      { session },
    );
    expect(listed.data?.myTaskList.map((t) => t.status)).toEqual(["in_progress"]);
  });

  it("returns OFFLINE_QUEUED for assign_task while offline (Req 4.8)", async () => {
    harness = await connectHarness(false);
    const assigned = await harness.call("assign_task", {
      session,
      title: "T",
      description: "d",
      assigneeMemberId: "u-2",
    });
    expect(assigned.ok).toBe(false);
    expect(assigned.error?.code).toBe("OFFLINE_QUEUED");
  });
});

describe("V2 liveness/notification/wake tools (Phase 3; Req 3.1–3.3)", () => {
  let harness: Harness;

  afterEach(async () => {
    await harness.close();
  });

  it("returns liveness for the session", async () => {
    harness = await connectHarness();
    const live = await harness.call<{
      members: Array<{ memberId: string; state: string }>;
    }>("get_liveness", { session });
    expect(live.ok).toBe(true);
    // self (u-1) is connected + just acted → active.
    expect(live.data?.members.find((m) => m.memberId === "u-1")?.state).toBe("active");
  });

  it("records a wake as a notification the target can read", async () => {
    // self is u-1; wake u-1 so the same fake surfaces it via get_notifications.
    harness = await connectHarness();
    const woke = await harness.call<{ targetMemberId: string }>("wake_member", {
      session,
      targetMemberId: "u-1",
      reason: "PR blocked",
    });
    expect(woke.ok).toBe(true);

    const notifs = await harness.call<{
      notifications: Array<{ source: string; severity: string; summary: string }>;
    }>("get_notifications", { session });
    expect(notifs.ok).toBe(true);
    const wake = notifs.data?.notifications.find((n) => n.source === "wake");
    expect(wake?.severity).toBe("urgent");
    expect(wake?.summary).toContain("PR blocked");
  });

  it("returns OFFLINE_QUEUED for wake_member while offline (Req 4.8)", async () => {
    harness = await connectHarness(false);
    const woke = await harness.call("wake_member", {
      session,
      targetMemberId: "u-2",
    });
    expect(woke.ok).toBe(false);
    expect(woke.error?.code).toBe("OFFLINE_QUEUED");
  });

  it("ask_luna returns a rules-based reply for the requested action (Req 4.2–4.4)", async () => {
    harness = await connectHarness();
    const reply = await harness.call<{ action: string; summary: string }>(
      "ask_luna",
      { session, action: "summarize", prompt: "What is the team doing?" },
    );
    expect(reply.ok).toBe(true);
    expect(reply.data?.action).toBe("summarize");
    expect(typeof reply.data?.summary).toBe("string");
    expect((reply.data?.summary ?? "").length).toBeGreaterThan(0);
  });

  it("returns OFFLINE_QUEUED for ask_luna while offline (Req 4.8)", async () => {
    harness = await connectHarness(false);
    const reply = await harness.call("ask_luna", {
      session,
      action: "answer",
      prompt: "Who owns the parser?",
    });
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe("OFFLINE_QUEUED");
  });

  it("share_diff stores a diff that list_diffs then returns (Req 5.1–5.5)", async () => {
    harness = await connectHarness();
    const shared = await harness.call<{ eventRevision: number; shared: boolean }>(
      "share_diff",
      { session, path: "src/api.ts", patch: "@@ -1 +1 @@\n-old\n+new" },
    );
    expect(shared.ok).toBe(true);
    expect(shared.data?.shared).toBe(true);

    const listed = await harness.call<{
      diffs: Array<{ path: string; patch: string }>;
    }>("list_diffs", { session });
    expect(listed.ok).toBe(true);
    expect(listed.data?.diffs.map((d) => d.path)).toEqual(["src/api.ts"]);

    // An empty patch clears the shared diff (Req 5.2, 5.3).
    const cleared = await harness.call<{ shared: boolean }>("share_diff", {
      session,
      path: "src/api.ts",
      patch: "",
    });
    expect(cleared.data?.shared).toBe(false);
    const after = await harness.call<{ diffs: unknown[] }>("list_diffs", {
      session,
    });
    expect(after.data?.diffs).toEqual([]);
  });

  it("returns OFFLINE_QUEUED for share_diff while offline (Req 4.8)", async () => {
    harness = await connectHarness(false);
    const shared = await harness.call("share_diff", {
      session,
      path: "src/api.ts",
      patch: "x",
    });
    expect(shared.ok).toBe(false);
    expect(shared.error?.code).toBe("OFFLINE_QUEUED");
  });
});
