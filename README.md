# EmberHost

EmberHost is a desktop control panel for turning your computer into a self-hosted Minecraft: Java Edition server. It downloads the newest stable vanilla server directly from Mojang, verifies the file, and manages the Java process from a polished Electron interface.

![EmberHost onboarding](docs/images/onboarding-preview.svg)

## What works today

- Creates isolated vanilla server instances using Mojang's live `latest.release` metadata
- Resolves the Minecraft-required Java major version instead of hardcoding it
- Streams the server JAR into an artifact cache and verifies its expected size and SHA-1
- Requires an explicit, initially unchecked Minecraft EULA agreement before writing `eula=true`
- Starts, stops, and monitors the Java process without invoking a shell
- Sends a graceful `stop` command before escalating after a timeout
- Streams stdout/stderr into a searchable-feeling live console and a persistent instance log
- Sends one validated Minecraft command at a time
- Persists multiple server configurations using atomic, schema-versioned JSON
- Preserves unknown comments and keys when updating `server.properties`
- Keeps running from the system tray when the window closes
- Keeps online mode enabled by default and never changes firewall/router settings automatically

This first release targets basic vanilla hosting. Backups, scheduled restarts, managed Java installation, public-connectivity checks, Paper support, and the newer Minecraft Server Management Protocol are natural next steps.

The tray process runs continuously while your desktop user session remains signed in. EmberHost is not yet an operating-system service, so it does not survive logout, reboot, or an Electron crash. A runtime ownership marker prevents a second copy of a server from starting when a Java process may have survived an abnormal app exit.

## Requirements

- Windows 10/11, macOS, or a modern Linux desktop
- A supported 64-bit Java runtime for the selected Minecraft release
- Internet access for the initial Mojang metadata and server download
- At least 2 GB of memory available for a small server

EmberHost reads `javaVersion.majorVersion` from the selected release metadata. For example, Minecraft 26.2 requires Java 25. If `java` is not on `PATH`, enter the full Java executable path during setup.

## Run from source

Install [Node.js](https://nodejs.org/) 22.12 or newer (Node 24 is recommended) and pnpm 11, then:

```powershell
pnpm install
pnpm dev
```

Useful commands:

```powershell
pnpm test       # unit tests
pnpm build      # typecheck + production bundles
pnpm smoke      # launch isolated Electron profile and capture onboarding
pnpm dist       # create the platform installer
```

## Create a server

1. Launch EmberHost and choose a server name.
2. Review the detected release, Java runtime, memory, player limit, and port.
3. Read and explicitly accept the [Minecraft EULA](https://www.minecraft.net/en-us/eula).
4. Select **Download & create**.
5. Open the dashboard and select **Start**.

Players on the same machine can use `localhost:25565`. Other devices on the LAN should use the host computer's private IP. Public internet hosting commonly requires a firewall rule, router port forwarding, and a public IP that is not behind CGNAT. EmberHost does not silently make those security-sensitive changes.

## Where data lives

Runtime data never goes inside the installed app or repository. Settings and large server data share a machine-local application-data root so roaming profiles cannot produce server entries whose worlds exist on another computer:

```text
Machine-local data root/
├─ emberhost.json
├─ artifact-cache/
│  └─ <mojang-sha1>.jar
└─ servers/
   └─ <instance-uuid>/
      ├─ server.jar
      ├─ server.properties
      ├─ eula.txt
      ├─ emberhost-instance.json
      ├─ emberhost-console.log
      └─ world/                 # created by Minecraft on first start
```

On Windows, settings, worlds, and artifacts are under `%LOCALAPPDATA%/EmberHost`. On macOS, they are under `~/Library/Application Support/EmberHost/runtime-data`. On Linux, they use `$XDG_DATA_HOME/EmberHost` or `~/.local/share/EmberHost`.

## Architecture

The React renderer is unprivileged. It has no Node.js or filesystem access and communicates through a narrow, typed preload API. The Electron main process owns all downloads, persistence, filesystem writes, Java checks, and child processes.

```text
React renderer
    │ validated commands and state events
    ▼
context-isolated preload
    │ narrow IPC contract
    ▼
Electron main process
    ├─ instance service ── Mojang metadata/downloads
    ├─ server manager ──── Java stdin/stdout/process lifecycle
    └─ atomic store ────── app data + per-instance files
```

Important safeguards include `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, denied navigation/popups, a restrictive CSP, sender checks, Zod IPC validation, UUID-based server directories, shell-free process spawning, and fixed external-link targets.

## Minecraft licensing

EmberHost is an independent project and is not affiliated with or endorsed by Mojang or Microsoft. It does not bundle, mirror, or redistribute Minecraft server software. The server JAR is downloaded on the user's computer from the URL provided by Mojang and verified against Mojang's metadata.

See the [Minecraft EULA](https://www.minecraft.net/en-us/eula) and [official server download page](https://www.minecraft.net/en-us/download/server).

## License

EmberHost's original source code is available under the [MIT License](LICENSE). Minecraft and its server software remain subject to Mojang/Microsoft terms.

Local development installers are unsigned. Production releases should be code-signed (and notarized on macOS) before distribution.
