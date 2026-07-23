/**
 * Round-trip tests for the CLI config files (host.json, agent.json,
 * local-api.json). Every write must read back exactly, keys must dedupe, and
 * partial agent-config updates must merge rather than clobber.
 */

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendAdminPublicKey,
  DEFAULT_AUTO_SYNC,
  DEFAULT_LIVE_DIFFS,
  readAgentConfig,
  readAutoSyncConfig,
  readHostConfig,
  readLiveDiffsConfig,
  readLocalApiConfig,
  readTeamConfig,
  updateAgentConfig,
  writeLocalApiConfig,
  type LocalApiFileSecurity,
} from "./config-files";

describe("config files round-trip", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cfls-cli-cfg-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("host.json: appends + dedupes admin keys and stores the team id", () => {
    const path = join(dir, "host.json");
    expect(readHostConfig(path)).toBeNull();

    appendAdminPublicKey(path, "KEY_A", "team-1");
    appendAdminPublicKey(path, "KEY_B", "team-1");
    appendAdminPublicKey(path, "KEY_A", "team-1"); // duplicate

    const config = readHostConfig(path);
    expect(config).not.toBeNull();
    expect(config?.teamId).toBe("team-1");
    expect(config?.authorizedAdminPublicKeys).toEqual(["KEY_A", "KEY_B"]);
  });

  it("agent.json: merges partial updates instead of clobbering", () => {
    const path = join(dir, "agent.json");
    expect(readAgentConfig(path)).toEqual({});

    updateAgentConfig(path, {
      hostUrl: "wss://host:8730",
      memberName: "alice",
    });
    updateAgentConfig(path, { invitation: "BASE64", teamId: "team-1" });

    expect(readAgentConfig(path)).toEqual({
      hostUrl: "wss://host:8730",
      memberName: "alice",
      invitation: "BASE64",
      teamId: "team-1",
    });
  });

  it("local-api.json: writes atomically with owner-only permissions", () => {
    const path = join(dir, "local-api.json");
    expect(readLocalApiConfig(path)).toBeNull();

    writeLocalApiConfig(path, { url: "ws://127.0.0.1:8750", token: "tok-123" });
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o077).toBe(0);
    }
    expect(
      readdirSync(dir).filter((entry) => entry.includes("local-api.json")),
    ).toEqual(["local-api.json"]);
    expect(readLocalApiConfig(path)).toEqual({
      url: "ws://127.0.0.1:8750",
      token: "tok-123",
    });
  });

  it.skipIf(process.platform === "win32")(
    "local-api.json: rejects a record readable by another local account",
    () => {
      const path = join(dir, "local-api.json");
      writeLocalApiConfig(path, {
        url: "ws://127.0.0.1:8750",
        token: "tok-123",
      });
      chmodSync(path, 0o644);

      expect(readLocalApiConfig(path)).toBeNull();
    },
  );

  it("local-api.json: creates the token record through the atomic Windows writer", () => {
    const path = join(dir, "local-api.json");
    const created: Array<{ path: string; contents: string }> = [];
    const verified: string[] = [];
    const security: LocalApiFileSecurity = {
      platform: "win32",
      createWindowsPrivateFile: (file, contents) => {
        // The regression boundary: Node must not create an inherited-ACL empty
        // file before it delegates secure creation and token writing to Windows.
        expect(existsSync(file)).toBe(false);
        created.push({ path: file, contents });
        writeFileSync(file, contents, "utf8");
      },
      verifyWindowsFile: (file) => {
        verified.push(file);
        return true;
      },
    };

    writeLocalApiConfig(
      path,
      { url: "ws://127.0.0.1:8750", token: "tok-123" },
      security,
    );

    expect(created).toHaveLength(1);
    expect(created[0]?.path).toMatch(/^.*local-api\.json\..+\.tmp$/u);
    expect(JSON.parse(created[0]?.contents ?? "")).toEqual({
      url: "ws://127.0.0.1:8750",
      token: "tok-123",
    });
    // Verify the atomically created source before moving it, then verify the
    // final target after its same-directory atomic rename.
    expect(verified.slice(0, 2)).toEqual([created[0]?.path, path]);
    expect(readLocalApiConfig(path, security)).toEqual({
      url: "ws://127.0.0.1:8750",
      token: "tok-123",
    });
    expect(
      verified.filter((file) => file === path).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("local-api.json: fails closed when atomic Windows creation fails", () => {
    const path = join(dir, "local-api.json");
    const security: LocalApiFileSecurity = {
      platform: "win32",
      createWindowsPrivateFile: (file) => {
        // No inherited-ACL file may be created before the secure creator runs.
        expect(existsSync(file)).toBe(false);
        throw new Error("atomic ACL setup unavailable");
      },
      verifyWindowsFile: () => true,
    };

    expect(() =>
      writeLocalApiConfig(
        path,
        { url: "ws://127.0.0.1:8750", token: "tok-123" },
        security,
      ),
    ).toThrow("atomic ACL setup unavailable");
    expect(existsSync(path)).toBe(false);
    expect(
      readdirSync(dir).filter((entry) => entry.includes("local-api.json")),
    ).toEqual([]);
  });

  it("local-api.json: rejects an unverifiable record on mocked Windows", () => {
    const path = join(dir, "local-api.json");
    writeFileSync(
      path,
      JSON.stringify({ url: "ws://127.0.0.1:8750", token: "tok-123" }),
    );
    let checks = 0;
    const security: LocalApiFileSecurity = {
      platform: "win32",
      createWindowsPrivateFile: () => undefined,
      verifyWindowsFile: () => {
        checks += 1;
        return false;
      },
    };

    expect(readLocalApiConfig(path, security)).toBeNull();
    expect(checks).toBe(1);
  });

  it("local-api.json: removes the token temporary when Windows verification fails", () => {
    const path = join(dir, "local-api.json");
    const security: LocalApiFileSecurity = {
      platform: "win32",
      createWindowsPrivateFile: (file, contents) => {
        writeFileSync(file, contents, "utf8");
      },
      verifyWindowsFile: () => false,
    };

    expect(() =>
      writeLocalApiConfig(
        path,
        { url: "ws://127.0.0.1:8750", token: "tok-123" },
        security,
      ),
    ).toThrow("Could not verify a current-user-only Windows ACL");
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("config.json autoSync", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cfls-cli-autosync-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the safe disabled defaults when the file is absent", () => {
    const path = join(dir, "config.json");
    expect(readAutoSyncConfig(path)).toEqual(DEFAULT_AUTO_SYNC);
    expect(readAutoSyncConfig(path).enabled).toBe(false);
    expect(readTeamConfig(path)).toEqual({});
  });

  it("returns disabled defaults when the autoSync block is absent", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ somethingElse: true }));
    expect(readAutoSyncConfig(path)).toEqual(DEFAULT_AUTO_SYNC);
  });

  it("fills missing fields with defaults but honors provided ones", () => {
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify({
        autoSync: { enabled: true, autoMerge: true, commitIntervalSec: 45 },
      }),
    );
    expect(readAutoSyncConfig(path)).toEqual({
      enabled: true,
      remote: "origin",
      branchPrefix: "cfls/",
      commitIntervalSec: 45,
      fetchIntervalSec: 20,
      autoMerge: true,
    });
  });

  it("ignores invalid field types and falls back to defaults", () => {
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify({
        autoSync: {
          enabled: "yes", // not a boolean → treated as disabled
          remote: "", // empty → default
          branchPrefix: 123, // wrong type → default
          commitIntervalSec: -5, // non-positive → default
          fetchIntervalSec: 0, // non-positive → default
          autoMerge: "true", // not a boolean → false
        },
      }),
    );
    expect(readAutoSyncConfig(path)).toEqual(DEFAULT_AUTO_SYNC);
  });

  it("only enables when enabled === true (boolean, not truthy)", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ autoSync: { enabled: true } }));
    expect(readAutoSyncConfig(path).enabled).toBe(true);
  });
});

describe("config.json liveDiffs (Phase 5; Req 5.1, 5.4)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cfls-cli-livediffs-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the disabled default when the file is absent", () => {
    const path = join(dir, "config.json");
    expect(readLiveDiffsConfig(path)).toEqual(DEFAULT_LIVE_DIFFS);
    expect(readLiveDiffsConfig(path).enabled).toBe(false);
  });

  it("returns disabled when the liveDiffs block is absent", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ autoSync: { enabled: true } }));
    expect(readLiveDiffsConfig(path).enabled).toBe(false);
  });

  it("enables only when enabled === true (boolean, not truthy)", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ liveDiffs: { enabled: "yes" } }));
    expect(readLiveDiffsConfig(path).enabled).toBe(false);
    writeFileSync(path, JSON.stringify({ liveDiffs: { enabled: true } }));
    expect(readLiveDiffsConfig(path).enabled).toBe(true);
  });

  it("surfaces the liveDiffs block through readTeamConfig", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ liveDiffs: { enabled: true } }));
    expect(readTeamConfig(path).liveDiffs).toEqual({ enabled: true });
  });
});
