/**
 * The thin `vscode` adapter (task 11.1–11.4 wiring; design §3.5).
 *
 * This is the ONLY module that imports the `vscode` API. It translates VS Code
 * events into the pure {@link EditorEvent} stream ({@link VsCodeEditorHost}),
 * renders a {@link CoordinationViewModel} into a status-bar indicator
 * ({@link StatusBarRenderer}), and reads the Local_API connection settings. All
 * coordination logic lives in the pure modules, so the test suite runs under
 * vitest without the VS Code runtime.
 */

import type { RiskLevel } from "@cfls/protocol";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import * as vscode from "vscode";

import {
  ALL_SOFT_CONFIG,
  parseRulesConfig,
  type RepositoryRulesConfig,
} from "@cfls/core-state";

import {
  ActiveEditorPathTracker,
  EmitterEditorHost,
  type EditorEvent,
  type EditorEventKind,
  type EditorHost,
} from "./editor-host";
import {
  resolveLocalApiSettings,
  type LocalApiSettings,
  type RawLocalApiConfig,
} from "./local-api-settings";
import {
  buildHoverMarkdown,
  buildStatusTooltip,
  decorateForPath,
  fileBadgeForPath,
} from "./presence-ui";
import { buildTeamPanelHtml, type TeamPanelLocalState } from "./team-panel";
import {
  buildLocalDiffPreview,
  type LocalDiffPreview,
} from "./local-diff-preview";
import type { CoordinationViewModel } from "./view-model";

export type { LocalApiSettings } from "./local-api-settings";

/**
 * The small structural subset of VS Code's subscription collection that the
 * adapter needs. Keeping this structural lets `index.ts` use the UI controller
 * without importing the `vscode` module itself.
 */
export interface SubscriptionCollection {
  push(...disposables: Array<{ dispose(): void }>): unknown;
}

/**
 * The extension-context shape consumed by the adapter wiring. It deliberately
 * exposes only subscriptions, so the entrypoint can stay free of a `vscode`
 * import while still accepting VS Code's real ExtensionContext at runtime.
 */
export interface VsCodeExtensionContext {
  subscriptions: SubscriptionCollection;
  /** Root of the installed extension; used for CSP-safe webview assets. */
  extensionUri?: vscode.Uri;
}

/** Options shared by the status bar and richer editor coordination cues. */
export interface CoordinationUiOptions {
  /** The local member id; never show this member as someone else coordinating. */
  selfMemberId?: string;
  /** Root of this extension's packaged resources. */
  extensionUri?: vscode.Uri;
}

/** The current extension member id until per-device identities are wired in. */
const DEFAULT_SELF_MEMBER_ID = "self";

/**
 * Risk colours deliberately use the same language in the editor and Explorer:
 * soft is informational blue, coordination-required is amber, and hard is red.
 */
const RISK_PRESENTATION: Record<
  RiskLevel,
  { editorColor: string; editorBackground: string; themeColor: string }
> = {
  soft: {
    editorColor: "#4d9fff",
    editorBackground: "rgba(77, 159, 255, 0.08)",
    themeColor: "charts.blue",
  },
  "coordination-required": {
    editorColor: "#d99a22",
    editorBackground: "rgba(217, 154, 34, 0.10)",
    themeColor: "problemsWarningIcon.foreground",
  },
  hard: {
    editorColor: "#e05252",
    editorBackground: "rgba(224, 82, 82, 0.10)",
    themeColor: "problemsErrorIcon.foreground",
  },
};

/**
 * Load the team's committed Repository_Rules_Config from
 * `<workspaceFolder>/.coordination/rules.json` so cooperative hard-stop and the
 * risk view resolve path modes exactly as the agent does (Req 15). A missing or
 * malformed file yields the fail-safe all-soft config (Req 15.5) — a broken
 * rules file never silently escalates a path to hard/coordination-required.
 */
