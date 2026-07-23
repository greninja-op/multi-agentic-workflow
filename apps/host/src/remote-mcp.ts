/**
 * Bearer-gated, read-only MCP surface hosted alongside the CoordinationHost.
 *
 * Desktop agents still use the richer `cfls mcp` stdio bridge because it acts
 * through their enrolled local device identity. This endpoint is deliberately
 * narrower: a coding agent can inspect the live metadata-only team picture
 * without a local service, but it can neither impersonate a team member nor
 * create/release locks or intents.
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  ALL_SOFT_CONFIG,
  buildRiskMap,
  normalizePath,
  normalizePathKey,
  resolveMode,
} from "@cfls/core-state";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DependencyEdge, SessionId } from "@cfls/protocol";
import { deriveDeviceId } from "@cfls/security";
import { z } from "zod";

import type { CoordinationAuthority } from "./authority";
import type { RemoteMcpConfig } from "./config";

const MAX_BODY_BYTES = 256 * 1024;

interface HostedMcpOptions {
  config: RemoteMcpConfig;
  authority: CoordinationAuthority;
  /** Current live member IDs for a session, supplied by the WSS server. */
  connectedMembers: (session: SessionId) => readonly string[];
}

interface HostedMcpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

interface ConnectionEnvelope {
  status: "online" | "offline";
  hostUrl: string;
  lastSyncAt: string | null;
}

interface StalenessEnvelope {
  stale: boolean;
  secondsSinceSync: number | null;
}

interface McpEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
  connection: ConnectionEnvelope;
  staleness: StalenessEnvelope;
}

interface MutableTask {
  intentId: string;
  description: string;
  modifyPaths: Set<string>;
  createPaths: Set<string>;
}

interface MutableMember {
  memberId: string;
  deviceIds: Set<string>;
  files: Map<
    string,
    Set<"editing" | "soft-lock" | "intent" | "planned-create">
  >;
  tasks: Map<string, MutableTask>;
  lastEventRevision: number;
}

const sessionSchema = z.object({
  repoId: z.string(),
  teamId: z.string(),
  branch: z.string(),
  baseRevision: z.string().nullable(),
});

/**
 * A stateful Streamable-HTTP MCP endpoint. It is intentionally not a generic
 * HTTP proxy: requests always execute against one explicit Repository_Session
 * and require a bearer credential before the MCP handshake starts.
 */
export class HostedMcpEndpoint {
  private readonly sessions = new Map<string, HostedMcpSession>();

  constructor(private readonly options: HostedMcpOptions) {}

  /** Whether this endpoint owns the request's pathname. */
  matches(req: IncomingMessage): boolean {
    return pathname(req) === "/mcp";
  }

