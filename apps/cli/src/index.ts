/**
 * @cfls/cli — the `cfls` multi-laptop onboarding tool.
 *
 * Turns the single-laptop demo into a real onboarding flow: a team admin issues
 * signed invitations and runs the CoordinationHost; each teammate registers a
 * device key, receives an invitation, and runs a CoordinationAgent that writes a
 * Local_API discovery file the VS Code extension auto-detects. The tool ONLY
 * moves coordination metadata + public keys around; the repository files
 * themselves are shared through git. It reuses `@cfls/security`, `@cfls/host`,
 * `@cfls/agent`, and `@cfls/core-state` — no host/agent/security logic is
 * reimplemented here.
 *
 * Commands: admin-init · host · id · invite · join · connect · agent · mcp · service.
 */

import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CoordinationAgent,
  generateLocalAuthToken,
  loadRulesConfig,
} from "@cfls/agent";
import { startHost } from "@cfls/host";
import type { SessionId } from "@cfls/protocol";
import { deriveDeviceId, issueInvitation } from "@cfls/security";

import {
  appendAdminPublicKey,
  readAgentConfig,
  readAutoSyncConfig,
  readHostConfig,
  readLiveDiffsConfig,
  updateAgentConfig,
  writeLocalApiConfig,
} from "./config-files";
import {
  agentConfigPath,
  hostConfigPath,
  localApiConfigPath,
  teamConfigPath,
} from "./paths";
import {
  commit,
  currentBranch,
  defaultGitRunner,
  enableRerere,
  fetch as gitFetch,
  listTrackingBranches,
  mergeLeavingConflicts,
  mergeReportingConflicts,
  push as gitPush,
  stagePaths,
  userBranchName,
  workingTreeChanges,
} from "./git";
import { buildCommitMessage, startGitSyncLoop } from "./git-sync";
import { openInEditor } from "./editor";
import { decodeInvitation, encodeInvitation } from "./invitation";
import {
  createAdminKey,
  loadAdminKey,
  loadOrCreateThisDeviceKey,
} from "./keys";
import { startMcpBridge } from "./mcp-bridge";
import {
  boolOption,
  log,
  parseArgs,
  resolveRepoRoot,
  stringOption,
  waitForShutdown,
  type ParsedArgs,
} from "./runtime";
import {
  DEFAULT_TEAM_ID,
  describeSession,
  resolveRepositorySession,
} from "./session";
import {
  getServiceStatus,
  installService,
  normalizeServicePlatform,
  uninstallService,
  type ServiceCommand,
  type ServiceCommandResult,
  type ServicePlanExecutor,
} from "./service";

/** Default loopback Local_API port for `cfls agent` (matches the extension default). */
export const DEFAULT_LOCAL_API_PORT = 8750;

/** A successfully started local agent, narrowed to the fields CLI publishing needs. */
export interface LocalApiPublishingAgent {
  start: () => Promise<{
    readonly localApiAddress: { readonly wsUrl?: string };
  }>;
  stop: () => Promise<void>;
}

/** Injectable seam for testing that discovery is published only after Local_API starts. */
export type LocalApiDiscoveryWriter = (
  path: string,
  value: { readonly url: string; readonly token: string },
) => void;

/**
 * Strictly parse the user-facing Local_API port. `net.listen` accepts only the
 * TCP range, so accepting e.g. `70000` here would otherwise publish a discovery
 * token for an API that cannot bind.
 */
export function parseLocalApiPort(value: string | boolean | undefined): number {
  if (value === undefined) {
    return DEFAULT_LOCAL_API_PORT;
  }
  if (typeof value !== "string" || !/^[0-9]+$/u.test(value)) {
    throw new Error("--local-port must be an integer from 1 through 65535.");
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("--local-port must be an integer from 1 through 65535.");
  }
  return port;
}

/** Parse the optional host dashboard environment switch consistently with host config. */
export function parseDashboardEnv(
  value: string | undefined,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value === "1" || value.toLowerCase() === "true";
}

/**
 * Start the loopback API before publishing its discovery token. If either API
 * startup or private-record publication fails, stop the partially started
 * agent. This prevents a fresh discovery record from ever pointing at an API
 * that failed to bind.
 */
export async function startAndPublishLocalApi(
  agent: LocalApiPublishingAgent,
  discoveryPath: string,
  token: string,
  writeDiscovery: LocalApiDiscoveryWriter = writeLocalApiConfig,
): Promise<string> {
  let startAttempted = false;
  try {
    startAttempted = true;
    const running = await agent.start();
    const url = running.localApiAddress.wsUrl;
    if (url === undefined || url.length === 0) {
      throw new Error(
        "The CFLS Local_API started without a loopback WebSocket address.",
      );
    }
    writeDiscovery(discoveryPath, { url, token });
    return url;
  } catch (error) {
    if (startAttempted) {
      try {
        await agent.stop();
      } catch {
        // Preserve the original startup/publication error. The agent owns all
        // local resources and its stop path is independently best-effort.
      }
    }
    throw error;
  }
}