export function readRepositoryRules(): RepositoryRulesConfig {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceFolder === undefined) {
    return ALL_SOFT_CONFIG;
  }
  const rulesPath = join(workspaceFolder, ".coordination", "rules.json");
  if (!existsSync(rulesPath)) {
    return ALL_SOFT_CONFIG;
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(rulesPath, "utf8"));
    return parseRulesConfig(raw).config;
  } catch {
    // Present-but-unreadable rules file → fail safe to all-soft (Req 15.5).
    return ALL_SOFT_CONFIG;
  }
}

/**
 * Read the extension's Local_API settings from VS Code configuration, falling
 * back to the `cfls agent` discovery file when no token is configured.
 */
export function readLocalApiSettings(): LocalApiSettings {
  const config = vscode.workspace.getConfiguration("cfls");
  const raw: RawLocalApiConfig = {
    url: config.get<string>("localApi.url", "ws://127.0.0.1:8750"),
    token: config.get<string>("localApi.token", ""),
    heartbeatIntervalMs: config.get<number>("heartbeat.intervalMs", 10_000),
  };
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return resolveLocalApiSettings(raw, workspaceFolder);
}

/**
 * Convert a URI inside the configured repository root to a repository-relative
 * path. External/untitled/other-workspace documents deliberately return
 * `undefined`: their paths must never become collaboration metadata.
 */
export function toRepoRelativePath(uri: vscode.Uri): string | undefined {
  const root = vscode.workspace.workspaceFolders?.[0];
  const containingFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (
    root === undefined ||
    containingFolder === undefined ||
    containingFolder.uri.toString() !== root.uri.toString()
  ) {
    return undefined;
  }
  const relativePath = vscode.workspace.asRelativePath(uri, false);
  // `asRelativePath` returns an absolute path for a URI outside the workspace;
  // keep an explicit belt-and-suspenders check in case a VS Code host provides
  // a nonstandard workspace-folder implementation.
  if (
    relativePath === "" ||
    relativePath === "." ||
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("..\\") ||
    /^(?:[A-Za-z]:[\\/]|[\\/])/u.test(relativePath)
  ) {
    return undefined;
  }
  return relativePath;
}

/** The small, VS Code-independent shape used by extension notification calls. */
export interface NotificationOptions {
  modal?: boolean;
  detail?: string;
}

/** Register a save observer and expose only its repository-relative path. */
export function onWillSaveTextDocument(
  listener: (path: string) => void,
): vscode.Disposable {
  return vscode.workspace.onWillSaveTextDocument((event) => {
    const path = toRepoRelativePath(event.document.uri);
    if (path !== undefined) {
      listener(path);
    }
  });
}

/** Register a no-argument command without leaking the VS Code API to callers. */
export function registerCommand(
  command: string,
  callback: () => void,
): vscode.Disposable {
  return vscode.commands.registerCommand(command, callback);
}

/** Surface a deliberate blocking coordination error through VS Code. */
export function showErrorMessage(message: string): void {
  void vscode.window.showErrorMessage(message);
}

/** Surface a non-blocking coordination warning through VS Code. */
export function showWarningMessage(message: string): void {
  void vscode.window.showWarningMessage(message);
}

/** Surface an explicit, user-requested coordination detail message. */
export function showInformationMessage(
  message: string,
  options?: NotificationOptions,
): void {
  if (options === undefined) {
    void vscode.window.showInformationMessage(message);
    return;
  }
  void vscode.window.showInformationMessage(message, options);
}

/** Execute the installed standalone client without using a shell. */
function runCfls(
  executable: string,
  args: readonly string[],
  cwd: string,
): Promise<string> {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile(
      executable,
      [...args],
      { cwd, encoding: "utf8", windowsHide: true, timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error === null) {
          resolveCommand(stdout);
          return;
        }
        const detail = stderr.trim() || stdout.trim() || error.message;
        rejectCommand(new Error(detail));
      },
    );
  });
}

