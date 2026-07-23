/**
 * @cfls/vscode-extension - the VS Code Editor_Extension entrypoint.
 *
 * The entrypoint owns the extension lifecycle and coordination refresh loop.
 * Every VS Code API call lives in `vscode-adapter`; pure presentation rules live
 * in `presence-ui`, so this module can remain a small orchestration boundary.
 */

import { ALL_SOFT_CONFIG, type RepositoryRulesConfig } from "@cfls/core-state";
import type {
  ConnectionSnapshot,
  ConnectionStatusData,
  GetRiskMapData,
  GetTeamStatusData,
  McpEnvelope,
  StalenessSnapshot,
} from "@cfls/mcp-server";
import type { SessionId } from "@cfls/protocol";

import { EditorEventForwarder } from "./editor-host";
import { enforceHardStop } from "./hard-stop";
import {
  LocalApiClient,
  LocalApiReconnectController,
} from "./local-api-client";
import { WebSocketFrameTransport } from "./transport";
import {
  CoordinationUiController,
  onWillSaveTextDocument,
  readLocalApiSettings,
  readRepositoryRules,
  registerCommand,
  setUpDemoWorkspace,
  showErrorMessage,
  showWarningMessage,
  type VsCodeExtensionContext,
  VsCodeEditorHost,
} from "./vscode-adapter";
import {
  buildConnectionStatusOnlyViewModel,
  buildCoordinationViewModel,
  buildTeamStatusOnlyViewModel,
  type CoordinationViewModel,
} from "./view-model";

/** Package identifier. */
export const APP_NAME = "@cfls/vscode-extension";

/** Extension-scoped runtime state, torn down on deactivate. */
interface Runtime {
  recovery: LocalApiReconnectController<LocalApiClient>;
  editorHost: VsCodeEditorHost;
  forwarder: EditorEventForwarder;
  ui: CoordinationUiController;
  refreshTimer: ReturnType<typeof setInterval>;
}

/** Exact risk data retained so an asynchronous team response cannot rederive it. */
interface RiskSnapshot {
  session: SessionId;
  riskMap: GetRiskMapData;
  connection: ConnectionSnapshot;
  staleness: StalenessSnapshot;
}

let runtime: Runtime | undefined;
let currentViewModel: CoordinationViewModel | undefined;
let currentSession: SessionId | undefined;
let rules: RepositoryRulesConfig = ALL_SOFT_CONFIG;
let latestRiskSnapshot: RiskSnapshot | undefined;
/** The last successful metadata-only team projection. */
let cachedTeamStatus: GetTeamStatusData | undefined;
/** The last successful live roster, independent of members' active work. */
let cachedConnectionStatus: ConnectionStatusData | undefined;
/** One in-flight team request prevents the two-second poll from piling up. */
let teamStatusRequest: Promise<void> | undefined;
/** One in-flight roster request prevents the two-second poll from piling up. */
let connectionStatusRequest: Promise<void> | undefined;
/** One in-flight risk request prevents out-of-order snapshots from overwriting newer UI. */
let riskMapRequest: Promise<void> | undefined;
/** Invalidates asynchronous refreshes after deactivate/reactivate. */
let runtimeEpoch = 0;
/**
 * This client's own Team_Member id, resolved from the agent's
 * `get_project_session_status`. Used so cooperative hard-stop never treats the
 * user's own lock as a block (own activity is already excluded from the Risk_Map
 * at the agent, Req 31.5, but this keeps the decision correct regardless).
 */
let selfMemberId = "self";

/** True only while a callback still belongs to the live replacement client. */
function isCurrentLocalApiClient(client: LocalApiClient): boolean {
  return runtime?.recovery.current() === client;
}

