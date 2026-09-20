const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

const RECOVERY_WORDLIST = [
  'pomme', 'banane', 'orange', 'citron', 'mangue', 'ananas', 'fraise', 'cerise', 'raisin', 'melon',
  'tigre', 'lion', 'ours', 'loup', 'renard', 'aigle', 'requin', 'dauphin', 'baleine', 'tortue',
  'serpent', 'panda', 'zebre', 'singe', 'cheval', 'chameau', 'lapin', 'hibou', 'corbeau', 'faucon',
  'montagne', 'riviere', 'foret', 'desert', 'ocean', 'volcan', 'glacier', 'vallee', 'cascade', 'plage',
  'soleil', 'lune', 'comete', 'planete', 'galaxie', 'nuage', 'orage', 'tonnerre', 'arcen', 'brouillard',
  'guitare', 'piano', 'violon', 'trompette', 'tambour', 'flute', 'harpe', 'batterie', 'cor', 'orgue',
  'chateau', 'tour', 'pont', 'phare', 'moulin', 'temple', 'jardin', 'fontaine', 'statue', 'grotte',
  'diamant', 'rubis', 'saphir', 'emeraude', 'topaze', 'perle', 'cristal', 'argent', 'bronze', 'platine',
  'robot', 'fusee', 'satellite', 'boussole', 'lanterne', 'ancre', 'clef', 'horloge', 'miroir', 'echelle',
  'pirate', 'chevalier', 'sorcier', 'dragon', 'phenix', 'griffon', 'sirene', 'geant', 'gobelin', 'fantome',
];

function generateRecoveryWords() {
  const pool = RECOVERY_WORDLIST.slice();
  const words = [];
  for (let i = 0; i < 5; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    words.push(pool.splice(idx, 1)[0]);
  }
  return words;
}

function normalizeRecoveryWords(words) {
  return (words || []).map((w) => String(w || '').trim().toLowerCase()).join(' ');
}