/** Default Host_URL for `cfls host`. */
const DEFAULT_HOST_URL = "wss://0.0.0.0:8730";

/** `cfls admin-init` — create + store the team admin key, register it in host.json. */
async function cmdAdminInit(args: ParsedArgs): Promise<void> {
  const teamId =
    stringOption(args, "team") ??
    readHostConfig(hostConfigPath())?.teamId ??
    DEFAULT_TEAM_ID;
  const adminKey = await createAdminKey(teamId);
  const config = appendAdminPublicKey(
    hostConfigPath(),
    adminKey.publicKey,
    teamId,
  );

  log.info(`Admin key created for team "${teamId}".`);
  log.info(
    `Admin private key stored securely (never written to disk in plaintext).`,
  );
  log.info(`Host config: ${hostConfigPath()}`);
  log.info("");
  log.info("Admin Device_Public_Key (share/keep for reference):");
  log.info(adminKey.publicKey);
  log.info("");
  log.info(
    `Authorized admin keys for this host: ${config.authorizedAdminPublicKeys.length}`,
  );
}

/** `cfls host` — start the CoordinationHost for this repo's session. */
async function cmdHost(args: ParsedArgs, cwd: string): Promise<void> {
  const hostConfig = readHostConfig(hostConfigPath());
  if (
    hostConfig === null ||
    hostConfig.authorizedAdminPublicKeys.length === 0
  ) {
    throw new Error(
      `No admin keys found in ${hostConfigPath()}. Run "cfls admin-init" first.`,
    );
  }

  const repoRoot = resolveRepoRoot(cwd);
  const repoOverride = stringOption(args, "repo");
  const { session } = resolveRepositorySession({
    repoRoot,
    teamId: hostConfig.teamId,
    ...(repoOverride !== undefined ? { remoteUrlOverride: repoOverride } : {}),
  });

  const hostUrl = stringOption(args, "url") ?? DEFAULT_HOST_URL;
  const certPath = stringOption(args, "cert") ?? process.env["CFLS_TLS_CERT"];
  const keyPath = stringOption(args, "key") ?? process.env["CFLS_TLS_KEY"];

  const tls =
    certPath !== undefined && keyPath !== undefined
      ? { certPath, keyPath }
      : { devSelfSigned: true };
  if (tls.devSelfSigned === true) {
    log.warn(
      "Starting with a development self-signed TLS certificate. Agents must pass " +
        "--insecure-tls. Provide --cert/--key (or CFLS_TLS_CERT/CFLS_TLS_KEY) for production.",
    );
  }

  const dbPath =
    stringOption(args, "db") ?? process.env["CFLS_DB_PATH"] ?? "host.db";
  const dashboard = parseDashboardEnv(process.env["CFLS_DASHBOARD"]);
  // Opt-in Live_Diff sharing (Phase 5; Req 5.1, 5.4). Off unless the team's
  // committed .coordination/config.json sets liveDiffs.enabled = true.
  const liveDiffs = readLiveDiffsConfig(teamConfigPath(repoRoot));
  const running = await startHost(
    {
      hostUrl,
      tls,
      dbPath,
      ...(dashboard === undefined ? {} : { dashboard }),
    },
    { expirySweepIntervalMs: 15_000, liveDiffsEnabled: liveDiffs.enabled },
  );
  if (liveDiffs.enabled) {
    log.warn(
      "Live_Diff sharing is ENABLED (opt-in): change diffs are shared within the " +
        "trusted team. This is the only feature that moves source-derived content.",
    );
  }
  running.authority.registerSession(
    session,
    hostConfig.authorizedAdminPublicKeys,
  );

  const shown = hostUrl.replace("0.0.0.0", "<this-machine-ip>");
  log.info(
    `CoordinationHost listening on ${shown} (bound port ${running.port}).`,
  );
  log.info(`Serving session: ${describeSession(session)}`);
  log.info(
    `Authorized admin keys: ${hostConfig.authorizedAdminPublicKeys.length}`,
  );
  log.info("Press Ctrl+C to stop.");

  await waitForShutdown(() => running.stop());
}

