# Download clients

Each client should export a common interface:

```js
async function getVersion() { /* optional display/test helper */ }
async function addByUrl(url) { /* add a torrent/release */ }
async function listTorrents(fields) { /* current state */ }
async function remove(id, { deleteFiles }) {}
```

`index.js` is the registry/facade used by the API, System/Health, and Settings UI. Register new clients there with:

- `id`, `name`, and `requiredFields`
- `makeClient(config)` returning the interface above
- `publicConfig(config)` for safe settings round-trips
- optional `check(config)` for health/test behavior
- optional `librarySshConn(config)` only if that client also supplies the SSH connection Ragearr can use for library scans and remote thumbnail generation

## rTorrent (`rtorrent.js`) — implemented

Talks to rTorrent over **SSH**, not a network RPC port. rTorrent's own control interface is commonly bound to a local Unix socket only (`network.scgi.open_local` in `rtorrent.rc`), with no network-reachable path — true for the instance this was built and tested against. Rather than requiring the user to open a network XML-RPC port on rTorrent itself (a real security-posture change) or depend on a web proxy's own single-credential auth (e.g. ruTorrent's app-level password, not meant to be shared with another tool), this uses a dedicated SSH key and a small bundled Python script (`rtorrent_scgi.py`, standard library only — implements SCGI framing by hand since no SCGI/XML-RPC client tooling was installed on the box this was tested against) to talk to the local socket directly.

Setup: generate a dedicated SSH keypair, add its public key to the target host's `authorized_keys`, configure `host`/`user`/`sshKeyPath`/`socketPath` when constructing the client. See `docs/prowlarr-notes.md`-adjacent reasoning in the module's own header comment for the full "why."

## Not yet implemented

qBittorrent, SABnzbd, Transmission, Deluge, NZBGet — these typically do have real network-reachable APIs (unlike this rTorrent setup), so they likely don't need the SSH approach at all. Worth checking the specific target's actual reachability before assuming a network API call will work, the way `rtorrent.js`'s header comment documents doing for this one.
