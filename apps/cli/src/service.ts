/**
 * Per-user background-service lifecycle support for the CFLS agent.
 *
 * This module deliberately does not import `child_process`, `fs`, or the CLI
 * router. It turns a validated service definition into an explicit plan and
 * can apply that plan only through an injected executor. That makes the
 * platform-specific pieces easy to test, lets the CLI choose its own UX, and
 * prevents an import of this module from ever installing a service as a side
 * effect.
 *
 * Linux uses a `systemd --user` unit. Windows uses a per-user Task Scheduler
 * task with an `InteractiveToken` logon type; neither mechanism needs elevated
 * privileges for the normal CFLS-agent use case.
 */

import { posix, win32 } from "node:path";

/** Platforms for which this module can build a per-user agent service. */
export type ServicePlatform = "linux" | "win32" | "windows";

/** The normalized platform names used by generated plans. */
export type CanonicalServicePlatform = "linux" | "win32";

/** A lifecycle operation represented by a {@link ServicePlan}. */
export type ServiceLifecycleAction = "install" | "uninstall" | "status";

/** A stable logical name, before `.service` / Task Scheduler path decoration. */
export const DEFAULT_SERVICE_NAME = "cfls-agent";

/** The command run by a newly installed service when callers do not override it. */
export const DEFAULT_SERVICE_ARGS: readonly string[] = ["agent"];

/** Human-readable description used in both systemd and Task Scheduler. */
export const DEFAULT_SERVICE_DESCRIPTION = "CFLS collaboration agent";

/**
 * Definition of a CFLS agent service. All three paths are target-machine paths,
 * not paths relative to the process constructing the plan. `userHome` makes
 * plan construction deterministic and avoids consulting the builder's own
 * home directory.
 */
export interface ServiceInstallOptions {
  readonly platform: ServicePlatform;
  readonly userHome: string;
  readonly executablePath: string;
  readonly workspacePath: string;
  /** Arguments passed directly to `executablePath`; defaults to `["agent"]`. */
  readonly args?: readonly string[];
  /** Logical name only, without a `.service` suffix or Task Scheduler folders. */
  readonly serviceName?: string;
  readonly description?: string;
  /**
   * Required for a Windows task: the current user's Task Scheduler principal
   * (for example `DESKTOP\\Alice`, `alice@example.com`, or a user SID).
   */
  readonly windowsUserId?: string;
}

/** The subset of an install definition needed for uninstalling or querying. */
export interface ServiceIdentity {
  readonly platform: ServicePlatform;
  readonly userHome: string;
  readonly serviceName?: string;
}

/** A normalized and validated definition returned by {@link validateServiceInstallOptions}. */
export interface ValidatedServiceInstallOptions {
  readonly platform: CanonicalServicePlatform;
  readonly userHome: string;
  readonly executablePath: string;
  readonly workspacePath: string;
  readonly args: readonly string[];
  readonly serviceName: string;
  readonly description: string;
  readonly windowsUserId?: string;
}

/** A normalized and validated service identity. */
export interface ValidatedServiceIdentity {
  readonly platform: CanonicalServicePlatform;
  readonly userHome: string;
  readonly serviceName: string;
}

/** A file that an install plan needs the executor to write. */
export interface ServiceFileWrite {
  readonly path: string;
  readonly content: string;
  readonly mode?: number;
  /** Task Scheduler's XML importer requires UTF-16LE with a BOM on Windows. */
  readonly encoding?: "utf8" | "utf16le-bom";
}

/** A file that an uninstall plan needs the executor to remove. */
export interface ServiceFileRemoval {
  readonly path: string;
  /** The removal is intentionally idempotent when the file is already absent. */
  readonly allowMissing: boolean;
}

/** A command deliberately represented as an executable plus argv, never a shell string. */
export interface ServiceCommand {
  readonly id: string;
  readonly executable: string;
  readonly args: readonly string[];
  /** Run before uninstall definition files are removed (stop/delete commands). */
  readonly phase?: "before-file-removal";
  /** A non-zero exit code is informational rather than fatal for this command. */
  readonly allowFailure?: boolean;
  /**
   * During uninstall only, a non-zero exit is safe when the native manager
   * explicitly confirms that this exact service target is already absent.
   * It deliberately does not make arbitrary failures (for example access
   * denied, a missing `systemctl` binary, or a corrupted service database)
   * non-fatal.
   */
  readonly allowMissingService?: boolean;
}

/** A fully resolved, side-effect-free lifecycle plan. */
export interface ServicePlan {
  readonly action: ServiceLifecycleAction;
  readonly platform: CanonicalServicePlatform;
  readonly serviceName: string;
  readonly directories: readonly string[];
  readonly filesToWrite: readonly ServiceFileWrite[];
  readonly filesToRemove: readonly ServiceFileRemoval[];
  readonly commands: readonly ServiceCommand[];
}