/** `cfls id` — ensure this device has a key; print its public key + deviceId. */
async function cmdId(cwd: string): Promise<void> {
  const repoRoot = resolveRepoRoot(cwd);
  const teamId =
    readAgentConfig(agentConfigPath(repoRoot)).teamId ?? DEFAULT_TEAM_ID;
  const { session } = resolveRepositorySession({ repoRoot, teamId });
  const deviceKey = await loadOrCreateThisDeviceKey(session.repoId);
  const deviceId = deriveDeviceId(deviceKey.publicKey);

  log.info("This device's identity:");
  log.info("");
  log.info("Device_Public_Key (send this to your team admin):");
  log.info(deviceKey.publicKey);
  log.info("");
  log.info(`deviceId: ${deviceId}`);
  log.info(`repo:     ${session.repoId}`);
}

/** `cfls invite <memberName> <devicePublicKeyBase64>` — sign an invitation. */
async function cmdInvite(args: ParsedArgs, cwd: string): Promise<void> {
  const [memberName, devicePublicKey] = args.positionals;
  if (memberName === undefined || devicePublicKey === undefined) {
    throw new Error("Usage: cfls invite <memberName> <devicePublicKeyBase64>");
  }

  const hostConfig = readHostConfig(hostConfigPath());
  if (hostConfig === null) {
    throw new Error(
      `No ${hostConfigPath()} found. Run "cfls admin-init" first.`,
    );
  }

  const repoRoot = resolveRepoRoot(cwd);
  const repoOverride = stringOption(args, "repo");
  const { session } = resolveRepositorySession({
    repoRoot,
    teamId: hostConfig.teamId,
    ...(repoOverride !== undefined ? { remoteUrlOverride: repoOverride } : {}),
  });

  const adminKey = await loadAdminKey(hostConfig.teamId);
  const invitation = issueInvitation(
    {
      session,
      devicePublicKey,
      memberId: memberName,
      issuerPublicKey: adminKey.publicKey,
    },
    adminKey.privateKey,
  );

  log.info(
    `Invitation for "${memberName}" (session: ${describeSession(session)}):`,
  );
  log.info("");
  log.info(encodeInvitation(invitation));
  log.info("");
  log.info(`The teammate runs:  cfls connect <the string above>`);
}

/** `cfls join --host <wss-url> [--name <memberName>]` — save join state. */
async function cmdJoin(args: ParsedArgs, cwd: string): Promise<void> {
  const hostUrl = stringOption(args, "host");
  if (hostUrl === undefined) {
    throw new Error(
      "Usage: cfls join --host <wss-url> [--name <memberName>] [--team <id>]",
    );
  }
  const repoRoot = resolveRepoRoot(cwd);
  const memberName = stringOption(args, "name");
  const teamId = stringOption(args, "team");

  updateAgentConfig(agentConfigPath(repoRoot), {
    hostUrl,
    ...(memberName !== undefined ? { memberName } : {}),
    ...(teamId !== undefined ? { teamId } : {}),
  });

  const { session } = resolveRepositorySession({
    repoRoot,
    ...(teamId !== undefined ? { teamId } : {}),
  });
  const deviceKey = await loadOrCreateThisDeviceKey(session.repoId);

  log.info(`Saved join state to ${agentConfigPath(repoRoot)}.`);
  log.info(`Host_URL: ${hostUrl}`);
  log.info("");
  log.info("This device's Device_Public_Key (send it to your team admin):");
  log.info(deviceKey.publicKey);
  log.info("");
  log.info("Next steps:");
  log.info("  1. Send the public key above to your team admin.");
  log.info("  2. The admin runs:  cfls invite <yourName> <thePublicKey>");
  log.info(
    "  3. Paste the invitation they return into:  cfls connect <invitation>",
  );
  log.info("  4. Then start coordinating:  cfls agent --insecure-tls");
}

/** `cfls connect <invitationBase64>` — validate + store the invitation. */
function cmdConnect(args: ParsedArgs, cwd: string): void {
  const [encoded] = args.positionals;
  if (encoded === undefined) {
    throw new Error("Usage: cfls connect <invitationBase64>");
  }
  const invitation = decodeInvitation(encoded);
  const repoRoot = resolveRepoRoot(cwd);
  updateAgentConfig(agentConfigPath(repoRoot), {
    invitation: encoded,
    memberName: invitation.claims.memberId,
    teamId: invitation.claims.session.teamId,
  });

  log.info(`Invitation accepted and saved to ${agentConfigPath(repoRoot)}.`);
  log.info(`Member: ${invitation.claims.memberId}`);
  log.info(`Session: ${describeSession(invitation.claims.session)}`);
  log.info("");
  log.info("Start coordinating with:  cfls agent --insecure-tls");
}

