const APP_NAME = 'ragearr';
const BACKUP_VERSION = 1;

const TABLES = [
  'settings',
  'users',
  'wanted_lists',
  'tracks',
  'candidates',
  'concert_grabs',
  'jobs',
];

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((col) => col.name);
}

function tableRows(db, table) {
  return db.prepare(`SELECT * FROM ${table}`).all();
}

function countsFromData(data) {
  const tables = data?.tables || {};
  return Object.fromEntries(TABLES.map((table) => [table, Array.isArray(tables[table]) ? tables[table].length : 0]));
}

function createBackup(db) {
  const tables = {};
  const schema = {};
  for (const table of TABLES) {
    schema[table] = tableColumns(db, table);
    tables[table] = tableRows(db, table);
  }
  return {
    app: APP_NAME,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    schema,
    counts: countsFromData({ tables }),
    tables,
  };
}

function parseBackup(input) {
  if (typeof input === 'string') return JSON.parse(input);
  return input;
}

function validateBackup(db, input) {
  const backup = parseBackup(input);
  if (!backup || typeof backup !== 'object') throw new Error('Backup is not a JSON object');
  if (backup.app !== APP_NAME) throw new Error('Backup is not a Ragearr backup');
  if (backup.version !== BACKUP_VERSION) throw new Error(`Unsupported backup version: ${backup.version || 'unknown'}`);
  if (!backup.tables || typeof backup.tables !== 'object') throw new Error('Backup is missing tables');

  const currentSchema = {};
  for (const table of TABLES) {
    if (!Array.isArray(backup.tables[table])) {
      if (table === 'users') backup.tables[table] = [];
      else throw new Error(`Backup is missing table: ${table}`);
    }
    currentSchema[table] = tableColumns(db, table);
    const allowed = new Set(currentSchema[table]);
    for (const row of backup.tables[table]) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`Backup table ${table} contains an invalid row`);
      for (const key of Object.keys(row)) {
        if (!allowed.has(key)) throw new Error(`Backup table ${table} has unsupported column: ${key}`);
      }
    }
  }
  // settings.get() JSON.parses every value, so one malformed value would break that setting for good.
  for (const row of backup.tables.settings) {
    try {
      JSON.parse(row.value);
    } catch {
      throw new Error(`Backup setting '${row.key}' does not contain valid JSON`);
    }
  }
  return {
    ok: true,
    backup,
    summary: {
      app: backup.app,
      version: backup.version,
      exportedAt: backup.exportedAt || null,
      counts: countsFromData(backup),
    },
  };
}

function insertRows(db, table, rows) {
  if (!rows.length) return;
  const known = tableColumns(db, table);
  // Rows may carry different keys, so each row is inserted with its own
  // columns (columns it omits take the schema default) instead of every row
  // being forced into the shape of the first one.
  const statements = new Map();
  for (const row of rows) {
    const columns = known.filter((col) => Object.prototype.hasOwnProperty.call(row, col));
    const signature = columns.join(',');
    if (!statements.has(signature)) {
      const quoted = columns.map((col) => `"${col}"`).join(', ');
      const placeholders = columns.map(() => '?').join(', ');
      statements.set(
        signature,
        columns.length
          ? db.prepare(`INSERT INTO ${table} (${quoted}) VALUES (${placeholders})`)
          : db.prepare(`INSERT INTO ${table} DEFAULT VALUES`)
      );
    }
    statements.get(signature).run(...columns.map((col) => row[col]));
  }
}

function restoreBackup(db, input) {
  const { backup, summary } = validateBackup(db, input);
  // A backup with no users (older exports, or one made before accounts existed) must not
  // wipe the accounts that are already here: with no users the API falls back to open
  // bootstrap mode when RAGEARR_API_KEY is unset.
  const keepUsers = backup.tables.users.length === 0;
  const restore = db.transaction(() => {
    db.prepare('DELETE FROM jobs').run();
    db.prepare('DELETE FROM sessions').run();
    db.prepare('DELETE FROM candidates').run();
    db.prepare('DELETE FROM tracks').run();
    db.prepare('DELETE FROM concert_grabs').run();
    db.prepare('DELETE FROM wanted_lists').run();
    if (!keepUsers) db.prepare('DELETE FROM users').run();
    db.prepare('DELETE FROM settings').run();

    insertRows(db, 'settings', backup.tables.settings);
    if (!keepUsers) insertRows(db, 'users', backup.tables.users);
    insertRows(db, 'wanted_lists', backup.tables.wanted_lists);
    insertRows(db, 'tracks', backup.tables.tracks);
    insertRows(db, 'candidates', backup.tables.candidates);
    insertRows(db, 'concert_grabs', backup.tables.concert_grabs);
    insertRows(db, 'jobs', backup.tables.jobs);
    db.prepare("UPDATE jobs SET status = 'failed', message = COALESCE(message, 'Marked failed during restore'), updated_at = datetime('now') WHERE status IN ('queued', 'running')").run();
    // Nothing is running after a restore, so no track can still be downloading.
    db.prepare("UPDATE tracks SET status = 'approved', updated_at = datetime('now') WHERE status = 'downloading'").run();
  });
  restore();
  return { ok: true, restoredAt: new Date().toISOString(), summary };
}

function filename(date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  return `ragearr-backup-${stamp}.json`;
}

module.exports = {
  APP_NAME,
  BACKUP_VERSION,
  TABLES,
  createBackup,
  validateBackup,
  restoreBackup,
  filename,
};