function validateCustomWord(customWord) {
  const trimmed = String(customWord || '').trim();
  if (trimmed.length < 2 || trimmed.length > 30) {
    throw new Error('Ton mot personnalise doit faire entre 2 et 30 caracteres');
  }
  return trimmed;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function freshData() {
  return { users: [], nextUserId: 1, matchHistory: [] };
}

function loadData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    const initial = freshData();
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch (e) {
    console.error('Impossible de lire data/db.json, reinitialisation.', e);
    const initial = freshData();
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
}

const data = loadData();

function persist() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(check, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createUser(username, password, customWord) {
  username = String(username || '').trim();
  password = String(password || '');
  if (!USERNAME_RE.test(username)) {
    throw new Error('Pseudo invalide (3 a 20 caracteres : lettres, chiffres, _)');
  }
  if (password.length < 6) {
    throw new Error('Mot de passe trop court (6 caracteres minimum)');
  }
  if (data.users.find((u) => u.username.toLowerCase() === username.toLowerCase())) {
    throw new Error('Ce pseudo est deja pris');
  }
  const cleanCustomWord = validateCustomWord(customWord);

  const recoveryWords = generateRecoveryWords();

  const user = {
    id: data.nextUserId++,
    username,
    displayName: username,
    passwordHash: hashPassword(password),
    recoveryHash: hashPassword(normalizeRecoveryWords([...recoveryWords, cleanCustomWord])),
    bio: '',
    avatar: null,
    socialX: '',
    socialInstagram: '',
    socialTiktok: '',
    walletAddress: null,
    createdAt: Date.now(),
    isAdmin: false,
    stats: { matches: 0, wins: 0, losses: 0, draws: 0, totalPnl: 0, bestPnl: 0, netCash: 0, cashMatches: 0 },
  };
  data.users.push(user);
  persist();
  return { user, recoveryWords, customWord: cleanCustomWord };
}

function findUserByRecoveryWords(words) {
  const normalized = normalizeRecoveryWords(words);
  if (!normalized) return null;
  return data.users.find((u) => u.recoveryHash && verifyPassword(normalized, u.recoveryHash)) || null;
}

function resetAccountWithRecoveryWords(words, newUsername, newPassword, newCustomWord) {
  const user = findUserByRecoveryWords(words);
  if (!user) throw new Error('Ces mots secrets ne correspondent a aucun compte.');

  newPassword = String(newPassword || '');
  if (newPassword.length < 6) {
    throw new Error('Mot de passe trop court (6 caracteres minimum)');
  }
  const cleanCustomWord = validateCustomWord(newCustomWord);

  if (newUsername) {
    const trimmed = String(newUsername).trim();
    if (!USERNAME_RE.test(trimmed)) {
      throw new Error('Pseudo invalide (3 a 20 caracteres : lettres, chiffres, _)');
    }
    if (data.users.find((u) => u.id !== user.id && u.username.toLowerCase() === trimmed.toLowerCase())) {
      throw new Error('Ce pseudo est deja pris');
    }
    user.username = trimmed;
  }

  user.passwordHash = hashPassword(newPassword);

  // On genere de nouveaux mots secrets a chaque utilisation, par securite.
  const newRecoveryWords = generateRecoveryWords();
  user.recoveryHash = hashPassword(normalizeRecoveryWords([...newRecoveryWords, cleanCustomWord]));

  persist();
  return { user, recoveryWords: newRecoveryWords, customWord: cleanCustomWord };
}

function getUserByUsername(username) {
  return data.users.find((u) => u.username.toLowerCase() === String(username || '').toLowerCase());
}

function getUserById(id) {
  return data.users.find((u) => u.id === id);
}

function updateProfile(id, fields) {
  const user = getUserById(id);
  if (!user) throw new Error('Utilisateur introuvable');
  const { displayName, bio, avatar, socialX, socialInstagram, socialTiktok } = fields || {};

  if (displayName !== undefined) {
    const trimmed = String(displayName).trim().slice(0, 24);
    if (trimmed.length < 2) throw new Error('Le pseudo affiche doit faire au moins 2 caracteres');
    if (data.users.find((u) => u.id !== user.id && u.displayName.toLowerCase() === trimmed.toLowerCase())) {
      throw new Error('Ce pseudo est deja pris par un autre joueur');
    }
    user.displayName = trimmed;
  }
  if (bio !== undefined) user.bio = String(bio).slice(0, 280);
  if (avatar !== undefined) {
    if (avatar === null) {
      user.avatar = null;
    } else {
      if (typeof avatar !== 'string' || !avatar.startsWith('data:image/')) {
        throw new Error('Image de profil invalide');
      }
      if (avatar.length > 400000) throw new Error('Image trop lourde (max ~300 Ko)');
      user.avatar = avatar;
    }
  }
  if (socialX !== undefined) user.socialX = String(socialX).trim().slice(0, 60);
  if (socialInstagram !== undefined) user.socialInstagram = String(socialInstagram).trim().slice(0, 60);
  if (socialTiktok !== undefined) user.socialTiktok = String(socialTiktok).trim().slice(0, 60);

  persist();
  return user;
}

function setWalletAddress(id, wallet) {
  const user = getUserById(id);
  if (!user) return;
  user.walletAddress = wallet;
  persist();
}

function recordMatchResult(id, { mode, durationSec, pnlPct, result, staked = 0, netCash = 0 }) {
  const user = getUserById(id);
  if (!user) return;
  const s = user.stats;
  s.matches++;
  if (result === 'win') s.wins++;
  else if (result === 'loss') s.losses++;
  else s.draws++;
  s.totalPnl += pnlPct;
  if (s.matches === 1 || pnlPct > s.bestPnl) s.bestPnl = pnlPct;
  if (staked > 0) {
    s.cashMatches = (s.cashMatches || 0) + 1;
    s.netCash = round2((s.netCash || 0) + netCash);
  }

  data.matchHistory.push({ userId: id, mode, durationSec, pnlPct, result, staked, netCash, ts: Date.now() });
  persist();
}

function publicProfile(user) {
  if (!user) return null;
  const s = user.stats;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    bio: user.bio,
    avatar: user.avatar,
    socialX: user.socialX,
    socialInstagram: user.socialInstagram,
    socialTiktok: user.socialTiktok,
    walletAddress: user.walletAddress,
    isAdmin: user.isAdmin || false,
    stats: {
      matches: s.matches,
      wins: s.wins,
      losses: s.losses,
      draws: s.draws,
      points: s.wins * 3 + s.draws,
      avgPnl: s.matches > 0 ? round2(s.totalPnl / s.matches) : 0,
      bestPnl: s.matches > 0 ? round2(s.bestPnl) : 0,
      netCash: round2(s.netCash || 0),
      cashMatches: s.cashMatches || 0,
    },
  };
}

function searchUsers(query, excludeId) {
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2) return [];
  return data.users
    .filter((u) => u.id !== excludeId)
    .filter(
      (u) =>
        u.displayName.toLowerCase().includes(q) ||
        u.username.toLowerCase().includes(q) ||
        (u.walletAddress && u.walletAddress.toLowerCase().includes(q))
    )
    .slice(0, 20)
    .map(publicProfile);
}

