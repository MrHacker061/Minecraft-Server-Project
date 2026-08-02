# CurseForge modpack integration

## Current EmberHost milestone

EmberHost can create Forge servers and manage trusted local mod JARs. The Mods screen also accepts the `mods` directory from an extracted official server pack. Direct CurseForge catalog search and downloads are intentionally marked as pending approval in the application.

CurseForge requires an approved, unique `x-api-key`. Its [third-party API terms](https://support.curseforge.com/support/solutions/articles/9000207405-curseforge-3rd-party-api-terms-and-conditions) say that the key is non-transferable and must not be disclosed, so a production key cannot be embedded in an Electron application or sent to its renderer. EmberHost must first [apply for API access](https://support.curseforge.com/support/solutions/articles/9000208346-about-the-curseforge-api-and-how-to-apply-for-a-key) and obtain approval for this server-manager use case and its proposed backend broker.

## Planned approved flow

1. The renderer sends only search text, the exact Minecraft release, and the selected Forge loader to EmberHost's main process.
2. The main process calls an EmberHost-owned HTTPS broker. The CurseForge key stays only in that backend's secret store and is never returned to the desktop application.
3. Search requests use the Minecraft game ID, the modpack class ID, the exact game version, and Forge loader type. EmberHost does not silently substitute a different release.
4. The selected client file is checked for its matching official `serverPackFileId`. The server-pack file must belong to the same project and report `isServerPack`.
5. Downloads use only the URL supplied by CurseForge. The API key is never forwarded to the returned CDN host.
6. EmberHost stages the archive, checks the declared byte length and available hash, rejects unsafe archive paths and symbolic links, and never executes included `.bat`, `.sh`, PowerShell, or installer scripts.
7. The matching client `manifest.json` is validated as CurseForge Minecraft modpack manifest version 1. Its exact Minecraft version and primary `forge-...` loader must match the new server.
8. Mods and safe data directories are promoted transactionally. Missing distribution permission or an unavailable download leaves the import incomplete and sends the user to the official CurseForge page for a manual download.

## Security and product rules

- Do not bundle, log, persist, or expose the CurseForge API key.
- Do not scrape project pages or derive CDN URLs.
- Do not persist CurseForge catalog responses unless the approved agreement explicitly allows it.
- Do not automatically convert a client-only pack into a server pack; client-only mods cannot be identified reliably from the export manifest alone.
- Do not start an incompletely imported pack.
- Treat every mod as executable code with the same operating-system access as the Minecraft Java process.
- Keep a per-file project/file ID and verified hash after an approved install, subject to the approved data-retention terms.

The relevant protocol is documented by the [official CurseForge REST API](https://docs.curseforge.com/rest-api/). Until approval is complete, the supported path is to download an official server pack from CurseForge, extract it locally, and import its `mods` directory into a stopped Forge server.
