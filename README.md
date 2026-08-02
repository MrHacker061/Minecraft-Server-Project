# EmberHost

EmberHost is a desktop control panel for turning a personal computer into a self-hosted Minecraft: Java Edition server. Paper is the recommended default for smoother play and plugin compatibility, Vanilla remains available, and Forge can now be installed for trusted local mods.

![EmberHost onboarding](docs/images/onboarding-preview.svg)

## What works today

- Lists every official Minecraft release in Mojang's manifest and creates any release for which Mojang publishes a server JAR.
- Recommends the newest stable Paper build, resolved from Paper's live API.
- Keeps Vanilla server creation available through Mojang's official metadata.
- Recommends Forge's official recommended build, falls back to its latest promotion when needed, and pins the exact resolved Maven coordinate.
- Resolves and verifies the exact selected release instead of silently substituting the newest version.
- EmberHost's own Paper, Vanilla, Forge-installer, and Chunky downloads use allowlisted official hosts; the official Forge installer then resolves the dependencies required by that Forge build.
- Verifies Paper with SHA-256, Vanilla with Mojang's SHA-1, Forge with the strongest published Maven sidecar checksum available plus its pinned SHA-1, and Chunky with SHA-512 plus the declared file size.
- Resolves Minecraft's required Java major version instead of hardcoding it; Forge creation and startup require that exact major version.
- Requires explicit Minecraft EULA acceptance before writing eula=true.
- Offers Balanced, Far View, and Maximum Performance profiles.
- Refreshes and prioritizes active LAN addresses when your computer changes networks.
- Uses safe G1GC launch flags for Paper and a larger initial heap only in the maximum-performance profile.
- Shows live Paper TPS, MSPT, process memory, CPU use, player count, and uptime.
- Pre-generates selected dimensions with Chunky from a configurable 256–20,000 block radius.
- Flushes the world, pauses autosave, creates a verified safety backup, and restores autosave before pregeneration begins.
- Automatically pauses pregeneration for connected players or unhealthy tick times and resumes when safe.
- Manages up to eight non-overlapping force-loaded regions, with a seven-chunk radius and 256 total chunks.
- Starts, stops, and monitors Java without invoking a shell.
- Sends a graceful stop command before escalating after a timeout.
- Creates checked rolling world backups on a per-server schedule, with bounded retention and an on-demand backup action.
- Streams output into a live console and a persistent, size-capped instance log.
- Persists multiple server configurations with atomic, schema-versioned JSON.
- Changes the configured world seed and safely regenerates the active Overworld, Nether, and End for Vanilla, Paper, or Forge.
- Browses a curated catalog of common Paper plugins and resolves releases for the server's exact Minecraft version.
- Adds, inventories, and removes local Paper plugin JARs while the server is stopped.
- Adds, inventories, and removes trusted local Forge mod JARs, and transactionally imports the root JARs from an extracted server pack's `mods` folder while the server is stopped.
- Moves deleted server folders and removable plugins or mods to the operating system recycle bin instead of permanently erasing them.
- Preserves unknown comments and keys when updating server.properties.
- Keeps running in the system tray when the window closes.
- Keeps online mode enabled by default and never changes firewall or router settings automatically.

The tray process can run continuously while the desktop user remains signed in. EmberHost is not an operating-system service, so it does not survive logout, reboot, or an Electron crash. Conservative runtime ownership markers prevent a second copy of a server from starting when Java may have survived an abnormal exit.

## Paper plugins and Forge mods

Paper supports Bukkit, Spigot, and Paper plugins. EmberHost installs the verified Chunky Paper plugin automatically because the World Tools screen depends on it. The **Plugins** screen includes a searchable, category-filtered catalog of 12 curated projects and still supports importing a local `.jar` file.

