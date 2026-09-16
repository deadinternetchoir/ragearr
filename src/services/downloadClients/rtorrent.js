// rTorrent download client, controlled over SSH rather than a network RPC
// port. rTorrent's own control interface (SCGI-wrapped XML-RPC) is commonly
// bound to a local Unix socket only, with no network-reachable path at all
// (confirmed true for the instance this was built against: `network.scgi.
// open_local` in rtorrent.rc). Rather than requiring the user to reconfigure
// rTorrent's own security posture (opening a network XML-RPC port) or
// depend on a web-proxy layer's own auth (ruTorrent's app-level password,
// which is single-credential and not meant to be shared with another tool),
// this connects over SSH using its own dedicated key and runs a small
// bundled Python script (rtorrent_scgi.py, stdlib only) against the local
// socket - the same access shape already used elsewhere in this project for
// remote administration.
//
// Implements the shared download-client interface described in
// src/services/downloadClients/README.md.

const path = require('path');
const { sshExec, scpUpload } = require('../sshExec');

const REMOTE_SCRIPT_PATH = '.ragearr_rtorrent_scgi.py';
const LOCAL_SCRIPT_PATH = path.join(__dirname, 'rtorrent_scgi.py');

function makeClient({ host, user, sshKeyPath, socketPath }) {
  const conn = { host, user, sshKeyPath };

  let _scriptEnsured = false;
  async function ensureRemoteScript() {
    if (_scriptEnsured) return;
    await scpUpload(conn, LOCAL_SCRIPT_PATH, REMOTE_SCRIPT_PATH);
    _scriptEnsured = true;
  }

  // Calls an rTorrent XML-RPC method by name with string params. Returns the
  // Python-repr'd result as a string (good enough for the specific calls
  // this app needs - see docs/prowlarr-notes.md-style notes below on why a
  // fuller XML-RPC-in-Node client wasn't worth building for this).
  async function call(method, ...params) {
    await ensureRemoteScript();
    const quotedParams = params.map((p) => `'${String(p).replace(/'/g, "'\\''")}'`).join(' ');
    const cmd = `python3 ${REMOTE_SCRIPT_PATH} '${socketPath}' '${method}' ${quotedParams}`.trim();
    return sshExec(conn, cmd);
  }

  return {
    async getVersion() {
      return (await call('system.client_version')).trim();
    },

    async listTorrents(fields = ['d.name=', 'd.hash=', 'd.complete=']) {
      return call('d.multicall2', '', 'main', ...fields);
    },

    // Add a torrent by URL (magnet link or a .torrent file's direct URL,
    // e.g. from a Prowlarr release's downloadUrl).
    async addByUrl(url) {
      return call('load.start', '', url);
    },

    async remove(infoHash, { deleteFiles } = {}) {
      if (deleteFiles) {
        // erase removes the torrent and its data; delete_tied only removes
        // the torrent entry, leaving downloaded files in place.
        return call('d.erase', infoHash);
      }
      return call('d.delete_tied', infoHash);
    },
  };
}

module.exports = { makeClient };
