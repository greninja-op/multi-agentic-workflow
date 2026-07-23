/**
 * Markup for the CFLS team coordination panel.
 *
 * The interactive renderer lives in `media/team-panel.js`, served through a
 * VS Code webview resource URI. Keeping it external is important: some VS Code
 * webviews refuse inline scripts even when a nonce is supplied. The initial
 * roster remains server-rendered, so the panel is still useful if a webview
 * engine is degraded.
 */

import type { CoordinationViewModel } from "./view-model";
import type { LocalDiffPreview } from "./local-diff-preview";

/** Local-only state supplied by the VS Code adapter, never by the host. */
export interface TeamPanelLocalState {
  selfMemberId: string;
  localDiffPreview?: LocalDiffPreview;
}

/** Webview-scoped locations created by the VS Code adapter. */
export interface TeamPanelAssets {
  scriptUri: string;
  cspSource: string;
}

/** Serialize state safely for an inert JSON script element. */
function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** Escape text emitted into the initial no-script panel state. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function connectionLabel(state: "connected" | "offline" | "unknown"): string {
  return state === "connected"
    ? "Connected"
    : state === "offline"
      ? "Offline"
      : "Roster pending";
}

/** Render a usable roster before the external renderer has loaded. */
function initialRosterHtml(viewModel: CoordinationViewModel): string {
  if (viewModel.members.length === 0) {
    return '<div class="empty">No team members are currently visible.</div>';
  }
  return viewModel.members
    .map((member) => {
      const initials = Array.from(member.memberId || "?")
        .slice(0, 2)
        .join("")
        .toUpperCase();
      const activity = member.activityKnown
        ? `${member.files.length} active file${member.files.length === 1 ? "" : "s"}`
        : "No activity reported";
      return `<div class="member fallback-member" aria-label="${escapeHtml(member.memberId)}"><span class="avatar">${escapeHtml(initials)}</span><span style="min-width:0"><span class="member-name">${escapeHtml(member.memberId)}</span><span class="member-meta">${escapeHtml(connectionLabel(member.connectionState))} · ${escapeHtml(activity)}</span></span></div>`;
    })
    .join("");
}

/** Render current declared work even if the webview script cannot load. */
function initialDetailHtml(viewModel: CoordinationViewModel): string {
  const member = viewModel.members[0];
  if (member === undefined) {
    return '<div class="empty">Live roster members and their activity appear here in real time.</div>';
  }
  const tasks = member.tasks.length
    ? member.tasks
        .map((task) => {
          const paths = [
            ...task.modifyPaths.map((path) => `Modify: ${path}`),
            ...task.createPaths.map((path) => `Create: ${path}`),
          ];
          return `<article class="card"><div class="card-title">${escapeHtml(task.description || "Undescribed coordination task")}</div><div class="card-body">${escapeHtml(paths.join("\n") || "No paths recorded.")}</div></article>`;
        })
        .join("")
    : '<div class="empty">No declared work reported yet.</div>';
  const files = member.files.length
    ? member.files
        .map((file) => `<div class="file-row"><code>${escapeHtml(file.path)}</code></div>`)
        .join("")
    : '<div class="empty">No active files reported yet.</div>';
  return `<h2>${escapeHtml(member.memberId)}</h2><div class="subtle">${escapeHtml(connectionLabel(member.connectionState))} · ${member.activityKnown ? "Activity reported" : "No activity reported"}</div><div class="section"><h3>Declared work</h3>${tasks}</div><div class="section"><h3>Current files</h3>${files}</div>`;
}