/** Prefer the installer locations, with an explicit setting for custom installs. */
function findCflsClient(): string {
  const configured = vscode.workspace
    .getConfiguration("cfls")
    .get<string>("clientPath", "")
    .trim();
  if (configured !== "") return configured;
  const installed =
    process.platform === "win32"
      ? join(
          process.env["LOCALAPPDATA"] ?? homedir(),
          "CFLS",
          "bin",
          "cfls.exe",
        )
      : join(homedir(), ".local", "bin", "cfls");
  return existsSync(installed) ? installed : "cfls";
}

function pairingCodeFromOutput(output: string): string | undefined {
  const match = /^CFLS_PAIR_CODE=(\d{8})$/mu.exec(output);
  return match?.[1];
}

/**
 * One-click, demo-only pairing for the current workspace. The extension talks
 * only to the installed local client; that client obtains a normal signed
 * invitation from the relay and then installs the existing per-user service.
 */
export async function setUpDemoWorkspace(): Promise<void> {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspace === undefined) {
    throw new Error(
      "Open the project folder in VS Code before setting up CFLS.",
    );
  }
  const choice = await vscode.window.showQuickPick(
    [
      {
        label: "Create a pairing code",
        description:
          "Use this on the first laptop, then share its 8-digit code.",
        action: "host" as const,
      },
      {
        label: "Join with a pairing code",
        description:
          "Use this on the second laptop after the first creates a code.",
        action: "join" as const,
      },
    ],
    {
      title: "CFLS demo setup",
      placeHolder: "Choose how this computer joins the demo",
    },
  );
  if (choice === undefined) return;
  const memberName = await vscode.window.showInputBox({
    title: "CFLS display name (optional)",
    prompt:
      "For example, Alice. Leave blank to use this device's generated name.",
    validateInput: (value) =>
      /[\u0000-\u001f\u007f]/u.test(value) || value.trim().length > 64
        ? "Use up to 64 normal characters."
        : undefined,
  });
  if (memberName === undefined) return;
  let code: string | undefined;
  if (choice.action === "join") {
    code = await vscode.window.showInputBox({
      title: "Enter the 8-digit CFLS pairing code",
      ignoreFocusOut: true,
      validateInput: (value) =>
        /^\d{8}$/u.test(value.trim()) ? undefined : "Enter exactly 8 digits.",
    });
    if (code === undefined) return;
  }
  const executable = findCflsClient();
  const pairingArgs = [
    choice.action === "host" ? "demo-host" : "demo-join",
    ...(code === undefined ? [] : [code.trim()]),
    ...(memberName.trim() === "" ? [] : ["--name", memberName.trim()]),
  ];
  const output = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "CFLS is connecting this workspace…",
      cancellable: false,
    },
    async () => {
      const pairOutput = await runCfls(executable, pairingArgs, workspace);
      await runCfls(
        executable,
        ["service", "install", "--workspace", workspace],
        workspace,
      );
      return pairOutput;
    },
  );
  if (choice.action === "host") {
    const pairingCode = pairingCodeFromOutput(output);
    if (pairingCode === undefined) {
      throw new Error(
        "CFLS paired this laptop but did not return a usable pairing code.",
      );
    }
    await vscode.env.clipboard.writeText(pairingCode);
    void vscode.window.showInformationMessage(
      `CFLS pairing code: ${pairingCode} — copied. Enter it on the second laptop within 10 minutes.`,
      { modal: true },
    );
    return;
  }
  void vscode.window.showInformationMessage(
    "CFLS is connected. The background service is running for this folder.",
  );
}

/**
 * A {@link EditorHost} that bridges VS Code workspace/window events to the pure
 * {@link EditorEvent} stream. Registers its VS Code listeners on construction and
 * releases them on {@link dispose}.
 */
export class VsCodeEditorHost implements EditorHost {
  private readonly emitter = new EmitterEditorHost();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly activeEditor = new ActiveEditorPathTracker();
  private disposed = false;

