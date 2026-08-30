const express = require('express');
const db = require('../db');

const router = express.Router();

// --- Wanted lists ---

router.get('/wanted-lists', (req, res) => {
  const rows = db.prepare('SELECT * FROM wanted_lists ORDER BY created_at DESC').all();
  res.json(rows);
});

router.post('/wanted-lists', (req, res) => {
  const { name, source_type } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const info = db
    .prepare('INSERT INTO wanted_lists (name, source_type) VALUES (?, ?)')
    .run(name, source_type || 'manual');
  res.status(201).json({ id: info.lastInsertRowid, name, source_type: source_type || 'manual' });
});

// --- Tracks ---

router.get('/tracks', (req, res) => {
  const { wanted_list_id, status } = req.query;
  let sql = 'SELECT * FROM tracks WHERE 1=1';
  const params = [];
  if (wanted_list_id) {
    sql += ' AND wanted_list_id = ?';
    params.push(wanted_list_id);
  }
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  sql += ' ORDER BY id';
  res.json(db.prepare(sql).all(...params));
});

router.post('/tracks', (req, res) => {
  const { wanted_list_id, artist, track_name, album, duration_sec, source_uri } = req.body;
  if (!artist || !track_name) {
    return res.status(400).json({ error: 'artist and track_name are required' });
  }
  const info = db
    .prepare(
      `INSERT INTO tracks (wanted_list_id, artist, track_name, album, duration_sec, source_uri)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(wanted_list_id || null, artist, track_name, album || null, duration_sec || null, source_uri || null);
  res.status(201).json({ id: info.lastInsertRowid });
});

// --- Candidates (review queue) ---

router.get('/tracks/:id/candidates', (req, res) => {
  const rows = db.prepare('SELECT * FROM candidates WHERE track_id = ? ORDER BY score DESC').all(req.params.id);
  res.json(rows);
});

router.post('/candidates/:id/select', (req, res) => {
  const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id);
  if (!candidate) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE candidates SET selected = 0 WHERE track_id = ?').run(candidate.track_id);
  db.prepare('UPDATE candidates SET selected = 1 WHERE id = ?').run(candidate.id);
  db.prepare("UPDATE tracks SET status = 'approved', updated_at = datetime('now') WHERE id = ?").run(candidate.track_id);
  res.json({ ok: true });
});

module.exports = router;