/** `cfls agent [--insecure-tls] [--local-port 8750]` — run the CoordinationAgent. */
async function cmdAgent(args: ParsedArgs, cwd: string): Promise<void> {
  // Validate this before doing any config or secret work. In particular, an
  // invalid port must not cause a discovery token to be written.
  const port = parseLocalApiPort(args.options["local-port"]);
  const repoRoot = resolveRepoRoot(cwd);
  const config = readAgentConfig(agentConfigPath(repoRoot));
  if (config.hostUrl === undefined) {
    throw new Error(
      'No Host_URL saved. Run "cfls join --host <wss-url>" first.',
    );
  }
  if (config.invitation === undefined) {
    throw new Error(
      'No invitation saved. Run "cfls connect <invitation>" first.',
    );
  }

  // The invitation carries the authoritative session the host will accept, so we
  // coordinate against it (git-derived branch/base drift can otherwise change the
  // session identity). The repoId is identical either way (same git remote).
  const invitation = decodeInvitation(config.invitation);
  const session = invitation.claims.session;

  const deviceKey = await loadOrCreateThisDeviceKey(session.repoId);
  if (deviceKey.publicKey !== invitation.claims.devicePublicKey) {
    throw new Error(
      "This device's key does not match the invitation. The admin must issue an " +
        'invitation for the public key shown by "cfls id" on THIS machine.',
    );
  }

  const memberId = config.memberName ?? invitation.claims.memberId;
  const self = { memberId, deviceId: deriveDeviceId(deviceKey.publicKey) };
  const rules = loadRulesConfig(repoRoot).config;

  const localAuthToken = generateLocalAuthToken();
  const discoveryPath = localApiConfigPath(repoRoot);

  const agent = new CoordinationAgent({
    session,
    self,
    hostUrl: config.hostUrl,
    invitation: config.invitation,
    rules,
    cacheDir: `${repoRoot}/.coordination/.cache`,
    authorizedFolder: repoRoot,
    insecureTls: boolOption(args, "insecure-tls"),
    deviceKey,
    localApiPort: port,
    localAuthToken,
    enableNamedPipe: false,
    connection: { autoReconnect: true },
  });
  const localApiUrl = await startAndPublishLocalApi(
    agent,
    discoveryPath,
    localAuthToken,
  );

  log.info(`CoordinationAgent started for "${memberId}".`);
  log.info(`Host_URL:  ${config.hostUrl}`);
  log.info(
    `Local_API: ${localApiUrl} (extension auto-discovers via ${discoveryPath})`,
  );
  log.info(`Session:   ${describeSession(session)}`);
  log.info(
    "Open this repo in VS Code (with the CFLS extension installed) — it goes Online automatically.",
  );

  // OPT-IN automatic git sync (Model A). A strict no-op unless the team's
  // committed .coordination/config.json sets autoSync.enabled = true, so default
  // `cfls agent` behavior is unchanged. Never switches/resets the user's branch,
  // never force-pushes, never auto-resolves conflicts.
  const autoSync = readAutoSyncConfig(teamConfigPath(repoRoot));
  if (autoSync.enabled) {
    // Turn on git's "reuse recorded resolution" so a conflict resolved once is
    // replayed automatically next time (conflict-avoidance). Best-effort.
    enableRerere(repoRoot);
  }
  const syncLoop = startGitSyncLoop({
    cwd: repoRoot,
    config: autoSync,
    member: memberId,
    runner: defaultGitRunner,
    onNotice: (notice) => log.info(notice),
    // Live coordination-aware pre-warning: the set of paths OTHER teammates are
    // editing/holding right now, read fresh from the agent's converged view each
    // consumer cycle. The consumer warns (and defers auto-merge) before touching
    // a file someone is mid-edit on.
    getHeldPathsByOthers: () => heldPathsByOthers(agent, session, memberId),
  });
  if (autoSync.enabled) {
    log.info(
      `Auto-sync ON (Model A): publishing to ${userBranchName(autoSync.branchPrefix, memberId)} ` +
        `every ${autoSync.commitIntervalSec}s, fetching every ${autoSync.fetchIntervalSec}s` +
        `${autoSync.autoMerge ? ", autoMerge (conflict-free only)" : ", notify-only"}` +
        `, rerere on, live-edit pre-warning on.`,
    );
  }
  log.info("Press Ctrl+C to stop.");

  await waitForShutdown(async () => {
    syncLoop.stop();
    await agent.stop();
  });
}

/** `cfls mcp [--workspace <path>]` — expose a running agent over MCP stdio. */
async function cmdMcp(args: ParsedArgs, cwd: string): Promise<void> {
  if (args.options["help"] === true || args.options["help"] === "true") {
    log.info("Usage: cfls mcp [--workspace <path>]");
    return;
  }
  if (
    args.positionals.length > 0 ||
    args.options["workspace"] === true ||
    Object.keys(args.options).some((option) => option !== "workspace")
  ) {
    throw new Error("Usage: cfls mcp [--workspace <path>]");
  }

  const workspaceOption = stringOption(args, "workspace");
  if (workspaceOption !== undefined && workspaceOption.trim().length === 0) {
    throw new Error("The --workspace path must not be empty.");
  }
  const workspace = resolveRepoRoot(
    workspaceOption === undefined ? cwd : resolve(cwd, workspaceOption),
  );
  await startMcpBridge(workspace);
}

