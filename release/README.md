# CFLS demo downloads

The hosted CFLS relay is ready at `wss://sync.cfls.cyberkunju.com`. The
standalone clients and installers below use it by default, so teammates do not
need to be on the same LAN or configure a VPN.

An invitation is still required for every device. It is the authorization that
lets the relay verify who may read and publish coordination metadata; the
installer deliberately does not bypass it.

## Downloads

| Download                 | Direct link                                                                            | Use                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Windows client           | [cfls.exe](https://cfls.cyberkunju.com/downloads/cfls.exe)                             | Standalone Windows CLI; no Node.js install needed.                          |
| Windows installer        | [install-windows.ps1](https://cfls.cyberkunju.com/downloads/install-windows.ps1)       | Installs the CLI for the current user and creates the Agent task.           |
| Linux x64 client         | [cfls-linux-x64](https://cfls.cyberkunju.com/downloads/cfls-linux-x64)                 | Standalone Linux x86_64 CLI.                                                |
| Linux installer          | [install-linux.sh](https://cfls.cyberkunju.com/downloads/install-linux.sh)             | Installs the CLI for the current user and creates the systemd user service. |
| VS Code / Kiro extension | [cfls-coordination.vsix](https://cfls.cyberkunju.com/downloads/cfls-coordination.vsix) | Clickable CFLS status item, team panel, and local diff preview.             |

## Connect a Windows laptop

1. Download `cfls.exe`, then get this device's public key and send it to the
   team admin:

   ```powershell
   Invoke-WebRequest https://cfls.cyberkunju.com/downloads/cfls.exe -OutFile .\cfls.exe
   .\cfls.exe id
   ```

2. After the admin returns a signed invitation, download and run the installer
   from the checked-out repository:

   ```powershell
   Invoke-WebRequest https://cfls.cyberkunju.com/downloads/install-windows.ps1 -OutFile .\install-windows.ps1
   powershell -ExecutionPolicy Bypass -File .\install-windows.ps1 `
     -Workspace C:\work\your-repository -Name alice -Invite '<invitation>'
   ```

The installer saves `wss://sync.cfls.cyberkunju.com`, redeems the invitation,
and creates a per-user Task Scheduler Agent. It does not require Node.js.

## Connect a Linux laptop

1. Download the Linux x64 binary, make it executable, and send its public key
   to the team admin. (For ARM64, build the documented native target from
   source until a signed ARM64 release asset is published.)

   ```bash
   curl -fLO https://cfls.cyberkunju.com/downloads/cfls-linux-x64
   curl -fLO https://cfls.cyberkunju.com/downloads/install-linux.sh
   chmod +x cfls-linux-x64 install-linux.sh
   ./cfls-linux-x64 id
   ```

2. After receiving the signed invitation, install and start the background
   Agent for the repository:

   ```bash
   ./install-linux.sh \
     --workspace /absolute/path/to/your-repository \
     --name alice \
     --invite '<invitation>'
   ```

The installer saves the hosted relay, installs `cfls` in `~/.local/bin`, and
creates a per-user systemd service. It will not start an Agent without an
invitation. If your system policy stops user services after logout, enable user
lingering through the system administrator.

## Install the editor extension

Download the VSIX, then install it in VS Code or Kiro:

```bash
code --install-extension ./cfls-coordination.vsix --force
kiro --install-extension ./cfls-coordination.vsix --force
```

With the local Agent running, the status bar shows the CFLS mark, team, and
connection state. Click it to open the active-team panel. Selecting your own
active file can show a compact local saved-versus-unsaved diff; teammate source
and patches are never transmitted or displayed.

## Hosted read-only MCP

The hosted Streamable HTTP MCP endpoint is:

```text
https://sync.cfls.cyberkunju.com/mcp
```

It is bearer-authenticated and read-only. It exposes the authorized session's
team status, connection status, risk map, and dependency metadata; it cannot
impersonate a device or create locks and intents. Ask the team admin for a
hosted MCP bearer token, then add this shape to the remote-MCP configuration of
your client:

```json
{
  "url": "https://sync.cfls.cyberkunju.com/mcp",
  "headers": {
    "Authorization": "Bearer <hosted-mcp-token>"
  }
}
```

For device-authenticated intent and lock changes, use the local stdio bridge
(`cfls mcp`) from an enrolled laptop instead.

The hosted risk map is advisory: repository protection rules remain on enrolled
clients, so only the local bridge can enforce those rules for a mutation.

## Rebuilding artifacts

The source commands below produce the same artifact families when a custom
internal build is needed:

```bash
pnpm -C apps/vscode-extension package:vsix
pnpm -C apps/cli package:win
pnpm -C apps/cli package:linux
```

The Windows build is an unsigned internal executable, so Windows SmartScreen or
Defender may request confirmation on first launch. Code signing is a separate
release process.
