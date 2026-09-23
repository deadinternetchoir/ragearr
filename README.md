# Ragearr

Ragearr is an early-alpha [Servarr](https://wiki.servarr.com/)-family app for finding, downloading, reviewing, and organizing **music videos** for a media library.

It is designed for the gap next to Sonarr, Radarr, and Lidarr: one tracked item per song, candidate review before download, quality profiles, monitored/unmonitored state, import lists, manual import, root folders, backup/restore, health checks, and local user auth.

The name is a nod to the long-running Australian music-video program *Rage*, plus the usual `arr` suffix. Ragearr is not affiliated with ABC or the Servarr projects.

> **Status: alpha.** Ragearr works against a real library, but the project is still young. Expect rough edges, missing integrations, and schema/UI changes. Do not expose it directly to the public internet without a trusted reverse proxy, TLS, and an auth plan.

## Current Features

**Per-track music videos**
- Import wanted tracks from YouTube playlist URLs, Spotify playlist URLs, Spotify CSV exports, pasted CSV/plain text, or URL-backed CSV/plain text.
- Preview and de-dupe import lists before writing anything.
- Search YouTube via `yt-dlp`, score candidates, and show confidence/reasoning before download.
- Reject common false positives such as lyric videos, visualizers, playthroughs, tutorials, live performances, and low-motion/static-image uploads.
- Approve candidates into a background download queue instead of blocking the UI.
- Use quality profiles/cutoffs for `yt-dlp` format selection.
- Track monitored/unmonitored state.
- Attach existing files manually, or move/rename them into Ragearr's library layout.
- Scan one or more library root folders (local mounts or over SSH) and import existing files it finds.
- Show YouTube thumbnails or generated frame thumbnails where available.

**Arr-style app features**
- Local users and 30-day browser sessions.
- API-key bootstrap/recovery auth.
- Admin/user roles.
- Settings pages for Prowlarr, Spotify, download client, library roots, quality profiles, release-profile scoring rules, Connect/Discord notifications, backup/restore, and users.
- Servarr-style System/Health checks.
- JSON backup/export/preview/restore for app data. Backups include users, settings, wanted lists, tracks, candidates, concert grabs, and activity history; active sessions and media files are not copied.
- Non-destructive smoke test and focused parser/settings tests.

**Concert releases**
- Ragearr can search full concert/live-show releases through Prowlarr and dispatch grabs through the active download-client interface.
- rTorrent over SSH/SCGI and qBittorrent WebUI are implemented today.
- Other concrete download clients are not implemented yet.

## Quick Start

```bash
git clone https://github.com/deadinternetchoir/ragearr.git
cd ragearr
cp docker-compose.yml docker-compose.override.yml
```

Edit `docker-compose.override.yml` for your paths, timezone, and bootstrap key:

```yaml
services:
  ragearr:
    environment:
      - TZ=Etc/UTC
      - RAGEARR_API_KEY=replace-with-a-long-random-key
      # optional: owner for files Ragearr writes into local roots (e.g. your media server's user)
      - RAGEARR_LOCAL_UID=1000
      - RAGEARR_LOCAL_GID=1000
    volumes:
      - ./config:/config
      - /path/to/your/MusicVideos:/musicvideos
```

Then in **Settings -> Library**, add the mounted folder as a local root: `Music Videos | /musicvideos | local`.

Then start it:

```bash
docker compose up -d
```

Open `http://localhost:5299`.

On first use:

1. Sign in with the API key from `RAGEARR_API_KEY`.
2. Go to **Settings -> Users**.
3. Create your first admin user.
4. Log out and sign back in with username/password.
5. Keep the API key as a recovery credential.

If `RAGEARR_API_KEY` is not configured and no users exist yet, Ragearr opens the API in bootstrap-admin mode so the first user can be created. This is convenient for local testing, but not recommended for shared networks.

## Configuration Notes

- **Data directory:** `/config` holds SQLite data, settings, generated thumbnails, and app state.
- **Auth:** API key is accepted via `X-Api-Key`, `Authorization: Bearer <key>`, or `?apikey=...`; user sessions use bearer tokens.
- **Spotify:** Direct Spotify playlist imports require a Spotify app client ID/secret in Settings. Spotify CSV exports work without credentials.
- **Prowlarr:** Used for full concert/live-show release search, not per-track music-video search.
- **Download clients:** rTorrent talks over SSH and a local SCGI socket; qBittorrent talks to the WebUI API. See `src/services/downloadClients/README.md`.
- **Library roots:** Configure roots from Settings, one per line as `Name | /path`. A root mounted into the container is written `Name | /path | local` and is accessed directly; any other root is reached over the SSH connection of an SSH-capable download client (rTorrent). qBittorrent can receive concert grabs, but does not provide SSH access, so use local roots with it.
- **File ownership:** the container runs as root. Set `RAGEARR_LOCAL_UID`/`RAGEARR_LOCAL_GID` so files Ragearr writes into local roots are owned by your media user (directories 775, files 664) and stay manageable by other apps.
- **Security:** Ragearr is alpha software. Put it behind a reverse proxy with TLS and restrict access before exposing it beyond a trusted LAN/VPN.

## Tests

Against a running instance:

```bash
RAGEARR_BASE_URL=http://127.0.0.1:5299 RAGEARR_API_KEY=your-key npm run smoke
```

Focused local checks:

```bash
npm run test:import-lists
npm run test:candidate-rules
npm run test:spotify
npm run test:root-folders
npm run test:backups
npm run test:users
npm run test:download-clients
npm run test:local-library
```

## Architecture

```
src/
  server.js               Express app entrypoint
  db.js                   SQLite schema and idempotent migrations
  routes/api.js           REST API
  services/
    youtube.js            YouTube search, scoring, static-video checks, downloads
    importLists.js        YouTube/Spotify/CSV/plain-text import parsing
    spotify.js            Spotify client-credentials playlist import
    rootFolders.js        Library root-folder settings normalization
    backups.js            JSON backup export/preview/restore
    users.js              Local users, password hashes, and sessions
    library.js            Library scans (local or SSH) and manual-import file search
    notifications.js      Connect/Discord webhook notifications
    qualityProfiles.js    yt-dlp quality/cutoff profiles
    candidateRules.js     Release-profile style scoring settings
    systemHealth.js       Servarr-style health checks
    thumbnails.js         YouTube thumbnails and generated frame thumbnails
    downloadClients/      Download-client registry; rTorrent and qBittorrent
  public/                 Vanilla HTML/CSS/JS UI
scripts/
  smoke-api.js            Non-destructive API smoke test
  test-*.js               Focused no-framework regression checks
```

## Why Not Just Use Lidarr?

Lidarr tracks music releases and albums. Music videos are a different item model: one video file per song, visual false positives, no reliable music-video-specific torrent category, and a workflow closer to Radarr's per-item review/import shape than Lidarr's album hierarchy.

Ragearr stays small: Node, Express, SQLite, vanilla JS, and the same surrounding tools many Servarr users already run.

## License

GPL-3.0, matching the rest of the Servarr family.
