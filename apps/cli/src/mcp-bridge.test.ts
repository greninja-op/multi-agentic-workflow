import { LocalApiServer } from "@cfls/agent";
import {
  COORDINATION_UPDATE_LOGGER,
  COORDINATION_UPDATE_NOTIFICATION_TYPE,
  type CoordinationUpdateNotificationData,
  type McpEnvelope,
  TOOL_NAMES,
} from "@cfls/mcp-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CoordinationUpdate, SessionId } from "@cfls/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { writeLocalApiConfig, type LocalApiConfigFile } from "./config-files";
import {
  createMcpBridge,
  LocalApiWebSocketClient,
  type McpBridge,
} from "./mcp-bridge";

const session: SessionId = {
  repoId: "repo-bridge",
  teamId: "team-bridge",
  branch: "main",
  baseRevision: "base-1",
};

const connection = {
  status: "online" as const,
  hostUrl: "wss://coordination.example.test",
  lastSyncAt: "2026-07-21T12:00:00.000Z",
};

const staleness = { stale: false, secondsSinceSync: 0 };

function success(data: unknown): McpEnvelope<unknown> {
  return { ok: true, data, connection, staleness };
}

interface Harness {
  localApi: LocalApiServer;
  bridge: McpBridge;
  client: Client;
  requestCalls: Array<{ method: string; params: unknown }>;
  subscribeCalls: number;
  pushUpdate: ((update: unknown) => void) | undefined;
}

let harness: Harness | undefined;