/** Render a risk result immediately, using the most recent team metadata. */
function renderRiskResponse(
  ui: CoordinationUiController,
  session: SessionId,
  envelope: McpEnvelope<GetRiskMapData>,
): void {
  if (!envelope.ok || envelope.data === undefined) {
    return;
  }
  latestRiskSnapshot = {
    session,
    riskMap: envelope.data,
    connection: envelope.connection,
    staleness: envelope.staleness,
  };
  currentViewModel = buildCoordinationViewModel({
    riskMap: latestRiskSnapshot.riskMap,
    ...(cachedTeamStatus !== undefined ? { teamStatus: cachedTeamStatus } : {}),
    ...(cachedConnectionStatus !== undefined
      ? { connectionStatus: cachedConnectionStatus }
      : {}),
    teamId: session.teamId,
    connection: latestRiskSnapshot.connection,
    staleness: latestRiskSnapshot.staleness,
  });
  ui.render(currentViewModel);
}

/**
 * Render whichever metadata projections have arrived without making live
 * roster visibility depend on a Risk_Map or an active-work record. Both
 * `get_team_status` and `get_connection_status` call this after updating their
 * independent caches.
 */
function renderMetadataResponse(
  ui: CoordinationUiController,
  session: SessionId,
  connection: ConnectionSnapshot,
  staleness: StalenessSnapshot,
): void {
  if (latestRiskSnapshot?.session === session) {
    currentViewModel = buildCoordinationViewModel({
      riskMap: latestRiskSnapshot.riskMap,
      ...(cachedTeamStatus !== undefined
        ? { teamStatus: cachedTeamStatus }
        : {}),
      ...(cachedConnectionStatus !== undefined
        ? { connectionStatus: cachedConnectionStatus }
        : {}),
      teamId: session.teamId,
      // Keep the exact Risk_Map, but use the newest metadata response for the
      // connection chip and roster states. In particular, an offline roster
      // response must never leave the panel header claiming the host is live.
      connection,
      staleness,
    });
  } else if (cachedTeamStatus !== undefined) {
    currentViewModel = buildTeamStatusOnlyViewModel({
      teamStatus: cachedTeamStatus,
      ...(cachedConnectionStatus !== undefined
        ? { connectionStatus: cachedConnectionStatus }
        : {}),
      teamId: session.teamId,
      connection,
      staleness,
    });
  } else if (cachedConnectionStatus !== undefined) {
    currentViewModel = buildConnectionStatusOnlyViewModel({
      connectionStatus: cachedConnectionStatus,
      teamId: session.teamId,
      connection,
      staleness,
    });
  } else {
    return;
  }
  ui.render(currentViewModel);
}

/**
 * Refresh the richer team panel independently of risk/decorations. A delayed
 * team response can never freeze the editor UI, and only one request is active
 * until the Local_API's normal request timeout settles it.
 */
function refreshTeamStatus(
  client: LocalApiClient,
  ui: CoordinationUiController,
  session: SessionId,
  epoch: number,
): void {
  if (!isCurrentLocalApiClient(client) || teamStatusRequest !== undefined) {
    return;
  }
  const request = client
    .request("get_team_status", { session })
    .then((response) => {
      if (
        epoch !== runtimeEpoch ||
        currentSession !== session ||
        !isCurrentLocalApiClient(client)
      ) {
        return;
      }
      const envelope = response as McpEnvelope<GetTeamStatusData>;
      if (!envelope.ok || envelope.data === undefined) {
        return;
      }
      cachedTeamStatus = envelope.data;
      // Preserve the exact latest Risk_Map rather than attempting to recreate
      // it from display data. This lets the panel update immediately without
      // changing risk/decorations or waiting for the next poll. If risk is
      // temporarily unavailable, still render the live metadata-only team
      // panel rather than making it depend on a separate query succeeding.
      renderMetadataResponse(
        ui,
        session,
        envelope.connection,
        envelope.staleness,
      );
    })
    .catch(() => {
      // Keep the previous team metadata; risk/decorations remain responsive.
    })
    .finally(() => {
      if (teamStatusRequest === request) {
        teamStatusRequest = undefined;
      }
    });
  teamStatusRequest = request;
}

/**
 * Refresh the live host roster separately from activity. The response includes
 * idle admitted members, which must remain visible even before they edit a
 * file or declare work.
 */
