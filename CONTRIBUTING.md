# Contributing to Ragearr

This project is early and the shape of things is still settling — genuinely useful contributions right now are more likely to be design discussion (open an issue) than a large PR, since core pieces (indexer integration, download client abstraction) aren't finished yet.

## Areas that need work

- **Prowlarr integration** (`src/services/prowlarr.js`) — searching indexers for a "Music Videos" category release, matching results back to a wanted artist/track.
- **Download clients** (`src/services/downloadClients/`) — qBittorrent, SABnzbd, rTorrent/ruTorrent, Transmission, Deluge. One client per file, matching a shared interface (add/status/remove).
- **Candidate scoring** (`src/services/youtube.js`) — the YouTube fallback path's confidence heuristics (official-channel matching, title/track matching, live-performance fallback rules). This has been prototyped against a real 148-track playlist; the scoring logic is a reasonable starting point but has known gaps (e.g. cover songs matching the original artist's video instead of the covering artist's).
- **Jellyfin target** (`src/services/mediaServers/jellyfin.js`) — currently Plex-only.
- **Web UI** — review queue, wanted-list management, settings.

## Development

Runs on Node.js + SQLite, matching the rest of the app's stack. No build step currently required.

```bash
npm install
npm run dev
```

## Code style

No strict linter config yet — keep it readable, prefer small focused functions, avoid unnecessary abstraction. Comment only where the *why* isn't obvious from the code itself.

## License

By contributing, you agree your contribution is licensed under GPL-3.0, matching the project.