  /** Serve one authenticated Streamable HTTP MCP request. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    setSecurityHeaders(res);
    if (!this.authorized(req)) {
      sendJson(
        res,
        401,
        { error: "unauthorized" },
        {
          "www-authenticate": 'Bearer realm="CFLS hosted MCP"',
        },
      );
      return;
    }

    if (req.method === "OPTIONS") {
      sendJson(
        res,
        405,
        { error: "method_not_allowed" },
        { allow: "GET, POST, DELETE" },
      );
      return;
    }
    if (
      req.method !== "GET" &&
      req.method !== "POST" &&
      req.method !== "DELETE"
    ) {
      sendJson(
        res,
        405,
        { error: "method_not_allowed" },
        { allow: "GET, POST, DELETE" },
      );
      return;
    }

    try {
      const parsed =
        req.method === "POST"
          ? await readJson(req)
          : { ok: true as const, body: undefined };
      if (!parsed.ok) {
        sendJson(res, parsed.status, { error: parsed.error });
        return;
      }

      const requestedId = headerValue(req, "mcp-session-id");
      if (requestedId !== undefined) {
        const active = this.sessions.get(requestedId);
        if (active === undefined) {
          sendMcpError(res, 404, "Unknown MCP session.");
          return;
        }
        await active.transport.handleRequest(req, res, parsed.body);
        return;
      }

      if (req.method !== "POST" || !isInitializeRequest(parsed.body)) {
        sendMcpError(
          res,
          400,
          "Start with an MCP initialize request and no mcp-session-id header.",
        );
        return;
      }

      const session = this.createSession();
      try {
        // SDK 1.29's Node HTTP transport declares optional callback accessors
        // as `T | undefined`, while its generic Transport interface uses exact
        // optional properties. They are runtime-compatible; bridge the
        // declaration mismatch at this SDK boundary rather than weakening our
        // own endpoint types.
        await session.server.connect(session.transport as unknown as Transport);
        await session.transport.handleRequest(req, res, parsed.body);
        const sessionId = session.transport.sessionId;
        if (sessionId !== undefined) {
          this.sessions.set(sessionId, session);
        }
      } catch (error) {
        await session.server.close().catch(() => undefined);
        if (!res.headersSent) {
          sendMcpError(
            res,
            500,
            error instanceof Error
              ? error.message
              : "Failed to initialize MCP.",
          );
        }
      }
    } catch {
      if (!res.headersSent) {
        sendMcpError(
          res,
          500,
          "The hosted MCP endpoint could not process the request.",
        );
      }
    }
  }

  /** Close active MCP transports during host shutdown. */
  async close(): Promise<void> {
    const active = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(
      active.map(async ({ server, transport }) => {
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      }),
    );
  }

  private authorized(req: IncomingMessage): boolean {
    const authorization = headerValue(req, "authorization");
    if (authorization === undefined || !authorization.startsWith("Bearer ")) {
      return false;
    }
    return secureEqual(
      authorization.slice("Bearer ".length),
      this.options.config.token,
    );
  }

  private createSession(): HostedMcpSession {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
    });
    const server = createHostedMcpServer(this.options);
    const session: HostedMcpSession = { server, transport };
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id !== undefined && this.sessions.get(id) === session) {
        this.sessions.delete(id);
      }
      // `McpServer.connect()` wraps this callback and closes the protocol when
      // the transport closes. Calling `server.close()` here would close the
      // transport again and recurse through this callback indefinitely.
    };
    return session;
  }
}

function createHostedMcpServer(options: HostedMcpOptions): McpServer {
  const server = new McpServer(
    {
      name: "cfls-hosted-mcp",
      version: "0.1.0",
    },
    { capabilities: {} },
  );

  const scoped = (candidate: SessionId): boolean =>
    sameSession(candidate, options.config.session) &&
    sessionRegistered(options);

  server.registerTool(
    "get_team_status",
    {
      description:
        "Return the live CFLS team roster, declared tasks, file activity, and locks for the authorized repository session. Metadata only; no source content or patches.",
      inputSchema: { session: sessionSchema },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ session }) => {
      if (!scoped(session)) {
        return denied(options);
      }
      return success(options, teamStatus(options));
    },
  );

  server.registerTool(
    "get_risk_map",
    {
      description:
        "Return the metadata-only CFLS risk map for the authorized session, including active lock, presence, intent, and dependency contributors.",
      inputSchema: { session: sessionSchema },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ session }) => {
      if (!scoped(session)) {
        return denied(options);
      }
      return success(options, riskMap(options));
    },
  );

  server.registerTool(
    "get_connection_status",
    {
      description:
        "Return the current online/offline roster seen by the CFLS relay for this credential's repository session.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => success(options, connectionStatus(options)),
  );

  server.registerTool(
    "get_project_session_status",
    {
      description:
        "Return the Repository_Session explicitly authorized for this hosted MCP credential.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      success(options, {
        session: {
          ...options.config.session,
          manualConfig: true,
        },
        authorized: sessionRegistered(options),
        memberId: "hosted-mcp",
      }),
  );

  server.registerTool(
    "get_dependencies",
    {
      description:
        "Return repository-relative metadata dependencies for a path in the authorized CFLS session.",
      inputSchema: { path: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ path }) => success(options, dependencies(options, path)),
  );

  server.registerTool(
    "get_dependents",
    {
      description:
        "Return repository-relative metadata dependents for a path in the authorized CFLS session.",
      inputSchema: { path: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ path }) => success(options, dependents(options, path)),
  );

  server.registerTool(
    "get_dependency_impact",
    {
      description:
        "Return direct and reverse metadata dependency impact for repository-relative paths. No source code is returned.",
      inputSchema: { paths: z.array(z.string()) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ paths }) => success(options, dependencyImpact(options, paths)),
  );

  return server;
}