/** Execute a platform service-manager command without involving a shell. */
function runServiceCommand(
  command: ServiceCommand,
): Promise<ServiceCommandResult> {
  return new Promise<ServiceCommandResult>((resolveCommand, rejectCommand) => {
    execFile(
      command.executable,
      [...command.args],
      { encoding: "utf8", maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error === null) {
          resolveCommand({ exitCode: 0, stdout, stderr });
          return;
        }
        const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
        if (typeof code === "number") {
          resolveCommand({ exitCode: code, stdout, stderr });
          return;
        }
        rejectCommand(error);
      },
    );
  });
}

/** The small native adapter used only when the user explicitly runs `service`. */
function nativeServiceExecutor(): ServicePlanExecutor {
  return {
    ensureDirectory: async (path) => {
      await mkdir(path, { recursive: true });
    },
    writeFile: async (file) => {
      await writeFile(file.path, file.content, {
        encoding: "utf8",
        ...(file.mode !== undefined ? { mode: file.mode } : {}),
      });
    },
    removeFile: async (file) => {
      await rm(file.path, { force: file.allowMissing });
    },
    run: runServiceCommand,
  };
}

/** Build validated argv for a background agent when this CLI is Node-hosted or a SEA exe. */
export function serviceAgentArgs(args: ParsedArgs): string[] {
  const agentArgs: string[] = [];
  // A standalone Node SEA executable invokes itself directly. A normal npm/pnpm
  // install needs Node to run the current JavaScript entry file first.
  if (process.versions["sea"] === undefined) {
    const entry = process.argv[1];
    if (entry === undefined || entry === "") {
      throw new Error(
        "Cannot determine the CFLS CLI entry point for the background service.",
      );
    }
    agentArgs.push(resolve(entry));
  }
  agentArgs.push("agent");
  if (boolOption(args, "insecure-tls")) {
    agentArgs.push("--insecure-tls");
  }
  const localPort = args.options["local-port"];
  if (localPort !== undefined) {
    // The installed service must receive the same strictly valid port as an
    // interactive `cfls agent`; otherwise it could install successfully but
    // fail on every background launch.
    agentArgs.push("--local-port", String(parseLocalApiPort(localPort)));
  }
  return agentArgs;
}

function serviceUsage(): string {
  return (
    "Usage: cfls service <install|uninstall|status> [--workspace <path>] " +
    "[--name <service-name>] [--insecure-tls] [--local-port <port>] " +
    "[--windows-user <DOMAIN\\\\User-or-SID>]"
  );
}

/** `cfls service` — install/query/remove the per-user CFLS agent service. */
async function cmdService(args: ParsedArgs, cwd: string): Promise<void> {
  if (args.options["help"] === true || args.options["help"] === "true") {
    log.info(serviceUsage());
    return;
  }
  const [action] = args.positionals;
  if (
    (action !== "install" && action !== "uninstall" && action !== "status") ||
    args.positionals.length !== 1
  ) {
    throw new Error(serviceUsage());
  }

  const requestedPlatform = stringOption(args, "platform") ?? process.platform;
  const platform = normalizeServicePlatform(requestedPlatform);
  if (platform !== process.platform) {
    throw new Error(
      `Run this command on its target platform (requested ${platform}, running ${process.platform}).`,
    );
  }

  const workspaceOption = stringOption(args, "workspace");
  const workspace = resolveRepoRoot(
    workspaceOption === undefined ? cwd : resolve(cwd, workspaceOption),
  );
  const userHome = homedir();
  const serviceName = stringOption(args, "name");
  const windowsUserId = stringOption(args, "windows-user");
  const identity = {
    platform,
    userHome,
    ...(serviceName !== undefined ? { serviceName } : {}),
  };
  const executor = nativeServiceExecutor();

  if (action === "status") {
    const status = await getServiceStatus(identity, executor);
    log.info(
      `CFLS agent service (${status.serviceName}): ${status.state}. ${status.detail}`,
    );
    return;
  }

  const result =
    action === "install"
      ? await installService(
          {
            ...identity,
            executablePath: process.execPath,
            workspacePath: workspace,
            args: serviceAgentArgs(args),
            ...(platform === "win32" && windowsUserId !== undefined
              ? { windowsUserId }
              : {}),
          },
          executor,
        )
      : await uninstallService(identity, executor);

  for (const warning of result.warnings) {
    log.warn(warning);
  }
  if (!result.ok) {
    const target = result.failure?.target ?? "unknown step";
    const exit =
      result.failure?.exitCode === undefined
        ? ""
        : ` (exit code ${result.failure.exitCode})`;
    throw new Error(
      `Could not ${action} CFLS agent service at ${target}${exit}.`,
    );
  }
  log.info(
    action === "install"
      ? `CFLS agent service installed for ${workspace}.`
      : "CFLS agent service removed.",
  );
  if (action === "install" && platform === "linux") {
    log.info(
      "For headless use after logout, enable systemd user lingering for this account if your distro requires it.",
    );
  }
}

