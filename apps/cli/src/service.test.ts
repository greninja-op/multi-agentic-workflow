/**
 * Unit coverage for the per-user service lifecycle builders. Every lifecycle
 * operation uses a recording executor: these tests never invoke `systemctl`,
 * `schtasks`, a shell, or the real filesystem.
 */

import { describe, expect, it } from "vitest";

import {
  applyServicePlan,
  buildLinuxUserServiceInstallPlan,
  buildServiceInstallPlan,
  buildServiceStatusPlan,
  buildServiceUninstallPlan,
  buildWindowsUserTaskInstallPlan,
  getServiceStatus,
  parseLinuxUserServiceStatus,
  parseWindowsUserTaskStatus,
  escapeSystemdPath,
  quoteSystemdArgument,
  quoteWindowsArgument,
  type ServiceCommand,
  type ServiceCommandResult,
  type ServiceFileRemoval,
  type ServiceFileWrite,
  type ServicePlanExecutor,
} from "./service";

const okResult: ServiceCommandResult = { exitCode: 0, stdout: "", stderr: "" };

function recordingExecutor(
  run: (command: ServiceCommand) => ServiceCommandResult = () => okResult,
  removeFile: (file: ServiceFileRemoval) => void | Promise<void> = () =>
    undefined,
): {
  executor: ServicePlanExecutor;
  calls: string[];
  writes: ServiceFileWrite[];
  removals: ServiceFileRemoval[];
} {
  const calls: string[] = [];
  const writes: ServiceFileWrite[] = [];
  const removals: ServiceFileRemoval[] = [];
  return {
    executor: {
      ensureDirectory: (path) => {
        calls.push(`mkdir:${path}`);
      },
      writeFile: (file) => {
        writes.push(file);
        calls.push(`write:${file.path}`);
      },
      removeFile: (file) => {
        removals.push(file);
        calls.push(`remove:${file.path}`);
        return removeFile(file);
      },
      run: (command) => {
        calls.push(`run:${command.executable} ${command.args.join(" ")}`);
        return run(command);
      },
    },
    calls,
    writes,
    removals,
  };
}

describe("service definition validation", () => {
  it("rejects relative and malformed target paths before building a plan", () => {
    expect(() =>
      buildServiceInstallPlan({
        platform: "linux",
        userHome: "/home/alice",
        executablePath: "./cfls",
        workspacePath: "/work/project",
      }),
    ).toThrow(/executablePath must be an absolute POSIX path/);

    expect(() =>
      buildServiceInstallPlan({
        platform: "win32",
        userHome: "C:\\Users\\Alice",
        executablePath: "C:\\Program Files\\CFLS\\cfls.exe",
        workspacePath: ".\\project",
        windowsUserId: "DESKTOP\\Alice",
      }),
    ).toThrow(/workspacePath must be an absolute Windows path/);
  });

  it("rejects unsafe logical names and command arguments", () => {
    expect(() =>
      buildServiceInstallPlan({
        platform: "linux",
        userHome: "/home/alice",
        executablePath: "/opt/cfls/cfls",
        workspacePath: "/work/project",
        serviceName: "../../other-service",
      }),
    ).toThrow(/serviceName may contain only/);

    expect(() =>
      buildServiceInstallPlan({
        platform: "linux",
        userHome: "/home/alice",
        executablePath: "/opt/cfls/cfls",
        workspacePath: "/work/project",
        args: ["agent", "--workspace\nmalicious"],
      }),
    ).toThrow(/args\[1\]/);

    expect(() =>
      buildServiceInstallPlan({
        platform: "win32",
        userHome: "C:\\Users\\Alice",
        executablePath: "C:\\CFLS\\cfls.exe",
        workspacePath: "C:\\work\\project",
      }),
    ).toThrow(/windowsUserId must be a non-empty string/);
  });
});