function teamStatus(options: HostedMcpOptions) {
  const snapshot = options.authority.snapshot(options.config.session);
  const members = new Map<string, MutableMember>();
  const memberFor = (memberId: string): MutableMember => {
    let member = members.get(memberId);
    if (member === undefined) {
      member = {
        memberId,
        deviceIds: new Set(),
        files: new Map(),
        tasks: new Map(),
        lastEventRevision: 0,
      };
      members.set(memberId, member);
    }
    return member;
  };
  const addFile = (
    member: MutableMember,
    path: string,
    role: "editing" | "soft-lock" | "intent" | "planned-create",
  ): void => {
    const normalized = normalizePath(path);
    const roles = member.files.get(normalized) ?? new Set();
    roles.add(role);
    member.files.set(normalized, roles);
  };

  for (const entry of options.authority.membership(options.config.session)) {
    if (entry.revoked || !entry.invitationValid) {
      continue;
    }
    memberFor(entry.memberId).deviceIds.add(
      deriveDeviceId(entry.devicePublicKey),
    );
  }
  for (const memberId of options.connectedMembers(options.config.session)) {
    memberFor(memberId);
  }
  for (const lock of snapshot.locks) {
    if (lock.concurrent) {
      continue;
    }
    const member = memberFor(lock.holder.memberId);
    member.deviceIds.add(lock.holder.deviceId);
    member.lastEventRevision = Math.max(
      member.lastEventRevision,
      lock.eventRevision,
    );
    addFile(member, lock.scope, "soft-lock");
  }
  for (const presence of snapshot.presence) {
    if (presence.state === "stopped") {
      continue;
    }
    const member = memberFor(presence.member.memberId);
    member.deviceIds.add(presence.member.deviceId);
    member.lastEventRevision = Math.max(
      member.lastEventRevision,
      presence.eventRevision,
    );
    addFile(member, presence.path, "editing");
  }
  for (const intent of snapshot.intents) {
    const member = memberFor(intent.owner.memberId);
    member.deviceIds.add(intent.owner.deviceId);
    member.lastEventRevision = Math.max(
      member.lastEventRevision,
      intent.eventRevision,
    );
    const task = member.tasks.get(intent.intentId) ?? {
      intentId: intent.intentId,
      description: intent.description,
      modifyPaths: new Set<string>(),
      createPaths: new Set<string>(),
    };
    for (const path of intent.modifyPaths) {
      const normalized = normalizePath(path);
      task.modifyPaths.add(normalized);
      addFile(member, normalized, "intent");
    }
    for (const creation of intent.createPaths) {
      const normalized = normalizePath(creation.path);
      task.createPaths.add(normalized);
      addFile(member, normalized, "planned-create");
    }
    member.tasks.set(intent.intentId, task);
  }

  return {
    teamId: options.config.session.teamId,
    members: [...members.values()]
      .map((member) => ({
        memberId: member.memberId,
        deviceIds: [...member.deviceIds].sort(compare),
        files: [...member.files.entries()]
          .map(([path, roles]) => ({ path, roles: [...roles].sort(compare) }))
          .sort((left, right) => compare(left.path, right.path)),
        tasks: [...member.tasks.values()]
          .map((task) => ({
            intentId: task.intentId,
            description: task.description,
            modifyPaths: [...task.modifyPaths].sort(compare),
            createPaths: [...task.createPaths].sort(compare),
          }))
          .sort((left, right) => compare(left.intentId, right.intentId)),
        lastEventRevision: member.lastEventRevision,
      }))
      .sort((left, right) => compare(left.memberId, right.memberId)),
    highestRevision: snapshot.highestRevision,
  };
}

