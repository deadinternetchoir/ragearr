// Prowlarr integration — NOT YET IMPLEMENTED.
//
// Intended shape: query Prowlarr's /api/v1/search endpoint (categories
// restricted to a "Music Videos" category where an indexer offers one),
// scoring/filtering results the same way Sonarr/Radarr do — by matching
// release titles against the wanted artist/track, preferring indexers the
// user has ranked higher, and respecting any configured quality profile.
//
// See https://wiki.servarr.com/prowlarr/api for the real API shape before
// building this out. Contributions welcome — see CONTRIBUTING.md.

async function search(/* { artist, trackName } */) {
  throw new Error('Prowlarr integration not yet implemented — see CONTRIBUTING.md');
}

module.exports = { search };