/**
 * Read the live set of repo-relative paths OTHER teammates are actively editing
 * or holding a lock on, from the agent's converged coordination view. Used to
 * pre-warn (and defer auto-merges) before a git merge would touch a file someone
 * is mid-edit on. Never throws — returns an empty set if the view is unavailable.
 */
function heldPathsByOthers(
  agent: CoordinationAgent,
  session: SessionId,
  selfMemberId: string,
): ReadonlySet<string> {
  const held = new Set<string>();
  try {
    for (const entry of agent.view.entries(session)) {
      if (
        entry.path !== undefined &&
        entry.member.memberId !== selfMemberId &&
        (entry.entryType === "soft_lock" || entry.entryType === "presence")
      ) {
        held.add(entry.path);
      }
    }
  } catch {
    // View not ready / offline — no pre-warning this cycle.
  }
  return held;
}

/**
 * Resolve the member name used for the per-user publish branch: prefers the
 * saved agent config, then the stored invitation, then `--name`. Throws a clear
 * error when none is available (the sync commands need a stable identity).
 */
function resolveSyncMember(repoRoot: string, args: ParsedArgs): string {
  const config = readAgentConfig(agentConfigPath(repoRoot));
  const fromInvitation =
    config.invitation !== undefined
      ? decodeInvitation(config.invitation).claims.memberId
      : undefined;
  const member =
    stringOption(args, "name") ?? config.memberName ?? fromInvitation;
  if (member === undefined || member === "") {
    throw new Error(
      'No member name found. Run "cfls join --name <you>" / "cfls connect <invitation>" first, ' +
        "or pass --name <you>.",
    );
  }
  return member;
}

/** `cfls sync status` — show branches, ahead/behind, and working-tree state. */
function cmdSyncStatus(args: ParsedArgs, cwd: string): void {
  const repoRoot = resolveRepoRoot(cwd);
  const autoSync = readAutoSyncConfig(teamConfigPath(repoRoot));
  const member = resolveSyncMember(repoRoot, args);
  const branch = currentBranch(repoRoot) ?? "(unknown)";
  const myBranch = userBranchName(autoSync.branchPrefix, member);
  const changes = workingTreeChanges(repoRoot);

  log.info(
    `Auto-sync:      ${autoSync.enabled ? "ENABLED" : "disabled (opt-in)"}`,
  );
  log.info(`Current branch: ${branch}`);
  log.info(`My publish br.: ${myBranch}  (remote: ${autoSync.remote})`);
  log.info(
    `Working tree:   ${changes.length === 0 ? "clean" : `${changes.length} changed path(s)`}`,
  );
  log.info("");

  const branches = listTrackingBranches(
    autoSync.remote,
    autoSync.branchPrefix,
    repoRoot,
  ).filter((b) => b.branch !== myBranch);
  if (branches.length === 0) {
    log.info(
      `No other ${autoSync.branchPrefix}* branches on ${autoSync.remote} yet.`,
    );
    return;
  }
  log.info("Teammate branches:");
  for (const b of branches) {
    log.info(
      `  ${b.branch}  (behind you ${b.behind}, ahead of you ${b.ahead})`,
    );
  }
}

/** `cfls sync push` — manually stage coordinated changes, commit, and publish. */
function cmdSyncPush(args: ParsedArgs, cwd: string): void {
  const repoRoot = resolveRepoRoot(cwd);
  const autoSync = readAutoSyncConfig(teamConfigPath(repoRoot));
  const member = resolveSyncMember(repoRoot, args);
  const branch = userBranchName(autoSync.branchPrefix, member);

  const changes = workingTreeChanges(repoRoot);
  if (changes.length === 0) {
    log.info("Nothing to sync — working tree is clean.");
    return;
  }

  const paths = changes.map((c) => c.path);
  const staged = stagePaths(paths, repoRoot);
  if (!staged.ok) {
    throw new Error(
      "Failed to stage changes (git add). Resolve manually and retry.",
    );
  }
  const committed = commit(buildCommitMessage(member, paths.length), repoRoot);
  if (!committed.ok) {
    log.info("Nothing committed (no staged changes after .gitignore).");
    return;
  }
  const pushed = gitPush(autoSync.remote, branch, repoRoot);
  if (!pushed.ok) {
    throw new Error(
      `Committed ${paths.length} file(s), but push to ${branch} was rejected ` +
        "(auth or non-fast-forward). Check credentials or fetch/merge, then retry.",
    );
  }
  log.info(
    `Published ${paths.length} file(s) to ${autoSync.remote}/${branch}.`,
  );
}

