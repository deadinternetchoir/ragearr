# Ragearr

A [Servarr](https://wiki.servarr.com/)-family app for finding, downloading, and organizing **music videos** for your media library — the missing piece next to Sonarr, Radarr, and Lidarr.

Named after [*Rage*](https://en.wikipedia.org/wiki/Rage_(TV_program)), the long-running ABC late-night music video program.

> **Status: early development.** Core matching/download logic has been prototyped and used for real; the Servarr-pattern integration (Prowlarr + download clients) described below is in progress. Contributions and design feedback welcome.

## What it does

- Takes a "wanted" list of artist/track pairs (e.g. imported from a Spotify/Apple Music playlist export) and finds music videos for them.
- Pulls releases through **Prowlarr**, so it inherits whatever indexers you already have configured — same as Sonarr/Radarr/Lidarr.
- Sends grabs to your existing **download client** (qBittorrent, SABnzbd, rTorrent, etc.).
- Falls back to a YouTube-based source (via `yt-dlp`) for videos that genuinely aren't available through traditional indexers — common for official/live music videos.
- A review queue for candidate matches — this is deliberately **not** a fully automated black box. Music video releases are messy (lyric videos mislabeled as official, live performances, wrong-song false matches, unofficial reuploads), so Ragearr surfaces its confidence and lets you approve/reject before anything downloads.
- Imports finished files into your media library folder structure and refreshes **Plex** or **Jellyfin** (pluggable target backend — more targets welcome).

## Why not just use Lidarr?

Lidarr handles audio. Nothing in the Servarr family handles the actual *video* side of "music video" — this fills that gap using the same conventions (Prowlarr for indexers, a standard download-client abstraction, a review/wanted-list UI) rather than reinventing acquisition from scratch.

## Quick start

```bash
docker compose up -d
```

See [`docker-compose.yml`](./docker-compose.yml) for configuration. Full setup docs are coming as the Prowlarr/download-client integration lands — see [CONTRIBUTING.md](./CONTRIBUTING.md) if you want to help build it out.

## Architecture

```
├── src/
│   ├── server.js              — app entrypoint
│   ├── db.js                  — SQLite schema + migrations
│   ├── routes/                — REST API
│   ├── services/
│   │   ├── prowlarr.js        — indexer search via Prowlarr's API
│   │   ├── downloadClients/   — qBittorrent/SABnzbd/rTorrent/etc. clients
│   │   ├── youtube.js         — yt-dlp-based fallback source + candidate scoring
│   │   └── mediaServers/
│   │       ├── plex.js
│   │       └── jellyfin.js    — target backends, swappable
│   └── public/                — web UI
├── Dockerfile
└── docker-compose.yml
```

## License

GPL-3.0, matching the rest of the Servarr family.