/** The filesystem locations and platform-specific service identifiers for a plan. */
export interface ServicePaths {
  /** Directory containing the unit definition or Task Scheduler XML. */
  readonly definitionDirectory: string;
  /** Full path to the persisted systemd unit or task XML definition. */
  readonly definitionPath: string;
  /** `cfls-agent.service` on Linux, `\\CFLS-cfls-agent` on Windows. */
  readonly platformServiceId: string;
}

/** Error thrown when an untrusted service definition is unsafe or incomplete. */
export class ServiceValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ServiceValidationError";
  }
}

const CONTROL_CHARACTER = /\p{Cc}/u;
const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/** Resolve Node's `win32` spelling and the user-facing `windows` alias. */
export function normalizeServicePlatform(
  platform: string,
): CanonicalServicePlatform {
  if (platform === "linux") {
    return "linux";
  }
  if (platform === "win32" || platform === "windows") {
    return "win32";
  }
  throw new ServiceValidationError(
    `Unsupported service platform "${platform}". Expected linux or win32.`,
  );
}

/** True only for a non-empty argument that is safe to serialize into both targets. */
export function isSafeServiceArgument(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !CONTROL_CHARACTER.test(value)
  );
}

function requireSafeText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ServiceValidationError(`${field} must be a non-empty string.`);
  }
  if (CONTROL_CHARACTER.test(value)) {
    throw new ServiceValidationError(
      `${field} must not contain control characters, newlines, or NUL bytes.`,
    );
  }
  return value;
}

function requireAbsolutePath(
  value: unknown,
  field: string,
  platform: CanonicalServicePlatform,
): string {
  const path = requireSafeText(value, field);
  const isAbsolute = platform === "linux" ? posix.isAbsolute : win32.isAbsolute;
  if (!isAbsolute(path)) {
    const expected =
      platform === "linux" ? "/absolute/path" : "C:\\absolute\\path";
    throw new ServiceValidationError(
      `${field} must be an absolute ${platform === "linux" ? "POSIX" : "Windows"} path (for example ${expected}).`,
    );
  }
  return path;
}

function requireServiceName(value: unknown): string {
  const name = requireSafeText(value, "serviceName");
  if (!SERVICE_NAME.test(name)) {
    throw new ServiceValidationError(
      "serviceName may contain only letters, numbers, dots, underscores, and hyphens.",
    );
  }
  if (name.endsWith(".service")) {
    throw new ServiceValidationError(
      "serviceName is logical; omit the .service suffix.",
    );
  }
  return name;
}

function requireSafeArgs(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new ServiceValidationError(
      "args must be an array of non-empty strings.",
    );
  }
  const args = value.map((argument, index) => {
    if (!isSafeServiceArgument(argument)) {
      throw new ServiceValidationError(
        `args[${index}] must be a non-empty string without control characters.`,
      );
    }
    return argument;
  });
  return args;
}

/**
 * Validate a service definition without touching the filesystem. Existence is
 * deliberately not checked here: a plan may be made on one machine and applied
 * later on its target machine.
 */
export function validateServiceInstallOptions(
  options: ServiceInstallOptions,
): ValidatedServiceInstallOptions {
  if (typeof options !== "object" || options === null) {
    throw new ServiceValidationError("service options must be an object.");
  }
  const platform = normalizeServicePlatform(options.platform);
  const userHome = requireAbsolutePath(options.userHome, "userHome", platform);
  const executablePath = requireAbsolutePath(
    options.executablePath,
    "executablePath",
    platform,
  );
  const workspacePath = requireAbsolutePath(
    options.workspacePath,
    "workspacePath",
    platform,
  );
  const args =
    options.args === undefined
      ? [...DEFAULT_SERVICE_ARGS]
      : requireSafeArgs(options.args);
  const serviceName = requireServiceName(
    options.serviceName ?? DEFAULT_SERVICE_NAME,
  );
  const description = requireSafeText(
    options.description ?? DEFAULT_SERVICE_DESCRIPTION,
    "description",
  );
  const windowsUserId =
    platform === "win32"
      ? requireSafeText(options.windowsUserId, "windowsUserId")
      : undefined;

  return {
    platform,
    userHome,
    executablePath,
    workspacePath,
    args,
    serviceName,
    description,
    ...(windowsUserId !== undefined ? { windowsUserId } : {}),
  };
}