  constructor() {
    this.wire();
  }

  onEditorEvent(listener: (event: EditorEvent) => void): () => void {
    return this.emitter.onEditorEvent(listener);
  }

  /**
   * Return the latest active-editor state for a newly authenticated Local_API
   * client. This is a current-state reassertion, not buffered offline activity:
   * it lets the agent correct any durable editor scope after startup/reconnect.
   */
  currentActiveEditorEvent(): EditorEvent {
    return {
      kind: "active_editor_changed",
      activeEditorSnapshot: true,
      at: Date.now(),
      ...this.activeEditor.currentState(),
    };
  }

  private fire(
    kind: EditorEventKind,
    uri?: vscode.Uri,
    oldUri?: vscode.Uri,
  ): void {
    const path = uri === undefined ? undefined : toRepoRelativePath(uri);
    const oldPath =
      oldUri === undefined ? undefined : toRepoRelativePath(oldUri);
    // A rename is valid only when both sides belong to this exact workspace;
    // for every other path-bearing event, omit it rather than leaking an
    // external filesystem path to the local agent/host.
    if (
      (uri !== undefined && path === undefined) ||
      (oldUri !== undefined && oldPath === undefined)
    ) {
      return;
    }
    this.emit(kind, path, oldPath);
  }

  /** Emit a path payload already proven repository-relative by this adapter. */
  private emit(kind: EditorEventKind, path?: string, oldPath?: string): void {
    const event: EditorEvent = {
      kind,
      at: Date.now(),
      ...(path !== undefined ? { path } : {}),
      ...(oldPath !== undefined ? { oldPath } : {}),
    };
    this.emitter.emit(event);
  }

  /**
   * Publish the active repository document, including the previous path on a
   * tab switch. A non-repository/undefined editor deliberately becomes an
   * `oldPath`-only transition so the agent can retire the prior repository
   * file without receiving an external path.
   */
  private publishActiveEditor(editor: vscode.TextEditor | undefined): void {
    const path =
      editor === undefined
        ? undefined
        : toRepoRelativePath(editor.document.uri);
    const transition = this.activeEditor.setActive(path);
    if (transition !== undefined) {
      this.emit("active_editor_changed", transition.path, transition.oldPath);
    }
  }

  private wire(): void {
    // workspace_opened: fire once for the currently open workspace.
    if (vscode.workspace.workspaceFolders !== undefined) {
      queueMicrotask(() => {
        if (!this.disposed) {
          this.fire("workspace_opened");
        }
      });
    }
    // `onDidChangeActiveTextEditor` does not replay the document already open
    // when onStartupFinished activation runs. Queue this after construction so
    // the entrypoint has attached its forwarder, then publish the current
    // repository file exactly once.
    queueMicrotask(() => {
      if (!this.disposed) {
        this.publishActiveEditor(vscode.window.activeTextEditor);
      }
    });
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.fire("workspace_opened");
        this.publishActiveEditor(vscode.window.activeTextEditor);
      }),
      vscode.workspace.onDidOpenTextDocument((doc) =>
        this.fire("file_opened", doc.uri),
      ),
      vscode.window.onDidChangeActiveTextEditor((editor) =>
        this.publishActiveEditor(editor),
      ),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length > 0) {
          this.fire("editing_started", e.document.uri);
        }
      }),
      vscode.workspace.onDidSaveTextDocument((doc) =>
        this.fire("file_saved", doc.uri),
      ),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        const transition = this.activeEditor.clearIfActive(
          toRepoRelativePath(doc.uri),
        );
        if (transition !== undefined) {
          this.emit(
            "active_editor_changed",
            transition.path,
            transition.oldPath,
          );
        }
        this.fire("file_closed", doc.uri);
      }),
      vscode.workspace.onDidRenameFiles((e) => {
        for (const f of e.files) {
          const transition = this.activeEditor.rename(
            toRepoRelativePath(f.oldUri),
            toRepoRelativePath(f.newUri),
          );
          if (transition !== undefined) {
            this.emit(
              "active_editor_changed",
              transition.path,
              transition.oldPath,
            );
          }
          this.fire("file_renamed", f.newUri, f.oldUri);
        }
      }),
      vscode.workspace.onDidDeleteFiles((e) => {
        for (const uri of e.files) {
          const transition = this.activeEditor.clearIfActive(
            toRepoRelativePath(uri),
          );
          if (transition !== undefined) {
            this.emit(
              "active_editor_changed",
              transition.path,
              transition.oldPath,
            );
          }
          this.fire("file_deleted", uri);
        }
      }),
    );
  }

  dispose(): void {
    this.disposed = true;
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}