describe("Linux systemd --user plans", () => {
  it("writes a per-user unit and uses argv-based systemctl commands", () => {
    const plan = buildLinuxUserServiceInstallPlan({
      userHome: "/home/alice",
      executablePath: "/opt/CFLS/cfls agent",
      workspacePath: "/work/team alpha",
      args: ["agent", "--team", "north$star%"],
      description: 'CFLS "team" agent',
    });

    expect(plan.directories).toEqual(["/home/alice/.config/systemd/user"]);
    expect(plan.filesToWrite[0]).toMatchObject({
      path: "/home/alice/.config/systemd/user/cfls-agent.service",
      mode: 0o644,
    });
    expect(plan.filesToWrite[0]?.content).toContain(
      'ExecStart="/opt/CFLS/cfls agent" "agent" "--team" "north$$star%%"',
    );
    expect(plan.filesToWrite[0]?.content).toContain(
      "WorkingDirectory=/work/team\\x20alpha",
    );
    expect(plan.commands).toEqual([
      {
        id: "systemd-daemon-reload",
        executable: "systemctl",
        args: ["--user", "daemon-reload"],
      },
      {
        id: "systemd-enable-and-start",
        executable: "systemctl",
        args: ["--user", "enable", "--now", "cfls-agent.service"],
      },
    ]);
  });

  it("escapes systemd interpolation characters as literals", () => {
    expect(quoteSystemdArgument('a\\b"c$d%e')).toBe('"a\\\\b\\"c$$d%%e"');
  });

  it("renders WorkingDirectory paths without invalid quote characters", () => {
    expect(escapeSystemdPath("/work/team alpha/%quoted")).toBe(
      "/work/team\\x20alpha/%%quoted",
    );
    expect(() => escapeSystemdPath("relative/path")).toThrow(/absolute/);
  });

  it("uses an idempotent stop/remove/reload plan for uninstall", () => {
    const plan = buildServiceUninstallPlan({
      platform: "linux",
      userHome: "/home/alice",
    });
    expect(plan.filesToRemove).toEqual([
      {
        path: "/home/alice/.config/systemd/user/cfls-agent.service",
        allowMissing: true,
      },
    ]);
    expect(plan.commands[0]).toMatchObject({
      args: ["--user", "disable", "--now", "cfls-agent.service"],
      allowMissingService: true,
    });
    expect(plan.commands[1]?.args).toEqual(["--user", "daemon-reload"]);
  });
});

