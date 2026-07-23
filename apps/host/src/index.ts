/**
 * @cfls/host — the CoordinationHost server: WSS/TLS listener, authentication,
 * ingest pipeline, SQLite-backed persistence, broadcast, sync, expiry,
 * diagnostics, and audit. The definitive coordination authority (design §3.1).
 *
 * This module exposes the assembled host and its building blocks so both the
 * runnable entry point and the test suite can construct a host over a real WSS
 * connection and a real (or in-memory) SQLite store.
 */

export const APP_NAME = "@cfls/host";

export {
  loadHostConfig,
  parseHostUrl,
  DEFAULT_START_TIMEOUT_MS,
  type HostConfig,
  type HostConfigInput,
  type HostTlsConfig,
  type RemoteMcpConfig,
  type DemoPairingConfig,
} from "./config";
export {
  HostedMcpEndpoint,
  buildHostedMcpRiskMap,
  buildHostedMcpTeamStatus,
} from "./remote-mcp";
export { resolveTls, generateDevCertificate, type ResolvedTls } from "./tls";
export {
  SqliteStore,
  StoreError,
  type Store,
  type PersistedEvent,
  type PersistedExpiry,
  type PersistedMutation,
  type PersistedSession,
} from "./store";
export { generateChallenge, signChallenge, verifyChallenge } from "./challenge";
export {
  CoordinationAuthority,
  type AuthPrincipal,
  type AuthorityOptions,
  type ChallengeResult,
  type HandshakeResult,
  type IngestOutcome,
  type SyncResult,
} from "./authority";
export {
  CoordinationServer,
  type ServerOptions,
  type HealthStatus,
  type DiagnosticsReport,
} from "./server";

import { CoordinationAuthority } from "./authority";
import {
  loadHostConfig,
  type HostConfig,
  type HostConfigInput,
} from "./config";
import { CoordinationServer, type ServerOptions } from "./server";
import { SqliteStore, type Store } from "./store";

/** A running host: its config, store, authority, server, and a stop handle. */
export interface RunningHost {
  config: HostConfig;
  store: Store;
  authority: CoordinationAuthority;
  server: CoordinationServer;
  /** The actual bound port (useful when the config port was 0). */
  port: number;
  stop: () => Promise<void>;
}

/**
 * Assemble and start a CoordinationHost from configuration (Req 1.1). Opens the
 * SQLite store (restoring authoritative state on restart — Req 1.5, 1.6),
 * constructs the authority, and starts the WSS/TLS server. The returned
 * {@link RunningHost.stop} closes the server and the store.
 */
export async function startHost(
  input: HostConfigInput = {},
  options: ServerOptions = {},
): Promise<RunningHost> {
  const config = loadHostConfig(input);
  const store = new SqliteStore(config.dbPath);
  const authority = new CoordinationAuthority(store, options);
  const server = new CoordinationServer(config, authority, options);
  const { port } = await server.start();
  return {
    config,
    store,
    authority,
    server,
    port,
    stop: async () => {
      await server.stop();
      store.close();
    },
  };
}