/**
 * Renders the coordination view model into the small, always-visible status
 * chip. The renderer remains independently usable for backwards compatibility,
 * while {@link CoordinationUiController} owns it in the richer UI path.
 */
export class StatusBarRenderer {
  private readonly item: vscode.StatusBarItem;
  private selfMemberId: string;

  constructor(options: CoordinationUiOptions = {}) {
    this.selfMemberId = options.selfMemberId ?? DEFAULT_SELF_MEMBER_ID;
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.item.command = "cfls.showCoordinationStatus";
    this.item.show();
  }

  setSelfMemberId(selfMemberId: string): void {
    this.selfMemberId = selfMemberId;
  }

  render(vm: CoordinationViewModel): void {
    const coordinatedPaths = vm.paths.filter(
      (path) => decorateForPath(vm, path.path, this.selfMemberId) !== null,
    );
    const hasActiveCoordination =
      !vm.offline && !vm.stale && coordinatedPaths.length > 0;
    const stateIcon = vm.offline
      ? "$(cloud-offline)"
      : vm.stale
        ? "$(sync)"
        : "$(check)";
    const summary = hasActiveCoordination
      ? `${coordinatedPaths.length} file(s) in play`
      : vm.statusText;
    const team = (vm.teamId ?? "Team").trim() || "Team";
    const teamLabel = team.length > 20 ? `${team.slice(0, 19)}…` : team;
    const coordinationIcon = hasActiveCoordination ? "$(warning)" : stateIcon;
    // Keep the CFLS mark at the leading edge. The whole chip is a command, so
    // it remains obvious that clicking it opens the live team desk.
    this.item.text = `$(organization) CFLS  ${coordinationIcon}  ${teamLabel} · ${summary}`;
    this.item.command = vm.offline
      ? "cfls.setupDemo"
      : "cfls.showCoordinationStatus";
    this.item.backgroundColor = hasActiveCoordination
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;

    const tooltip = new vscode.MarkdownString(
      buildStatusTooltip(vm, this.selfMemberId),
    );
    tooltip.isTrusted = false;
    if (vm.offline) {
      tooltip.appendMarkdown(
        "\n\nClick **CFLS** to set up this workspace with a short pairing code.",
      );
    }
    this.item.tooltip = tooltip;
  }

  dispose(): void {
    this.item.dispose();
  }
}

/**
 * Explorer decorations are intentionally kept adapter-only: the pure UI layer
 * decides whether a badge exists, while this provider converts it to VS Code's
 * `FileDecoration` API and re-emits changes on every view-model refresh.
 */