function riskMap(options: HostedMcpOptions) {
  const snapshot = options.authority.snapshot(options.config.session);
  const entries = buildRiskMap({
    // This service is a read-only team observer, not an enrolled member. A
    // synthetic identity intentionally excludes no teammate activity.
    requester: { memberId: "__cfls_hosted_mcp__", deviceId: "hosted-mcp" },
    branch: options.config.session.branch,
    locks: snapshot.locks,
    presence: snapshot.presence,
    intents: snapshot.intents,
    // Repository rule files live in the protected checkout on each client.
    // Without sending them to the host, the safe remote fallback is all-soft.
    rules: ALL_SOFT_CONFIG,
    ...(options.authority.dependencyGraph(options.config.session) === null
      ? {}
      : { graph: options.authority.dependencyGraph(options.config.session)! }),
  });
  return {
    paths: entries.map((entry) => ({
      path: entry.path,
      riskLevel: entry.riskLevel,
      contributors: entry.contributors.map((contributor) => ({
        memberId: contributor.member.memberId,
        kind: contributor.kind,
      })),
      explanation: entry.explanation,
      acknowledgementRequired: entry.acknowledgementRequired,
    })),
    plannedFileCreations: snapshot.intents.flatMap((intent) =>
      intent.createPaths.map((creation) => ({
        path: normalizePath(creation.path),
        memberId: intent.owner.memberId,
      })),
    ),
    highestRevision: snapshot.highestRevision,
  };
}

function connectionStatus(options: HostedMcpOptions) {
  const allMembers = new Set(
    options.authority
      .membership(options.config.session)
      .filter((entry) => !entry.revoked && entry.invitationValid)
      .map((entry) => entry.memberId),
  );
  const connected = new Set(options.connectedMembers(options.config.session));
  for (const memberId of connected) {
    allMembers.add(memberId);
  }
  return {
    status: sessionRegistered(options) ? "online" : "offline",
    participants: {
      connected: [...connected].sort(compare),
      offline: [...allMembers]
        .filter((member) => !connected.has(member))
        .sort(compare),
    },
    manualCoordinationRequired: !sessionRegistered(options),
  };
}

function dependencies(options: HostedMcpOptions, rawPath: string) {
  const path = normalizePath(rawPath);
  const graph = options.authority.dependencyGraph(options.config.session);
  const edges = allEdges(graph);
  return {
    dependsOn: uniquePaths(
      edges.filter((edge) => samePath(edge.from, path)).map((edge) => edge.to),
    ),
    presentInGraph: graphContains(graph, path),
  };
}

function dependents(options: HostedMcpOptions, rawPath: string) {
  const path = normalizePath(rawPath);
  const graph = options.authority.dependencyGraph(options.config.session);
  const edges = allEdges(graph);
  return {
    dependedOnBy: uniquePaths(
      edges.filter((edge) => samePath(edge.to, path)).map((edge) => edge.from),
    ),
    presentInGraph: graphContains(graph, path),
  };
}

function dependencyImpact(options: HostedMcpOptions, paths: readonly string[]) {
  const graph = options.authority.dependencyGraph(options.config.session);
  const edges = allEdges(graph);
  return {
    impacts: paths.map((rawPath) => {
      const path = normalizePath(rawPath);
      const presentInGraph = graphContains(graph, path);
      const reverse = uniquePaths(
        edges
          .filter((edge) => samePath(edge.to, path))
          .map((edge) => edge.from),
      );
      return {
        path,
        directDependencies: uniquePaths(
          edges
            .filter((edge) => samePath(edge.from, path))
            .map((edge) => edge.to),
        ),
        reverseDependencies: reverse,
        sharedContracts: [],
        riskLevel: resolveMode(path, ALL_SOFT_CONFIG),
        explanationPaths: reverse.map((target) => ({
          target,
          via: edges.filter(
            (edge) => samePath(edge.from, target) && samePath(edge.to, path),
          ),
        })),
        presentInGraph,
      };
    }),
  };
}

