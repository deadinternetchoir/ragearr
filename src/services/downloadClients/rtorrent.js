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

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const SSH_BIN = process.env.RTORRENT_SSH_BIN || 'ssh';
const SCP_BIN = process.env.RTORRENT_SCP_BIN || 'scp';
const REMOTE_SCRIPT_PATH = '.ragearr_rtorrent_scgi.py';
const LOCAL_SCRIPT_PATH = path.join(__dirname, 'rtorrent_scgi.py');

function makeClient({ host, user, sshKeyPath, socketPath }) {
  const sshTarget = `${user}@${host}`;
  const sshArgs = () => ['-i', sshKeyPath, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', sshTarget];

  function ssh(remoteCommand) {
    return new Promise((resolve, reject) => {
      execFile(SSH_BIN, [...sshArgs(), remoteCommand], { maxBuffer: 20 * 1024 * 1024, timeout: 30000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve(stdout);
      });
    });
  }

  let _scriptEnsured = false;
  function ensureRemoteScript() {
    if (_scriptEnsured) return Promise.resolve();
    return new Promise((resolve, reject) => {
      execFile(
        SCP_BIN,
        ['-i', sshKeyPath, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', LOCAL_SCRIPT_PATH, `${sshTarget}:${REMOTE_SCRIPT_PATH}`],
        { timeout: 20000 },
        (err, stdout, stderr) => {
          if (err) return reject(new Error(stderr || err.message));
          _scriptEnsured = true;
          resolve();
        }
      );
    });
  }

  // Calls an rTorrent XML-RPC method by name with string params. Returns the
  // Python-repr'd result as a string (good enough for the specific calls
  // this app needs - see docs/prowlarr-notes.md-style notes below on why a
  // fuller XML-RPC-in-Node client wasn't worth building for this).
  async function call(method, ...params) {
    await ensureRemoteScript();
    const quotedParams = params.map((p) => `'${String(p).replace(/'/g, "'\\''")}'`).join(' ');
    const cmd = `python3 ${REMOTE_SCRIPT_PATH} '${socketPath}' '${method}' ${quotedParams}`.trim();
    return ssh(cmd);
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
