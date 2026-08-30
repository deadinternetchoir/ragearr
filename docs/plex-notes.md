# Notes on talking to Plex

Things that weren't obvious and cost real debugging time — worth knowing before touching `src/services/mediaServers/plex.js`.

## Reaching a Plex server with no direct port forward

If Plex isn't reachable via a LAN IP or a forwarded port (true for some seedbox/VPS hosting — Plex may run in a network namespace the rest of the host can't reach directly, relying entirely on Plex's own remote-access infrastructure), don't assume `localhost`/a private IP will work. Instead:

1. Get an auth token via the [PIN-based OAuth flow](https://forums.plex.tv/t/authenticating-with-plex/609370) (`POST https://plex.tv/api/v2/pins`, then poll `GET https://plex.tv/api/v2/pins/:id` until `authToken` is set, after the user approves the linked device at `https://plex.tv/link`).
2. Call `GET https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1` with that token to get every reachable connection URI for the account's servers.
3. Each server typically has 2-3 connections: a `local: true` one (only reachable on the server's own LAN — often useless for a remote client), a `relay: true` one (goes through Plex's relay infrastructure — requires a full Plex client handshake, not just a raw HTTPS request, so plain `curl`/`fetch` will fail the TLS handshake), and sometimes a third `local: false, relay: false` one — a direct externally-reachable connection Plex negotiated for itself (e.g. a NAT-forwarded port on a seedbox). **That third kind is the one to use** for a plain HTTP client.

## Known flakiness

The direct (non-relay) connection can intermittently return a bare `401 Unauthorized` even with a valid, working token, then succeed again seconds later on retry — hasn't been root-caused, but a retry-with-backoff wrapper (see `plex.js`) reliably works around it. Don't assume a single 401 means the token is bad.

## `force=1` on a section refresh needs local/trusted access

`GET /library/sections/:id/refresh?force=1` 401s over a remote token-only connection — it appears to require the request originate from a genuinely local/trusted client. A plain `GET /library/sections/:id/refresh` (no `force`) works fine remotely and is sufficient — Plex detects changed file sizes/mtimes on its own without needing a forced full rescan.

## Creating a "Music Videos" library (Plex has no dedicated music-video type)

Plex removed the standalone music-video library type years ago. The working combination for a personal-media/"Other Videos"-style library via the API:

- `agent=com.plexapp.agents.none` (the **legacy** agent identifier — the modern `tv.plex.agents.none` "Plex Personal Media" agent exists too, but pairing it with the scanner below returns `"new scanner needs to be paired with new agent"`)
- `scanner=Plex Video Files Scanner`
- `language=xn` (Plex's "no language" code — omitting `language` entirely, or passing `en`/`en-US`, both get rejected as `'language' is invalid` for this agent)
- `location[]=<path>` — **note the `[]`**. A bare `location=<path>` key is silently ignored (treated as if no location were given at all, which itself causes a generic, unhelpful `400 Bad Request` with no message body).

## External subtitle files need more than one refresh pass

Adding a sidecar `.srt` (named `<video basename>.<lang>.srt`, e.g. `Song.en.srt` next to `Song.mkv`) doesn't show up after a single `refresh` call, even after waiting. What worked:

1. `GET /library/sections/:id/refresh` (the whole-section "scan library files" pass)
2. Wait ~20-45s
3. The subtitle stream then appears — but **only** on the single-item detail endpoint (`GET /library/metadata/:ratingKey`), not on the bulk section listing (`GET /library/sections/:id/all`), which doesn't include the nested `Media[].Part[].Stream[]` array at all. Check per-item, not the bulk listing, when verifying a subtitle (or any stream-level detail) actually landed.

## Legacy Plex metadata agent bundles are dead

Third-party Plex "Agent" bundles (the old Python `Framework.bundle`-based plugins some guides still reference for niche metadata sources) stopped working entirely as of Plex Media Server 1.41.7.9717 (April 2025) — Plex removed the legacy agent framework outright. Don't build against that pattern; it won't load on any current server.

## AV1 and Shield TV

No released NVIDIA Shield TV model (2015 through the 2019 refresh — no newer model exists) has hardware AV1 decode, and software decode at 4K isn't viable on that hardware. If a client reports videos "won't play at all" rather than buffering/transcoding, check the video codec before assuming a library/scan problem — `bestvideo[vcodec!*=av01]+bestaudio/best` in a yt-dlp format selector avoids this at download time. YouTube doesn't offer H.265/HEVC at any resolution as an alternative; VP9 is the fallback that's broadly hardware-decodable on Shield TV (added in the 2017 refresh) and available at the same resolutions AV1 is.