/** Validate the identity used by an uninstall or a status query. */
export function validateServiceIdentity(
  identity: ServiceIdentity,
): ValidatedServiceIdentity {
  if (typeof identity !== "object" || identity === null) {
    throw new ServiceValidationError("service identity must be an object.");
  }
  const platform = normalizeServicePlatform(identity.platform);
  return {
    platform,
    userHome: requireAbsolutePath(identity.userHome, "userHome", platform),
    serviceName: requireServiceName(
      identity.serviceName ?? DEFAULT_SERVICE_NAME,
    ),
  };
}

/** Resolve the target user's unit/XML location without consulting the local OS. */
export function resolveServicePaths(
  identity: ServiceIdentity | ValidatedServiceIdentity,
): ServicePaths {
  const validated = validateServiceIdentity(identity);
  if (validated.platform === "linux") {
    const definitionDirectory = posix.join(
      validated.userHome,
      ".config",
      "systemd",
      "user",
    );
    return {
      definitionDirectory,
      definitionPath: posix.join(
        definitionDirectory,
        `${validated.serviceName}.service`,
      ),
      platformServiceId: `${validated.serviceName}.service`,
    };
  }

  const definitionDirectory = win32.join(
    validated.userHome,
    "AppData",
    "Local",
    "CFLS",
    "services",
  );
  return {
    definitionDirectory,
    definitionPath: win32.join(
      definitionDirectory,
      `${validated.serviceName}.xml`,
    ),
    // A custom Task Scheduler folder may not exist for ordinary user accounts.
    // A root-level CFLS-prefixed task has no hidden folder prerequisite.
    platformServiceId: `\\CFLS-${validated.serviceName}`,
  };
}

/**
 * Quote a single systemd command/directive argument. `$` and `%` are escaped
 * too, so an argument remains literal rather than becoming a systemd variable
 * or unit specifier expansion.
 */
export function quoteSystemdArgument(value: string): string {
  const safe = requireSafeText(value, "systemd argument");
  const escaped = safe
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"')
    .replace(/\$/gu, () => "$$")
    .replace(/%/gu, "%%");
  return `"${escaped}"`;
}

/**
 * Escape a path-valued systemd directive without surrounding quotes.
 *
 * `ExecStart=` accepts shell-like quoted argv elements, but path directives
 * such as `WorkingDirectory=` do not: quote characters become part of the
 * value and systemd rejects the path as non-absolute. Use systemd's C-style
 * escapes for the few characters that need protection instead.
 */
export function escapeSystemdPath(value: string): string {
  const path = requireSafeText(value, "systemd path");
  if (!posix.isAbsolute(path)) {
    throw new ServiceValidationError(
      "systemd path must be an absolute POSIX path.",
    );
  }
  return path
    .replace(/\\/gu, "\\\\")
    .replace(/ /gu, "\\x20")
    .replace(/"/gu, "\\x22")
    .replace(/%/gu, "%%");
}

/**
 * Turn one argv element into a Windows command-line argument using the standard
 * `CommandLineToArgvW` escaping rules. It is intentionally not a shell escape.
 */
export function quoteWindowsArgument(value: string): string {
  const safe = requireSafeText(value, "Windows argument");
  if (!/[\s"]/u.test(safe)) {
    return safe;
  }

  let quoted = '"';
  let backslashes = 0;
  for (const character of safe) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1);
      quoted += '"';
      backslashes = 0;
      continue;
    }
    quoted += "\\".repeat(backslashes);
    quoted += character;
    backslashes = 0;
  }
  quoted += "\\".repeat(backslashes * 2);
  return `${quoted}"`;
}

