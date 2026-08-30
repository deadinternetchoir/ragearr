# Download clients

Not yet implemented. Each client should export a common interface:

```js
async function addRelease({ downloadUrl, category }) { /* returns a client-specific job id */ }
async function getStatus(jobId) { /* returns { complete: bool, progress: 0-1, savePath } */ }
async function remove(jobId, { deleteFiles }) {}
```

Planned, matching what the rest of the Servarr family supports: qBittorrent, SABnzbd, rTorrent/ruTorrent, Transmission, Deluge, NZBGet. One file per client (`qbittorrent.js`, `sabnzbd.js`, etc.), matching the shared interface above so `src/services/downloadClients/index.js` can dispatch to whichever the user has configured.

See CONTRIBUTING.md.