describe("Windows Task Scheduler plans", () => {
  it("writes a per-user interactive-token task and registers it with schtasks", () => {
    const plan = buildWindowsUserTaskInstallPlan({
      userHome: "C:\\Users\\Alice",
      executablePath: "C:\\Program Files\\CFLS\\cfls.exe",
      workspacePath: "C:\\work\\team alpha",
      args: ["agent", "--label", 'A "quoted" value'],
      description: "CFLS <agent> & team",
      windowsUserId: "DESKTOP\\Alice",
    });

    expect(plan.directories).toEqual([
      "C:\\Users\\Alice\\AppData\\Local\\CFLS\\services",
    ]);
    expect(plan.filesToWrite[0]?.path).toBe(
      "C:\\Users\\Alice\\AppData\\Local\\CFLS\\services\\cfls-agent.xml",
    );
    expect(plan.filesToWrite[0]?.encoding).toBe("utf16le-bom");
    expect(plan.filesToWrite[0]?.content).toContain(
      '<?xml version="1.0" encoding="UTF-16"?>',
    );
    expect(plan.filesToWrite[0]?.content).toContain(
      "<LogonType>InteractiveToken</LogonType>",
    );
    expect(plan.filesToWrite[0]?.content).toContain(
      "<RunLevel>LeastPrivilege</RunLevel>",
    );
    expect(plan.filesToWrite[0]?.content).toContain(
      "<UserId>DESKTOP\\Alice</UserId>",
    );
    expect(plan.filesToWrite[0]?.content).toContain(
      "<LogonTrigger>\n      <Enabled>true</Enabled>\n      <UserId>DESKTOP\\Alice</UserId>",
    );
    expect(plan.filesToWrite[0]?.content).toContain(
      "<RestartOnFailure>\n      <Interval>PT1M</Interval>\n      <Count>5</Count>",
    );
    expect(plan.filesToWrite[0]?.content).toContain(
      "<Description>CFLS &lt;agent&gt; &amp; team</Description>",
    );
    expect(plan.filesToWrite[0]?.content).toContain(
      "<Arguments>agent --label &quot;A \\&quot;quoted\\&quot; value&quot;</Arguments>",
    );
    expect(plan.commands).toEqual([
      {
        id: "task-create",
        executable: "schtasks.exe",
        args: [
          "/Create",
          "/TN",
          "\\CFLS-cfls-agent",
          "/XML",
          "C:\\Users\\Alice\\AppData\\Local\\CFLS\\services\\cfls-agent.xml",
          "/F",
        ],
      },
      {
        id: "task-start",
        executable: "schtasks.exe",
        args: ["/Run", "/TN", "\\CFLS-cfls-agent"],
      },
    ]);
  });

  it("uses Windows argv quoting for spaces, quotes, and trailing backslashes", () => {
    expect(quoteWindowsArgument("plain")).toBe("plain");
    expect(quoteWindowsArgument("two words")).toBe('"two words"');
    expect(quoteWindowsArgument('a "quoted" value')).toBe(
      '"a \\"quoted\\" value"',
    );
    expect(quoteWindowsArgument("C:\\path with spaces\\")).toBe(
      '"C:\\path with spaces\\\\"',
    );
  });

  it("queries and deletes only the named per-user task", () => {
    const status = buildServiceStatusPlan({
      platform: "windows",
      userHome: "C:\\Users\\Alice",
      serviceName: "demo-agent",
    });
    expect(status.commands[0]?.executable).toBe("powershell.exe");
    expect(status.commands[0]?.args.slice(0, 3)).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-Command",
    ]);
    expect(status.commands[0]?.args[3]).toContain(
      "Get-ScheduledTask -TaskPath '\\CFLS\\' -TaskName 'demo-agent'",
    );

    const uninstall = buildServiceUninstallPlan({
      platform: "win32",
      userHome: "C:\\Users\\Alice",
      serviceName: "demo-agent",
    });
    expect(uninstall.commands[0]).toMatchObject({
      args: ["/End", "/TN", "\\CFLS-demo-agent"],
      allowMissingService: true,
    });
    expect(uninstall.commands[1]).toMatchObject({
      args: ["/Delete", "/TN", "\\CFLS-demo-agent", "/F"],
      allowMissingService: true,
    });
  });
});