async function createHarness(
  options: { discoveryPath?: string } = {},
): Promise<Harness> {
  const requestCalls: Array<{ method: string; params: unknown }> = [];
  let subscribeCalls = 0;
  let pushUpdate: ((update: unknown) => void) | undefined;
  const localApi = new LocalApiServer({
    token: "bridge-test-token",
    enableNamedPipe: false,
    handlers: {
      request: async (method, params) => {
        requestCalls.push({ method, params });
        switch (method) {
          case "get_connection_status":
            return success({
              status: "online",
              participants: { connected: ["ada", "lin"], offline: [] },
              manualCoordinationRequired: false,
            });
          case "get_project_session_status":
            return success({
              session: { ...session, manualConfig: false },
              authorized: true,
              memberId: "ada",
            });
          case "get_team_status":
            return success({
              teamId: session.teamId,
              highestRevision: 7,
              members: [
                {
                  memberId: "lin",
                  deviceIds: ["device-lin"],
                  files: [{ path: "src/server.ts", roles: ["editing"] }],
                  tasks: [
                    {
                      intentId: "intent-lin",
                      description: "Add status endpoint",
                      modifyPaths: ["src/server.ts"],
                      createPaths: [],
                    },
                  ],
                  lastEventRevision: 7,
                },
              ],
            });
          default:
            return success({ method, params });
        }
      },
      subscribe: async (_params, push) => {
        subscribeCalls += 1;
        pushUpdate = push;
        return { ok: true, data: { subscriptionId: "sub-bridge" } };
      },
    },
  });
  const address = await localApi.start();
  if (address.wsUrl === undefined) {
    throw new Error("Test Local_API did not start its WebSocket transport.");
  }

  const config: LocalApiConfigFile = {
    url: address.wsUrl,
    token: "bridge-test-token",
  };
  const bridge = await createMcpBridge(config, {
    connectTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
    ...(options.discoveryPath === undefined
      ? {}
      : { discoveryPath: options.discoveryPath }),
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await bridge.server.connect(serverTransport);
  const client = new Client({ name: "bridge-test-client", version: "0.0.0" });
  await client.connect(clientTransport);

  return {
    localApi,
    bridge,
    client,
    requestCalls,
    get subscribeCalls() {
      return subscribeCalls;
    },
    get pushUpdate() {
      return pushUpdate;
    },
  };
}

afterEach(async () => {
  if (harness === undefined) {
    return;
  }
  await harness.client.close();
  await harness.bridge.server.close();
  await harness.bridge.close();
  await harness.localApi.stop();
  harness = undefined;
});

describe("external Local_API MCP bridge", () => {
  it("exposes the existing MCP tools and forwards a team-status request", async () => {
    harness = await createHarness();

    const listed = await harness.client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(
      [...TOOL_NAMES].sort(),
    );

    const result = await harness.client.callTool({
      name: "get_team_status",
      arguments: { session },
    });
    const rawContent = (result as { content?: unknown }).content;
    const text = Array.isArray(rawContent)
      ? rawContent.find(isTextContent)
      : undefined;
    if (text === undefined) {
      throw new Error("The MCP server did not return a text result.");
    }
    const envelope = JSON.parse(text.text) as McpEnvelope<{
      members: Array<{
        memberId: string;
        tasks: Array<{ description: string }>;
      }>;
    }>;
    expect(envelope.ok).toBe(true);
    expect(envelope.connection).toEqual(connection);
    expect(envelope.staleness).toEqual(staleness);
    expect(envelope.data?.members[0]?.memberId).toBe("lin");
    expect(envelope.data?.members[0]?.tasks[0]?.description).toBe(
      "Add status endpoint",
    );
    expect(harness.requestCalls).toContainEqual({
      method: "get_team_status",
      params: { session },
    });
  });

  it("authenticates before forwarding and relays Local_API subscriptions", async () => {
    harness = await createHarness();
    const updates: CoordinationUpdate[] = [];
    const repeatedUpdates: CoordinationUpdate[] = [];

    const subscription =
      await harness.bridge.port.subscribeToCoordinationUpdates(
        { session },
        (update) => updates.push(update),
      );
    const repeated = await harness.bridge.port.subscribeToCoordinationUpdates(
      { session },
      (update) => repeatedUpdates.push(update),
    );
    expect(subscription).toEqual({
      ok: true,
      data: { subscriptionId: "sub-bridge" },
    });
    expect(repeated).toEqual(subscription);
    expect(harness.requestCalls[0]?.method).toBe("get_connection_status");
    expect(harness.subscribeCalls).toBe(1);

    const update = {
      eventRevision: 8,
      entryType: "presence",
    } as unknown as CoordinationUpdate;
    harness.pushUpdate?.(update);
    await expect.poll(() => updates).toEqual([update]);
    await expect.poll(() => repeatedUpdates).toEqual([update]);
  });

  it("restores a live stream after agent restart without a later MCP tool call", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cfls-mcp-bridge-"));
    const discoveryPath = join(directory, "local-api.json");
    let restartedApi: LocalApiServer | undefined;
    try {
      harness = await createHarness({ discoveryPath });
      const initialAddress = harness.localApi.boundAddress();
      if (initialAddress.wsUrl === undefined) {
        throw new Error(
          "Test Local_API did not expose an initial WebSocket URL.",
        );
      }
      writeLocalApiConfig(discoveryPath, {
        url: initialAddress.wsUrl,
        token: "bridge-test-token",
      });

      const updates: CoordinationUpdate[] = [];
      await harness.bridge.port.subscribeToCoordinationUpdates(
        { session },
        (update) => updates.push(update),
      );
      expect(harness.subscribeCalls).toBe(1);

      let restartedSubscribeCalls = 0;
      let pushRestartedUpdate: ((update: unknown) => void) | undefined;
      const restartedRequestCalls: string[] = [];
      restartedApi = new LocalApiServer({
        token: "rotated-bridge-test-token",
        enableNamedPipe: false,
        handlers: {
          request: async (method, params) => {
            restartedRequestCalls.push(method);
            switch (method) {
              case "get_connection_status":
                return success({
                  status: "online",
                  participants: { connected: ["ada", "lin"], offline: [] },
                  manualCoordinationRequired: false,
                });
              default:
                return success({ method, params });
            }
          },
          subscribe: async (_params, push) => {
            restartedSubscribeCalls += 1;
            pushRestartedUpdate = push;
            return { ok: true, data: { subscriptionId: "sub-restarted" } };
          },
        },
      });
      const restartedAddress = await restartedApi.start();
      if (restartedAddress.wsUrl === undefined) {
        throw new Error("Restarted Local_API did not expose a WebSocket URL.");
      }
      // This is the record the bridge must reread after the old socket closes.
      // Keeping both servers up here guarantees the URL is actually different.
      writeLocalApiConfig(discoveryPath, {
        url: restartedAddress.wsUrl,
        token: "rotated-bridge-test-token",
      });
      expect(restartedAddress.wsUrl).not.toBe(initialAddress.wsUrl);

      await harness.localApi.stop();
      // No tool is called after the old socket closes. The bridge must reread
      // the atomically rotated discovery record, authenticate to the new
      // Local_API, and restore the existing logical subscription on its own.
      await expect
        .poll(() => restartedSubscribeCalls, {
          timeout: 15_000,
          interval: 200,
        })
        .toBe(1);
      expect(restartedRequestCalls).not.toContain("get_team_status");

      const recoveredUpdate = {
        eventRevision: 12,
        entryType: "presence",
        op: "added",
        path: "src/recovered.ts",
        member: { memberId: "lin", deviceId: "device-lin-rotated" },
      } as const;
      if (pushRestartedUpdate === undefined) {
        throw new Error(
          "The restored Local_API subscription did not register.",
        );
      }
      pushRestartedUpdate(recoveredUpdate);
      await expect
        .poll(() => updates, { timeout: 15_000, interval: 200 })
        .toEqual([recoveredUpdate]);

      // The shared afterEach owns the restarted server from this point on.
      harness.localApi = restartedApi;
      restartedApi = undefined;
    } finally {
      if (restartedApi !== undefined) {
        await restartedApi.stop();
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it("relays deduplicated Local_API updates as standard MCP notifications", async () => {
    harness = await createHarness();
    const notifications: CoordinationUpdateNotificationData[] = [];
    harness.client.setNotificationHandler(
      LoggingMessageNotificationSchema,
      (notification) => {
        if (
          notification.params.logger === COORDINATION_UPDATE_LOGGER &&
          isCoordinationUpdateNotification(notification.params.data)
        ) {
          notifications.push(notification.params.data);
        }
      },
    );

    const first = await harness.client.callTool({
      name: "subscribe_to_coordination_updates",
      arguments: { session },
    });
    const repeated = await harness.client.callTool({
      name: "subscribe_to_coordination_updates",
      arguments: { session },
    });
    const firstEnvelope = toolEnvelope<{ subscriptionId: string }>(first);
    const repeatedEnvelope = toolEnvelope<{ subscriptionId: string }>(repeated);
    expect(firstEnvelope.ok).toBe(true);
    expect(repeatedEnvelope.data?.subscriptionId).toBe(
      firstEnvelope.data?.subscriptionId,
    );
    expect(harness.subscribeCalls).toBe(1);

    const update = {
      eventRevision: 8,
      entryType: "presence",
      op: "added",
      path: "src/team.ts",
      member: { memberId: "lin", deviceId: "device-lin" },
    } as const;
    if (harness.pushUpdate === undefined) {
      throw new Error(
        "The Local_API subscription did not register an update push.",
      );
    }
    harness.pushUpdate(update);

    await expect
      .poll(() => notifications)
      .toEqual([
        {
          type: COORDINATION_UPDATE_NOTIFICATION_TYPE,
          update,
        },
      ]);
  });

  it("rejects a discovery record that points outside numeric loopback", async () => {
    await expect(
      LocalApiWebSocketClient.connect({
        url: "ws://example.com:8750",
        token: "not-a-secret-we-assert",
      }),
    ).rejects.toThrow("numeric loopback");
  });

  it("rejects an invalid Local_API authentication token", async () => {
    harness = await createHarness();
    const address = harness.localApi.boundAddress();
    await expect(
      LocalApiWebSocketClient.connect({
        url: address.wsUrl!,
        token: "wrong-token",
      }),
    ).rejects.toThrow("authentication failed");
  });
});

function isTextContent(
  value: unknown,
): value is { type: "text"; text: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "text" in value &&
    value.type === "text" &&
    typeof value.text === "string"
  );
}

function toolEnvelope<T>(result: unknown): McpEnvelope<T> {
  const rawContent = (result as { content?: unknown }).content;
  const text = Array.isArray(rawContent)
    ? rawContent.find(isTextContent)
    : undefined;
  if (text === undefined) {
    throw new Error("The MCP server did not return a text result.");
  }
  return JSON.parse(text.text) as McpEnvelope<T>;
}

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
