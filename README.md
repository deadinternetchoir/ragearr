# Ragearr

A [Servarr](https://wiki.servarr.com/)-family app for finding, downloading, and organizing **music videos** for your media library — the missing piece next to Sonarr, Radarr, and Lidarr.

Named after [*Rage*](https://en.wikipedia.org/wiki/Rage_(TV_program)), the long-running ABC late-night music video program.

> **Status: early development.** Core matching/download logic has been prototyped and used for real; the Servarr-pattern integration (Prowlarr + download clients) described below is in progress. Contributions and design feedback welcome.

## What it does

Two distinct features, deliberately kept separate — see [docs/prowlarr-notes.md](./docs/prowlarr-notes.md) for why:

**Per-track music videos** (the primary path):
- Takes a "wanted" list of artist/track pairs (e.g. imported from a Spotify/Apple Music playlist export) and finds a music video for each one.
- Sourced via YouTube (`yt-dlp`) — validated against a real 148-track playlist and tuned from real false positives (wrong-song matches, lyric videos mislabeled as official, unofficial reuploads). Indexer-based sources (Prowlarr) were tried first and found not to work for this: indexer "Music Video" categories are populated with full concert films, not individual song clips.
- A review queue for candidates, not full automation — Ragearr surfaces its confidence tier (high/medium/none) and its reasoning; you approve before anything downloads.
- Imports finished files into your media library folder structure and refreshes **Plex** or **Jellyfin** (pluggable target backend — more targets welcome).

**Concerts** (a distinct, artist-level feature):
- Pulls full concert films / live-show releases through **Prowlarr**, so it inherits whatever indexers you already have configured — same as Sonarr/Radarr/Lidarr.
- Sends grabs to your existing **download client** (qBittorrent, SABnzbd, rTorrent, etc. — not yet implemented, see CONTRIBUTING.md).

## Why not just use Lidarr?

Considered forking Lidarr (or Radarr — architecturally the closer fit, since its per-item video/quality-profile model matches "one music video file per song" better than Lidarr's audio-album hierarchy) instead of building standalone. Decided against it: this exact feature has been an [open, unresolved Lidarr issue since 2019](https://github.com/lidarr/Lidarr/issues/762), and the one real prior attempt at a companion tool has been abandoned since 2020. Forking and tracking an actively-developed ~300MB C#/.NET codebase is a heavy, ongoing burden for a solo/small effort. Ragearr integrates with the same tools (Prowlarr, download clients) without inheriting that maintenance cost.

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