/** Build the team panel document and attach the externally packaged renderer. */
export function buildTeamPanelHtml(
  viewModel: CoordinationViewModel,
  teamName: string,
  localState: TeamPanelLocalState = { selfMemberId: "self" },
  assets?: TeamPanelAssets,
): string {
  const initialState = safeJson({ viewModel, teamName, ...localState });
  const initialRoster = initialRosterHtml(viewModel);
  const initialDetail = initialDetailHtml(viewModel);
  const csp =
    assets === undefined
      ? "default-src 'none'; style-src 'unsafe-inline'; script-src 'none';"
      : `default-src 'none'; style-src 'unsafe-inline'; script-src ${assets.cspSource};`;
  const renderer =
    assets === undefined
      ? ""
      : `<script src="${escapeHtml(assets.scriptUri)}"></script>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>CFLS Team Coordination</title>
  <style>
    :root { color-scheme: light dark; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: var(--vscode-editor-background); }
    .header { display: flex; align-items: center; gap: 10px; padding: 18px 22px; border-bottom: 1px solid var(--vscode-panel-border); background: linear-gradient(110deg, color-mix(in srgb, var(--vscode-editor-background) 88%, #4d9fff), var(--vscode-editor-background)); }
    .mark { width: 30px; height: 30px; flex: none; } .title { min-width: 0; } h1 { margin: 0; font-size: 16px; font-weight: 700; }
    .subtle { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .state { margin-left: auto; font-size: 12px; padding: 4px 8px; border-radius: 999px; border: 1px solid var(--vscode-panel-border); } .state.offline { color: var(--vscode-errorForeground); } .state.stale { color: var(--vscode-editorWarning-foreground); }
    .layout { display: grid; grid-template-columns: minmax(190px, 30%) minmax(0, 1fr); min-height: calc(100vh - 71px); } .members { border-right: 1px solid var(--vscode-panel-border); padding: 14px 10px; } .members-label { color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 700; letter-spacing: .08em; margin: 0 8px 8px; text-transform: uppercase; }
    .member { appearance: none; border: 1px solid transparent; background: transparent; color: inherit; cursor: pointer; display: flex; gap: 9px; align-items: center; text-align: left; width: 100%; padding: 9px; border-radius: 6px; font: inherit; } .member:hover, .member.selected { background: var(--vscode-list-hoverBackground); border-color: var(--vscode-focusBorder); } .fallback-member { cursor: default; }
    .avatar { align-items: center; background: var(--vscode-button-secondaryBackground); border-radius: 50%; display: inline-flex; flex: none; font-size: 12px; font-weight: 700; height: 26px; justify-content: center; width: 26px; } .member-name { display: block; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .member-meta { display: block; color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 2px; }
    .detail { padding: 22px; } .detail h2 { font-size: 18px; margin: 0 0 4px; } .section { margin-top: 24px; } .section h3 { color: var(--vscode-descriptionForeground); font-size: 11px; letter-spacing: .08em; margin: 0 0 8px; text-transform: uppercase; }
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 7px; margin-bottom: 8px; overflow: hidden; } .card-title { font-size: 13px; font-weight: 600; padding: 9px 11px 0; } .card-body { color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.5; padding: 4px 11px 10px; white-space: pre-wrap; }
    .file-row { align-items: center; display: flex; gap: 8px; min-height: 32px; padding: 7px 10px; border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 65%, transparent); } .file-row:last-child { border-bottom: 0; } code { color: var(--vscode-textLink-foreground); font-family: var(--vscode-editor-font-family); font-size: 12px; overflow-wrap: anywhere; } .roles { display: flex; flex-wrap: wrap; gap: 4px; margin-left: auto; } .tag { background: var(--vscode-badge-background); border-radius: 10px; color: var(--vscode-badge-foreground); font-size: 10px; padding: 2px 6px; }
    .empty { color: var(--vscode-descriptionForeground); font-size: 13px; line-height: 1.55; padding: 15px 8px; } .privacy { background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 10%, transparent); border-left: 3px solid var(--vscode-editorWarning-foreground); color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.5; padding: 10px 12px; }
    .diff-card { border: 1px solid var(--vscode-panel-border); border-radius: 7px; overflow: hidden; } .diff-meta { color: var(--vscode-descriptionForeground); font-size: 11px; padding: 8px 10px; border-bottom: 1px solid var(--vscode-panel-border); } .diff-preview { background: var(--vscode-textCodeBlock-background); font-family: var(--vscode-editor-font-family); font-size: 11px; line-height: 1.5; margin: 0; overflow-x: auto; padding: 6px 0; } .diff-line { display: grid; grid-template-columns: 22px minmax(0, 1fr); min-width: max-content; padding: 1px 10px; white-space: pre; } .diff-line.added { background: color-mix(in srgb, var(--vscode-testing-iconPassed) 16%, transparent); } .diff-line.removed { background: color-mix(in srgb, var(--vscode-testing-iconFailed) 16%, transparent); } .diff-prefix { color: var(--vscode-descriptionForeground); user-select: none; } .diff-line.added .diff-prefix { color: var(--vscode-testing-iconPassed); } .diff-line.removed .diff-prefix { color: var(--vscode-testing-iconFailed); }
    @media (max-width: 560px) { .layout { grid-template-columns: 1fr; } .members { border-bottom: 1px solid var(--vscode-panel-border); border-right: 0; } }
  </style>
</head>
<body>
  <header class="header"><svg class="mark" viewBox="0 0 32 32" aria-label="CFLS logo" role="img"><path fill="#62e6e0" d="M16 2 29 9.5v13L16 30 3 22.5v-13L16 2Zm0 5.1L7.5 12v8L16 24.9l8.5-4.9v-8L16 7.1Z"/><path fill="#d6f54a" d="M14 11h8v3h-5v4h4v3h-7V11Z"/></svg><div class="title"><h1 id="team-title">CFLS</h1><div class="subtle" id="team-subtitle"></div></div><div class="state" id="connection-state"></div></header>
  <main class="layout"><aside class="members"><div class="members-label">Team members</div><div id="member-list">${initialRoster}</div></aside><section class="detail" id="member-detail">${initialDetail}</section></main>
  <script id="cfls-initial-state" type="application/json">${initialState}</script>
  ${renderer}
</body>
</html>`;
}