function refreshConnectionStatus(
  client: LocalApiClient,
  ui: CoordinationUiController,
  session: SessionId,
  epoch: number,
): void {
  if (
    !isCurrentLocalApiClient(client) ||
    connectionStatusRequest !== undefined
  ) {
    return;
  }
  const request = client
    .request("get_connection_status", {})
    .then((response) => {
      if (
        epoch !== runtimeEpoch ||
        currentSession !== session ||
        !isCurrentLocalApiClient(client)
      ) {
        return;
      }
      const envelope = response as McpEnvelope<ConnectionStatusData>;
      if (!envelope.ok || envelope.data === undefined) {
        return;
      }
      cachedConnectionStatus = envelope.data;
      renderMetadataResponse(
        ui,
        session,
        envelope.connection,
        envelope.staleness,
      );
    })
    .catch(() => {
      // Keep the last known roster; activity and risk refresh independently.
    })
    .finally(() => {
      if (connectionStatusRequest === request) {
        connectionStatusRequest = undefined;
      }
    });
  connectionStatusRequest = request;
}

/**
 * Fetch risk, team activity, and roster independently. A slow or failed risk
 * query must never prevent the status-bar panel from refreshing.
 */
function refresh(
  client: LocalApiClient,
  ui: CoordinationUiController,
): Promise<void> {
  if (currentSession === undefined || !isCurrentLocalApiClient(client)) {
    return Promise.resolve();
  }
  const session = currentSession;
  const epoch = runtimeEpoch;
  // Start this first, independently of the risk request. It is intentionally
  // not awaited: either result can update the panel while risk is timing out.
  refreshTeamStatus(client, ui, session, epoch);
  refreshConnectionStatus(client, ui, session, epoch);
  if (riskMapRequest !== undefined) {
    return riskMapRequest;
  }
  const request = Promise.resolve()
    .then(() => client.request("get_risk_map", { session }))
    .then((riskResponse) => {
      if (
        epoch !== runtimeEpoch ||
        currentSession !== session ||
        !isCurrentLocalApiClient(client)
      ) {
        return;
      }
      renderRiskResponse(
        ui,
        session,
        riskResponse as McpEnvelope<GetRiskMapData>,
      );
    })
    .catch(() => {
      // Preserve the last known risk/decorations; the team request remains live.
    })
    .finally(() => {
      if (riskMapRequest === request) {
        riskMapRequest = undefined;
      }
    });
  riskMapRequest = request;
  return request;
}

/** Resolve the Repository_Session from the local CoordinationAgent. */
async function resolveSession(client: LocalApiClient): Promise<SessionId> {
  const envelope = (await client.request(
    "get_project_session_status",
    {},
  )) as McpEnvelope<{
    session: {
      repoId: string;
      teamId: string;
      branch: string;
      baseRevision: string | null;
    };
    memberId?: string;
  }>;
  if (!envelope.ok || envelope.data === undefined) {
    throw new Error("The local agent did not return a project session.");
  }
  const { repoId, teamId, branch, baseRevision } = envelope.data.session;
  currentSession = { repoId, teamId, branch, baseRevision };
  if (
    typeof envelope.data.memberId === "string" &&
    envelope.data.memberId !== ""
  ) {
    selfMemberId = envelope.data.memberId;
  }
  return currentSession;
}

/** Blank offline snapshots used before the first successful fetch. */
function offlineSnapshot(): {
  connection: ConnectionSnapshot;
  staleness: StalenessSnapshot;
} {
  return {
    connection: { status: "offline", hostUrl: "", lastSyncAt: null },
    staleness: { stale: true, secondsSinceSync: null },
  };
}

/**
 * Render a deliberately offline model after the local service disappears.
 * Keep harmless last-known team metadata visible as stale context, but clear
 * path risk so the cooperative hard-stop correctly falls back to the explicit
 * offline/manual-coordination rule rather than presenting old locks as live.
 */
