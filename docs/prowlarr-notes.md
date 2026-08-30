# Notes on Prowlarr integration

## Real finding: indexer "Music Video" categories are concert/live-show releases, not per-song clips

Validated against a real Prowlarr instance with 7 configured indexers (a mix of private torrent trackers and Usenet indexers). Only 2 of them had a genuine dedicated music-video category — the rest had zero, or a false-positive match on an unrelated category (e.g. matching `WMV` as a file-extension category, not an actual "music video" category — filter carefully).

Searching those categories for **individual tracks** ("Architects Blackhole", "Silverstein Poison Pill") returned **zero results**. Searching **broadly by artist** ("Metallica", "Bring Me The Horizon") returned dozens of results — but every one was a **full concert film, live DVD rip, or live stream release**, never a standalone single-song music video clip.

This makes sense once you think about scene/tracker release conventions: nobody releases a discrete torrent for one 3-minute official video. "Music Videos" as a tracker category means full concert/live-show collections.

**Consequence for this app's architecture:** Prowlarr is not a substitute for the YouTube-based per-track pipeline (`src/services/youtube.js`) — it's a different, complementary feature: acquiring full concert films/live shows, scoped per-artist rather than per-track. Keep these as two separate features (`tracks` + per-track candidates vs. a `concerts` search), not one unified pipeline.

## Category IDs are indexer-specific — don't hardcode them

Prowlarr assigns categories a numeric ID that's specific to each indexer's own capability mapping (private/custom categories commonly show up in the `100000+` range). **A category ID validated against one Prowlarr instance's indexers will not be valid on a different user's instance with different indexers configured.** `src/services/prowlarr.js` looks these up dynamically by matching category **names** (`/music.?video/i` against each indexer's `capabilities.categories`) rather than hardcoding IDs, so it works across different users' indexer setups.

## API shape (validated live)

- Base: `<prowlarr base url>/api/v1/`, auth via `apikey` query param (found in Prowlarr's own `config.xml`, `<ApiKey>` element — not exposed any other way via the API itself).
- `GET /indexer` — lists configured indexers, including `capabilities.categories` (what to scan for a music-video-named category).
- `GET /search?query=<text>&indexerIds=<id>&indexerIds=<id>&categories=<id>&categories=<id>&type=search` — `indexerIds` and `categories` are repeatable query params (array), not comma-joined.
- A plain-text query like `"Architects Blackhole music video"` returns **worse** results than just `"Architects Blackhole"` — release titles don't literally contain the words "music video," so appending them as literal query text just adds noise. Search by artist name, and restrict via the `categories` parameter instead of query text.