/** Escape text that is inserted into a Task Scheduler XML element. */
export function escapeTaskXml(value: string): string {
  const safe = requireSafeText(value, "Task Scheduler XML value");
  return safe
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

function asLinuxOptions(
  options: ServiceInstallOptions,
): ValidatedServiceInstallOptions {
  const validated = validateServiceInstallOptions(options);
  if (validated.platform !== "linux") {
    throw new ServiceValidationError(
      "Linux unit generation requires platform: linux.",
    );
  }
  return validated;
}

function asWindowsOptions(
  options: ServiceInstallOptions,
): ValidatedServiceInstallOptions {
  const validated = validateServiceInstallOptions(options);
  if (validated.platform !== "win32") {
    throw new ServiceValidationError(
      "Windows task generation requires platform: win32 or windows.",
    );
  }
  return validated;
}

/** Build the complete contents of a `systemd --user` unit. */
export function buildLinuxUserServiceUnit(
  options: ServiceInstallOptions,
): string {
  const validated = asLinuxOptions(options);
  const execStart = [validated.executablePath, ...validated.args]
    .map(quoteSystemdArgument)
    .join(" ");

  return [
    "[Unit]",
    `Description=${quoteSystemdArgument(validated.description)}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${escapeSystemdPath(validated.workspacePath)}`,
    `ExecStart=${execStart}`,
    "Restart=on-failure",
    "RestartSec=3",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** Build a Task Scheduler XML definition that runs only in the current user's session. */
export function buildWindowsUserTaskXml(
  options: ServiceInstallOptions,
): string {
  const validated = asWindowsOptions(options);
  const paths = resolveServicePaths(validated);
  const windowsUserId = validated.windowsUserId;
  if (windowsUserId === undefined) {
    // Validation guarantees this, but retain a local guard if the validated
    // shape ever changes independently from the Windows renderer.
    throw new ServiceValidationError(
      "Windows task generation requires a windowsUserId principal.",
    );
  }
  const argumentsText = validated.args.map(quoteWindowsArgument).join(" ");

  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    `    <URI>${escapeTaskXml(paths.platformServiceId)}</URI>`,
    `    <Description>${escapeTaskXml(validated.description)}</Description>`,
    "  </RegistrationInfo>",
    "  <Triggers>",
    "    <LogonTrigger>",
    "      <Enabled>true</Enabled>",
    `      <UserId>${escapeTaskXml(windowsUserId)}</UserId>`,
    "    </LogonTrigger>",
    "  </Triggers>",
    "  <Principals>",
    '    <Principal id="CFLSUser">',
    `      <UserId>${escapeTaskXml(windowsUserId)}</UserId>`,
    "      <LogonType>InteractiveToken</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <AllowHardTerminate>true</AllowHardTerminate>",
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "    <RestartOnFailure>",
    "      <Interval>PT1M</Interval>",
    "      <Count>5</Count>",
    "    </RestartOnFailure>",
    "    <Enabled>true</Enabled>",
    "  </Settings>",
    '  <Actions Context="CFLSUser">',
    "    <Exec>",
    `      <Command>${escapeTaskXml(validated.executablePath)}</Command>`,
    `      <Arguments>${escapeTaskXml(argumentsText)}</Arguments>`,
    `      <WorkingDirectory>${escapeTaskXml(validated.workspacePath)}</WorkingDirectory>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\n");
}

interface ServiceCommandOptions {
  readonly allowFailure?: boolean;
  readonly allowMissingService?: boolean;
  readonly phase?: "before-file-removal";
}

function serviceCommand(
  id: string,
  executable: string,
  args: readonly string[],
  options: ServiceCommandOptions = {},
): ServiceCommand {
  return {
    id,
    executable,
    args,
    ...(options.allowFailure === true ? { allowFailure: true } : {}),
    ...(options.allowMissingService === true
      ? { allowMissingService: true }
      : {}),
    ...(options.phase !== undefined ? { phase: options.phase } : {}),
  };
}

/** Build a side-effect-free install plan for Linux or Windows. */
export function buildServiceInstallPlan(
  options: ServiceInstallOptions,
): ServicePlan {
  const validated = validateServiceInstallOptions(options);
  const paths = resolveServicePaths(validated);

  if (validated.platform === "linux") {
    return {
      action: "install",
      platform: "linux",
      serviceName: validated.serviceName,
      directories: [paths.definitionDirectory],
      filesToWrite: [
        {
          path: paths.definitionPath,
          content: buildLinuxUserServiceUnit(validated),
          mode: 0o644,
        },
      ],
      filesToRemove: [],
      commands: [
        serviceCommand("systemd-daemon-reload", "systemctl", [
          "--user",
          "daemon-reload",
        ]),
        serviceCommand("systemd-enable-and-start", "systemctl", [
          "--user",
          "enable",
          "--now",
          paths.platformServiceId,
        ]),
      ],
    };
  }

  return {
    action: "install",
    platform: "win32",
    serviceName: validated.serviceName,
    directories: [paths.definitionDirectory],
    filesToWrite: [
      {
        path: paths.definitionPath,
        content: buildWindowsUserTaskXml(validated),
        encoding: "utf16le-bom",
      },
    ],
    filesToRemove: [],
    commands: [
      serviceCommand("task-create", "schtasks.exe", [
        "/Create",
        "/TN",
        paths.platformServiceId,
        "/XML",
        paths.definitionPath,
        "/F",
      ]),
      serviceCommand("task-start", "schtasks.exe", [
        "/Run",
        "/TN",
        paths.platformServiceId,
      ]),
    ],
  };
}

/** Build an idempotent uninstall plan. No command is run until an executor applies it. */
export function buildServiceUninstallPlan(
  identity: ServiceIdentity,
): ServicePlan {
  const validated = validateServiceIdentity(identity);
  const paths = resolveServicePaths(validated);

  if (validated.platform === "linux") {
    return {
      action: "uninstall",
      platform: "linux",
      serviceName: validated.serviceName,
      directories: [],
      filesToWrite: [],
      filesToRemove: [{ path: paths.definitionPath, allowMissing: true }],
      commands: [
        serviceCommand(
          "systemd-disable-and-stop",
          "systemctl",
          ["--user", "disable", "--now", paths.platformServiceId],
          {
            allowMissingService: true,
            phase: "before-file-removal",
          },
        ),
        serviceCommand("systemd-daemon-reload", "systemctl", [
          "--user",
          "daemon-reload",
        ]),
      ],
    };
  }

  return {
    action: "uninstall",
    platform: "win32",
    serviceName: validated.serviceName,
    directories: [],
    filesToWrite: [],
    filesToRemove: [{ path: paths.definitionPath, allowMissing: true }],
    commands: [
      serviceCommand(
        "task-stop",
        "schtasks.exe",
        ["/End", "/TN", paths.platformServiceId],
        {
          allowMissingService: true,
          phase: "before-file-removal",
        },
      ),
      serviceCommand(
        "task-delete",
        "schtasks.exe",
        ["/Delete", "/TN", paths.platformServiceId, "/F"],
        {
          allowMissingService: true,
          phase: "before-file-removal",
        },
      ),
    ],
  };
}

/** Build a plan that asks the native service manager for current state. */
export function buildServiceStatusPlan(identity: ServiceIdentity): ServicePlan {
  const validated = validateServiceIdentity(identity);
  const paths = resolveServicePaths(validated);

  if (validated.platform === "linux") {
    return {
      action: "status",
      platform: "linux",
      serviceName: validated.serviceName,
      directories: [],
      filesToWrite: [],
      filesToRemove: [],
      commands: [
        serviceCommand(
          "systemd-status",
          "systemctl",
          [
            "--user",
            "show",
            paths.platformServiceId,
            "--property=LoadState",
            "--property=ActiveState",
            "--property=SubState",
            "--property=UnitFileState",
            "--value",
          ],
          { allowFailure: true },
        ),
      ],
    };
  }

  return {
    action: "status",
    platform: "win32",
    serviceName: validated.serviceName,
    directories: [],
    filesToWrite: [],
    filesToRemove: [],
    commands: [
      serviceCommand(
        "task-status",
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          windowsTaskStatusScript(validated.serviceName),
        ],
        { allowFailure: true },
      ),
    ],
  };
}

/**
 * Emit a compact, numeric Task Scheduler status record. `schtasks /FO LIST`
 * localizes both labels and state strings, so parsing it makes `service status`
 * unreliable on non-English Windows. `TaskState`'s enum values and a Boolean
 * `Settings.Enabled` are locale-neutral. The task name is validated before this
 * script is built, so it cannot inject PowerShell syntax.
 */
function windowsTaskStatusScript(serviceName: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    `$task = Get-ScheduledTask -TaskPath '\\CFLS\\' -TaskName '${serviceName}'`,
    "$state = [int]$task.State",
    "$enabled = if ([bool]$task.Settings.Enabled) { 1 } else { 0 }",
    '[Console]::Out.WriteLine("CFLS_TASK_STATE=$state;ENABLED=$enabled")',
    "} catch {",
    // HRESULT 0x80070002 is ERROR_FILE_NOT_FOUND, independent of UI locale.
    "if ($_.Exception.HResult -eq -2147024894) {",
    "[Console]::Out.WriteLine('CFLS_TASK_NOT_FOUND')",
    "exit 0",
    "}",
    "throw",
    "}",
  ].join("; ");
}

/** Convenience type for the Linux-specific builder and installer helpers. */
export type LinuxUserServiceOptions = Omit<ServiceInstallOptions, "platform">;

/** Convenience type for the Windows-specific builder and installer helpers. */
export type WindowsUserTaskOptions = Omit<ServiceInstallOptions, "platform">;

/** Build a Linux plan without making the caller repeat `platform: "linux"`. */
export function buildLinuxUserServiceInstallPlan(
  options: LinuxUserServiceOptions,
): ServicePlan {
  return buildServiceInstallPlan({ ...options, platform: "linux" });
}

/** Build a Windows Task Scheduler plan without making the caller repeat its platform. */
export function buildWindowsUserTaskInstallPlan(
  options: WindowsUserTaskOptions,
): ServicePlan {
  return buildServiceInstallPlan({ ...options, platform: "win32" });
}

/** Result returned by a command executor. It contains no shell interpretation. */
export interface ServiceCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

type MaybePromise<T> = T | Promise<T>;

/**
 * The only capability needed to apply a plan. Production code can adapt this
 * to `fs/promises` and `execFile`; tests provide a recorder. The module itself
 * intentionally has no default executor.
 */
export interface ServicePlanExecutor {
  readonly ensureDirectory: (path: string) => MaybePromise<void>;
  readonly writeFile: (file: ServiceFileWrite) => MaybePromise<void>;
  readonly removeFile: (file: ServiceFileRemoval) => MaybePromise<void>;
  readonly run: (command: ServiceCommand) => MaybePromise<ServiceCommandResult>;
}

/** A non-sensitive description of the step that could not be applied. */
export interface ServicePlanFailure {
  readonly stage: "ensure-directory" | "write-file" | "remove-file" | "command";
  readonly target: string;
  readonly exitCode?: number;
}

/** Outcome of applying a plan through an injected executor. */
export interface ServiceApplyResult {
  readonly ok: boolean;
  readonly plan: ServicePlan;
  readonly commandResults: readonly ServiceCommandResult[];
  /** Non-fatal failures (for example deleting an already absent service). */
  readonly warnings: readonly string[];
  readonly failure?: ServicePlanFailure;
}

function failedPlanResult(
  plan: ServicePlan,
  commandResults: readonly ServiceCommandResult[],
  warnings: readonly string[],
  failure: ServicePlanFailure,
): ServiceApplyResult {
  return { ok: false, plan, commandResults, warnings, failure };
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function commandOutput(result: ServiceCommandResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

function isVerifiedMissingService(
  platform: CanonicalServicePlatform,
  command: ServiceCommand,
  result: ServiceCommandResult,
): boolean {
  const output = commandOutput(result);

  if (platform === "linux") {
    const serviceId = command.args[command.args.length - 1];
    if (serviceId === undefined) {
      return false;
    }
    const escapedServiceId = serviceId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(
      `\\bunit(?:\\s+file)?\\s+["']?${escapedServiceId}["']?\\s+(?:not found|does not exist|not loaded)\\b`,
      "iu",
    ).test(output);
  }

  if (
    command.id === "task-stop" &&
    /\b(?:the )?(?:scheduled )?task(?: [^\r\n]*)? is not(?: currently)? running\b/iu.test(
      output,
    )
  ) {
    return true;
  }

  return (
    /\berror:\s*the system cannot find the (?:file|path) specified\b/iu.test(
      output,
    ) ||
    /\berror:\s*the specified task name [^\r\n]+ does not exist in the system\b/iu.test(
      output,
    )
  );
}

/**
 * Apply an already-built plan in its declared order. A stop/delete command
 * marked `before-file-removal` runs before its definition disappears; all other
 * commands run after writes/removals. Required command failures stop the
 * operation immediately. Uninstall cleanup is idempotent only for an explicit
 * native "service not found" response or an `ENOENT` file removal; real native
 * and filesystem failures remain failures.
 * Any executor exception becomes a typed failed result instead of escaping
 * through a CLI command handler.
 */
export async function applyServicePlan(
  plan: ServicePlan,
  executor: ServicePlanExecutor,
): Promise<ServiceApplyResult> {
  const commandResults: ServiceCommandResult[] = [];
  const warnings: string[] = [];

  for (const directory of plan.directories) {
    try {
      await executor.ensureDirectory(directory);
    } catch {
      return failedPlanResult(plan, commandResults, warnings, {
        stage: "ensure-directory",
        target: directory,
      });
    }
  }

  for (const file of plan.filesToWrite) {
    try {
      await executor.writeFile(file);
    } catch {
      return failedPlanResult(plan, commandResults, warnings, {
        stage: "write-file",
        target: file.path,
      });
    }
  }

  const runCommand = async (
    command: ServiceCommand,
  ): Promise<ServiceApplyResult | undefined> => {
    let result: ServiceCommandResult;
    try {
      result = await executor.run(command);
    } catch {
      if (command.allowFailure === true) {
        warnings.push(`Optional command ${command.id} could not be run.`);
        return undefined;
      }
      return failedPlanResult(plan, commandResults, warnings, {
        stage: "command",
        target: command.id,
      });
    }
    commandResults.push(result);
    if (result.exitCode === 0) {
      return undefined;
    }
    if (
      plan.action === "uninstall" &&
      command.allowMissingService === true &&
      isVerifiedMissingService(plan.platform, command, result)
    ) {
      warnings.push(
        `Service was already absent while running ${command.id}; continuing cleanup.`,
      );
      return undefined;
    }
    if (command.allowFailure === true) {
      warnings.push(
        `Optional command ${command.id} exited with code ${result.exitCode}.`,
      );
      return undefined;
    }
    return failedPlanResult(plan, commandResults, warnings, {
      stage: "command",
      target: command.id,
      exitCode: result.exitCode,
    });
  };

  for (const command of plan.commands) {
    if (command.phase !== "before-file-removal") {
      continue;
    }
    const failed = await runCommand(command);
    if (failed !== undefined) {
      return failed;
    }
  }

  for (const file of plan.filesToRemove) {
    try {
      await executor.removeFile(file);
    } catch (error: unknown) {
      if (file.allowMissing && isMissingFileError(error)) {
        warnings.push(`Service definition was already absent at ${file.path}.`);
        continue;
      }
      return failedPlanResult(plan, commandResults, warnings, {
        stage: "remove-file",
        target: file.path,
      });
    }
  }

  for (const command of plan.commands) {
    if (command.phase === "before-file-removal") {
      continue;
    }
    const failed = await runCommand(command);
    if (failed !== undefined) {
      return failed;
    }
  }

  return { ok: true, plan, commandResults, warnings };
}

/** Build and apply an install plan through the caller-provided executor. */
export async function installService(
  options: ServiceInstallOptions,
  executor: ServicePlanExecutor,
): Promise<ServiceApplyResult> {
  return applyServicePlan(buildServiceInstallPlan(options), executor);
}

/** Build and apply an uninstall plan through the caller-provided executor. */
export async function uninstallService(
  identity: ServiceIdentity,
  executor: ServicePlanExecutor,
): Promise<ServiceApplyResult> {
  return applyServicePlan(buildServiceUninstallPlan(identity), executor);
}

/** Linux-specific installer helper. It still only uses the supplied executor. */
export async function installLinuxUserService(
  options: LinuxUserServiceOptions,
  executor: ServicePlanExecutor,
): Promise<ServiceApplyResult> {
  return applyServicePlan(buildLinuxUserServiceInstallPlan(options), executor);
}

/** Windows-specific installer helper. It still only uses the supplied executor. */
export async function installWindowsUserTask(
  options: WindowsUserTaskOptions,
  executor: ServicePlanExecutor,
): Promise<ServiceApplyResult> {
  return applyServicePlan(buildWindowsUserTaskInstallPlan(options), executor);
}

/** High-level runtime state, deliberately preserving unknown values. */
export type ServiceRuntimeState =
  "running" | "stopped" | "failed" | "not-installed" | "unknown";

/** Parsed state independent of a particular platform service name. */
export interface ServiceStatusSnapshot {
  readonly installed: boolean | null;
  readonly enabled: boolean | null;
  readonly active: boolean | null;
  readonly state: ServiceRuntimeState;
  readonly detail: string;
}

/** A named status snapshot returned by {@link getServiceStatus}. */
export interface ServiceStatus extends ServiceStatusSnapshot {
  readonly platform: CanonicalServicePlatform;
  readonly serviceName: string;
}

function statusSnapshot(
  installed: boolean | null,
  enabled: boolean | null,
  active: boolean | null,
  state: ServiceRuntimeState,
  detail: string,
): ServiceStatusSnapshot {
  return { installed, enabled, active, state, detail };
}

function systemdProperty(
  stdout: string,
  name: string,
  position: number,
): string | undefined {
  const keyed = new RegExp(`^${name}=(.*)$`, "mu").exec(stdout);
  if (keyed?.[1] !== undefined) {
    return keyed[1].trim();
  }
  const values = stdout.split(/\r?\n/u);
  return values[position]?.trim();
}

/** Parse the output of the `systemctl --user show ... --value` status command. */
export function parseLinuxUserServiceStatus(
  result: ServiceCommandResult,
): ServiceStatusSnapshot {
  const loadState = systemdProperty(result.stdout, "LoadState", 0);
  const activeState = systemdProperty(result.stdout, "ActiveState", 1);
  const subState = systemdProperty(result.stdout, "SubState", 2);
  const unitFileState = systemdProperty(result.stdout, "UnitFileState", 3);
  const detail = [
    loadState !== undefined ? `LoadState=${loadState}` : undefined,
    activeState !== undefined ? `ActiveState=${activeState}` : undefined,
    subState !== undefined ? `SubState=${subState}` : undefined,
    unitFileState !== undefined ? `UnitFileState=${unitFileState}` : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join("; ");

  if (loadState === "not-found") {
    return statusSnapshot(false, false, false, "not-installed", detail);
  }
  if (loadState !== "loaded") {
    return statusSnapshot(
      null,
      null,
      null,
      "unknown",
      detail || "No systemd state.",
    );
  }

  const enabled =
    unitFileState === "enabled" || unitFileState === "enabled-runtime"
      ? true
      : unitFileState === "disabled" || unitFileState === "masked"
        ? false
        : null;
  if (activeState === "active") {
    return statusSnapshot(true, enabled, true, "running", detail);
  }
  if (activeState === "failed") {
    return statusSnapshot(true, enabled, false, "failed", detail);
  }
  if (activeState === "inactive" || activeState === "deactivating") {
    return statusSnapshot(true, enabled, false, "stopped", detail);
  }
  return statusSnapshot(
    true,
    enabled,
    null,
    "unknown",
    detail || "No active state.",
  );
}

function listField(stdout: string, name: string): string | undefined {
  const expression = new RegExp(`^${name}:\\s*(.+?)\\s*$`, "imu");
  return expression.exec(stdout)?.[1]?.trim();
}

/**
 * Parse the locale-neutral marker emitted by {@link windowsTaskStatusScript}.
 * The English `schtasks` parser remains as a compatibility fallback for callers
 * that persisted or inject legacy output in tests/integrations.
 */
export function parseWindowsUserTaskStatus(
  result: ServiceCommandResult,
): ServiceStatusSnapshot {
  const combined = `${result.stdout}\n${result.stderr}`;
  if (/^CFLS_TASK_NOT_FOUND\s*$/mu.test(combined)) {
    return statusSnapshot(
      false,
      false,
      false,
      "not-installed",
      "Task was not found.",
    );
  }
  const marker = /^CFLS_TASK_STATE=(\d+);ENABLED=([01])\s*$/mu.exec(
    result.stdout,
  );
  if (result.exitCode === 0 && marker !== null) {
    const taskState = Number.parseInt(marker[1]!, 10);
    const enabled = marker[2] === "1";
    const detail = `TaskState=${taskState}; Enabled=${enabled}`;
    // Microsoft.Management.Infrastructure.TaskState:
    // 0 Unknown, 1 Disabled, 2 Queued, 3 Ready, 4 Running.
    if (taskState === 4) {
      return statusSnapshot(true, enabled, true, "running", detail);
    }
    if (taskState === 1) {
      return statusSnapshot(true, false, false, "stopped", detail);
    }
    if (taskState === 2 || taskState === 3) {
      return statusSnapshot(true, enabled, false, "stopped", detail);
    }
    return statusSnapshot(true, enabled, null, "unknown", detail);
  }
  if (
    result.exitCode !== 0 &&
    /cannot find|does not exist|cannot locate/iu.test(combined)
  ) {
    return statusSnapshot(
      false,
      false,
      false,
      "not-installed",
      "Task was not found.",
    );
  }
  if (result.exitCode !== 0) {
    return statusSnapshot(null, null, null, "unknown", "Task query failed.");
  }

  const status = listField(result.stdout, "Status")?.toLowerCase();
  const taskState = listField(
    result.stdout,
    "Scheduled Task State",
  )?.toLowerCase();
  const enabled =
    taskState === "enabled" ? true : taskState === "disabled" ? false : null;
  const detail = [
    status !== undefined ? `Status=${status}` : undefined,
    taskState !== undefined ? `Scheduled Task State=${taskState}` : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join("; ");

  if (status === "running") {
    return statusSnapshot(true, enabled, true, "running", detail);
  }
  if (status === "ready" || status === "disabled") {
    return statusSnapshot(
      true,
      enabled ?? status !== "disabled",
      false,
      "stopped",
      detail,
    );
  }
  if (status === "failed") {
    return statusSnapshot(true, enabled, false, "failed", detail);
  }
  return statusSnapshot(
    true,
    enabled,
    null,
    "unknown",
    detail || "No task status.",
  );
}

/**
 * Query a native service manager through an injected executor and normalize the
 * result. A failed query becomes `unknown` unless the manager explicitly
 * reports that the task/unit does not exist.
 */
export async function getServiceStatus(
  identity: ServiceIdentity,
  executor: Pick<ServicePlanExecutor, "run">,
): Promise<ServiceStatus> {
  const plan = buildServiceStatusPlan(identity);
  const command = plan.commands[0];
  if (command === undefined) {
    // Kept as a defensive guard if a future platform gains a malformed plan.
    return {
      platform: plan.platform,
      serviceName: plan.serviceName,
      ...statusSnapshot(null, null, null, "unknown", "No status command."),
    };
  }

  try {
    const result = await executor.run(command);
    const snapshot =
      plan.platform === "linux"
        ? parseLinuxUserServiceStatus(result)
        : parseWindowsUserTaskStatus(result);
    return {
      platform: plan.platform,
      serviceName: plan.serviceName,
      ...snapshot,
    };
  } catch {
    return {
      platform: plan.platform,
      serviceName: plan.serviceName,
      ...statusSnapshot(
        null,
        null,
        null,
        "unknown",
        "Status command could not be run.",
      ),
    };
  }
}
