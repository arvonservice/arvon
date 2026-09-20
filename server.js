const crypto = require('crypto');
const express = require('express');
const http = require('http');
const path = require('path');
const session = require('express-session');
const { Server } = require('socket.io');
const { PublicKey } = require('@solana/web3.js');
const { GameEngine, MIN_STAKE_USD } = require('./lib/game');
const db = require('./lib/db');
const escrow = require('./lib/escrow');

function isValidSolanaAddress(value) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) return false;
  try {
    new PublicKey(value);
    return true;
  } catch (e) {
    return false;
  }
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 },
});

app.use(sessionMiddleware);
app.use(express.json({ limit: '800kb' }));
// no-store : evite qu'un navigateur affiche une version en cache du site apres une
// mise a jour (le probleme classique du "je vois pas mes changements, j'ai pourtant
// rafraichi la page").
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
}));
io.engine.use(sessionMiddleware);

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Non connecte' });
  next();
}

app.post('/api/register', (req, res) => {
  try {
    const { username, password, customWord } = req.body || {};
    const { user, recoveryWords, customWord: savedCustomWord } = db.createUser(username, password, customWord);
    req.session.userId = user.id;
    res.json({ ok: true, user: db.publicProfile(user), recoveryWords, customWord: savedCustomWord });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/account/recover', (req, res) => {
  try {
    const { words, newUsername, newPassword, newCustomWord } = req.body || {};
    if (!Array.isArray(words) || words.length !== 6) {
      return res.status(400).json({ error: 'Il faut fournir les 5 mots secrets et ton mot personnalise.' });
    }
    const { user, recoveryWords, customWord } = db.resetAccountWithRecoveryWords(words, newUsername, newPassword, newCustomWord);
    req.session.userId = user.id;
    res.json({ ok: true, user: db.publicProfile(user), recoveryWords, customWord });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.getUserByUsername(username);
  if (!user || !db.verifyPassword(String(password || ''), user.passwordHash)) {
    return res.status(400).json({ error: 'Identifiants incorrects' });
  }
  req.session.userId = user.id;
  res.json({ ok: true, user: db.publicProfile(user) });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  const user = req.session.userId ? db.getUserById(req.session.userId) : null;
  res.json({ user: db.publicProfile(user) });
});

app.post('/api/profile', requireAuth, (req, res) => {
  try {
    const user = db.updateProfile(req.session.userId, req.body || {});
    res.json({ ok: true, user: db.publicProfile(user) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/leaderboard', (req, res) => {
  res.json(db.getLeaderboard());
});

app.get('/api/me/recap', requireAuth, (req, res) => {
  const { matches, windowLabel } = db.getUserRecentMatches(req.session.userId, 12);
  const avgPnl = matches.length ? matches.reduce((s, m) => s + m.pnlPct, 0) / matches.length : 0;
  const bestPnl = matches.length ? Math.max(...matches.map((m) => m.pnlPct)) : 0;
  res.json({
    matches: matches.map((m) => ({ pnlPct: m.pnlPct, ts: m.ts, result: m.result })),
    windowLabel,
    avgPnl: Math.round(avgPnl * 100) / 100,
    bestPnl: Math.round(bestPnl * 100) / 100,
  });
});

app.post('/api/tournaments/:id/join', requireAuth, (req, res) => {
  try {
    db.joinTournament(Number(req.params.id), req.session.userId);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/tournaments/:id/leave', requireAuth, (req, res) => {
  try {
    db.leaveTournament(Number(req.params.id), req.session.userId);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/users/search', (req, res) => {
  const results = db.searchUsers(req.query.q, req.session.userId || null);
  res.json(results);
});

app.get('/api/users/:id', (req, res) => {
  const user = db.getUserById(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'Joueur introuvable' });
  res.json({ user: db.publicProfile(user) });
});

app.get('/api/wallet/info', async (req, res) => {
  res.json({
    ready: escrow.isReady(),
    mint: escrow.getMintAddress(),
    minStake: MIN_STAKE_USD,
    feeRatePct: Number(process.env.PLATFORM_FEE_RATE || 0.15) * 100,
  });
});

app.get('/api/wallet/balance', async (req, res) => {
  if (!escrow.isReady()) return res.json({ balance: 0, ready: false });
  const address = String(req.query.address || '');
  if (!isValidSolanaAddress(address)) return res.status(400).json({ error: 'Adresse invalide' });
  const balance = await escrow.getBalance(address);
  res.json({ balance, ready: true });
});

const engine = new GameEngine(io);

io.on('connection', (socket) => {
  const session = socket.request.session;
  const user = session && session.userId ? db.getUserById(session.userId) : null;
  engine.registerPlayer(socket, user);

  socket.on('connectWallet', (wallet) => {
    const trimmed = typeof wallet === 'string' ? wallet.trim() : '';
    if (!isValidSolanaAddress(trimmed)) {
      socket.emit('walletError', 'Adresse Solana invalide.');
      return;
    }
    engine.setWallet(socket.id, trimmed);
    socket.emit('walletConnected', trimmed);
  });

  socket.on('disconnectWallet', () => {
    engine.clearWallet(socket.id);
  });

  socket.on('findMatch', ({ mode, duration, cash } = {}) => {
    engine.joinQueue(socket.id, mode, duration, !!cash);
  });

  socket.on('cancelQueue', () => {
    engine.leaveQueue(socket.id);
  });

  socket.on('findBrMatch', ({ cash } = {}) => {
    engine.joinBrQueue(socket.id, !!cash);
  });

  socket.on('cancelBrQueue', () => {
    engine.leaveBrQueue(socket.id);
  });

  socket.on('cashStakePrepare', async ({ pendingId, amount } = {}, ack) => {
    const result = await engine.prepareCashStake(socket.id, pendingId, amount);
    if (typeof ack === 'function') ack(result);
  });

  socket.on('cashStakeConfirm', async ({ pendingId, signedTx, amount } = {}, ack) => {
    const result = await engine.confirmCashStake(socket.id, pendingId, signedTx, amount);
    if (result.error) socket.emit('matchError', result.error);
    if (typeof ack === 'function') ack(result);
  });

  socket.on('cashStakeDecline', ({ pendingId } = {}) => {
    engine.declineCashStake(socket.id, pendingId);
  });

  socket.on('brStakePrepare', async ({ pendingId, amount } = {}, ack) => {
    const result = await engine.prepareBrStakeDeposit(socket.id, pendingId, amount);
    if (typeof ack === 'function') ack(result);
  });

  socket.on('brStakeConfirm', async ({ pendingId, signedTx, amount } = {}, ack) => {
    const result = await engine.confirmBrStakeDeposit(socket.id, pendingId, signedTx, amount);
    if (result.error) socket.emit('matchError', result.error);
    if (typeof ack === 'function') ack(result);
  });

  socket.on('brStakeDecline', ({ pendingId } = {}) => {
    engine.declineBrStake(socket.id, pendingId);
  });

  socket.on('leaveBrSpectate', () => {
    const player = engine.players.get(socket.id);
    if (player && player.matchId) socket.leave(player.matchId);
  });

  socket.on('challengeUser', ({ targetUserId, duration, cash } = {}) => {
    const result = engine.sendChallenge(socket.id, Number(targetUserId), duration, !!cash);
    if (result.error) socket.emit('matchError', result.error);
    else socket.emit('challengeSent', { challengeId: result.challengeId });
  });

  socket.on('challengeRespond', ({ challengeId, accept } = {}) => {
    const result = engine.respondChallenge(socket.id, challengeId, !!accept);
    if (result.error) socket.emit('matchError', result.error);
  });

  socket.on('disconnect', () => {
    engine.disconnect(socket.id);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Arvon lance sur http://localhost:${PORT}`);
});

escrow.init().catch((e) => {
  console.error("[escrow] Erreur inattendue a l'initialisation :", e.message);
});
