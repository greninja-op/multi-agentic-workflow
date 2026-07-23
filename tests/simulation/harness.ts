/**
 * The 5-agent local multi-agent simulation harness (task 12.1; Req 6.7;
 * design §13.4).
 *
 * Wires ONE real {@link startHost | CoordinationHost} (`apps/host`) — its WSS/TLS
 * server, Ed25519 auth, ingest, SQLite store, broadcast, sync, and expiry — to
 * FIVE in-process real {@link CoordinationAgent}s (`apps/agent`), each with its
 * own WSS client, {@link AgentCoordinationPort}, and embedded Local_MCP_Server,
 * connected over the actual local WSS transport (a development self-signed
 * certificate; agents use `insecureTls`). Everything runs on one machine using
 * an ephemeral port and temp dirs for the SQLite store and per-agent encrypted
 * caches; Device_Keys and Signed_Invitations are provided through
 * `@cfls/security` so the real membership/authorization paths execute.
 *
 * The harness provides deterministic helpers to drive editor events
 * (`reportPresence` / `save`), MCP tool calls (`acquireLock`, `releaseLock`,
 * `declareIntent`, `getRiskMap`, …), and to await coordination convergence
 * (`waitUntil`, `waitForConverged`).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CoordinationAgent, type RunningAgent } from "@cfls/agent";
import { ALL_SOFT_CONFIG } from "@cfls/core-state";
import type {
  AcquireLockData,
  AgentResult,
  DeclareIntentData,
  GetDependenciesData,
  GetRiskMapData,
  MaybePromise,
  ReleaseLockData,
} from "@cfls/mcp-server";
import type {
  CoordinationUpdate,
  DependencyGraph,
  MemberRef,
  ScopeKind,
  SessionId,
} from "@cfls/protocol";
import {
  deriveDeviceId,
  generateDeviceKey,
  issueInvitation,
  type DeviceKey,
} from "@cfls/security";
import { startHost, type RunningHost } from "@cfls/host";

/** Default number of in-process agents connected to the single host (Req 6.7). */
export const DEFAULT_AGENT_COUNT = 5;

/** Options for {@link Simulation.start}. */
export interface SimulationOptions {
  /** How many in-process agents to connect (default 5). */
  agentCount?: number;
  /** Repository_Session overrides (repoId/teamId/branch). */
  session?: Partial<SessionId>;
  /** Metadata-only Dependency_Graph shared by every agent (indirect risk). */
  graph?: DependencyGraph;
  /** Heartbeat/expiry tuning forwarded to the host authority (Req 26). */
  expiry?: {
    heartbeatIntervalMs?: number;
    lockExpiryIntervalMs?: number;
    softLockMaxAgeMs?: number;
  };
  /** Host expiry-sweep interval (ms); 0 disables the timer (default 0, driven manually). */
  expirySweepIntervalMs?: number;
  /** Per-agent WSS heartbeat interval (ms); 0 disables auto pings (default 0). */
  heartbeatIntervalMs?: number;
  /** Enable opt-in Live_Diff sharing on the host (Phase 5; default off). */
  liveDiffs?: boolean;
}

/** One connected simulated agent plus its identity and live handles. */
export interface SimAgent {
  /** Stable member identity (`agent-0`, `agent-1`, …). */
  readonly member: MemberRef;
  /** The Ed25519 Device_Key backing this agent. */
  readonly deviceKey: DeviceKey;
  /** The assembled, started CoordinationAgent. */
  readonly agent: CoordinationAgent;
  /** The handles returned by {@link CoordinationAgent.start}. */
  readonly running: RunningAgent;
}

/** How long convergence helpers poll before giving up (ms). */
const CONVERGENCE_TIMEOUT_MS = 8_000;
/** Poll interval for convergence helpers (ms). */
const POLL_INTERVAL_MS = 15;

/**
 * A running one-host / five-agent simulation over the real local WSS transport.
 * Construct with {@link Simulation.start}; always {@link Simulation.stop} in a
 * test teardown to release the port, sockets, store, and temp dirs.
 */
export class Simulation {
  private constructor(
    readonly host: RunningHost,
    readonly session: SessionId,
    readonly admin: DeviceKey,
    readonly agents: SimAgent[],
    private readonly tmpRoot: string,
  ) {}

  /** The bound WSS URL of the host. */
  get hostUrl(): string {
    return `wss://127.0.0.1:${this.host.port}`;
  }

  /** Shorthand accessor for the agent at `index`. */
  agentAt(index: number): SimAgent {
    const agent = this.agents[index];
    if (agent === undefined) {
      throw new RangeError(
        `No agent at index ${index} (have ${this.agents.length}).`,
      );
    }
    return agent;
  }