/**
 * `cfls sync merge <member> [--resolve]` — merge a teammate's published branch.
 *
 * Default (safe): attempts a clean merge; on conflict it lists the exact
 * conflicting files and restores your working tree untouched (nothing is left
 * half-merged). With `--resolve` it instead performs the merge and LEAVES the
 * conflict markers in place, then opens the conflicted files in your editor's
 * merge UI so you can resolve them and `git commit`.
 */
function cmdSyncMerge(args: ParsedArgs, cwd: string): void {
  const [target] = args.positionals;
  if (target === undefined) {
    throw new Error("Usage: cfls sync merge <member> [--resolve]");
  }
  const repoRoot = resolveRepoRoot(cwd);
  const autoSync = readAutoSyncConfig(teamConfigPath(repoRoot));
  const branch = userBranchName(autoSync.branchPrefix, target);
  const ref = `${autoSync.remote}/${branch}`;
  const resolve = boolOption(args, "resolve");

  // rerere lets a hand-resolved conflict be replayed automatically next time.
  enableRerere(repoRoot);
  // Refresh remote-tracking refs first so we merge the latest published tip.
  gitFetch(autoSync.remote, repoRoot);

  if (resolve) {
    const result = mergeLeavingConflicts(ref, repoRoot);
    if (result.ok) {
      log.info(
        result.alreadyUpToDate === true
          ? `Already up to date with ${ref}.`
          : `Merged ${ref} cleanly into ${currentBranch(repoRoot) ?? "the current branch"}.`,
      );
      return;
    }
    log.warn(
      `Merge of ${ref} has conflicts in ${result.conflictedFiles.length} file(s):`,
    );
    for (const f of result.conflictedFiles) {
      log.warn(`  ${f}`);
    }
    const opened = openInEditor(result.conflictedFiles, repoRoot);
    log.info("");
    if (opened !== null) {
      log.info(
        `Opened the conflicted files in ${opened}. Use its merge editor to resolve each,`,
      );
      log.info(
        'then run:  git commit   (the merge is in progress — do NOT run "git merge --abort"',
      );
      log.info("unless you want to throw the merge away).");
    } else {
      log.info(
        "Could not launch an editor automatically. Open the files above, resolve the",
      );
      log.info(
        "<<<<<<< / >>>>>>> markers, then run:  git add -A  &&  git commit",
      );
    }
    log.info(`To cancel this merge entirely:  git merge --abort`);
    return;
  }

  const result = mergeReportingConflicts(ref, repoRoot);
  if (result.ok) {
    log.info(
      result.alreadyUpToDate === true
        ? `Already up to date with ${ref}.`
        : `Merged ${ref} cleanly into ${currentBranch(repoRoot) ?? "the current branch"}.`,
    );
    return;
  }
  const list =
    result.conflictedFiles.length > 0
      ? ` Conflicting file(s):\n  - ${result.conflictedFiles.join("\n  - ")}`
      : "";
  throw new Error(
    `Merge of ${ref} hit conflicts and was aborted (your tree is unchanged).${list}\n` +
      `To resolve interactively in your editor, run:  cfls sync merge ${target} --resolve\n` +
      "Or open a Pull Request on GitHub and resolve it there.",
  );
}

/** `cfls sync <status|push|merge>` — automatic git sync commands (Model A). */
async function cmdSync(args: ParsedArgs, cwd: string): Promise<void> {
  const [sub, ...rest] = args.positionals;
  const subArgs: ParsedArgs = { positionals: rest, options: args.options };
  switch (sub) {
    case "status":
      cmdSyncStatus(subArgs, cwd);
      return;
    case "push":
      cmdSyncPush(subArgs, cwd);
      return;
    case "merge":
      cmdSyncMerge(subArgs, cwd);
      return;
    default:
      throw new Error("Usage: cfls sync <status|push|merge <member>>");
  }
}

