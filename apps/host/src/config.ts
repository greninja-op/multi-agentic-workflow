/**
 * Host configuration (Req 1.1, 6.1–6.3; design §2.2, §4.1).
 *
 * The CoordinationHost listens at a **configurable `Host_URL`** — there is no
 * hardcoded address or port (Req 6.1). Moving the host from a laptop to a VPS
 * changes only this configuration and the TLS material (design §2.2). All fields
 * are resolved here from an explicit override object first, then environment
 * variables, then safe defaults, so the same binary runs unchanged everywhere.
 */

import type { ExpiryConfigInput } from "@cfls/core-state";
import type { SessionId } from "@cfls/protocol";
import type { DevicePrivateKey, DevicePublicKey } from "@cfls/security";

/** TLS material for the WSS listener (Req 6.1, 6.3; design §4.1). */
export interface HostTlsConfig {
  /** Path to a PEM certificate (chain) file. */
  certPath?: string;
  /** Path to the PEM private-key file for {@link certPath}. */
  keyPath?: string;
  /**
   * When true and no cert/key path is supplied, generate an in-memory
   * **development-only** self-signed certificate. NEVER enable in production:
   * clients must skip certificate validation to connect, defeating TLS trust.
   */
  devSelfSigned?: boolean;
}

/**
 * Opt-in configuration for the hosted, read-only MCP endpoint. The bearer
 * token is deliberately separate from device credentials: it can read the
 * scoped session's metadata, but can never impersonate a device or mutate
 * coordination state.
 */
export interface RemoteMcpConfig {
  /** High-entropy bearer token required on every `/mcp` request. */
  token: string;
  /** The only Repository_Session this remote credential is allowed to read. */
  session: SessionId;
  /** Public relay URL reported in MCP connection envelopes. */
  publicHostUrl?: string;
}

/**
 * Explicitly opt-in, demo-only enrollment via a short pairing code. The relay
 * uses its existing admin key to mint normal signed invitations; this setting
 * intentionally removes the usual human-admin approval step and MUST stay off
 * for a production relay.
 */
export interface DemoPairingConfig {
  /** Team/default session used when enrolling arbitrary demo workspaces. */
  session: SessionId;
  /** Persistent relay admin identity that signs the resulting invitations. */
  issuerPublicKey: DevicePublicKey;
  issuerPrivateKey: DevicePrivateKey;
  /** Pairing-code lifetime. Defaults to ten minutes. */
  codeTtlMs?: number;
  /** Resulting invitation lifetime. Defaults to twelve hours. */
  invitationTtlMs?: number;
}

/** Fully-resolved host configuration. */
export interface HostConfig {
  /** The configured `Host_URL`, e.g. `wss://dev-host.local:8443` (Req 6.1). */
  hostUrl: string;
  /** Bind host parsed from {@link hostUrl}. */
  host: string;
  /** Bind port parsed from {@link hostUrl}. */
  port: number;
  /** TLS material (Req 6.1, 6.3). */
  tls: HostTlsConfig;
  /**
   * Filesystem path to the SQLite database file, or `":memory:"` for an
   * ephemeral store (tests). Durable persistence + restart recovery (Req 1.5,
   * 1.6) require a real file path.
   */
  dbPath: string;
  /** Whether the read-only coordination dashboard HTTP routes are available. */
  dashboard: boolean;
  /** Optional bearer-gated hosted MCP endpoint. Omitted means the route is off. */
  remoteMcp?: RemoteMcpConfig;
  /** Demo-only short-code enrollment. Never enabled implicitly. */
  demoPairing?: DemoPairingConfig;
  /** Heartbeat/expiry tuning forwarded to the core-state expiry engine (Req 26). */
  expiry?: ExpiryConfigInput;
  /** Milliseconds the {@link start} call is allowed before failing (Req 1.1). */
  startTimeoutMs: number;
}

/** Caller overrides for {@link loadHostConfig}; every field is optional. */
export interface HostConfigInput {
  hostUrl?: string;
  tls?: HostTlsConfig;
  dbPath?: string;
  /** Enable the read-only dashboard routes. Defaults to true. */
  dashboard?: boolean;
  /** Enable a bearer-gated, read-only hosted MCP endpoint for one session. */
  remoteMcp?: RemoteMcpConfig;
  /** Enable explicitly supplied demo-only short-code enrollment. */
  demoPairing?: DemoPairingConfig;
  expiry?: ExpiryConfigInput;
  startTimeoutMs?: number;
}

/** Default listen deadline: the host must be listening within 10s (Req 1.1). */
export const DEFAULT_START_TIMEOUT_MS = 10_000;

/**
 * Parse a `Host_URL` into its bind host and port. Accepts `wss://host:port`
 * (TLS) and, for local development/tests only, `ws://host:port`. A missing port
 * defaults to 8443 (the conventional WSS coordination port). Throws on a URL
 * that is not a `ws`/`wss` URL so misconfiguration fails fast rather than
 * silently binding the wrong address (Req 6.1).
 */