function getUserRecentMatches(userId, limit) {
  const mine = data.matchHistory.filter((m) => m.userId === userId);
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  let recent = mine.filter((m) => m.ts >= dayAgo);
  let windowLabel = '24h';
  if (recent.length < 2) {
    recent = mine.slice(-limit);
    windowLabel = 'recent';
  }
  return { matches: recent.slice(-limit), windowLabel };
}

function getLeaderboard() {
  return data.users
    .map((u) => publicProfile(u))
    .filter((u) => u.stats.matches > 0)
    .sort((a, b) => {
      const s = b.stats.points - a.stats.points;
      if (s !== 0) return s;
      const wrA = a.stats.matches > 0 ? a.stats.wins / a.stats.matches : 0;
      const wrB = b.stats.matches > 0 ? b.stats.wins / b.stats.matches : 0;
      if (wrB !== wrA) return wrB - wrA;
      return b.stats.avgPnl - a.stats.avgPnl;
    });
}

function createTournament(name, description, mode, maxParticipants, prizePool) {
  const tournament = {
    id: data.nextTournamentId++,
    name,
    description,
    mode,
    maxParticipants,
    prizePool: prizePool || 0,
    participants: [],
    status: 'upcoming',
    createdAt: Date.now(),
    startedAt: null,
    endedAt: null,
  };
  data.tournaments.push(tournament);
  saveData();
  return tournament;
}

function getTournaments() {
  return data.tournaments || [];
}

function getTournamentById(id) {
  return (data.tournaments || []).find((t) => t.id === Number(id));
}

function updateTournament(id, updates) {
  const tournament = getTournamentById(id);
  if (!tournament) throw new Error('Tournament not found');
  Object.assign(tournament, updates);
  saveData();
  return tournament;
}

function deleteTournament(id) {
  const idx = (data.tournaments || []).findIndex((t) => t.id === Number(id));
  if (idx === -1) throw new Error('Tournament not found');
  data.tournaments.splice(idx, 1);
  saveData();
}

function joinTournament(tournamentId, userId) {
  const tournament = getTournamentById(tournamentId);
  if (!tournament) throw new Error('Tournament not found');
  if (tournament.participants.includes(userId)) throw new Error('Already joined');
  if (tournament.participants.length >= tournament.maxParticipants) throw new Error('Tournament full');
  tournament.participants.push(userId);
  saveData();
}

function leaveTournament(tournamentId, userId) {
  const tournament = getTournamentById(tournamentId);
  if (!tournament) throw new Error('Tournament not found');
  const idx = tournament.participants.indexOf(userId);
  if (idx === -1) throw new Error('Not joined');
  tournament.participants.splice(idx, 1);
  saveData();
}

function setAdminFlag(id, isAdmin) {
  const user = data.users.find(u => u.id === Number(id));
  if (!user) throw new Error('User not found');
  user.isAdmin = !!isAdmin;
  persist();
  return user;
}

module.exports = {
  createUser,
  getUserByUsername,
  getUserById,
  updateProfile,
  setWalletAddress,
  recordMatchResult,
  publicProfile,
  getLeaderboard,
  getUserRecentMatches,
  searchUsers,
  verifyPassword,
  findUserByRecoveryWords,
  resetAccountWithRecoveryWords,
  createTournament,
  getTournaments,
  getTournamentById,
  updateTournament,
  deleteTournament,
  joinTournament,
  leaveTournament,
  setAdminFlag,
};