Catalog compatibility is resolved live from Modrinth for the server's exact Minecraft version and the Paper loader. Only listed stable releases are eligible for quick installation. EmberHost restricts downloads to the selected allowlisted project on Modrinth's CDN, verifies the declared byte size and SHA-512 hash, validates the JAR structure, and copies it atomically without loading or executing it. Projects with no exact stable release remain visible as unavailable instead of receiving a guessed build. Stop Paper before adding or removing plugins; changes load on the next start.

Plugins run with the same operating-system access as the Minecraft server. Only install plugins from developers you trust and confirm that the plugin supports the selected Minecraft and Paper versions. Chunky is protected from removal because World Preparation depends on it. Other removals go through the recycle bin.

Version 0.7 adds Forge server creation and local mod management. EmberHost resolves promotions from Forge's official metadata, downloads the selected installer from the official Forge Maven repository, verifies its published checksums, and runs it with the selected Java executable without a shell. Modern Forge is launched through its generated Windows or Unix Java argument file; older Forge installations use their generated root JAR. EmberHost never runs Forge-generated `run.bat`, `run.sh`, or other pack scripts.

The **Mods** screen accepts an individual trusted mod `.jar` or the root `mods` directory from an already extracted server pack. Imports validate regular files and JAR structure, enforce bounded sizes, record SHA-256 inventory metadata, and commit a folder import transactionally. Mods are executable code with the same operating-system access as the Java server process. Stop Forge before changing mods, install only files you trust, and verify that every mod supports the server's exact Minecraft and Forge versions.

This milestone does **not** install a complete modpack: it does not import pack configuration or overrides, resolve dependencies, distinguish client-only mods, or download projects from CurseForge. Live CurseForge search and server-pack downloads require CurseForge approval plus a backend that keeps the approved, non-disclosable API key out of the desktop application. Until that is available, download and extract an official server pack yourself, then import only its `mods` folder. See [the CurseForge integration plan](docs/CURSEFORGE_INTEGRATION.md).

## Performance tools

The profiles are intentionally understandable rather than mysterious:

| Profile | Default memory | View distance | Simulation distance | Best for |
| --- | ---: | ---: | ---: | --- |
| Balanced | 4 GB | 12 | 8 | Everyday play |
| Far View | 6 GB | 16 | 6 | Seeing farther without simulating every distant entity |
| Maximum Performance | 6 GB | 10 | 6 | Stable tick time and additional players |

Memory suggestions are capped against available system memory in the UI. Custom values remain available, and simulation distance cannot exceed view distance.

World preparation generates terrain before players travel through it, which removes most exploration-time chunk-generation spikes. Prepared chunks use disk space but do not remain active. Force-loaded regions are different: they stay ticking without a nearby player and therefore consume ongoing CPU and memory. EmberHost keeps those regions deliberately small and bounded.

Every preparation run writes a timestamped safety backup under emberhost-backups inside the server directory. These preparation backups are separate from rolling automatic backups and are never pruned automatically, so their disk use should be reviewed periodically. If EmberHost cannot confirm that autosave was restored after a preparation backup, it stops the server instead of continuing in an unsafe state.

## Automatic world backups

Automatic backups are enabled per server by default, with the first copy due after roughly 15 minutes, then every 6 hours. Settings can change the interval to 1, 3, 6, 12, or 24 hours and retain the newest 1, 3, 5, 7, or 14 automatic copies. A manual **Back up now** action is available even when the schedule is disabled.

EmberHost only copies a world while Minecraft is fully stopped. If a due server is online, it waits until every player disconnects, performs a graceful maintenance stop, copies and checks the active Overworld, Nether, and End, and then starts the server again. Starting, deleting, regenerating, preparing, and backing up the same world are serialized so they cannot mutate it concurrently. Interrupted operations leave a bounded recovery marker instead of silently starting from partial staging data.

Each copy is staged and checked by file count and byte count before it is promoted under `emberhost-backups/automatic`. Retention runs only after a new copy succeeds and only removes recognized automatic backups belonging to that server; world-preparation backups, unknown folders, malformed entries, and symbolic links are never pruned. Automatic backups include world and player data, not plugins, mods, or server configuration.