class CoordinationFileDecorationProvider
  implements vscode.FileDecorationProvider, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<
    vscode.Uri | vscode.Uri[] | undefined
  >();
  private viewModel: CoordinationViewModel | undefined;

  readonly onDidChangeFileDecorations = this.emitter.event;

  constructor(private selfMemberId: string) {}

  setSelfMemberId(selfMemberId: string): void {
    if (this.selfMemberId === selfMemberId) {
      return;
    }
    this.selfMemberId = selfMemberId;
    this.emitter.fire(undefined);
  }

  setViewModel(viewModel: CoordinationViewModel | undefined): void {
    this.viewModel = viewModel;
    // An undefined URI asks VS Code to re-query every visible resource. This is
    // important because a refresh can remove a badge as well as add one.
    this.emitter.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== "file" || this.viewModel === undefined) {
      return undefined;
    }
    const cue = fileBadgeForPath(
      this.viewModel,
      toRepoRelativePath(uri) ?? "",
      this.selfMemberId,
    );
    if (cue === null) {
      return undefined;
    }
    return new vscode.FileDecoration(
      cue.badge,
      cue.tooltip,
      new vscode.ThemeColor(RISK_PRESENTATION[cue.riskLevel].themeColor),
    );
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/**
 * Adapter-owned in-editor coordination UI. It intentionally takes only pure
 * view-model data from the extension entrypoint; all hover, decoration, Explorer
 * and status-bar calls to the VS Code runtime stay inside this module.
 *
 * Call {@link register} once from activation, then {@link render} after each
 * view-model refresh. The controller owns all of its registration disposables.
 */
export class CoordinationUiController implements vscode.Disposable {
  readonly statusBar: StatusBarRenderer;

  private selfMemberId: string;
  private readonly decorationTypes: Record<
    RiskLevel,
    vscode.TextEditorDecorationType
  >;
  private readonly fileDecorationProvider: CoordinationFileDecorationProvider;
  private readonly extensionUri: vscode.Uri | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private viewModel: CoordinationViewModel | undefined;
  private decoratedEditor: vscode.TextEditor | undefined;
  private teamPanel: vscode.WebviewPanel | undefined;
  private teamName = "CFLS Team";
  /** Local, unsaved source preview; never attached to coordination metadata. */
  private localDiffPreview: LocalDiffPreview | undefined;
  private registered = false;
  private disposed = false;
  private addedToSubscriptions = false;

  constructor(options: CoordinationUiOptions = {}) {
    this.selfMemberId = options.selfMemberId ?? DEFAULT_SELF_MEMBER_ID;
    this.extensionUri = options.extensionUri;
    this.statusBar = new StatusBarRenderer({ selfMemberId: this.selfMemberId });
    this.fileDecorationProvider = new CoordinationFileDecorationProvider(
      this.selfMemberId,
    );
    this.decorationTypes = {
      soft: this.createDecorationType("soft"),
      "coordination-required": this.createDecorationType(
        "coordination-required",
      ),
      hard: this.createDecorationType("hard"),
    };
  }

  /**
   * Register the hover, active-editor and Explorer integrations. Passing
   * `context.subscriptions` is optional but recommended; it needs no `vscode`
   * import at the call site because {@link SubscriptionCollection} is structural.
   */
  register(subscriptions?: SubscriptionCollection): void {
    if (this.disposed) {
      return;
    }
    if (!this.registered) {
      this.registered = true;
      this.disposables.push(
        vscode.languages.registerHoverProvider(
          { scheme: "file" },
          {
            provideHover: (document) => this.provideHover(document),
          },
        ),
        vscode.window.registerFileDecorationProvider(
          this.fileDecorationProvider,
        ),
        vscode.window.onDidChangeActiveTextEditor(() => {
          this.applyActiveEditorDecoration();
          this.postTeamPanelState();
        }),
        vscode.workspace.onDidChangeTextDocument((event) => {
          if (event.document === vscode.window.activeTextEditor?.document) {
            this.postTeamPanelState();
          }
        }),
        vscode.workspace.onDidSaveTextDocument((document) => {
          if (document === vscode.window.activeTextEditor?.document) {
            this.postTeamPanelState();
          }
        }),
      );
    }
    if (subscriptions !== undefined && !this.addedToSubscriptions) {
      subscriptions.push(this);
      this.addedToSubscriptions = true;
    }
  }

