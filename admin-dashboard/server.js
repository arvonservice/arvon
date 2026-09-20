const express = require('express');
const session = require('express-session');
const path = require('path');
const db = require('../lib/db');

const app = express();
const PORT = process.env.ADMIN_PORT || 3001;

app.use(session({
  secret: 'arvon-admin-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' }
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function requireAdminAuth(req, res, next) {
  if (!req.session.adminAuth) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  const adminPassword = 'Admin@2026Arvon';

  if (password === adminPassword) {
    req.session.adminAuth = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Invalid password' });
});

app.post('/api/logout', (req, res) => {
  req.session.adminAuth = false;
  res.json({ ok: true });
});

app.get('/api/tournaments', requireAdminAuth, (req, res) => {
  res.json(db.getTournaments());
});

app.post('/api/tournaments', requireAdminAuth, (req, res) => {
  try {
    const { name, description, mode, maxParticipants, prizePool } = req.body || {};
    const t = db.createTournament(name, description, mode, maxParticipants, prizePool);
    res.json({ ok: true, tournament: t });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.patch('/api/tournaments/:id', requireAdminAuth, (req, res) => {
  try {
    const t = db.updateTournament(Number(req.params.id), req.body || {});
    res.json({ ok: true, tournament: t });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/tournaments/:id', requireAdminAuth, (req, res) => {
  try {
    db.deleteTournament(Number(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Admin Dashboard sur http://localhost:${PORT}`);
});