function renderLocalAgentUnavailable(ui: CoordinationUiController): void {
  const highestRevision = Math.max(
    latestRiskSnapshot?.riskMap.highestRevision ?? 0,
    cachedTeamStatus?.highestRevision ?? 0,
  );
  currentViewModel = buildCoordinationViewModel({
    riskMap: {
      paths: [],
      plannedFileCreations: [],
      highestRevision,
    },
    ...(cachedTeamStatus !== undefined ? { teamStatus: cachedTeamStatus } : {}),
    ...(cachedConnectionStatus !== undefined
      ? { connectionStatus: cachedConnectionStatus }
      : {}),
    ...(currentSession !== undefined ? { teamId: currentSession.teamId } : {}),
    ...offlineSnapshot(),
  });
  ui.render(currentViewModel);
}

/** VS Code entrypoint. All runtime VS Code calls are delegated to the adapter. */
export async function activate(context: VsCodeExtensionContext): Promise<void> {
  runtimeEpoch += 1;
  currentSession = undefined;
  currentViewModel = undefined;
  selfMemberId = "self";
  cachedTeamStatus = undefined;
  cachedConnectionStatus = undefined;
  teamStatusRequest = undefined;
  connectionStatusRequest = undefined;
  riskMapRequest = undefined;
  latestRiskSnapshot = undefined;
  // Load the team's committed rules so hard-stop resolves path modes as the
  // agent does (Req 15); fail-safe all-soft when absent/malformed (Req 15.5).
  rules = readRepositoryRules();
  const epoch = runtimeEpoch;

  const editorHost = new VsCodeEditorHost();
  const ui = new CoordinationUiController({
    selfMemberId,
    ...(context.extensionUri !== undefined
      ? { extensionUri: context.extensionUri }
      : {}),
  });
  ui.register(context.subscriptions);

  // Seed an offline model so the status chip and all empty UI states are ready
  // before the first successful local-Agent request.
  currentViewModel = buildCoordinationViewModel({
    riskMap: { paths: [], plannedFileCreations: [], highestRevision: 0 },
    ...offlineSnapshot(),
  });
  ui.render(currentViewModel);

  const recovery = new LocalApiReconnectController({
    // This factory intentionally rereads the private discovery record on every
    // fresh attempt. `cfls agent` rotates its loopback endpoint/token whenever
    // the service restarts, so retaining the activation-time settings would
    // make recovery authenticate against a dead credential forever.
    createClient: () => {
      const settings = readLocalApiSettings();
      return new LocalApiClient({
        transport: new WebSocketFrameTransport(settings.url),
        token: settings.token,
        heartbeatIntervalMs: settings.heartbeatIntervalMs,
      });
    },
    initialize: async (client) => {
      const session = await resolveSession(client);
      if (epoch !== runtimeEpoch) {
        throw new Error("The VS Code extension runtime changed.");
      }
      ui.setSelfMemberId(selfMemberId);
      await client.subscribe({ session }, () => {
        // A dead client's late update must not refresh the newly connected
        // session. The new client gets its own single subscription below.
        if (epoch === runtimeEpoch && recovery.current() === client) {
          void refresh(client, ui);
        }
      });
    },
    onConnected: (client) => {
      if (epoch !== runtimeEpoch) {
        void recovery.close();
        return;
      }
      // A connected client becomes visible only after auth, session resolution,
      // and its one subscription all succeeded. No request from the dead client
      // is replayed here; refresh issues a brand-new snapshot query instead.
      // Editor events emitted before local authentication are deliberately not
      // replayed, but the *current* active editor is durable state. Reassert it
      // for startup and every Local_API recovery so the agent can retire any
      // stale prior active scope and claim only the file currently in focus.
      client.sendEditorEvent(editorHost.currentActiveEditorEvent());
      void refresh(client, ui);
    },
    onUnavailable: () => {
      if (epoch !== runtimeEpoch) {
        return;
      }
      // Drop the old in-flight guards so a recovered client can immediately
      // issue fresh reads rather than waiting for a dead socket's timeout.
      teamStatusRequest = undefined;
      connectionStatusRequest = undefined;
      riskMapRequest = undefined;
      renderLocalAgentUnavailable(ui);
    },
  });

  const forwarder = new EditorEventForwarder(editorHost, (event) => {
    // Events occurring while offline are intentionally not buffered or replayed
    // after recovery. They describe transient editor activity and must not be
    // attributed to a later agent session.
    recovery.current()?.sendEditorEvent(event);
  });

  const refreshTimer = setInterval(() => {
    const client = recovery.current();
    if (client === undefined) {
      // `connect` deduplicates an in-flight run. Invoking it from the poll keeps
      // retry batches alive after the bounded backoff is exhausted while the
      // service is still unavailable.
      void recovery.connect();
      return;
    }
    void refresh(client, ui);
  }, 2_000);
  refreshTimer.unref?.();

  // Cooperative hard-stop: surface a clear warning when a save is attempted on
  // a hard-locked path held by another member. The public VS Code API exposes
  // this as a pre-save notification rather than a cancellable edit operation;
  // CFLS therefore never misrepresents it as an OS-level file lock.
  context.subscriptions.push(
    onWillSaveTextDocument((path) => {
      if (currentViewModel === undefined) {
        return;
      }
      const decision = enforceHardStop(
        currentViewModel,
        rules,
        path,
        selfMemberId,
      );
      if (!decision.allowed) {
        showErrorMessage(decision.message);
      } else if (decision.reason === "offline-manual-coordination") {
        showWarningMessage(`${decision.message} (${path})`);
      }
    }),
    registerCommand("cfls.showCoordinationStatus", async () => {
      // The user explicitly opened the team panel: make one fresh roster read
      // first. This ensures its initial document contains every connected
      // teammate even if a webview later refuses script execution.
      const client = recovery.current();
      const session = currentSession;
      if (client !== undefined && session !== undefined) {
        try {
          const response = (await client.request(
            "get_connection_status",
            {},
          )) as McpEnvelope<ConnectionStatusData>;
          if (response.ok && response.data !== undefined) {
            cachedConnectionStatus = response.data;
            renderMetadataResponse(
              ui,
              session,
              response.connection,
              response.staleness,
            );
          }
        } catch {
          // Keep the last rendered state; the normal reconnect loop remains
          // responsible for recovering a temporarily unavailable local agent.
        }
      }
      const vm = currentViewModel;
      if (vm === undefined) {
        showWarningMessage(
          "CFLS: The local coordination agent has not supplied a status yet.",
        );
        return;
      }
      ui.showTeamPanel(vm, vm.teamId ?? currentSession?.teamId ?? "CFLS Team");
    }),
    registerCommand("cfls.reconnectLocalAgent", () => {
      void recovery.reconnect();
    }),
    registerCommand("cfls.setupDemo", () => {
      void setUpDemoWorkspace()
        .then(() => recovery.reconnect())
        .catch((error: unknown) => {
          showErrorMessage(
            `CFLS setup could not finish: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }),
  );

  runtime = { recovery, editorHost, forwarder, ui, refreshTimer };
  // Return activation promptly with its offline-ready UI; connection/recovery
  // occurs in the background and does not leave the status item unrendered.
  void recovery.connect();
}

/** VS Code teardown. */
export function deactivate(): void {
  runtimeEpoch += 1;
  if (runtime === undefined) {
    return;
  }
  clearInterval(runtime.refreshTimer);
  runtime.forwarder.dispose();
  runtime.editorHost.dispose();
  runtime.ui.dispose();
  void runtime.recovery.close();
  runtime = undefined;
  teamStatusRequest = undefined;
  connectionStatusRequest = undefined;
  riskMapRequest = undefined;
  cachedTeamStatus = undefined;
  cachedConnectionStatus = undefined;
  latestRiskSnapshot = undefined;
  currentSession = undefined;
  currentViewModel = undefined;
  selfMemberId = "self";
}