  /**
   * Boot the host and connect `agentCount` agents over real WSS. Resolves once
   * every agent has completed its handshake and is online.
   */
  static async start(options: SimulationOptions = {}): Promise<Simulation> {
    const agentCount = options.agentCount ?? DEFAULT_AGENT_COUNT;
    const tmpRoot = mkdtempSync(join(tmpdir(), "cfls-sim-"));

    const session: SessionId = {
      repoId: "github.com/acme/coordination",
      teamId: "team-sim",
      branch: "main",
      baseRevision: null,
      ...options.session,
    };

    const admin: DeviceKey = generateDeviceKey();

    const host = await startHost(
      {
        hostUrl: "wss://127.0.0.1:0",
        tls: { devSelfSigned: true },
        dbPath: join(tmpRoot, "host.db"),
        ...(options.expiry !== undefined ? { expiry: options.expiry } : {}),
      },
      {
        expirySweepIntervalMs: options.expirySweepIntervalMs ?? 0,
        ...(options.liveDiffs !== undefined
          ? { liveDiffsEnabled: options.liveDiffs }
          : {}),
      },
    );
    host.authority.registerSession(session, [admin.publicKey]);

    const sim = new Simulation(host, session, admin, [], tmpRoot);

    for (let i = 0; i < agentCount; i += 1) {
      const built = await sim.connectAgent(`agent-${i}`, options);
      sim.agents.push(built);
    }

    return sim;
  }

  /**
   * Build, invite, and connect a single agent to the running host. Exposed so
   * scenarios can add an agent with a custom identity/invitation (e.g. the
   * unauthorized-device rejection scenario).
   */
  async connectAgent(
    memberId: string,
    options: SimulationOptions = {},
    overrides: {
      invitation?: string;
      authorized?: boolean;
      deviceKey?: DeviceKey;
    } = {},
  ): Promise<SimAgent> {
    const deviceKey = overrides.deviceKey ?? generateDeviceKey();
    const member: MemberRef = {
      memberId,
      deviceId: deriveDeviceId(deviceKey.publicKey),
    };
    const invitation =
      overrides.invitation ?? this.invitationFor(deviceKey, memberId);

    const agent = new CoordinationAgent({
      session: this.session,
      self: member,
      hostUrl: this.hostUrl,
      invitation,
      rules: ALL_SOFT_CONFIG,
      cacheDir: join(this.tmpRoot, `cache-${memberId}`),
      insecureTls: true,
      deviceKey,
      localApiPort: 0,
      enableNamedPipe: false,
      ...(options.graph !== undefined ? { graph: options.graph } : {}),
      ...(overrides.authorized !== undefined
        ? { authorized: overrides.authorized }
        : {}),
      connection: {
        heartbeatIntervalMs: options.heartbeatIntervalMs ?? 0,
        autoReconnect: false,
      },
    });
    const running = await agent.start();
    return { member, deviceKey, agent, running };
  }

  /**
   * Issue a base64 Signed_Invitation for `deviceKey`/`memberId` signed by the
   * session admin. Used by every admitted agent; scenarios can also mint an
   * invitation signed by a NON-admin to exercise the rejection path.
   */
  invitationFor(
    deviceKey: DeviceKey,
    memberId: string,
    issuer: DeviceKey = this.admin,
  ): string {
    const invitation = issueInvitation(
      {
        session: this.session,
        devicePublicKey: deviceKey.publicKey,
        memberId,
        issuerPublicKey: issuer.publicKey,
      },
      issuer.privateKey,
    );
    return Buffer.from(JSON.stringify(invitation), "utf8").toString("base64");
  }

  // -------------------------------------------------------------------------
  // Editor-event drivers (Editor_Extension → agent → host over real WSS)
  // -------------------------------------------------------------------------

  /** Drive an editor presence/edit event for `agentIndex` (Req 3.2, 11.x). */
  reportPresence(
    agentIndex: number,
    path: string,
    state: "started" | "editing" | "stopped" = "editing",
  ): void {
    this.agentAt(agentIndex)
      .agent.hostConnection()
      .send("presence.report", { path, state });
  }

  /** Drive a confirmed file save (reconciled as editing presence, Req 17.x). */
  save(agentIndex: number, path: string): void {
    this.reportPresence(agentIndex, path, "editing");
  }

  /** Drive a confirmed rename/move for `agentIndex` (Req 30.1, 30.2). */
  renamePath(agentIndex: number, fromPath: string, toPath: string): void {
    this.agentAt(agentIndex)
      .agent.hostConnection()
      .send("path.renamed", { fromPath, toPath });
  }

  /** Drive a confirmed deletion for `agentIndex` (Req 30.5). */
  deletePath(agentIndex: number, path: string): void {
    this.agentAt(agentIndex)
      .agent.hostConnection()
      .send("path.deleted", { path });
  }