/** `cfls clone <repo-url> [--host <wss>] [--name <member>] [--team <id>]`. */
async function cmdClone(args: ParsedArgs): Promise<void> {
  const [repoUrl] = args.positionals;
  if (repoUrl === undefined) {
    throw new Error(
      "Usage: cfls clone <repo-url> [--host <wss>] [--name <member>] [--team <id>]",
    );
  }

  // `git clone` uses the user's OWN GitHub/remote access (SSH keys, credential
  // helper, PAT). cfls never handles those credentials.
  const clone = defaultGitRunner(["clone", repoUrl], process.cwd());
  if (!clone.ok) {
    throw new Error(
      `git clone failed for ${repoUrl}. Ensure you have access to the repo ` +
        "(SSH key / credentials) — cfls uses your own GitHub access and stores no tokens.",
    );
  }

  // Derive the checkout directory git created (last path segment, minus .git).
  const tail =
    repoUrl
      .replace(/\.git$/, "")
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .pop() ?? "repo";
  const repoRoot = resolve(process.cwd(), tail);

  const hostUrl = stringOption(args, "host");
  const memberName = stringOption(args, "name");
  const teamId = stringOption(args, "team");
  updateAgentConfig(agentConfigPath(repoRoot), {
    ...(hostUrl !== undefined ? { hostUrl } : {}),
    ...(memberName !== undefined ? { memberName } : {}),
    ...(teamId !== undefined ? { teamId } : {}),
  });

  log.info(`Cloned ${repoUrl} into ${repoRoot}.`);
  log.info(`Scaffolded ${agentConfigPath(repoRoot)}.`);
  log.info("");
  log.info("Next steps (from inside the repo):");
  log.info(
    "  1. cfls id                 # share this device's public key with your admin",
  );
  log.info(
    "  2. cfls connect <invite>   # paste the invitation the admin returns",
  );
  log.info("  3. cfls agent --insecure-tls");
  log.info("");
  log.info("Note: pushing/pulling files still uses YOUR own GitHub access.");
}

/** Print top-level usage. */
function printUsage(): void {
  log.info(
    [
      "cfls — Collaborative File Lock Sync onboarding tool",
      "",
      "Admin commands:",
      "  cfls admin-init [--team <id>]                 Create + store the team admin key",
      "  cfls host [--url wss://0.0.0.0:8730] [--db <path>]",
      "            [--cert <pem>] [--key <pem>] [--repo <url>]",
      "                                                Start the CoordinationHost",
      "  cfls invite <memberName> <devicePublicKey>    Issue a signed invitation",
      "",
      "Teammate commands:",
      "  cfls id                                       Show this device's public key + id",
      "  cfls join --host <wss-url> [--name <name>] [--team <id>]",
      "                                                Save host + name, print next steps",
      "  cfls connect <invitationBase64>               Store an invitation",
      "  cfls agent [--insecure-tls] [--local-port 8750]",
      "                                                Run the local CoordinationAgent",
      "  cfls mcp [--workspace <path>]                 Expose this running agent to an MCP client",
      "  cfls service <install|uninstall|status>       Manage the per-user background agent",
      "            [--workspace <path>] [--name <id>] [--windows-user <principal>]",
      "",
      "Automatic git sync (Model A, opt-in via .coordination/config.json):",
      "  cfls clone <repo-url> [--host <wss>] [--name <name>] [--team <id>]",
      "                                                Clone + scaffold .coordination",
      "  cfls sync status                              Show branches + ahead/behind + tree state",
      "  cfls sync push                                Commit coordinated changes + push cfls/<you>",
      "  cfls sync merge <member> [--resolve]          Merge a teammate; --resolve opens the",
      "                                                editor merge UI instead of aborting on conflict",
    ].join("\n"),
  );
}

/** CLI entrypoint. */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  const cwd = process.cwd();

  try {
    switch (command) {
      case "admin-init":
        await cmdAdminInit(args);
        return 0;
      case "host":
        await cmdHost(args, cwd);
        return 0;
      case "id":
        await cmdId(cwd);
        return 0;
      case "invite":
        await cmdInvite(args, cwd);
        return 0;
      case "join":
        await cmdJoin(args, cwd);
        return 0;
      case "connect":
        cmdConnect(args, cwd);
        return 0;
      case "agent":
        await cmdAgent(args, cwd);
        return 0;
      case "mcp":
        await cmdMcp(args, cwd);
        return 0;
      case "service":
        await cmdService(args, cwd);
        return 0;
      case "sync":
        await cmdSync(args, cwd);
        return 0;
      case "clone":
        await cmdClone(args);
        return 0;
      case undefined:
      case "help":
      case "--help":
      case "-h":
        printUsage();
        return 0;
      default:
        log.error(`Unknown command "${command}".`);
        printUsage();
        return 1;
    }
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

// Only run when executed directly (not when imported by tests). Compare the
// resolved filesystem paths (handling Windows separators and URL-encoded spaces).
function isInvokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return resolve(fileURLToPath(import.meta.url)) === resolve(entry);
  } catch {
    return false;
  }
}

if (isInvokedDirectly()) {
  main().then(
    (code) => {
      if (code !== 0) process.exitCode = code;
    },
    (error: unknown) => {
      log.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
