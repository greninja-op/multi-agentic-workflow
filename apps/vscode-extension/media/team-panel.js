/* CFLS team panel renderer. Runs as a VS Code webview-local resource. */
(() => {
  "use strict";

  const stateNode = document.getElementById("cfls-initial-state");
  let state;
  try {
    state = JSON.parse(stateNode?.textContent || "{}");
  } catch {
    return;
  }
  const vscode =
    typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
  let selectedMemberId = vscode?.getState()?.selectedMemberId ?? null;
  const roleLabel = {
    editing: "editing",
    "soft-lock": "lock",
    intent: "intent",
    "planned-create": "new file",
  };
  const connectionLabel = {
    connected: "Connected",
    offline: "Offline",
    unknown: "Roster pending",
  };
  const diffPrefix = { added: "+", removed: "−", context: " " };

  const el = (tag, className) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  };
  const text = (node, value) => {
    node.textContent = String(value ?? "");
    return node;
  };
  const initials = (name) =>
    Array.from(name || "?").slice(0, 2).join("").toUpperCase();

  function render() {
    const vm = state?.viewModel;
    if (!vm) return;
    const members = vm.members || [];
    if (!members.some((member) => member.memberId === selectedMemberId)) {
      selectedMemberId = members[0]?.memberId ?? null;
    }

    text(
      document.getElementById("team-title"),
      "CFLS · " + (state.teamName || vm.teamId || "Team"),
    );
    text(
      document.getElementById("team-subtitle"),
      vm.statusText || "Waiting for coordination data",
    );
    const stateBadge = document.getElementById("connection-state");
    stateBadge.className =
      "state" + (vm.offline ? " offline" : vm.stale ? " stale" : "");
    text(stateBadge, vm.offline ? "Offline" : vm.stale ? "Stale" : "Live");

    const list = document.getElementById("member-list");
    list.replaceChildren();
    if (members.length === 0) {
      list.append(text(el("div", "empty"), "No team members are currently visible."));
    }
    for (const member of members) {
      const button = el(
        "button",
        "member" + (member.memberId === selectedMemberId ? " selected" : ""),
      );
      button.type = "button";
      button.addEventListener("click", () => {
        selectedMemberId = member.memberId;
        vscode?.setState({ selectedMemberId });
        render();
      });
      const avatar = text(el("span", "avatar"), initials(member.memberId));
      const copy = el("span");
      copy.style.minWidth = "0";
      copy.append(text(el("div", "member-name"), member.memberId));
      const activity = member.activityKnown
        ? member.files.length + " active file" + (member.files.length === 1 ? "" : "s")
        : "No activity reported";
      copy.append(
        text(
          el("div", "member-meta"),
          (connectionLabel[member.connectionState] || "Roster pending") +
            " · " +
            activity,
        ),
      );
      button.append(avatar, copy);
      list.append(button);
    }

    const detail = document.getElementById("member-detail");
    detail.replaceChildren();
    const member = members.find((item) => item.memberId === selectedMemberId);
    if (!member) {
      detail.append(
        text(
          el("div", "empty"),
          "Live roster members and their activity appear here in real time.",
        ),
      );
      return;
    }
    detail.append(text(el("h2"), member.memberId));
    const devices = member.activityKnown
      ? member.deviceIds.length
        ? member.deviceIds.join(", ")
        : "No device id reported"
      : "No activity metadata reported";
    const revision =
      member.lastEventRevision === null
        ? "No activity revision"
        : "Active entry revision " + member.lastEventRevision;
    detail.append(
      text(
        el("div", "subtle"),
        "Connection: " +
          (connectionLabel[member.connectionState] || "Roster pending") +
          " · Active devices: " +
          devices +
          " · " +
          revision,
      ),
    );

    const tasks = el("div", "section");
    tasks.append(text(el("h3"), "Declared work"));
    if (!member.tasks.length) {
      tasks.append(
        text(
          el("div", "empty"),
          member.activityKnown
            ? "No explicit task declared. Active files are shown below."
            : "This teammate is in the live roster but has not reported active work.",
        ),
      );
    }
    for (const task of member.tasks) {
      const card = el("article", "card");
      card.append(
        text(el("div", "card-title"), task.description || "Undescribed coordination task"),
      );
      const body = el("div", "card-body");
      const paths = [
        ...task.modifyPaths.map((path) => "Modify: " + path),
        ...task.createPaths.map((path) => "Create: " + path),
      ];
      card.append(text(body, paths.length ? paths.join("\n") : "No paths recorded."));
      tasks.append(card);
    }
    detail.append(tasks);

    const files = el("div", "section");
    files.append(text(el("h3"), "Current files"));
    if (!member.files.length) {
      files.append(
        text(
          el("div", "empty"),
          member.activityKnown ? "No active files." : "No activity metadata reported yet.",
        ),
      );
    }
    for (const file of member.files) {
      const row = el("div", "file-row");
      row.append(text(el("code"), file.path));
      const roles = el("div", "roles");
      for (const role of file.roles) {
        roles.append(text(el("span", "tag"), roleLabel[role] || role));
      }
      row.append(roles);
      files.append(row);
    }
    detail.append(files);

    const diff = el("div", "section");
    const isLocalMember = member.memberId === state.selfMemberId;
    diff.append(text(el("h3"), isLocalMember ? "Your local diff preview" : "Teammate diff preview"));
    if (!isLocalMember) {
      const paths = member.files.map((file) => file.path).slice(0, 3);
      const pathText = paths.length ? " Current activity: " + paths.join(", ") + "." : "";
      diff.append(
        text(
          el("div", "privacy"),
          "CFLS never uploads or relays teammate source patches." +
            pathText +
            " Ask this teammate to open their own CFLS panel to view their local preview.",
        ),
      );
    } else if (!state.localDiffPreview) {
      diff.append(
        text(
          el("div", "empty"),
          "Open a locally changed, unsaved file to show a small diff here. This preview remains only on this computer.",
        ),
      );
    } else {
      const preview = state.localDiffPreview;
      const card = el("div", "diff-card");
      const meta =
        preview.changedLines +
        " changed line" +
        (preview.changedLines === 1 ? "" : "s") +
        (preview.truncated ? " · preview limited" : "") +
        " · source stays local";
      card.append(text(el("div", "card-title"), preview.path));
      card.append(text(el("div", "diff-meta"), meta));
      const pre = el("pre", "diff-preview");
      for (const line of preview.lines) {
        const row = el("div", "diff-line " + line.kind);
        row.append(text(el("span", "diff-prefix"), diffPrefix[line.kind] || " "));
        row.append(text(el("span"), line.text));
        pre.append(row);
      }
      card.append(pre);
      diff.append(card);
    }
    detail.append(diff);
  }

  window.addEventListener("message", (event) => {
    if (event.data?.type === "team-state") {
      state = event.data.state;
      render();
    }
  });
  render();
})();