These copies live beside the server on the same computer. They are useful for recovering from world corruption or mistakes, but they do not protect against failure or loss of that drive. Copy important backups to another disk or an off-site destination for disaster recovery. Scheduling runs only while EmberHost is open; the tray can keep it active while the desktop user remains signed in.

## Requirements

- Windows 10/11, macOS, or a modern Linux desktop
- A supported 64-bit Java runtime for the selected Minecraft release
- The exact Mojang-declared Java major when creating or running Forge; a newer major is not substituted automatically
- Internet access for the initial metadata, server, Forge installer, dependencies, and Chunky downloads
- At least 4 GB of available memory for the recommended Paper profile
- Additional SSD space for worlds, rolling backups, and pregeneration backups

EmberHost reads `javaVersion.majorVersion` from Mojang's selected release metadata. Vanilla and Paper reject an older runtime; Forge requires that major exactly for both installation and startup. If `java` is not on `PATH`, enter the full Java executable path during setup.

## Run from source

Install [Node.js](https://nodejs.org/) 22.12 or newer and pnpm 11, then:

~~~powershell
pnpm install
pnpm dev
~~~

Useful commands:

~~~powershell
pnpm test       # unit and service tests
pnpm build      # typecheck and production bundles
pnpm smoke      # isolated onboarding and dashboard Electron checks
pnpm dist       # platform installer
~~~

## Create and optimize a server

1. Launch EmberHost, choose a server name, and select an official Minecraft release.
2. Keep Paper selected when a stable build exists, choose Vanilla, or choose the Forge build offered from Forge's official promotions metadata.
3. Select a performance profile and review the required Java version, memory, player limit, and port.
4. Read and explicitly accept the [Minecraft EULA](https://www.minecraft.net/en-us/eula).
5. Select **Download & create**, then start the server.
6. Open **Plugins** on a stopped Paper server to browse the curated catalog or add a trusted local plugin JAR. On Forge, open **Mods** to add a trusted local mod JAR or import an extracted server pack's `mods` folder.
7. Open **World Tools** to set a seed or regenerate the active world. Paper servers can also prepare terrain or add small force-loaded regions.
8. Open **Settings** to review the automatic world-backup schedule, retention, and latest checked copy.

Mojang's manifest includes a few very early client releases for which it no longer publishes a server artifact. EmberHost shows those releases but refuses creation with a clear message rather than downloading an unofficial or unverifiable JAR.

To delete a server, stop it, open **Settings**, choose **Delete server**, and enter the server name exactly. EmberHost validates that the folder is one of its managed UUID directories, checks for live or orphaned Java processes, and then moves the complete folder to the recycle bin. Shared download caches are preserved.

To change an existing world's seed, stop the server, open **World Tools**, enter the replacement seed, and choose **Regenerate world**. EmberHost requires the exact server name and clearly confirms that the active Overworld, Nether, End, builds, inventories, and player data are removed first. The old active world folders are moved to the recycle bin; server settings, plugins or mods, and EmberHost backups remain.

Players on the same machine can use localhost:25565. Other devices on the LAN should use the host computer's private IP. Public hosting commonly requires a firewall rule, router port forwarding, and a public IP that is not behind CGNAT. EmberHost does not silently make those security-sensitive changes.

## Where data lives

Runtime data never goes inside the installed app or repository. Settings and large server data share a machine-local application-data root:

~~~text
Machine-local data root/
├─ emberhost.json
├─ artifact-cache/
│  ├─ <paper-sha256-or-mojang-sha1>.jar
│  ├─ forge-<minecraft>-<forge>-<sha1>-installer.jar
│  └─ chunky-<sha512>.jar
└─ servers/
   └─ <instance-uuid>/
      ├─ paper.jar, server.jar, or Forge-generated launch files
      ├─ libraries/                         # modern Forge dependencies and argfiles
      ├─ plugins/
      │  ├─ Chunky.jar
      │  ├─ <additional-plugin>.jar
      │  └─ .emberhost-plugins.json
      ├─ mods/
      │  ├─ <trusted-mod>.jar
      │  └─ .emberhost-mods.json
      ├─ server.properties
      ├─ eula.txt
      ├─ emberhost-instance.json
      ├─ emberhost-performance.json
      ├─ emberhost-backup-policy.json
      ├─ emberhost-console.log
      ├─ emberhost-backups/
      │  └─ automatic/
      │     └─ auto-<timestamp>-<uuid>/
      │        ├─ emberhost-backup.json
      │        └─ <active world folders>/
      └─ world/ or the configured level-name
~~~

On Windows, settings, worlds, and artifacts are under %LOCALAPPDATA%/EmberHost. On macOS, they are under ~/Library/Application Support/EmberHost/runtime-data. On Linux, they use $XDG_DATA_HOME/EmberHost or ~/.local/share/EmberHost.

The version 0.7 store uses schema v3 so each instance can record either a JAR launch target or Forge's platform-specific Java argument files. Schema v1 and v2 data are migrated in place while preserving existing Vanilla and Paper instances. Data written by a newer, unsupported schema is never overwritten or treated as corruption.

## Architecture and safeguards

The React renderer is unprivileged. It has no Node.js or filesystem access and communicates through a narrow, typed preload API. The Electron main process owns downloads, persistence, backups, filesystem writes, Java checks, and child processes.

~~~text
React renderer
    │ validated commands and state events
    ▼
context-isolated preload
    │ narrow IPC contract
    ▼
Electron main process
    ├─ instance service ── Mojang, Paper, Forge, and Modrinth metadata/downloads
    ├─ server manager ──── Java lifecycle, console, and health samples
    ├─ world service ───── serialized world operations, Chunky tasks, and bounded force-loads
    ├─ backup service ──── scheduling, checked snapshots, recovery, and retention
    ├─ plugin service ──── catalog resolution, verified installs, inventory, and removal
    ├─ mod service ─────── local Forge JAR validation, inventory, import, and removal
    └─ atomic store ────── app data and per-instance metadata
~~~

Safeguards include contextIsolation, disabled Node integration, renderer sandboxing, denied navigation and popups, a restrictive CSP, IPC sender checks, Zod validation, UUID server directories, shell-free process spawning, atomic state writes, checksum verification, strict download hosts, redirect rejection, bounded streams, conservative orphan-process detection, safe Forge launch-target checks, archive validation, checked backup staging with strict retention ownership, recoverable deletion, and transactional mod imports and world operations.

## Upstream software and licensing

EmberHost is independent and is not affiliated with or endorsed by Mojang, Microsoft, PaperMC, MinecraftForge, CurseForge, Modrinth, or Chunky.

It does not bundle Minecraft server software, Forge, mods, or optional catalog plugins. Downloads happen on the user's computer only after the user starts the relevant creation or install action. Vanilla comes from [Mojang](https://www.minecraft.net/en-us/download/server), Paper from [PaperMC](https://papermc.io/downloads/paper), Forge promotions and the selected installer from [MinecraftForge](https://files.minecraftforge.net/net/minecraftforge/forge/), and explicitly selected catalog plugins from [Modrinth](https://modrinth.com/). Forge installation follows the files produced by its official installer; EmberHost launches its generated argument files or legacy JAR and does not execute generated scripts.

See the [Minecraft EULA](https://www.minecraft.net/en-us/eula), [PaperMC terms](https://papermc.io/terms), the [official MinecraftForge license](https://github.com/MinecraftForge/MinecraftForge/blob/1.21.x/LICENSE.txt), and each upstream plugin or mod license. CurseForge access is not active in version 0.7; the planned integration must comply with the [CurseForge third-party API terms](https://support.curseforge.com/support/solutions/articles/9000207405-curseforge-3rd-party-api-terms-and-conditions). EmberHost's original source is under the [MIT License](LICENSE); third-party attribution is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Local development installers are unsigned. Production releases should be code-signed and notarized where applicable before distribution.