describe("executor-backed lifecycle", () => {
  it("applies an install in order through an injected executor only", async () => {
    const plan = buildServiceInstallPlan({
      platform: "linux",
      userHome: "/home/alice",
      executablePath: "/opt/cfls/cfls",
      workspacePath: "/work/project",
    });
    const { executor, calls, writes } = recordingExecutor();

    const result = await applyServicePlan(plan, executor);

    expect(result.ok).toBe(true);
    expect(writes).toHaveLength(1);
    expect(calls).toEqual([
      "mkdir:/home/alice/.config/systemd/user",
      "write:/home/alice/.config/systemd/user/cfls-agent.service",
      "run:systemctl --user daemon-reload",
      "run:systemctl --user enable --now cfls-agent.service",
    ]);
  });

  it("does not continue after a required native command fails", async () => {
    const plan = buildServiceInstallPlan({
      platform: "win32",
      userHome: "C:\\Users\\Alice",
      executablePath: "C:\\CFLS\\cfls.exe",
      workspacePath: "C:\\work\\project",
      windowsUserId: "DESKTOP\\Alice",
    });
    const { executor } = recordingExecutor(() => ({
      exitCode: 5,
      stdout: "",
      stderr: "access denied",
    }));

    const result = await applyServicePlan(plan, executor);

    expect(result).toMatchObject({
      ok: false,
      failure: { stage: "command", target: "task-create", exitCode: 5 },
    });
  });

  it("stops a Linux service before removing its unit, then reloads systemd", async () => {
    const plan = buildServiceUninstallPlan({
      platform: "linux",
      userHome: "/home/alice",
    });
    const { executor, calls } = recordingExecutor();

    const result = await applyServicePlan(plan, executor);

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      "run:systemctl --user disable --now cfls-agent.service",
      "remove:/home/alice/.config/systemd/user/cfls-agent.service",
      "run:systemctl --user daemon-reload",
    ]);
  });

  it("only treats an explicit missing systemd unit as idempotent", async () => {
    const plan = buildServiceUninstallPlan({
      platform: "linux",
      userHome: "/home/alice",
    });
    const { executor, calls } = recordingExecutor((command) => {
      if (command.id === "systemd-disable-and-stop") {
        return {
          exitCode: 1,
          stdout: "",
          stderr:
            "Failed to disable unit: Unit file cfls-agent.service does not exist.",
        };
      }
      return okResult;
    });

    const result = await applyServicePlan(plan, executor);

    expect(result).toMatchObject({ ok: true });
    expect(result.warnings).toEqual([
      "Service was already absent while running systemd-disable-and-stop; continuing cleanup.",
    ]);
    expect(calls).toEqual([
      "run:systemctl --user disable --now cfls-agent.service",
      "remove:/home/alice/.config/systemd/user/cfls-agent.service",
      "run:systemctl --user daemon-reload",
    ]);
  });

  it("does not hide a real native uninstall failure", async () => {
    const plan = buildServiceUninstallPlan({
      platform: "linux",
      userHome: "/home/alice",
    });
    const { executor, calls } = recordingExecutor((command) => {
      if (command.id === "systemd-disable-and-stop") {
        return { exitCode: 1, stdout: "", stderr: "Access denied." };
      }
      return okResult;
    });

    const result = await applyServicePlan(plan, executor);

    expect(result).toMatchObject({
      ok: false,
      failure: {
        stage: "command",
        target: "systemd-disable-and-stop",
        exitCode: 1,
      },
    });
    expect(calls).toEqual([
      "run:systemctl --user disable --now cfls-agent.service",
    ]);
  });

  it("only ignores an actually missing definition file during uninstall", async () => {
    const plan = buildServiceUninstallPlan({
      platform: "linux",
      userHome: "/home/alice",
    });
    const missingFile = Object.assign(new Error("missing"), { code: "ENOENT" });
    const { executor, calls } = recordingExecutor(
      () => okResult,
      () => {
        throw missingFile;
      },
    );

    const result = await applyServicePlan(plan, executor);

    expect(result).toMatchObject({ ok: true });
    expect(result.warnings).toEqual([
      "Service definition was already absent at /home/alice/.config/systemd/user/cfls-agent.service.",
    ]);
    expect(calls).toEqual([
      "run:systemctl --user disable --now cfls-agent.service",
      "remove:/home/alice/.config/systemd/user/cfls-agent.service",
      "run:systemctl --user daemon-reload",
    ]);
  });

  it("fails if definition removal reports anything other than ENOENT", async () => {
    const plan = buildServiceUninstallPlan({
      platform: "linux",
      userHome: "/home/alice",
    });
    const permissionDenied = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    const { executor, calls } = recordingExecutor(
      () => okResult,
      () => {
        throw permissionDenied;
      },
    );

    const result = await applyServicePlan(plan, executor);

    expect(result).toMatchObject({
      ok: false,
      failure: {
        stage: "remove-file",
        target: "/home/alice/.config/systemd/user/cfls-agent.service",
      },
    });
    expect(calls).toEqual([
      "run:systemctl --user disable --now cfls-agent.service",
      "remove:/home/alice/.config/systemd/user/cfls-agent.service",
    ]);
  });

  it("recognizes Task Scheduler's explicit task-not-found response", async () => {
    const plan = buildServiceUninstallPlan({
      platform: "win32",
      userHome: "C:\\Users\\Alice",
    });
    const { executor, calls } = recordingExecutor((command) => {
      if (command.id === "task-stop" || command.id === "task-delete") {
        return {
          exitCode: 1,
          stdout: "ERROR: The system cannot find the file specified.",
          stderr: "",
        };
      }
      return okResult;
    });

    const result = await applyServicePlan(plan, executor);

    expect(result).toMatchObject({ ok: true });
    expect(result.warnings).toHaveLength(2);
    expect(calls).toEqual([
      "run:schtasks.exe /End /TN \\CFLS-cfls-agent",
      "run:schtasks.exe /Delete /TN \\CFLS-cfls-agent /F",
      "remove:C:\\Users\\Alice\\AppData\\Local\\CFLS\\services\\cfls-agent.xml",
    ]);
  });
});