  /** Upload a metadata-only Dependency_Graph from `agentIndex` (Req 19.3). */
  uploadGraph(agentIndex: number, graph: DependencyGraph): void {
    this.agentAt(agentIndex)
      .agent.hostConnection()
      .send("dep.snapshot", { graph });
  }

  /** The Dependency_Graph an agent's port currently holds (shared/received). */
  portGraph(agentIndex: number): DependencyGraph | undefined {
    return this.agentAt(agentIndex).agent.agentPort().currentGraph();
  }

  // -------------------------------------------------------------------------
  // MCP tool-call drivers (Local_MCP_Server → AgentCoordinationPort → host)
  // -------------------------------------------------------------------------

  /** MCP `acquire_lock` for `agentIndex` (Req 12.1–12.4). */
  acquireLock(
    agentIndex: number,
    scope: string,
    scopeKind: ScopeKind = "file",
  ): Promise<AcquireLockData> {
    return this.expectOk(
      this.agentAt(agentIndex).agent.agentPort().acquireLock({
        session: this.session,
        scope,
        scopeKind,
      }),
    );
  }

  /** MCP `release_lock` for `agentIndex` (Req 12.5–12.8). */
  releaseLock(agentIndex: number, scope: string): Promise<ReleaseLockData> {
    return this.expectOk(
      this.agentAt(agentIndex).agent.agentPort().releaseLock({ scope }),
    );
  }

  /** MCP `declare_intent` for `agentIndex` (Req 16.1–16.2). */
  declareIntent(
    agentIndex: number,
    input: {
      modifyPaths?: string[];
      createPaths?: string[];
      description?: string;
    },
  ): Promise<DeclareIntentData> {
    return this.expectOk(
      this.agentAt(agentIndex)
        .agent.agentPort()
        .declareIntent({
          session: this.session,
          modifyPaths: input.modifyPaths ?? [],
          createPaths: input.createPaths ?? [],
          description: input.description ?? "",
        }),
    );
  }

  /** MCP `get_risk_map` for `agentIndex` (Req 24, 21, 22, 31.5). */
  getRiskMap(agentIndex: number): Promise<GetRiskMapData> {
    return this.expectOk(
      this.agentAt(agentIndex)
        .agent.agentPort()
        .getRiskMap({ session: this.session }),
    );
  }

  /** MCP `get_dependencies` for `agentIndex` (Req 23.2). */
  getDependencies(
    agentIndex: number,
    path: string,
  ): Promise<GetDependenciesData> {
    return this.expectOk(
      this.agentAt(agentIndex).agent.agentPort().getDependencies({ path }),
    );
  }

  /** Unwrap an {@link AgentResult}, throwing on the error case. */
  private async expectOk<T>(result: MaybePromise<AgentResult<T>>): Promise<T> {
    const resolved = await result;
    if (!resolved.ok) {
      throw new Error(`${resolved.error.code}: ${resolved.error.message}`);
    }
    return resolved.data;
  }

  // -------------------------------------------------------------------------
  // Convergence helpers
  // -------------------------------------------------------------------------

  /** The active cached coordination entries an agent currently sees (its view). */
  entries(agentIndex: number): CoordinationUpdate[] {
    return this.agentAt(agentIndex).agent.view.entries(this.session);
  }

  /** Poll `predicate` until it holds or the timeout elapses. */
  async waitUntil(
    predicate: () => boolean,
    {
      timeoutMs = CONVERGENCE_TIMEOUT_MS,
      label = "condition",
    }: { timeoutMs?: number; label?: string } = {},
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) {
        return;
      }
      await delay(POLL_INTERVAL_MS);
    }
    if (predicate()) {
      return;
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}.`);
  }

  /**
   * Wait until EVERY connected agent's view satisfies `predicate` — i.e. the
   * cluster has converged on the same authoritative state (design §13.4).
   */
  async waitForConverged(
    predicate: (entries: CoordinationUpdate[], agent: SimAgent) => boolean,
    options: { timeoutMs?: number; label?: string } = {},
  ): Promise<void> {
    await this.waitUntil(
      () =>
        this.agents.every((a) =>
          predicate(a.agent.view.entries(this.session), a),
        ),
      {
        label: options.label ?? "cluster convergence",
        ...(options.timeoutMs !== undefined
          ? { timeoutMs: options.timeoutMs }
          : {}),
      },
    );
  }

  /** Tear down every agent, then the host, then the temp dirs. */
  async stop(): Promise<void> {
    for (const { agent } of this.agents) {
      await agent.stop();
    }
    await this.host.stop();
    rmSync(this.tmpRoot, { recursive: true, force: true });
  }
}

/** A cancellable delay used by the convergence poller. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