  /**
   * Render a fresh model into every rich cue. This is safe to call on the
   * extension's two-second poll as well as on subscription updates.
   */
  render(viewModel: CoordinationViewModel): void {
    if (this.disposed) {
      return;
    }
    this.viewModel = viewModel;
    this.statusBar.render(viewModel);
    this.fileDecorationProvider.setViewModel(viewModel);
    this.applyActiveEditorDecoration();
    this.postTeamPanelState(viewModel);
  }

  /** Alias for integrations that describe a refresh as a view-model update. */
  update(viewModel: CoordinationViewModel): void {
    this.render(viewModel);
  }

  /** Update the local identity once the agent resolves it after authentication. */
  setSelfMemberId(selfMemberId: string): void {
    if (this.disposed || this.selfMemberId === selfMemberId) {
      return;
    }
    this.selfMemberId = selfMemberId;
    this.statusBar.setSelfMemberId(selfMemberId);
    this.fileDecorationProvider.setSelfMemberId(selfMemberId);
    if (this.viewModel !== undefined) {
      this.statusBar.render(this.viewModel);
      this.applyActiveEditorDecoration();
      this.postTeamPanelState();
    }
  }

  /** Open or focus the branded, live team coordination panel. */
  showTeamPanel(viewModel: CoordinationViewModel, teamName: string): void {
    if (this.disposed) {
      return;
    }
    this.teamName = teamName;
    if (this.teamPanel === undefined) {
      const panel = vscode.window.createWebviewPanel(
        "cfls.teamCoordination",
        `CFLS · ${teamName}`,
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          ...(this.extensionUri !== undefined
            ? {
                localResourceRoots: [
                  vscode.Uri.joinPath(this.extensionUri, "media"),
                ],
              }
            : {}),
        },
      );
      this.teamPanel = panel;
      const assets =
        this.extensionUri === undefined
          ? undefined
          : {
              scriptUri: panel.webview
                .asWebviewUri(
                  vscode.Uri.joinPath(
                    this.extensionUri,
                    "media",
                    "team-panel.js",
                  ),
                )
                .toString(),
              cspSource: panel.webview.cspSource,
            };
      panel.webview.html = buildTeamPanelHtml(
        viewModel,
        teamName,
        this.currentTeamPanelLocalState(),
        assets,
      );
      this.disposables.push(
        panel.onDidDispose(() => {
          if (this.teamPanel === panel) {
            this.teamPanel = undefined;
          }
        }),
      );
      return;
    }
    this.teamPanel.title = `CFLS · ${teamName}`;
    this.teamPanel.reveal(vscode.ViewColumn.Beside, true);
    this.postTeamPanelState(viewModel);
  }

  /**
   * Produce a bounded comparison only from the active local document and its
   * saved on-disk version. This stays in the extension/webview process and is
   * deliberately never merged into `CoordinationViewModel` or sent to CFLS.
   */
  private refreshLocalDiffPreview(): void {
    const document = vscode.window.activeTextEditor?.document;
    if (
      document === undefined ||
      document.uri.scheme !== "file" ||
      !document.isDirty
    ) {
      this.localDiffPreview = undefined;
      return;
    }
    const path = toRepoRelativePath(document.uri);
    if (path === undefined) {
      this.localDiffPreview = undefined;
      return;
    }
    try {
      this.localDiffPreview =
        buildLocalDiffPreview(
          path,
          readFileSync(document.uri.fsPath, "utf8"),
          document.getText(),
        ) ?? undefined;
    } catch {
      // A newly created/virtual/unreadable file has no stable saved baseline.
      this.localDiffPreview = undefined;
    }
  }

  private currentTeamPanelLocalState(): TeamPanelLocalState {
    this.refreshLocalDiffPreview();
    return {
      selfMemberId: this.selfMemberId,
      ...(this.localDiffPreview !== undefined
        ? { localDiffPreview: this.localDiffPreview }
        : {}),
    };
  }

  private postTeamPanelState(viewModel = this.viewModel): void {
    if (this.teamPanel === undefined || viewModel === undefined) {
      return;
    }
    void this.teamPanel.webview.postMessage({
      type: "team-state",
      state: {
        viewModel,
        teamName: this.teamName,
        ...this.currentTeamPanelLocalState(),
      },
    });
  }

  private createDecorationType(
    riskLevel: RiskLevel,
  ): vscode.TextEditorDecorationType {
    const presentation = RISK_PRESENTATION[riskLevel];
    return vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: presentation.editorBackground,
      overviewRulerColor: presentation.editorColor,
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      after: {
        color: presentation.editorColor,
        fontStyle: "italic",
        margin: "0 0 0 1.5em",
      },
    });
  }

  private provideHover(
    document: vscode.TextDocument,
  ): vscode.Hover | undefined {
    if (this.viewModel === undefined) {
      return undefined;
    }
    const markdown = buildHoverMarkdown(
      this.viewModel,
      toRepoRelativePath(document.uri) ?? "",
      this.selfMemberId,
    );
    if (markdown === null) {
      return undefined;
    }
    const contents = new vscode.MarkdownString(markdown);
    contents.isTrusted = false;
    return new vscode.Hover(contents);
  }

  private applyActiveEditorDecoration(): void {
    const editor = vscode.window.activeTextEditor;
    if (this.decoratedEditor !== undefined && this.decoratedEditor !== editor) {
      this.clearEditorDecoration(this.decoratedEditor);
      this.decoratedEditor = undefined;
    }
    if (editor === undefined || editor.document.uri.scheme !== "file") {
      return;
    }

    this.clearEditorDecoration(editor);
    if (this.viewModel === undefined) {
      return;
    }
    // A decoration must use a non-empty range. There is no useful first-line
    // annotation for a completely empty document, so leave it clear.
    if (editor.document.getText().length === 0) {
      return;
    }

    const cue = decorateForPath(
      this.viewModel,
      toRepoRelativePath(editor.document.uri) ?? "",
      this.selfMemberId,
    );
    if (cue === null) {
      return;
    }

    const firstLine = editor.document.lineAt(0);
    const range = firstLine.range.isEmpty
      ? firstLine.rangeIncludingLineBreak
      : firstLine.range;
    if (range.isEmpty) {
      return;
    }
    const presentation = RISK_PRESENTATION[cue.riskLevel];
    const decoration: vscode.DecorationOptions = {
      range,
      renderOptions: {
        after: {
          contentText: `  ${cue.message}`,
          color: presentation.editorColor,
          margin: "0 0 0 1.5em",
        },
      },
    };
    const hover = this.createHoverMarkdown(editor.document.uri);
    if (hover !== undefined) {
      decoration.hoverMessage = hover;
    }
    editor.setDecorations(this.decorationTypes[cue.riskLevel], [decoration]);
    this.decoratedEditor = editor;
  }

  private createHoverMarkdown(
    uri: vscode.Uri,
  ): vscode.MarkdownString | undefined {
    if (this.viewModel === undefined) {
      return undefined;
    }
    const markdown = buildHoverMarkdown(
      this.viewModel,
      toRepoRelativePath(uri) ?? "",
      this.selfMemberId,
    );
    if (markdown === null) {
      return undefined;
    }
    const contents = new vscode.MarkdownString(markdown);
    contents.isTrusted = false;
    return contents;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearActiveEditorDecoration();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.fileDecorationProvider.dispose();
    this.teamPanel?.dispose();
    this.teamPanel = undefined;
    for (const decorationType of Object.values(this.decorationTypes)) {
      decorationType.dispose();
    }
    this.statusBar.dispose();
  }

  private clearActiveEditorDecoration(): void {
    if (this.decoratedEditor === undefined) {
      return;
    }
    this.clearEditorDecoration(this.decoratedEditor);
    this.decoratedEditor = undefined;
  }

  private clearEditorDecoration(editor: vscode.TextEditor): void {
    for (const decorationType of Object.values(this.decorationTypes)) {
      editor.setDecorations(decorationType, []);
    }
  }
}
