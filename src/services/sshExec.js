// Shared SSH/SCP execution helper. Factored out of rtorrent.js so the
// host-key-persistence fix below only has to exist in one place - a second
// hand-rolled copy in a second service is exactly how that class of bug
// (BatchMode=yes ssh failing after every container rebuild because the
// default known_hosts location isn't part of the persistent /config mount)
// would quietly reappear somewhere else.

const { execFile } = require('child_process');

const SSH_BIN = process.env.RAGEARR_SSH_BIN || 'ssh';
const SCP_BIN = process.env.RAGEARR_SCP_BIN || 'scp';

// See rtorrent.js's original comment (same reasoning applies everywhere
// this app opens an SSH connection): the container filesystem is ephemeral
// except for the /config bind mount, so pinning known_hosts there is what
// makes host-key trust survive a rebuild instead of failing outright on
// the first connection after every redeploy.
const KNOWN_HOSTS_PATH = process.env.RAGEARR_KNOWN_HOSTS || '/config/known_hosts';

function commonOpts(sshKeyPath) {
  return [
    '-i', sshKeyPath,
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${KNOWN_HOSTS_PATH}`,
  ];
}

// A root folder mounted straight into the container (see rootFolders.js's
// `local` flag) uses this in place of an SSH connection: the same shell
// commands the library code already builds run through `sh -c` here instead
// of on a remote host, so no caller needs a second code path.
const LOCAL_CONN = Object.freeze({ local: true });

function isLocal(conn) {
  return Boolean(conn && conn.local);
}

// Runs a single remote command over SSH and resolves with stdout.
function sshExec(conn, remoteCommand, { timeout = 30000, maxBuffer = 20 * 1024 * 1024 } = {}) {
  if (isLocal(conn)) {
    return new Promise((resolve, reject) => {
      execFile('sh', ['-c', remoteCommand], { maxBuffer, timeout }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve(stdout);
      });
    });
  }
  const { host, user, sshKeyPath } = conn;
  const target = `${user}@${host}`;
  return new Promise((resolve, reject) => {
    execFile(
      SSH_BIN,
      [...commonOpts(sshKeyPath), target, remoteCommand],
      { maxBuffer, timeout },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve(stdout);
      }
    );
  });
}

// Uploads a local file to a remote path via scp (or copies it, for a local root).
function scpUpload(conn, localPath, remotePath, { timeout = 20000 } = {}) {
  if (isLocal(conn)) {
    return new Promise((resolve, reject) => {
      execFile('cp', [localPath, remotePath], { timeout }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve(stdout);
      });
    });
  }
  const { host, user, sshKeyPath } = conn;
  const target = `${user}@${host}`;
  return new Promise((resolve, reject) => {
    execFile(
      SCP_BIN,
      [...commonOpts(sshKeyPath), localPath, `${target}:${remotePath}`],
      { timeout },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve(stdout);
      }
    );
  });
}

module.exports = { sshExec, scpUpload, LOCAL_CONN, isLocal };