function allEdges(
  graph: ReturnType<CoordinationAuthority["dependencyGraph"]>,
): DependencyEdge[] {
  return graph?.modules.flatMap((module) => module.edges) ?? [];
}

function graphContains(
  graph: ReturnType<CoordinationAuthority["dependencyGraph"]>,
  path: string,
): boolean {
  if (graph === null) {
    return false;
  }
  return graph.modules.some(
    (module) =>
      samePath(module.sourceFile, path) ||
      module.edges.some(
        (edge) => samePath(edge.from, path) || samePath(edge.to, path),
      ),
  );
}

function samePath(left: string, right: string): boolean {
  return normalizePathKey(left) === normalizePathKey(right);
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => normalizePath(path)))].sort(compare);
}

function success<T>(options: HostedMcpOptions, data: T): CallToolResult {
  return toToolResult({
    ok: true,
    data,
    connection: envelopeConnection(options),
    staleness: { stale: false, secondsSinceSync: 0 },
  });
}

function denied(options: HostedMcpOptions): CallToolResult {
  return toToolResult({
    ok: false,
    error: {
      code: "AUTH_NOT_AUTHORIZED",
      message:
        "This hosted MCP credential is not authorized for that Repository_Session.",
    },
    connection: envelopeConnection(options),
    staleness: { stale: !sessionRegistered(options), secondsSinceSync: null },
  });
}

function envelopeConnection(options: HostedMcpOptions): ConnectionEnvelope {
  return {
    status: sessionRegistered(options) ? "online" : "offline",
    hostUrl: options.config.publicHostUrl ?? "",
    lastSyncAt: sessionRegistered(options) ? new Date().toISOString() : null,
  };
}

function toToolResult<T>(envelope: McpEnvelope<T>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    structuredContent: envelope as unknown as Record<string, unknown>,
  };
}

function sessionRegistered(options: HostedMcpOptions): boolean {
  return options.authority
    .sessions()
    .some((session) => sameSession(session, options.config.session));
}

function sameSession(left: SessionId, right: SessionId): boolean {
  return (
    left.repoId === right.repoId &&
    left.teamId === right.teamId &&
    left.branch === right.branch &&
    (left.baseRevision ?? null) === (right.baseRevision ?? null)
  );
}

function compare(left: string, right: string): number {
  return left.localeCompare(right);
}

function isInitializeRequest(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { method?: unknown }).method === "initialize"
  );
}

function pathname(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", "https://cfls.invalid").pathname;
  } catch {
    return "/";
  }
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function sendMcpError(
  res: ServerResponse,
  status: number,
  message: string,
): void {
  sendJson(res, status, {
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  });
}

async function readJson(
  req: IncomingMessage,
): Promise<
  { ok: true; body: unknown } | { ok: false; status: number; error: string }
> {
  const advertisedLength = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(advertisedLength) && advertisedLength > MAX_BODY_BYTES) {
    req.resume();
    return { ok: false, status: 413, error: "request_too_large" };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) {
      return { ok: false, status: 413, error: "request_too_large" };
    }
    chunks.push(bytes);
  }
  try {
    return {
      ok: true,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
  } catch {
    return { ok: false, status: 400, error: "invalid_json" };
  }
}

/** Exported only for focused unit tests of projection safety. */
export function buildHostedMcpTeamStatus(
  authority: CoordinationAuthority,
  config: RemoteMcpConfig,
  connectedMembers: (session: SessionId) => readonly string[] = () => [],
) {
  return teamStatus({ authority, config, connectedMembers });
}

/** Exported only for focused unit tests of projection safety. */
export function buildHostedMcpRiskMap(
  authority: CoordinationAuthority,
  config: RemoteMcpConfig,
) {
  return riskMap({ authority, config, connectedMembers: () => [] });
}