describe("status model", () => {
  it("normalizes systemd's running, enabled state", () => {
    expect(
      parseLinuxUserServiceStatus({
        exitCode: 0,
        stdout: "loaded\nactive\nrunning\nenabled\n",
        stderr: "",
      }),
    ).toMatchObject({
      installed: true,
      enabled: true,
      active: true,
      state: "running",
    });
  });

  it("does not pretend a missing or failed native query is healthy", () => {
    expect(
      parseLinuxUserServiceStatus({
        exitCode: 3,
        stdout: "not-found\ninactive\ndead\ndisabled\n",
        stderr: "",
      }),
    ).toMatchObject({ state: "not-installed", installed: false });

    expect(
      parseWindowsUserTaskStatus({
        exitCode: 1,
        stdout: "ERROR: The system cannot find the file specified.",
        stderr: "",
      }),
    ).toMatchObject({ state: "not-installed", installed: false });
  });

  it("normalizes Task Scheduler's list output and uses a mocked query", async () => {
    expect(
      parseWindowsUserTaskStatus({
        exitCode: 0,
        stdout: "Status: Running\nScheduled Task State: Enabled\n",
        stderr: "",
      }),
    ).toMatchObject({
      installed: true,
      enabled: true,
      active: true,
      state: "running",
    });

    const seen: ServiceCommand[] = [];
    const status = await getServiceStatus(
      { platform: "linux", userHome: "/home/alice" },
      {
        run: (command) => {
          seen.push(command);
          return {
            exitCode: 0,
            stdout: "loaded\ninactive\ndead\ndisabled\n",
            stderr: "",
          };
        },
      },
    );
    expect(seen[0]?.executable).toBe("systemctl");
    expect(status).toMatchObject({
      platform: "linux",
      serviceName: "cfls-agent",
      state: "stopped",
      enabled: false,
      active: false,
    });
  });

  it("uses TaskState's locale-neutral numeric output on non-English Windows", () => {
    expect(
      parseWindowsUserTaskStatus({
        exitCode: 0,
        stdout: "CFLS_TASK_STATE=4;ENABLED=1\n",
        stderr: "",
      }),
    ).toMatchObject({
      installed: true,
      enabled: true,
      active: true,
      state: "running",
    });
    expect(
      parseWindowsUserTaskStatus({
        exitCode: 0,
        stdout: "CFLS_TASK_STATE=3;ENABLED=1\n",
        stderr: "",
      }),
    ).toMatchObject({
      installed: true,
      enabled: true,
      active: false,
      state: "stopped",
    });
    expect(
      parseWindowsUserTaskStatus({
        exitCode: 0,
        stdout: "CFLS_TASK_NOT_FOUND\n",
        stderr: "",
      }),
    ).toMatchObject({ state: "not-installed", installed: false });
  });
});
