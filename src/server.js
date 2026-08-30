const express = require('express');
const path = require('path');
const db = require('./db');
const apiRouter = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 5299;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', apiRouter);

app.get('/api/health', (req, res) => {
  const trackCount = db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n;
  res.json({ status: 'ok', tracks: trackCount });
});

app.listen(PORT, () => {
  console.log(`Ragearr listening on port ${PORT}`);
});