export function parseHostUrl(hostUrl: string): {
  host: string;
  port: number;
  secure: boolean;
} {
  let url: URL;
  try {
    url = new URL(hostUrl);
  } catch {
    throw new Error(`Invalid Host_URL: ${hostUrl}`);
  }
  if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw new Error(
      `Host_URL must use the ws:// or wss:// scheme (got "${url.protocol}").`,
    );
  }
  const host = url.hostname === "" ? "127.0.0.1" : url.hostname;
  // Port 0 is permitted: it asks the OS for an ephemeral port (used by tests).
  const port = url.port === "" ? 8443 : Number.parseInt(url.port, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Host_URL has an invalid port: ${url.port}`);
  }
  return { host, port, secure: url.protocol === "wss:" };
}

/**
 * Resolve a {@link HostConfig} from explicit overrides, then environment
 * variables, then defaults (Req 6.1). Recognized environment variables:
 *
 *   - `CFLS_HOST_URL`         the `Host_URL` (required if not overridden)
 *   - `CFLS_TLS_CERT`         PEM certificate path
 *   - `CFLS_TLS_KEY`          PEM private-key path
 *   - `CFLS_TLS_DEV_SELF_SIGNED`  `"1"`/`"true"` to use a dev self-signed cert
 *   - `CFLS_DB_PATH`          SQLite database file path
 *   - `CFLS_DASHBOARD`        `"1"`/`"true"` to enable the dashboard (default true)
 *   - `CFLS_REMOTE_MCP_TOKEN` enable the hosted MCP endpoint when the CLI also
 *                              supplies its explicit session scope
 *
 * There is no built-in default address: an absent `Host_URL` throws so the host
 * never silently listens on a hardcoded address (Req 6.1).
 */
export function loadHostConfig(
  input: HostConfigInput = {},
  env: NodeJS.ProcessEnv = process.env,
): HostConfig {
  const hostUrl = input.hostUrl ?? env.CFLS_HOST_URL;
  if (hostUrl === undefined || hostUrl.trim() === "") {
    throw new Error(
      "Host_URL is not configured. Set CFLS_HOST_URL or pass { hostUrl } (Req 6.1).",
    );
  }
  const { host, port } = parseHostUrl(hostUrl);

  const tls: HostTlsConfig = input.tls ?? {
    ...(env.CFLS_TLS_CERT !== undefined ? { certPath: env.CFLS_TLS_CERT } : {}),
    ...(env.CFLS_TLS_KEY !== undefined ? { keyPath: env.CFLS_TLS_KEY } : {}),
    devSelfSigned: isTruthy(env.CFLS_TLS_DEV_SELF_SIGNED),
  };

  return {
    hostUrl,
    host,
    port,
    tls,
    dbPath: input.dbPath ?? env.CFLS_DB_PATH ?? ":memory:",
    dashboard:
      input.dashboard ??
      (env.CFLS_DASHBOARD === undefined ? true : isTruthy(env.CFLS_DASHBOARD)),
    ...(input.remoteMcp !== undefined
      ? { remoteMcp: normalizeRemoteMcp(input.remoteMcp) }
      : {}),
    ...(input.demoPairing !== undefined
      ? { demoPairing: normalizeDemoPairing(input.demoPairing) }
      : {}),
    ...(input.expiry !== undefined ? { expiry: input.expiry } : {}),
    startTimeoutMs: input.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
  };
}

function normalizeDemoPairing(config: DemoPairingConfig): DemoPairingConfig {
  if (
    config.session.repoId.trim() === "" ||
    config.session.teamId.trim() === "" ||
    config.session.branch.trim() === "" ||
    config.issuerPublicKey.trim() === "" ||
    config.issuerPrivateKey.trim() === ""
  ) {
    throw new Error(
      "CFLS demo pairing requires a complete session and admin key.",
    );
  }
  const codeTtlMs = config.codeTtlMs ?? 10 * 60_000;
  const invitationTtlMs = config.invitationTtlMs ?? 12 * 60 * 60_000;
  if (
    !Number.isInteger(codeTtlMs) ||
    codeTtlMs < 60_000 ||
    codeTtlMs > 60 * 60_000
  ) {
    throw new Error(
      "CFLS demo pairing code TTL must be between one and sixty minutes.",
    );
  }
  if (
    !Number.isInteger(invitationTtlMs) ||
    invitationTtlMs < 60_000 ||
    invitationTtlMs > 7 * 24 * 60 * 60_000
  ) {
    throw new Error(
      "CFLS demo pairing invitation TTL must be between one minute and seven days.",
    );
  }
  return {
    session: {
      repoId: config.session.repoId,
      teamId: config.session.teamId,
      branch: config.session.branch,
      baseRevision: config.session.baseRevision ?? null,
    },
    issuerPublicKey: config.issuerPublicKey,
    issuerPrivateKey: config.issuerPrivateKey,
    codeTtlMs,
    invitationTtlMs,
  };
}

function normalizeRemoteMcp(config: RemoteMcpConfig): RemoteMcpConfig {
  const token = config.token.trim();
  if (token.length < 24) {
    throw new Error(
      "CFLS hosted MCP token must be at least 24 characters long.",
    );
  }
  if (
    config.session.repoId.trim() === "" ||
    config.session.teamId.trim() === "" ||
    config.session.branch.trim() === ""
  ) {
    throw new Error(
      "CFLS hosted MCP requires a complete Repository_Session scope.",
    );
  }
  return {
    token,
    session: {
      repoId: config.session.repoId,
      teamId: config.session.teamId,
      branch: config.session.branch,
      baseRevision: config.session.baseRevision ?? null,
    },
    ...(config.publicHostUrl !== undefined && config.publicHostUrl.trim() !== ""
      ? { publicHostUrl: config.publicHostUrl }
      : {}),
  };
}

function isTruthy(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}
