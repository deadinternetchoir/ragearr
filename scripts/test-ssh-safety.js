#!/usr/bin/env node
// Checks how SSH/SCP commands are assembled, using fake ssh/scp binaries (no
// network, no real ssh). The fake ssh runs the remote command locally under
// `sh -c`, with a fake python3 on PATH that just echoes its arguments.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ragearr-ssh-'));
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
const argLog = path.join(tmp, 'ssh-args.log');

fs.writeFileSync(
  path.join(bin, 'fake-ssh'),
  `#!/bin/sh
# record every argument on its own line, then run the last one (the remote command) locally
for a in "$@"; do printf '%s\\n' "$a" >> "${argLog}"; last="$a"; done
printf -- '---\\n' >> "${argLog}"
exec sh -c "$last"
`,
  { mode: 0o755 }
);
fs.writeFileSync(
  path.join(bin, 'fake-scp'),
  `#!/bin/sh
for a in "$@"; do printf '%s\\n' "$a" >> "${argLog}"; done
printf -- '---\\n' >> "${argLog}"
`,
  { mode: 0o755 }
);
fs.writeFileSync(path.join(bin, 'python3'), '#!/bin/sh\nshift\nfor a in "$@"; do printf "%s\\n" "$a"; done\n', { mode: 0o755 });

process.env.RAGEARR_SSH_BIN = path.join(bin, 'fake-ssh');
process.env.RAGEARR_SCP_BIN = path.join(bin, 'fake-scp');
process.env.RAGEARR_DATA_DIR = path.join(tmp, 'data');
process.env.PATH = `${bin}:${process.env.PATH}`;

const db = require('../src/db');
const settings = require('../src/services/settings');
const { sshExec, scpUpload } = require('../src/services/sshExec');
const rtorrent = require('../src/services/downloadClients/rtorrent');
const downloadClients = require('../src/services/downloadClients');
const systemHealth = require('../src/services/systemHealth');
const rootFolders = require('../src/services/rootFolders');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function lastCall() {
  const calls = fs.readFileSync(argLog, 'utf8').split('---\n').filter(Boolean);
  return calls[calls.length - 1].split('\n').filter((l) => l !== '');
}

async function main() {
  // A user/host that looks like an ssh option must not be parsed as one
  // (e.g. -oProxyCommand=... would run a local command).
  const evil = { host: 'example.test', user: '-oProxyCommand=touch /tmp/never', sshKeyPath: '/k' };
  await sshExec(evil, 'true').catch(() => {});
  let args = lastCall();
  const target = `${evil.user}@${evil.host}`;
  assert(args.includes(target), 'ssh target missing from args');
  assert(args[args.indexOf(target) - 1] === '--', 'ssh target must follow "--" so it cannot be read as an option');

  await scpUpload(evil, '/local/file', '/remote/file').catch(() => {});
  args = lastCall();
  assert(args.includes('--'), 'scp must separate options from operands with "--"');
  assert(args.indexOf('--') < args.indexOf('/local/file'), 'scp operands must follow "--"');

  // rTorrent socket path is interpolated into a remote shell command.
  const marker = path.join(tmp, 'pwned-socket');
  const hostile = `/run/rt.sock'; touch '${marker}'; echo '`;
  const client = rtorrent.makeClient({ host: 'h', user: 'u', sshKeyPath: '/k', socketPath: hostile });
  const out = (await client.getVersion()).split('\n');
  assert(!fs.existsSync(marker), 'socketPath was executed as shell code');
  assert(out[0] === hostile, `socketPath should reach the script verbatim, got ${JSON.stringify(out[0])}`);

  // ...and in the health check for the configured client.
  const marker2 = path.join(tmp, 'pwned-check');
  settings.set('downloadClient', { type: 'rtorrent' });
  settings.set('rtorrent', { host: 'h', user: 'u', sshKeyPath: '/k', socketPath: `/nope'; touch '${marker2}'; echo '` });
  await downloadClients.checkActive();
  assert(!fs.existsSync(marker2), 'rtorrent health check executed socketPath as shell code');

  // Library path checks quote the root path too.
  const marker3 = path.join(tmp, 'pwned-root');
  rootFolders.saveConfig({ musicVideoRootFolders: `Evil|/nope'; touch '${marker3}'; echo '|local` });
  await systemHealth.checkLibraryPaths();
  assert(!fs.existsSync(marker3), 'library path health check executed the root path as shell code');
}

main()
  .then(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('SSH safety tests OK');
  })
  .catch((e) => {
    fs.rmSync(tmp, { recursive: true, force: true });
    console.error(e.message);
    process.exit(1);
  });
