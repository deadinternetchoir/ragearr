// Jellyfin target backend — NOT YET IMPLEMENTED.
//
// Jellyfin's REST API is well-documented (https://api.jellyfin.org/) and
// doesn't have the same NAT/relay-connectivity quirks Plex's does (see
// plex.js) — a direct API key + base URL should be sufficient.
//
// Needs at minimum: trigger a library scan, list items in a library,
// create/update a playlist. Mirror the interface shape in plex.js so
// src/services/mediaServers/index.js can pick a target generically.

function makeClient(/* { baseUrl, apiKey } */) {
  throw new Error('Jellyfin integration not yet implemented — see CONTRIBUTING.md');
}

module.exports = { makeClient };
