/*
 * CFLS demo dashboard — scripted "live" scenario for the demo video.
 *
 * Two real people (Alice on Laptop A, Bob on Laptop B) coordinate on one repo.
 * The timeline plays automatically and loops, so you can screen-record any
 * window and it always looks like a real, live session. Nothing here talks to
 * a server — it is a faithful, repeatable re-creation of what the real host
 * dashboard shows when two teammates are working at once.
 */

// ---- live state ------------------------------------------------------------
const state = {
  devices: [], // { id, name, laptop, color, doing }
  locks: [], // { path, holder, mode }
  presence: [], // { name, path }
  revision: 0,
  events: [], // { tick, kind, icon, html }
};

const PEOPLE = {
  Alice: {
    color: "linear-gradient(135deg,#62e6e0,#3bb7b2)",
    laptop: "Laptop A",
  },
  Bob: { color: "linear-gradient(135deg,#d6f54a,#a9c72f)", laptop: "Laptop B" },
};

// ---- helpers ---------------------------------------------------------------
const $ = (id) => document.getElementById(id);
let startedAt = Date.now();

function nowTick() {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
}

function addEvent(kind, icon, html) {
  state.revision += 1;
  state.events.unshift({ tick: nowTick(), kind, icon, html });
  if (state.events.length > 12) state.events.pop();
  render();
}

function connect(name) {
  const p = PEOPLE[name];
  if (!state.devices.some((d) => d.name === name)) {
    state.devices.push({
      name,
      laptop: p.laptop,
      color: p.color,
      doing: "connected",
    });
  }
  addEvent("join", "🔗", `<b>${name}</b> joined from <b>${p.laptop}</b>`);
}

function startEditing(name, path, doing) {
  if (!state.presence.some((x) => x.name === name && x.path === path)) {
    state.presence.push({ name, path });
  }
  const dev = state.devices.find((d) => d.name === name);
  if (dev) dev.doing = doing || `editing ${short(path)}`;
  addEvent("edit", "✏️", `<b>${name}</b> started editing <b>${path}</b>`);
}

function acquireLock(name, path, mode) {
  state.locks = state.locks.filter((l) => l.path !== path);
  state.locks.push({ path, holder: name, mode });
}

function releaseLock(name, path) {
  state.locks = state.locks.filter((l) => l.path !== path);
  state.presence = state.presence.filter(
    (x) => !(x.name === name && x.path === path),
  );
  const dev = state.devices.find((d) => d.name === name);
  if (dev) dev.doing = "idle";
  addEvent(
    "release",
    "✅",
    `<b>${name}</b> finished — <b>${path}</b> is free again`,
  );
}

function warn(html) {
  addEvent("warn", "⚠️", html);
}
function short(p) {
  const parts = p.split("/");
  return parts[parts.length - 1];
}

// ---- rendering -------------------------------------------------------------
function render() {
  $("updated").textContent = "just now";
  $("s-devices").textContent = state.devices.length;
  $("s-editing").textContent = state.presence.length;
  $("s-locks").textContent = state.locks.length;
  $("s-rev").textContent = state.revision;
  $("dev-count").textContent = state.devices.length;
  $("lock-count").textContent = state.locks.length;

  // devices
  const devBox = $("devices");
  if (state.devices.length === 0) {
    devBox.innerHTML = `<div class="empty">Waiting for laptops to connect…</div>`;
  } else {
    devBox.innerHTML = state.devices
      .map(
        (d) => `
      <div class="device">
        <span class="dot"></span>
        <span class="avatar" style="background:${d.color}">${d.name[0]}</span>
        <div class="meta">
          <div class="name">${d.name}</div>
          <div class="sub">${d.laptop} · online</div>
        </div>
        <div class="doing">${d.doing}</div>
      </div>`,
      )
      .join("");
  }

  // locks + presence
  const lockBox = $("locks");
  const rows = [];
  for (const l of state.locks) {
    const cls =
      l.mode === "hard"
        ? "hard"
        : l.mode === "coordination-required"
          ? "coord"
          : "soft";
    const label =
      l.mode === "hard"
        ? "HARD"
        : l.mode === "coordination-required"
          ? "COORDINATE"
          : "SOFT LOCK";
    rows.push(`<div class="row">
      <span class="badge ${cls}">${label}</span>
      <span class="path">${l.path}</span>
      <span class="who">held by ${l.holder}</span></div>`);
  }
  for (const pr of state.presence) {
    if (state.locks.some((l) => l.path === pr.path && l.holder === pr.name))
      continue;
    rows.push(`<div class="row">
      <span class="badge soft">EDITING</span>
      <span class="path">${pr.path}</span>
      <span class="who">${pr.name}</span></div>`);
  }
  lockBox.innerHTML = rows.length
    ? rows.join("")
    : `<div class="empty">No files in use yet.</div>`;

  // feed
  $("feed").innerHTML = state.events
    .map(
      (e) => `
    <div class="event ${e.kind}">
      <span class="tick">${e.tick}</span>
      <span class="ic">${e.icon}</span>
      <span class="txt">${e.html}</span>
    </div>`,
    )
    .join("");
}

// ---- ticking clocks --------------------------------------------------------
setInterval(() => {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  const m = Math.floor(s / 60);
  $("uptime").textContent = m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}, 1000);

// ---- the scenario timeline (loops) ----------------------------------------
const script = [
  [
    800,
    () =>
      addEvent("info", "🟢", `Coordination host started · session <b>main</b>`),
  ],
  [1600, () => connect("Alice")],
  [1600, () => connect("Bob")],
  [
    1800,
    () => {
      startEditing("Alice", "src/payments.ts");
      acquireLock("Alice", "src/payments.ts", "soft");
    },
  ],
  [
    2600,
    () =>
      warn(
        `<b>Bob</b> opened <b>src/payments.ts</b> — <b>Alice</b> is already here. Coordinate before editing.`,
      ),
  ],
  [
    2200,
    () => {
      acquireLock("Alice", "src/payments.ts", "coordination-required");
    },
  ],
  [
    2400,
    () => {
      startEditing("Bob", "src/auth/token.ts");
      acquireLock("Bob", "src/auth/token.ts", "soft");
    },
  ],
  [
    2600,
    () =>
      warn(
        `Heads up: <b>src/payments.ts</b> uses <b>src/auth/token.ts</b>. Alice &amp; Bob are on linked files.`,
      ),
  ],
  [2600, () => releaseLock("Alice", "src/payments.ts")],
  [
    2000,
    () => {
      startEditing("Bob", "src/payments.ts");
      acquireLock("Bob", "src/payments.ts", "soft");
      addEvent(
        "edit",
        "✏️",
        `<b>Bob</b> safely picked up <b>src/payments.ts</b>`,
      );
    },
  ],
  [2600, () => releaseLock("Bob", "src/auth/token.ts")],
  [2600, () => releaseLock("Bob", "src/payments.ts")],
  [2400, () => addEvent("info", "💤", `All files free · team in sync`)],
];

async function run() {
  // reset for a clean loop
  state.devices = [];
  state.locks = [];
  state.presence = [];
  state.events = [];
  state.revision = 0;
  startedAt = Date.now();
  render();
  for (const [delay, action] of script) {
    await new Promise((r) => setTimeout(r, delay));
    action();
  }
  await new Promise((r) => setTimeout(r, 2600));
  run(); // loop forever for the recording
}

render();
run();
