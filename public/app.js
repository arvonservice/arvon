const socket = io();

let selectedMode = null;
let selectedDuration = null;
let searchStartTime = null;
let searchInterval = null;
let currentUser = null;
let walletAddress = null;
let walletIsPhantom = false;
let selectedStakeMode = 'free';
let selectedStakeAmount = null;

// ===================== LANGUE (FR / EN) =====================

let lastMatchData = null;
let lastResultsData = null;
let lastBrMatchData = null;
let lastBrResultsData = null;

function setLang(lang) {
  LANG = lang;
  try { localStorage.setItem('arvonLang', lang); } catch (e) {}
  applyStaticI18n();
  updateRecap();
  updateWalletUI();
  if (viewEls.leaderboard.classList.contains('active')) loadLeaderboard();
  if (viewEls.profile.classList.contains('active') && currentUser) fillProfileForm();
  if (viewEls.publicProfile.classList.contains('active') && viewedPublicUser) renderPublicProfile(viewedPublicUser);
  if (viewEls.match.classList.contains('active') && lastMatchData) renderTeams(lastMatchData, false);
  if (viewEls.results.classList.contains('active') && lastResultsData) renderResults(lastResultsData);
  if (viewEls.brMatch.classList.contains('active') && lastBrMatchData) renderBrMatch(lastBrMatchData);
  if (viewEls.brResults.classList.contains('active') && lastBrResultsData) renderBrResults(lastBrResultsData);
}

document.querySelectorAll('.lang-btn').forEach((btn) => {
  btn.addEventListener('click', () => setLang(btn.dataset.lang));
});

applyStaticI18n();

const viewEls = {
  lobby: document.getElementById('lobby'),
  searching: document.getElementById('searching'),
  match: document.getElementById('matchScreen'),
  results: document.getElementById('resultsScreen'),
  leaderboard: document.getElementById('leaderboard'),
  profile: document.getElementById('profile'),
  brSearching: document.getElementById('brSearching'),
  brMatch: document.getElementById('brMatchScreen'),
  brResults: document.getElementById('brResultsScreen'),
  players: document.getElementById('players'),
  publicProfile: document.getElementById('publicProfile'),
};

function showView(name) {
  Object.values(viewEls).forEach((el) => el.classList.remove('active'));
  viewEls[name].classList.add('active');
  document.querySelectorAll('.nav-link').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  const inMatch = name === 'match' || name === 'brMatch';
  document.body.classList.toggle('in-match', inMatch);
  document.getElementById('discordFooter').style.display = inMatch ? 'none' : '';

  if (name === 'leaderboard') loadLeaderboard();
  if (name === 'lobby') initTraderRecap();
  if (name === 'profile') {
    if (!currentUser) {
      showView('lobby');
      openAuthModal('login');
      return;
    }
    fillProfileForm();
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function defaultAvatarDataUri(name) {
  const letter = (Array.from(String(name || '?').trim())[0] || '?').toUpperCase();
  const colors = ['#17b8d1', '#0b5c6d', '#ff4d6d', '#ffd166', '#4da3ff'];
  let hash = 0;
  for (const c of String(name || '')) hash = (hash * 31 + c.charCodeAt(0)) % 997;
  const color = colors[Math.abs(hash) % colors.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="${color}"/><text x="32" y="42" font-size="28" font-family="sans-serif" font-weight="700" fill="#05060a" text-anchor="middle">${letter}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// ===================== NAV / ACCOUNT =====================

document.querySelectorAll('.nav-link').forEach((btn) => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});
document.getElementById('logoBtn').addEventListener('click', () => showView('lobby'));

const accountDropdown = document.getElementById('accountDropdown');
document.getElementById('profilePillBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  accountDropdown.classList.toggle('hidden');
});
document.addEventListener('click', () => accountDropdown.classList.add('hidden'));
accountDropdown.querySelector('[data-view="profile"]').addEventListener('click', () => {
  accountDropdown.classList.add('hidden');
  showView('profile');
});

function updateAccountUI() {
  const authButtons = document.getElementById('authButtons');
  const accountArea = document.getElementById('accountArea');

  if (currentUser) {
    authButtons.classList.add('hidden');
    accountArea.classList.remove('hidden');
    document.getElementById('navName').textContent = currentUser.displayName;
    document.getElementById('navAvatar').src = currentUser.avatar || defaultAvatarDataUri(currentUser.displayName);
  } else {
    authButtons.classList.remove('hidden');
    accountArea.classList.add('hidden');
  }
  updateRequirements();
  initTraderRecap();
}

async function logout() {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  currentUser = null;
  updateAccountUI();
  resyncSocket();
  showView('lobby');
}
document.getElementById('logoutBtn').addEventListener('click', logout);
document.getElementById('profileLogoutBtn').addEventListener('click', logout);

async function loadMe() {
  try {
    const res = await fetch('/api/me');
    const data = await res.json();
    currentUser = data.user;
    updateAccountUI();
  } catch (e) {
    // hors ligne / erreur reseau : on reste en mode deconnecte
  }
}
loadMe();

// ===================== AUTH MODAL =====================

const authModal = document.getElementById('authModal');

function openAuthModal(tab) {
  authModal.classList.remove('hidden');
  switchAuthTab(tab || 'login');
}
function closeAuthModal() {
  authModal.classList.add('hidden');
  document.getElementById('loginError').textContent = '';
  document.getElementById('registerError').textContent = '';
  document.getElementById('loginForm').reset();
  document.getElementById('registerForm').reset();
}
function switchAuthTab(tab) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('loginForm').classList.toggle('hidden', tab !== 'login');
  document.getElementById('registerForm').classList.toggle('hidden', tab !== 'register');
}

document.getElementById('showLoginBtn').addEventListener('click', () => openAuthModal('login'));
document.getElementById('showRegisterBtn').addEventListener('click', () => openAuthModal('register'));
document.getElementById('reqAccountAction').addEventListener('click', () => openAuthModal('login'));
document.getElementById('closeAuthModal').addEventListener('click', closeAuthModal);
document.querySelectorAll('.tab-btn').forEach((btn) => btn.addEventListener('click', () => switchAuthTab(btn.dataset.tab)));

function onAuthSuccess(user) {
  currentUser = user;
  updateAccountUI();
  resyncSocket();
}

function resyncSocket() {
  socket.disconnect();
  socket.connect();
}

socket.on('connect', () => {
  if (walletAddress) socket.emit('connectWallet', walletAddress);
});

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  const errEl = document.getElementById('loginError');
  const submitBtn = e.target.querySelector('button[type="submit"]');
  errEl.textContent = '';
  submitBtn.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('loginUsername').value,
        password: document.getElementById('loginPassword').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || t('common.error'); return; }
    onAuthSuccess(data.user);
    closeAuthModal();
  } catch (err) {
    errEl.textContent = t('common.networkError');
  } finally {
    submitBtn.disabled = false;
  }
});

document.getElementById('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  const errEl = document.getElementById('registerError');
  const submitBtn = e.target.querySelector('button[type="submit"]');
  errEl.textContent = '';
  submitBtn.disabled = true;
  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('registerUsername').value,
        password: document.getElementById('registerPassword').value,
        customWord: document.getElementById('registerCustomWord').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || t('common.error'); return; }
    onAuthSuccess(data.user);
    closeAuthModal();
    showRecoveryWords(data.recoveryWords, data.customWord);
  } catch (err) {
    errEl.textContent = t('common.networkError');
  } finally {
    submitBtn.disabled = false;
  }
});

// ===================== MOTS SECRETS / RECUPERATION DE COMPTE =====================

function showRecoveryWords(words, customWord) {
  if (!words || !words.length) return;
  document.getElementById('recoveryWordsList').innerHTML = words
    .map((w) => `<span class="recovery-word-chip">${escapeHtml(w)}</span>`)
    .join('');
  document.getElementById('recoveryCustomWordBox').innerHTML = customWord
    ? `<span class="recovery-word-chip">${escapeHtml(customWord)}</span>`
    : '';
  document.getElementById('recoveryWordsModal').classList.remove('hidden');
}

document.getElementById('recoveryWordsConfirmBtn').addEventListener('click', () => {
  document.getElementById('recoveryWordsModal').classList.add('hidden');
});

document.getElementById('showForgotPasswordBtn').addEventListener('click', () => {
  closeAuthModal();
  document.getElementById('recoveryWord1').value = '';
  document.getElementById('recoveryWord2').value = '';
  document.getElementById('recoveryWord3').value = '';
  document.getElementById('recoveryWord4').value = '';
  document.getElementById('recoveryWord5').value = '';
  document.getElementById('recoveryWord6').value = '';
  document.getElementById('recoveryNewPassword').value = '';
  document.getElementById('recoveryNewUsername').value = '';
  document.getElementById('recoveryNewCustomWord').value = '';
  document.getElementById('recoveryError').textContent = '';
  document.getElementById('forgotPasswordModal').classList.remove('hidden');
});

document.getElementById('closeForgotPasswordModal').addEventListener('click', () => {
  document.getElementById('forgotPasswordModal').classList.add('hidden');
});

document.getElementById('recoverySubmitBtn').addEventListener('click', async () => {
  const errEl = document.getElementById('recoveryError');
  const btn = document.getElementById('recoverySubmitBtn');
  errEl.textContent = '';
  const words = [
    document.getElementById('recoveryWord1').value,
    document.getElementById('recoveryWord2').value,
    document.getElementById('recoveryWord3').value,
    document.getElementById('recoveryWord4').value,
    document.getElementById('recoveryWord5').value,
    document.getElementById('recoveryWord6').value,
  ];
  const newCustomWord = document.getElementById('recoveryNewCustomWord').value;
  if (words.some((w) => !w.trim()) || !newCustomWord.trim()) {
    errEl.textContent = t('recovery.fillAllWords');
    return;
  }
  btn.disabled = true;
  try {
    const res = await fetch('/api/account/recover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        words,
        newPassword: document.getElementById('recoveryNewPassword').value,
        newUsername: document.getElementById('recoveryNewUsername').value || undefined,
        newCustomWord,
      }),
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || t('common.error'); return; }
    onAuthSuccess(data.user);
    document.getElementById('forgotPasswordModal').classList.add('hidden');
    showRecoveryWords(data.recoveryWords, data.customWord);
  } catch (err) {
    errEl.textContent = t('common.networkError');
  } finally {
    btn.disabled = false;
  }
});

// ===================== WALLET =====================

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function setWalletAddress(addr) {
  walletAddress = addr;
  updateWalletUI();
  updateRequirements();
  if (socket.connected) socket.emit('connectWallet', walletAddress);
}

function disconnectWallet() {
  walletAddress = null;
  walletIsPhantom = false;
  updateWalletUI();
  updateRequirements();
  updateCashAvailability();
  socket.emit('disconnectWallet');
  document.getElementById('walletDropdown').classList.add('hidden');
}

function updateWalletUI() {
  const dot = document.getElementById('walletDot');
  const label = document.getElementById('walletLabel');
  if (walletAddress) {
    dot.classList.add('on');
    label.textContent = `${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}`;
    document.getElementById('walletDropdownAddress').textContent = walletAddress;
  } else {
    dot.classList.remove('on');
    label.textContent = t('wallet.notConnected');
  }
}

socket.on('walletConnected', (addr) => {
  walletAddress = addr;
  updateWalletUI();
  updateRequirements();
});

socket.on('walletError', (message) => {
  alert(message);
  walletAddress = null;
  updateWalletUI();
  updateRequirements();
});

const walletModal = document.getElementById('walletModal');
function openWalletModal() {
  document.getElementById('walletDropdown').classList.add('hidden');
  document.getElementById('manualWalletInput').value = '';
  document.getElementById('walletModalError').textContent = '';
  walletModal.classList.remove('hidden');
}
function closeWalletModal() {
  walletModal.classList.add('hidden');
}
document.getElementById('closeWalletModal').addEventListener('click', closeWalletModal);

document.getElementById('walletBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  if (walletAddress) {
    document.getElementById('walletDropdown').classList.toggle('hidden');
  } else {
    openWalletModal();
  }
});
document.addEventListener('click', () => document.getElementById('walletDropdown').classList.add('hidden'));
document.getElementById('disconnectWalletBtn').addEventListener('click', disconnectWallet);

document.getElementById('reqWalletAction').addEventListener('click', openWalletModal);

async function connectPhantom() {
  if (!(window.solana && window.solana.isPhantom)) {
    alert(t('wallet.phantomMissing'));
    return;
  }
  try {
    const resp = await window.solana.connect();
    walletIsPhantom = true;
    setWalletAddress(resp.publicKey.toString());
    closeWalletModal();
    updateCashAvailability();
  } catch (e) {
    // connexion refusee ou annulee
  }
}
document.getElementById('phantomConnectBtn').addEventListener('click', connectPhantom);

document.getElementById('manualWalletBtn').addEventListener('click', () => {
  const input = document.getElementById('manualWalletInput').value.trim();
  const errEl = document.getElementById('walletModalError');
  if (!SOLANA_ADDRESS_RE.test(input)) {
    errEl.textContent = t('wallet.invalidAddress');
    return;
  }
  errEl.textContent = '';
  walletIsPhantom = false;
  setWalletAddress(input);
  closeWalletModal();
  updateCashAvailability();
});

(async () => {
  if (window.solana && window.solana.isPhantom) {
    try {
      const resp = await window.solana.connect({ onlyIfTrusted: true });
      walletIsPhantom = true;
      setWalletAddress(resp.publicKey.toString());
      updateCashAvailability();
    } catch (e) {
      // pas de connexion de confiance prealable, on ne fait rien
    }
  }
})();

// ===================== LOBBY =====================

function updateRequirements() {
  document.getElementById('reqAccount').classList.toggle('ok', !!currentUser);
  document.getElementById('reqWallet').classList.toggle('ok', !!walletAddress);

  const isBr = selectedMode === 'br';
  const modeOk = isBr ? true : !!selectedDuration;
  const cashOk = selectedStakeMode === 'free' ? true : walletIsPhantom;
  const ready = !!(selectedMode && modeOk && currentUser && walletAddress && cashOk);
  document.getElementById('findMatchBtn').disabled = !ready;
  document.getElementById('hudTicket').classList.toggle('ready', ready);
}

function updateCashAvailability() {
  const warning = document.getElementById('cashPhantomWarning');
  if (selectedStakeMode === 'cash' && walletAddress && !walletIsPhantom) {
    warning.textContent = t('stake.needsPhantom');
  } else {
    warning.textContent = '';
  }
  updateRequirements();
}

function updateRecap() {
  document.getElementById('recapMode').textContent = selectedMode === 'br' ? t('mode.br') : (selectedMode || '—');
  document.getElementById('recapDuration').textContent = selectedMode === 'br' ? t('recap.durationFixed') : (selectedDuration ? document.querySelector(`#durationRow .chip[data-duration="${selectedDuration}"]`)?.textContent : '—');

  const recapStake = document.getElementById('recapStake');
  if (selectedStakeMode === 'free') {
    recapStake.textContent = t('stake.free');
    recapStake.classList.remove('cash-active');
  } else {
    recapStake.textContent = t('stake.cashLabel');
    recapStake.classList.add('cash-active');
  }
}

function showRosterPreview(which) {
  ['previewIdle', 'previewStandard', 'previewBr', 'previewDuel'].forEach((id) => {
    document.getElementById(id).classList.toggle('hidden', id !== which);
  });
}

document.querySelectorAll('#modeRow .blade').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#modeRow .blade').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
    const mode = btn.dataset.mode;

    if (mode === 'duel') {
      selectedMode = null;
      document.getElementById('hudTicket').classList.add('hud-ticket-inert');
      showRosterPreview('previewDuel');
      updateRecap();
      updateRequirements();
      return;
    }

    document.getElementById('hudTicket').classList.remove('hud-ticket-inert');
    selectedMode = mode;

    if (mode === 'br') {
      showRosterPreview('previewBr');
    } else {
      showRosterPreview('previewStandard');
    }

    updateRecap();
    updateRequirements();
  });
});

document.querySelectorAll('#durationRow .chip').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#durationRow .chip').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedDuration = btn.dataset.duration;
    updateRecap();
    updateRequirements();
  });
});

document.querySelectorAll('.stake-switch-opt').forEach((btn) => {
  btn.addEventListener('click', () => {
    selectedStakeMode = btn.dataset.stakeMode;
    document.querySelectorAll('.stake-switch-opt').forEach((b) => b.classList.toggle('selected', b.dataset.stakeMode === selectedStakeMode));
    document.getElementById('cashOptions').classList.toggle('hidden', selectedStakeMode !== 'cash');
    if (selectedStakeMode === 'cash') {
      refreshUsdtBalance();
      updateCashAvailability();
    }
    updateRecap();
    updateRequirements();
  });
});

async function refreshUsdtBalance() {
  if (!walletAddress) return;
  try {
    const res = await fetch(`/api/wallet/balance?address=${encodeURIComponent(walletAddress)}`);
    const data = await res.json();
    document.getElementById('usdtBalance').textContent = data.ready ? `$${data.balance}` : t('wallet.systemUnavailable');
  } catch (e) {
    document.getElementById('usdtBalance').textContent = '—';
  }
}

document.getElementById('findMatchBtn').addEventListener('click', () => {
  if (document.getElementById('findMatchBtn').disabled) return;

  if (selectedMode === 'br') {
    socket.emit('findBrMatch', { cash: selectedStakeMode === 'cash' });
    document.getElementById('brSearchInfo').textContent = t('br.queueStatus', { inQueue: 0, needed: 15 });
    showView('brSearching');
    return;
  }

  const cash = selectedStakeMode === 'cash';
  socket.emit('findMatch', { mode: selectedMode, duration: selectedDuration, cash });
  searchStartTime = Date.now();
  document.getElementById('searchInfo').textContent = t('searching.waitingOpponents');
  showView('searching');
  clearInterval(searchInterval);
  searchInterval = setInterval(() => {
    document.getElementById('searchTimer').textContent = `${Math.floor((Date.now() - searchStartTime) / 1000)}s`;
  }, 500);
});

document.getElementById('cancelBtn').addEventListener('click', () => {
  socket.emit('cancelQueue');
  clearInterval(searchInterval);
  showView('lobby');
});

socket.on('queueStatus', ({ inQueue, needed, cash }) => {
  document.getElementById('searchInfo').textContent = cash
    ? t('searching.cashStatus', { inQueue, needed })
    : t('searching.freeStatus', { inQueue });
});

socket.on('matchError', (message) => {
  alert(message);
  if (viewEls.searching.classList.contains('active') || viewEls.brSearching.classList.contains('active')) {
    showView('lobby');
  }
  document.getElementById('challengeWaitingModal').classList.add('hidden');
});

// ===================== MATCH =====================

let matchEndsAt = null;
let matchTimerTicker = null;

socket.on('matchStart', (data) => {
  clearInterval(searchInterval);
  document.getElementById('challengeWaitingModal').classList.add('hidden');
  document.getElementById('incomingChallengeModal').classList.add('hidden');
  document.getElementById('cashDepositModal').classList.add('hidden');
  clearInterval(incomingChallengeCountdownInterval);
  clearInterval(cashDepositCountdownInterval);
  const stakeLabel = data.isCash ? t('match.cashPotLabel', { pot: data.pot }) : '';
  document.getElementById('matchModeLabel').textContent = `${data.mode} · ${formatDuration(data.durationSec)}${stakeLabel}`;
  lastMatchData = data;
  // La vue doit deja etre visible (display:block) avant de construire les cartes :
  // sinon getBoundingClientRect() renvoie 0x0 pour les canvas de sparkline et leur
  // taille reste bloquee a 1x1 pour tout le reste du match (les cartes ne sont plus
  // reconstruites a chaque tick, seulement mises a jour en place).
  showView('match');
  renderTeams(data, false);
  matchEndsAt = Date.now() + data.remainingMs;
  updateTimer(data.remainingMs);
  clearInterval(matchTimerTicker);
  matchTimerTicker = setInterval(() => updateTimer(Math.max(0, matchEndsAt - Date.now())), 250);
});

socket.on('matchUpdate', (data) => {
  lastMatchData = data;
  renderTeams(data, true);
  matchEndsAt = Date.now() + data.remainingMs;
});

// Fin de match : le serveur relit les transactions de chaque joueur avant
// d'annoncer le resultat (et avant tout paiement).
socket.on('matchVerifying', () => {
  clearInterval(matchTimerTicker);
  clearInterval(brMatchTimerTicker);
  for (const id of ['matchTimer', 'brTimer']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.textContent = t('match.verifying');
    el.classList.remove('timer-urgent');
  }
});

socket.on('matchEnd', async (data) => {
  clearInterval(matchTimerTicker);
  lastResultsData = data;
  renderResults(data);
  showView('results');
  const iWon = currentUser && data.winner !== 'draw' && data.teams[data.winner === 'A' ? 0 : 1].some((p) => p.name === currentUser.displayName);
  if (iWon) spawnConfetti();
  if (currentUser) {
    try {
      const res = await fetch('/api/me');
      const d = await res.json();
      currentUser = d.user;
      updateAccountUI();
      if (viewEls.profile.classList.contains('active')) fillProfileForm();
    } catch (e) {
      // pas grave, les stats se remettront a jour au prochain chargement
    }
  }
});

document.getElementById('playAgainBtn').addEventListener('click', () => showView('lobby'));

function formatDuration(sec) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${sec / 60} min`;
  return `${sec / 3600} h`;
}

function updateTimer(remainingMs) {
  const totalSec = Math.ceil(remainingMs / 1000);
  const m = Math.floor(totalSec / 60).toString().padStart(2, '0');
  const s = (totalSec % 60).toString().padStart(2, '0');
  const timerEl = document.getElementById('matchTimer');
  timerEl.textContent = `${m}:${s}`;
  timerEl.classList.toggle('timer-urgent', remainingMs > 0 && remainingMs <= 10000);
}

function renderTeams(data, isUpdate) {
  const entriesA = renderTeamColumn('teamAColumn', data.teams[0], isUpdate);
  const entriesB = renderTeamColumn('teamBColumn', data.teams[1], isUpdate);
  applyTeamLeaderGlow(entriesA, entriesB);
  updateTeamPnlLive('teamAPnlLive', data.teams[0]);
  updateTeamPnlLive('teamBPnlLive', data.teams[1]);
  updateMomentum(data.teams[0], data.teams[1]);
}

function updateTeamPnlLive(elId, players) {
  const el = document.getElementById(elId);
  if (players.length < 2) {
    el.hidden = true;
    return;
  }
  const avg = round2(players.reduce((sum, p) => sum + p.pnlPct, 0) / players.length);
  el.hidden = false;
  el.textContent = `${avg > 0 ? '+' : ''}${avg.toFixed(2)}%`;
  el.className = `team-pnl-live ${avg >= 0 ? 'positive' : 'negative'}`;
}

function updateMomentum(teamA, teamB) {
  const knob = document.getElementById('momentumKnob');
  if (!knob || !teamA.length || !teamB.length) return;
  const avgA = teamA.reduce((s, p) => s + p.pnlPct, 0) / teamA.length;
  const avgB = teamB.reduce((s, p) => s + p.pnlPct, 0) / teamB.length;
  const diff = avgA - avgB;
  const SCALE = 6; // ecart (en points de %) au-dela duquel le curseur touche le bord
  const clamped = Math.max(-SCALE, Math.min(SCALE, diff));
  const pct = 50 + (clamped / SCALE) * 42;
  knob.style.left = `${pct}%`;
  knob.className = `momentum-knob ${diff > 0.02 ? 'team-a' : diff < -0.02 ? 'team-b' : ''}`;
}

// Anime le texte d'un element de %A vers %B avec un ease-out, façon compteur de jeu video.
function animateNumber(el, to) {
  const from = Number(el.dataset.value || 0);
  el.dataset.value = to;
  if (Math.abs(to - from) < 0.001) {
    el.textContent = `${to > 0 ? '+' : ''}${to.toFixed(2)}%`;
    return;
  }
  cancelAnimationFrame(el._tweenRaf);
  const start = performance.now();
  const duration = 700;
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const value = from + (to - from) * eased;
    el.textContent = `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
    if (t < 1) el._tweenRaf = requestAnimationFrame(step);
  };
  el._tweenRaf = requestAnimationFrame(step);
}

function spawnDeltaPopup(card, delta) {
  if (Math.abs(delta) < 0.01) return;
  const popup = document.createElement('div');
  popup.className = `delta-popup ${delta > 0 ? 'positive' : 'negative'}`;
  popup.textContent = `${delta > 0 ? '+' : ''}${delta.toFixed(2)}%`;
  card.appendChild(popup);
  setTimeout(() => popup.remove(), 1300);
}

function buildPlayerCard(p) {
  const card = document.createElement('div');
  card.className = 'player-card';
  card.dataset.playerId = p.id;

  const nameEl = document.createElement('div');
  nameEl.className = 'player-name';
  const avatar = document.createElement('img');
  avatar.className = 'avatar-sm';
  avatar.style.verticalAlign = 'middle';
  avatar.style.marginRight = '6px';
  avatar.src = p.avatar || defaultAvatarDataUri(p.name);
  nameEl.appendChild(avatar);
  nameEl.appendChild(document.createTextNode(p.name));

  const pnlEl = document.createElement('div');
  const pnlClass = p.pnlPct > 0 ? 'positive' : p.pnlPct < 0 ? 'negative' : 'neutral';
  pnlEl.className = `player-pnl ${pnlClass}`;
  pnlEl.textContent = `${p.pnlPct > 0 ? '+' : ''}${p.pnlPct.toFixed(2)}%`;
  pnlEl.dataset.value = p.pnlPct;

  const canvas = document.createElement('canvas');
  canvas.className = 'sparkline';

  card.appendChild(nameEl);
  card.appendChild(pnlEl);
  card.appendChild(canvas);

  const tagsBox = document.createElement('div');
  tagsBox.className = 'card-tags';
  renderCardTags(tagsBox, p);
  card.appendChild(tagsBox);

  return card;
}

// Les etiquettes changent en cours de match (alerte, token sans prix...) :
// elles sont redessinees a chaque mise a jour, seulement si elles ont change.
function renderCardTags(box, p) {
  const signature = JSON.stringify([p.simulated, p.walletError, p.alert, p.staked]);
  if (box.dataset.signature === signature) return;
  box.dataset.signature = signature;
  box.innerHTML = '';
  const add = (text, className = 'tag') => {
    const el = document.createElement('div');
    el.className = className;
    el.textContent = text;
    box.appendChild(el);
  };
  if (p.simulated && !p.walletError) add(t('match.simulatedTag'));
  if (p.walletError) add(p.walletError, 'tag warn');
  if (p.alert) add(t('match.alertTag'), 'tag warn');
  if (p.staked > 0) add(t('match.stakeTag', { amount: p.staked }));
}

// Etiquette de verification affichee dans les resultats.
const STATUS_TAG_KEYS = {
  disqualified: 'results.dqTag',
  neutralized: 'results.neutralizedTag',
  unverified: 'results.unverifiedTag',
};

function statusTagHtml(p) {
  const key = STATUS_TAG_KEYS[p.status] || (p.unranked ? 'match.unrankedTag' : null);
  if (!key) return '';
  const cls = p.status || 'unranked';
  return `<span class="bot-tag status-tag ${cls}">${escapeHtml(t(key))}</span>`;
}

function updatePlayerCard(card, p) {
  const pnlEl = card.querySelector('.player-pnl');
  const previousValue = Number(pnlEl.dataset.value || 0);
  const delta = round2(p.pnlPct - previousValue);
  const pnlClass = p.pnlPct > 0 ? 'positive' : p.pnlPct < 0 ? 'negative' : 'neutral';
  pnlEl.className = `player-pnl ${pnlClass}`;
  animateNumber(pnlEl, p.pnlPct);
  if (delta !== 0) spawnDeltaPopup(card, delta);

  const canvas = card.querySelector('canvas.sparkline');
  if (canvas) drawSparkline(canvas, p.history);

  const tagsBox = card.querySelector('.card-tags');
  if (tagsBox) renderCardTags(tagsBox, p);
}

function renderTeamColumn(elId, players, isUpdate) {
  const col = document.getElementById(elId);
  const existing = isUpdate ? new Map([...col.children].map((c) => [c.dataset.playerId, c])) : new Map();
  const canReuse = isUpdate && existing.size === players.length && players.every((p) => existing.has(String(p.id)));

  if (canReuse) {
    return players.map((p) => {
      const card = existing.get(String(p.id));
      updatePlayerCard(card, p);
      return { el: card, pnlPct: p.pnlPct };
    });
  }

  col.innerHTML = '';
  col.dataset.count = players.length;
  const entries = [];
  const canvasJobs = [];
  players.forEach((p) => {
    const card = buildPlayerCard(p);
    col.appendChild(card);
    canvasJobs.push({ canvas: card.querySelector('canvas.sparkline'), history: p.history });
    entries.push({ el: card, pnlPct: p.pnlPct });
  });
  // Toutes les cartes sont dans le DOM (donc dimensionnees par le flex du parent)
  // avant de fixer la resolution des canvas, sinon chaque canvas heriterait
  // d'une taille provisoire calculee avec un nombre de cartes incomplet.
  canvasJobs.forEach(({ canvas, history }) => {
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width));
    canvas.height = Math.max(1, Math.round(rect.height));
    drawSparkline(canvas, history);
  });
  return entries;
}

function drawSparkline(canvas, history) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (history.length < 2 || w < 2 || h < 2) return;

  const min = Math.min(...history, 0);
  const max = Math.max(...history, 0);
  const range = max - min || 1;
  const pad = 4;
  const xPad = 5;
  const points = history.map((v, i) => [
    xPad + (i / (history.length - 1)) * (w - xPad * 2),
    pad + (h - pad * 2) - ((v - min) / range) * (h - pad * 2),
  ]);
  const last = history[history.length - 1];
  const color = last >= 0 ? '#17b8d1' : '#ff4d6d';

  // remplissage degrade sous la courbe
  ctx.beginPath();
  ctx.moveTo(points[0][0], h);
  points.forEach(([x, y]) => ctx.lineTo(x, y));
  ctx.lineTo(points[points.length - 1][0], h);
  ctx.closePath();
  const gradient = ctx.createLinearGradient(0, 0, 0, h);
  gradient.addColorStop(0, `${color}4d`);
  gradient.addColorStop(1, `${color}00`);
  ctx.fillStyle = gradient;
  ctx.fill();

  // courbe lumineuse
  ctx.beginPath();
  points.forEach(([x, y], i) => { if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.shadowColor = color;
  ctx.shadowBlur = 6;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // point avec relief sur la derniere valeur
  const [lx, ly] = points[points.length - 1];
  ctx.beginPath();
  ctx.arc(lx, ly, 4, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 5;
  ctx.fill();
  ctx.shadowBlur = 0;
}

function renderResults(data) {
  const [pnlA, pnlB] = data.teamPnl;
  const title = document.getElementById('resultTitle');
  if (data.outcome === 'refund') title.textContent = t('results.refund');
  else if (data.outcome === 'void') title.textContent = t('results.void');
  else if (data.winner === 'draw') title.textContent = data.isCash ? t('results.drawCash') : t('results.draw');
  else title.textContent = data.winner === 'A' ? t('results.teamAWins') : t('results.teamBWins');

  const existingNote = document.getElementById('resultPotNote');
  if (existingNote) existingNote.remove();
  const notes = [];
  if (data.outcome === 'forfeit') notes.push(t('results.forfeitNote'));
  if (data.isCash && data.outcome !== 'refund') notes.push(t('results.potNote', { pot: data.pot }));
  if (notes.length) {
    const note = document.createElement('p');
    note.id = 'resultPotNote';
    note.className = 'hint';
    note.style.textAlign = 'center';
    note.textContent = notes.join(' ');
    title.insertAdjacentElement('afterend', note);
  }

  const container = document.getElementById('resultTeams');
  container.innerHTML = '';
  container.appendChild(buildResultTeam(t('match.teamA'), pnlA, data.teams[0], data.winner === 'A', data.payouts));
  container.appendChild(buildResultTeam(t('match.teamB'), pnlB, data.teams[1], data.winner === 'B', data.payouts));
}

function buildResultTeam(label, pnl, players, isWinner, payouts) {
  const box = document.createElement('div');
  box.className = 'result-team';

  const h3 = document.createElement('h3');
  h3.textContent = label;
  if (isWinner) {
    const badge = document.createElement('span');
    badge.className = 'winner-badge';
    h3.appendChild(badge);
  }
  box.appendChild(h3);

  const pnlEl = document.createElement('div');
  pnlEl.className = `team-pnl ${pnl >= 0 ? 'positive' : 'negative'}`;
  pnlEl.textContent = `${pnl > 0 ? '+' : ''}${pnl.toFixed(2)}%`;
  box.appendChild(pnlEl);

  players.forEach((p) => {
    const row = document.createElement('div');
    row.className = p.status === 'disqualified' ? 'result-row dq' : 'result-row';

    const nameSpan = document.createElement('span');
    const payout = payouts && payouts[p.id];
    const stakeLabel = p.staked > 0 ? t('results.stakeLabelInline', { amount: p.staked }) : '';
    nameSpan.textContent = `${p.name}${stakeLabel}${payout ? ` (+$${payout})` : ''}`;
    if (p.isBot) {
      const botTag = document.createElement('span');
      botTag.className = 'bot-tag';
      botTag.textContent = t('match.botTag');
      nameSpan.prepend(botTag);
    }
    const statusTag = statusTagHtml(p);
    if (statusTag) nameSpan.insertAdjacentHTML('beforeend', statusTag);

    const pnlSpan = document.createElement('span');
    pnlSpan.className = p.pnlPct >= 0 ? 'positive' : 'negative';
    pnlSpan.textContent = `${p.pnlPct > 0 ? '+' : ''}${p.pnlPct.toFixed(2)}%`;

    row.appendChild(nameSpan);
    row.appendChild(pnlSpan);
    box.appendChild(row);
  });

  return box;
}

// ===================== BATTLE ROYALE =====================

document.getElementById('brCancelBtn').addEventListener('click', () => {
  socket.emit('cancelBrQueue');
  showView('lobby');
});

socket.on('brQueueStatus', ({ inQueue, needed }) => {
  document.getElementById('brSearchInfo').textContent = t('br.queueStatus', { inQueue, needed });
});

let brEliminationIntervalMs = 120000;
let brNextEliminationDeadline = null;
let brNextEliminationTicker = null;

function updateBrNextEliminationLabel() {
  if (!brNextEliminationDeadline) return;
  const remaining = Math.max(0, brNextEliminationDeadline - Date.now());
  const totalSec = Math.ceil(remaining / 1000);
  const m = Math.floor(totalSec / 60).toString().padStart(2, '0');
  const s = (totalSec % 60).toString().padStart(2, '0');
  document.getElementById('brNextElimination').textContent = t('br.nextElimination', { time: `${m}:${s}` });
}

let brMatchEndsAt = null;
let brMatchTimerTicker = null;

function updateBrTimer(remainingMs) {
  const totalSec = Math.ceil(remainingMs / 1000);
  const m = Math.floor(totalSec / 60).toString().padStart(2, '0');
  const s = (totalSec % 60).toString().padStart(2, '0');
  const timerEl = document.getElementById('brTimer');
  timerEl.textContent = `${m}:${s}`;
  timerEl.classList.toggle('timer-urgent', remainingMs > 0 && remainingMs <= 10000);
}

socket.on('brMatchStart', (data) => {
  document.getElementById('brStakeModal').classList.add('hidden');
  clearInterval(brStakeCountdownInterval);
  brEliminationIntervalMs = data.eliminationIntervalMs;
  brNextEliminationDeadline = Date.now() + brEliminationIntervalMs;
  clearInterval(brNextEliminationTicker);
  brNextEliminationTicker = setInterval(updateBrNextEliminationLabel, 500);
  updateBrNextEliminationLabel();
  brMatchEndsAt = Date.now() + data.remainingMs;
  clearInterval(brMatchTimerTicker);
  brMatchTimerTicker = setInterval(() => updateBrTimer(Math.max(0, brMatchEndsAt - Date.now())), 250);
  renderBrMatch(data);
  showView('brMatch');
});

socket.on('brMatchUpdate', (data) => {
  brMatchEndsAt = Date.now() + data.remainingMs;
  renderBrMatch(data);
});

socket.on('brElimination', () => {
  brNextEliminationDeadline = Date.now() + brEliminationIntervalMs;
});

socket.on('brYouEliminated', ({ rank, totalPlayers }) => {
  document.getElementById('brEliminatedRank').textContent = t('br.eliminatedRank', { rank: ordinal(rank), total: totalPlayers });
  document.getElementById('brEliminatedModal').classList.remove('hidden');
});

document.getElementById('brSpectateBtn').addEventListener('click', () => {
  document.getElementById('brEliminatedModal').classList.add('hidden');
});
document.getElementById('brLeaveBtn').addEventListener('click', () => {
  document.getElementById('brEliminatedModal').classList.add('hidden');
  socket.emit('leaveBrSpectate');
  showView('lobby');
});

socket.on('brMatchEnd', (data) => {
  document.getElementById('brEliminatedModal').classList.add('hidden');
  clearInterval(brNextEliminationTicker);
  clearInterval(brMatchTimerTicker);
  const winner = data.outcome === 'win' ? data.ranking[0] : null;
  const iWon = currentUser && winner && winner.name === currentUser.displayName;
  if (iWon) spawnConfetti();
  lastBrResultsData = data;
  renderBrResults(data);
  showView('brResults');
  if (currentUser) {
    fetch('/api/me').then((r) => r.json()).then((d) => { currentUser = d.user; updateAccountUI(); }).catch(() => {});
  }
});

document.getElementById('brPlayAgainBtn').addEventListener('click', () => showView('lobby'));

function renderBrMatch(data) {
  lastBrMatchData = data;
  const potLabel = data.isCash ? t('br.potLabel', { pot: data.pot }) : '';
  document.getElementById('brAliveCount').textContent = t('br.aliveCount', { count: data.aliveCount }) + potLabel;
  updateBrTimer(data.remainingMs);

  const grid = document.getElementById('brGrid');
  grid.innerHTML = '';
  const entries = [];
  const sorted = data.players.slice().sort((a, b) => b.pnlPct - a.pnlPct);
  sorted.forEach((p) => {
    const pnlClass = p.pnlPct > 0 ? 'positive' : p.pnlPct < 0 ? 'negative' : 'neutral';
    const card = document.createElement('div');
    card.className = 'br-player-card' + (p.alive ? '' : ' eliminated');

    const nameEl = document.createElement('div');
    nameEl.className = 'player-name';
    const avatar = document.createElement('img');
    avatar.className = 'avatar-sm';
    avatar.style.verticalAlign = 'middle';
    avatar.style.marginRight = '6px';
    avatar.src = p.avatar || defaultAvatarDataUri(p.name);
    nameEl.appendChild(avatar);
    nameEl.appendChild(document.createTextNode(p.name));

    const pnlEl = document.createElement('div');
    pnlEl.className = `player-pnl ${pnlClass}`;
    pnlEl.textContent = `${p.pnlPct > 0 ? '+' : ''}${p.pnlPct.toFixed(2)}%`;

    const canvas = document.createElement('canvas');
    canvas.className = 'sparkline';
    canvas.width = 150;
    canvas.height = 26;

    card.appendChild(nameEl);
    card.appendChild(pnlEl);
    card.appendChild(canvas);

    if (!p.alive) {
      const tag = document.createElement('div');
      tag.className = 'br-eliminated-tag';
      tag.textContent = t('br.eliminatedTag');
      card.appendChild(tag);
    }
    for (const text of [p.walletError, p.alert ? t('match.alertTag') : null]) {
      if (!text) continue;
      const tag = document.createElement('div');
      tag.className = 'tag warn';
      tag.textContent = text;
      card.appendChild(tag);
    }

    grid.appendChild(card);
    drawSparkline(canvas, p.history);
    if (p.alive) entries.push({ el: card, pnlPct: p.pnlPct });
  });
  applyIndividualLeaderGlow(entries);
}

function renderBrResults(data) {
  const podium = document.getElementById('brPodium');
  podium.innerHTML = '';
  const existingNote = document.getElementById('brPotNote');
  if (existingNote) existingNote.remove();
  const noteText =
    data.outcome === 'refund' ? t('br.refund')
    : data.outcome === 'void' ? t('br.void')
    : data.isCash ? t('br.potNoteWinner', { pot: data.pot })
    : null;
  if (noteText) {
    const potNote = document.createElement('p');
    potNote.id = 'brPotNote';
    potNote.className = 'hint';
    potNote.style.textAlign = 'center';
    potNote.textContent = noteText;
    podium.parentElement.insertBefore(potNote, podium);
  }
  const order = [1, 0, 2];
  const slotClass = ['silver', 'gold', 'bronze'];
  order.forEach((rankIdx, slot) => {
    const p = data.ranking[rankIdx];
    if (!p) return;
    const el = document.createElement('div');
    el.className = `podium-slot ${slotClass[slot]}`;
    const img = document.createElement('img');
    img.src = p.avatar || defaultAvatarDataUri(p.name);
    el.appendChild(img);
    const bar = document.createElement('div');
    bar.className = 'podium-bar';
    bar.innerHTML = `<div class="podium-rank">#${p.rank}</div><div class="podium-name">${escapeHtml(p.name)}</div><div class="podium-pnl ${p.pnlPct >= 0 ? 'positive' : 'negative'}">${p.pnlPct > 0 ? '+' : ''}${p.pnlPct.toFixed(2)}%</div>`;
    el.appendChild(bar);
    podium.appendChild(el);
  });

  const list = document.getElementById('brFullRanking');
  list.innerHTML = '';
  data.ranking.forEach((p) => {
    const row = document.createElement('div');
    row.className = p.status === 'disqualified' ? 'br-rank-row dq' : 'br-rank-row';
    row.innerHTML = `
      <span class="br-rank-num">#${p.rank}</span>
      <img src="${p.avatar || defaultAvatarDataUri(p.name)}" alt="">
      <span class="br-rank-name">${p.isBot ? `<span class="bot-tag">${t('match.botTag')}</span>` : ''}${escapeHtml(p.name)}${statusTagHtml(p)}</span>
      <span class="${p.pnlPct >= 0 ? 'positive' : 'negative'}">${p.pnlPct > 0 ? '+' : ''}${p.pnlPct.toFixed(2)}%</span>
    `;
    list.appendChild(row);
  });
}

// ===================== SIGNATURE DE TRANSACTIONS (MISES) =====================

function round2(n) {
  return Math.round(n * 100) / 100;
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function signDepositTx(base64Tx) {
  if (!window.solanaWeb3) throw new Error(t('common.solanaLibMissing'));
  if (!(window.solana && window.solana.isPhantom)) throw new Error(t('common.phantomRequired'));
  const tx = window.solanaWeb3.Transaction.from(base64ToBytes(base64Tx));
  const signed = await window.solana.signTransaction(tx);
  return bytesToBase64(signed.serialize());
}

// ===================== DEPOT DE MISE (MODES EQUIPE) =====================
// Chacun choisit son propre montant (comme en Battle Royale Cash), pas de montant impose.

let currentCashPendingId = null;
let cashDepositCountdownInterval = null;

socket.on('cashStakePhaseStart', (data) => {
  currentCashPendingId = data.pendingId;
  selectedStakeAmount = null;
  document.querySelectorAll('#cashDepositAmountRow .chip').forEach((b) => b.classList.remove('selected'));
  document.getElementById('customCashDepositInput').value = '';
  document.getElementById('cashDepositError').textContent = '';
  document.getElementById('cashDepositMatchInfo').textContent = t('cash.matchInfo', { mode: data.mode, duration: formatDuration(data.durationSec), count: data.totalPlayers });
  document.getElementById('cashPotAmount').textContent = '$0';
  document.getElementById('cashLobbyList').innerHTML = '';
  const acceptBtn = document.getElementById('cashDepositAcceptBtn');
  acceptBtn.disabled = true;
  acceptBtn.textContent = t('cash.acceptAndJoin');

  let secondsLeft = Math.ceil(data.deadlineMs / 1000);
  const countdownEl = document.getElementById('cashDepositCountdown');
  countdownEl.textContent = t('common.expiresIn', { sec: secondsLeft });
  clearInterval(cashDepositCountdownInterval);
  cashDepositCountdownInterval = setInterval(() => {
    secondsLeft = Math.max(0, secondsLeft - 1);
    countdownEl.textContent = t('common.expiresIn', { sec: secondsLeft });
    if (secondsLeft <= 0) clearInterval(cashDepositCountdownInterval);
  }, 1000);

  document.getElementById('cashDepositModal').classList.remove('hidden');
});

document.querySelectorAll('#cashDepositAmountRow .chip').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#cashDepositAmountRow .chip').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
    document.getElementById('customCashDepositInput').value = '';
    selectedStakeAmount = Number(btn.dataset.stake);
    document.getElementById('cashDepositAcceptBtn').disabled = false;
  });
});

document.getElementById('customCashDepositInput').addEventListener('input', (e) => {
  const value = Number(e.target.value);
  document.querySelectorAll('#cashDepositAmountRow .chip').forEach((b) => b.classList.remove('selected'));
  selectedStakeAmount = value >= 1 ? value : null;
  document.getElementById('cashDepositAcceptBtn').disabled = !selectedStakeAmount;
});

socket.on('cashStakeUpdate', ({ pendingId, summary, pot }) => {
  if (pendingId !== currentCashPendingId) return;
  document.getElementById('cashPotAmount').textContent = `$${pot}`;
  const labels = { pending: t('cash.statusPending'), confirmed: null, declined: t('cash.statusDeclined') };
  document.getElementById('cashLobbyList').innerHTML = summary
    .map((s) => `<div class="cash-lobby-row"><span>${s.isBot ? `<span class="bot-tag">${t('match.botTag')}</span>` : ''}${escapeHtml(s.name)}</span><span class="status-${s.status}">${s.status === 'confirmed' ? `$${s.stake}` : labels[s.status] || s.status}</span></div>`)
    .join('');
});

document.getElementById('cashDepositAcceptBtn').addEventListener('click', () => {
  if (!selectedStakeAmount) return;
  const errEl = document.getElementById('cashDepositError');
  const btn = document.getElementById('cashDepositAcceptBtn');
  btn.disabled = true;
  errEl.textContent = '';

  socket.emit('cashStakePrepare', { pendingId: currentCashPendingId, amount: selectedStakeAmount }, async (prep) => {
    if (!prep || prep.error) {
      errEl.textContent = (prep && prep.error) || t('common.error');
      btn.disabled = false;
      return;
    }
    try {
      const signedTx = await signDepositTx(prep.tx);
      socket.emit('cashStakeConfirm', { pendingId: currentCashPendingId, signedTx, amount: selectedStakeAmount }, (result) => {
        if (result && result.error) {
          errEl.textContent = result.error;
          btn.disabled = false;
        } else {
          document.getElementById('cashDepositModal').classList.add('hidden');
          clearInterval(cashDepositCountdownInterval);
        }
      });
    } catch (e) {
      errEl.textContent = e.message || t('common.signatureCancelled');
      btn.disabled = false;
    }
  });
});

document.getElementById('cashDepositDeclineBtn').addEventListener('click', () => {
  socket.emit('cashStakeDecline', { pendingId: currentCashPendingId });
  document.getElementById('cashDepositModal').classList.add('hidden');
  clearInterval(cashDepositCountdownInterval);
});

socket.on('cashCancelled', ({ reason }) => {
  document.getElementById('cashDepositModal').classList.add('hidden');
  document.getElementById('brStakeModal').classList.add('hidden');
  clearInterval(cashDepositCountdownInterval);
  clearInterval(brStakeCountdownInterval);
  document.getElementById('cashCancelledReason').textContent = reason;
  document.getElementById('cashCancelledModal').classList.remove('hidden');
});

document.getElementById('cashCancelledOkBtn').addEventListener('click', () => {
  document.getElementById('cashCancelledModal').classList.add('hidden');
  showView('lobby');
});

// ===================== MISE BATTLE ROYALE =====================

let currentBrStakePendingId = null;
let brStakeCountdownInterval = null;
let selectedBrStakeAmount = null;

socket.on('brStakePhaseStart', (data) => {
  currentBrStakePendingId = data.pendingId;
  selectedBrStakeAmount = null;
  document.querySelectorAll('#brStakeAmountRow .chip').forEach((b) => b.classList.remove('selected'));
  document.getElementById('customBrStakeInput').value = '';
  document.getElementById('brStakeError').textContent = '';
  const confirmBtn = document.getElementById('brStakeConfirmBtn');
  confirmBtn.disabled = true;
  confirmBtn.textContent = t('cash.acceptAndJoin');

  let secondsLeft = Math.ceil(data.deadlineMs / 1000);
  const countdownEl = document.getElementById('brStakeCountdown');
  countdownEl.textContent = t('common.expiresIn', { sec: secondsLeft });
  clearInterval(brStakeCountdownInterval);
  brStakeCountdownInterval = setInterval(() => {
    secondsLeft = Math.max(0, secondsLeft - 1);
    countdownEl.textContent = t('common.expiresIn', { sec: secondsLeft });
    if (secondsLeft <= 0) clearInterval(brStakeCountdownInterval);
  }, 1000);

  document.getElementById('brStakeModal').classList.remove('hidden');
});

document.querySelectorAll('#brStakeAmountRow .chip').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#brStakeAmountRow .chip').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
    document.getElementById('customBrStakeInput').value = '';
    selectedBrStakeAmount = Number(btn.dataset.stake);
    document.getElementById('brStakeConfirmBtn').disabled = false;
  });
});

document.getElementById('customBrStakeInput').addEventListener('input', (e) => {
  const value = Number(e.target.value);
  document.querySelectorAll('#brStakeAmountRow .chip').forEach((b) => b.classList.remove('selected'));
  selectedBrStakeAmount = value >= 1 ? value : null;
  document.getElementById('brStakeConfirmBtn').disabled = !selectedBrStakeAmount;
});

socket.on('brStakeUpdate', ({ pendingId, summary, pot }) => {
  if (pendingId !== currentBrStakePendingId) return;
  document.getElementById('brStakePotAmount').textContent = `$${pot}`;
  const labels = { pending: t('cash.statusPending'), confirmed: null, declined: t('cash.statusWithdrawn') };
  document.getElementById('brStakeLobbyList').innerHTML = summary
    .map((s) => `<div class="cash-lobby-row"><span>${escapeHtml(s.name)}</span><span class="status-${s.status}">${s.status === 'confirmed' ? `$${s.stake}` : labels[s.status] || s.status}</span></div>`)
    .join('');
});

document.getElementById('brStakeConfirmBtn').addEventListener('click', () => {
  if (!selectedBrStakeAmount) return;
  const btn = document.getElementById('brStakeConfirmBtn');
  const errEl = document.getElementById('brStakeError');
  btn.disabled = true;
  errEl.textContent = '';

  socket.emit('brStakePrepare', { pendingId: currentBrStakePendingId, amount: selectedBrStakeAmount }, async (prep) => {
    if (!prep || prep.error) {
      errEl.textContent = (prep && prep.error) || t('common.error');
      btn.disabled = false;
      return;
    }
    try {
      const signedTx = await signDepositTx(prep.tx);
      socket.emit('brStakeConfirm', { pendingId: currentBrStakePendingId, signedTx, amount: selectedBrStakeAmount }, (result) => {
        if (result && result.error) {
          errEl.textContent = result.error;
          btn.disabled = false;
        } else {
          document.getElementById('brStakeModal').classList.add('hidden');
          clearInterval(brStakeCountdownInterval);
        }
      });
    } catch (e) {
      errEl.textContent = e.message || t('common.signatureCancelled');
      btn.disabled = false;
    }
  });
});

document.getElementById('brStakeDeclineBtn').addEventListener('click', () => {
  socket.emit('brStakeDecline', { pendingId: currentBrStakePendingId });
  document.getElementById('brStakeModal').classList.add('hidden');
  clearInterval(brStakeCountdownInterval);
});

// ===================== EFFETS (CONFETTIS, LEADER GLOW) =====================

function applyIndividualLeaderGlow(entries) {
  if (entries.length < 2) return;
  let best = null;
  entries.forEach((e) => { if (best === null || e.pnlPct > best.pnlPct) best = e; });
  entries.forEach((e) => e.el.classList.toggle('leading', e === best && best.pnlPct > 0));
}

function applyTeamLeaderGlow(entriesA, entriesB) {
  const avgA = entriesA.length ? round2(entriesA.reduce((s, e) => s + e.pnlPct, 0) / entriesA.length) : 0;
  const avgB = entriesB.length ? round2(entriesB.reduce((s, e) => s + e.pnlPct, 0) / entriesB.length) : 0;
  entriesA.forEach((e) => e.el.classList.toggle('leading', avgA > avgB));
  entriesB.forEach((e) => e.el.classList.toggle('leading', avgB > avgA));
}

function spawnConfetti() {
  const colors = ['#17b8d1', '#0b5c6d', '#ffd166', '#ff4d6d', '#4da3ff'];
  for (let i = 0; i < 60; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.left = `${Math.random() * 100}vw`;
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.animationDuration = `${1.8 + Math.random() * 1.4}s`;
    piece.style.animationDelay = `${Math.random() * 0.4}s`;
    document.body.appendChild(piece);
    setTimeout(() => piece.remove(), 3500);
  }
}

// ===================== LEADERBOARD =====================

const PODIUM_CROWN_SVG = '<svg viewBox="0 0 60 40" class="podium-crown-icon"><path d="M8,32 L8,16 L20,26 L30,8 L40,26 L52,16 L52,32 Z"/></svg>';

function renderLeaderboardPodium(list) {
  const podium = document.getElementById('leaderboardPodium');
  podium.innerHTML = '';
  const ranked = list.slice(0, 3);
  if (ranked.length === 0) return;
  podium.classList.toggle('podium-partial', ranked.length < 3);
  const order = ranked.length >= 3 ? [1, 0, 2] : ranked.map((_, i) => i);
  const slotClass = ranked.length >= 3 ? ['silver', 'gold', 'bronze'] : ranked.map((_, i) => ['gold', 'silver', 'bronze'][i]);
  order.forEach((idx, slot) => {
    const u = ranked[idx];
    if (!u) return;
    const rank = idx + 1;
    const cash = u.stats.netCash || 0;
    const el = document.createElement('div');
    el.className = `podium-slot ${slotClass[slot]}`;
    el.style.cursor = 'pointer';
    if (rank === 1) el.insertAdjacentHTML('beforeend', PODIUM_CROWN_SVG);
    const img = document.createElement('img');
    img.src = u.avatar || defaultAvatarDataUri(u.displayName);
    el.appendChild(img);
    const bar = document.createElement('div');
    bar.className = 'podium-bar';
    bar.innerHTML = `
      <div class="podium-rank">#${rank}</div>
      <div class="podium-name">${escapeHtml(u.displayName)}</div>
      <div class="podium-cash ${cash > 0 ? 'positive' : cash < 0 ? 'negative' : ''}">${cash > 0 ? '+' : ''}$${cash.toFixed(2)}</div>
      <div class="podium-pnl">${u.stats.points} pts</div>
    `;
    el.appendChild(bar);
    el.addEventListener('click', () => openPublicProfile(u.id));
    podium.appendChild(el);
  });
}

async function loadLeaderboard() {
  const body = document.getElementById('leaderboardBody');
  const empty = document.getElementById('leaderboardEmpty');
  body.innerHTML = '';
  try {
    const res = await fetch('/api/leaderboard');
    const list = await res.json();
    renderLeaderboardPodium(list);
    if (list.length === 0) {
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    list.forEach((u, i) => {
      const row = document.createElement('div');
      row.className = 'lb-row' + (i === 0 ? ' top1' : i === 1 ? ' top2' : i === 2 ? ' top3' : '');

      const winRate = u.stats.matches > 0 ? Math.round((u.stats.wins / u.stats.matches) * 100) : 0;
      row.innerHTML = `
        <span class="lb-rank">${i + 1}</span>
        <span class="lb-player"><img src="${u.avatar || defaultAvatarDataUri(u.displayName)}" alt="">${escapeHtml(u.displayName)}</span>
        <span>${u.stats.points}</span>
        <span>${u.stats.wins}-${u.stats.draws}-${u.stats.losses}</span>
        <span>${winRate}%</span>
        <span class="${u.stats.avgPnl >= 0 ? 'lb-positive' : 'lb-negative'}">${u.stats.avgPnl > 0 ? '+' : ''}${u.stats.avgPnl.toFixed(2)}%</span>
        <span class="${u.stats.bestPnl >= 0 ? 'lb-positive' : 'lb-negative'}">${u.stats.bestPnl > 0 ? '+' : ''}${u.stats.bestPnl.toFixed(2)}%</span>
      `;
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => openPublicProfile(u.id));
      body.appendChild(row);
    });
  } catch (e) {
    // silencieux : le tableau reste vide
  }
}

// ===================== PROFILE =====================

function fillProfileForm() {
  document.getElementById('profileDisplayName').value = currentUser.displayName;
  document.getElementById('profileBio').value = currentUser.bio || '';
  document.getElementById('profileX').value = currentUser.socialX || '';
  document.getElementById('profileInstagram').value = currentUser.socialInstagram || '';
  document.getElementById('profileTiktok').value = currentUser.socialTiktok || '';

  document.getElementById('avatarPreview').src = currentUser.avatar || defaultAvatarDataUri(currentUser.displayName);

  document.getElementById('statMatches').textContent = currentUser.stats.matches;
  document.getElementById('statWins').textContent = currentUser.stats.wins;
  document.getElementById('statLosses').textContent = currentUser.stats.losses;
  document.getElementById('statDraws').textContent = currentUser.stats.draws;
  document.getElementById('statPoints').textContent = currentUser.stats.points;
  document.getElementById('statAvgPnl').textContent = `${currentUser.stats.avgPnl > 0 ? '+' : ''}${currentUser.stats.avgPnl}%`;
  document.getElementById('statBestPnl').textContent = `${currentUser.stats.bestPnl > 0 ? '+' : ''}${currentUser.stats.bestPnl}%`;
  document.getElementById('statNetCash').textContent = `${currentUser.stats.netCash > 0 ? '+' : ''}$${currentUser.stats.netCash}`;
  document.getElementById('profileWallet').textContent = currentUser.walletAddress || t('wallet.noneLinked');

  document.getElementById('profileError').textContent = '';
  document.getElementById('profileSuccess').textContent = '';
}

function resizeImageToDataUrl(file, size) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        const scale = Math.max(size / img.width, size / img.height);
        const w = img.width * scale, h = img.height * scale;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

document.getElementById('avatarInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const errEl = document.getElementById('profileError');
  const okEl = document.getElementById('profileSuccess');
  errEl.textContent = '';
  okEl.textContent = '';
  const preview = document.getElementById('avatarPreview');
  const previousSrc = preview.src;
  try {
    const dataUrl = await resizeImageToDataUrl(file, 160);
    preview.src = dataUrl;
    // La photo se sauvegarde immediatement (pas besoin de cliquer sur "Enregistrer" en plus).
    const res = await fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ avatar: dataUrl }),
    });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || t('profile.photoSaveError');
      preview.src = previousSrc;
      return;
    }
    currentUser = data.user;
    updateAccountUI();
    okEl.textContent = t('profile.photoUpdated');
  } catch (err) {
    errEl.textContent = t('profile.photoError');
    preview.src = previousSrc;
  }
});

document.getElementById('saveProfileBtn').addEventListener('click', async () => {
  const errEl = document.getElementById('profileError');
  const okEl = document.getElementById('profileSuccess');
  errEl.textContent = '';
  okEl.textContent = '';

  const payload = {
    displayName: document.getElementById('profileDisplayName').value,
    bio: document.getElementById('profileBio').value,
    socialX: document.getElementById('profileX').value,
    socialInstagram: document.getElementById('profileInstagram').value,
    socialTiktok: document.getElementById('profileTiktok').value,
  };

  try {
    const res = await fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || t('common.error'); return; }
    currentUser = data.user;
    updateAccountUI();
    okEl.textContent = t('profile.updated');
  } catch (err) {
    errEl.textContent = t('common.networkError');
  }
});

// ===================== RECHERCHE DE JOUEURS =====================

async function findSimilarUsers() {
  if (!currentUser) return [];
  try {
    const res = await fetch('/api/leaderboard');
    const lb = await res.json();
    const userStats = currentUser.stats;
    return lb.users
      .filter(u => u.id !== currentUser.id)
      .map(u => ({
        ...u,
        statsDiff: Math.abs(u.stats.points - userStats.points) + Math.abs(u.stats.matches - userStats.matches),
      }))
      .sort((a, b) => a.statsDiff - b.statsDiff)
      .slice(0, 6)
      .map(({ statsDiff, ...u }) => u);
  } catch (e) {
    return [];
  }
}

async function runPlayerSearch() {
  const q = document.getElementById('playerSearchInput').value.trim();
  const resultsEl = document.getElementById('playerSearchResults');
  const emptyEl = document.getElementById('playerSearchEmpty');
  const panelEl = document.getElementById('playersPanel');
  panelEl.classList.remove('collapsed');
  resultsEl.innerHTML = '';

  let list = [];
  if (q.length < 2) {
    list = await findSimilarUsers();
    emptyEl.textContent = list.length === 0 ? t('players.empty') : '';
    emptyEl.classList.toggle('hidden', list.length > 0);
    if (list.length === 0) return;
  } else {
    try {
      const res = await fetch(`/api/users/search?q=${encodeURIComponent(q)}`);
      list = await res.json();
      if (list.length === 0) {
        emptyEl.textContent = t('players.empty');
        emptyEl.classList.remove('hidden');
        return;
      }
      emptyEl.classList.add('hidden');
    } catch (e) {
      emptyEl.textContent = t('common.networkError');
      emptyEl.classList.remove('hidden');
      return;
    }
  }

  list.forEach((u) => {
    const row = document.createElement('div');
    row.className = 'search-result-row';
    row.innerHTML = `
      <img src="${u.avatar || defaultAvatarDataUri(u.displayName)}" alt="">
      <div>
        <div class="search-result-name">${escapeHtml(u.displayName)}</div>
        <div class="search-result-meta">${u.walletAddress ? `${u.walletAddress.slice(0, 4)}...${u.walletAddress.slice(-4)}` : t('wallet.noneLinkedShort')}</div>
      </div>
      <div class="search-result-stats">${t('players.statsShort', { matches: u.stats.matches, points: u.stats.points })}</div>
    `;
    row.addEventListener('click', () => openPublicProfile(u.id));
    resultsEl.appendChild(row);
  });
}

document.getElementById('playerSearchBtn').addEventListener('click', runPlayerSearch);
document.getElementById('playerSearchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runPlayerSearch();
});

// ===================== DEFI DIRECT (recherche rapide depuis le lobby) =====================

async function runDuelSearch() {
  const q = document.getElementById('duelSearchInput').value.trim();
  const resultsEl = document.getElementById('duelSearchResults');
  const emptyEl = document.getElementById('duelSearchEmpty');
  resultsEl.innerHTML = '';

  let list = [];
  if (q.length < 2) {
    list = await findSimilarUsers();
    emptyEl.textContent = list.length === 0 ? t('players.empty') : '';
    emptyEl.classList.toggle('hidden', list.length > 0);
    if (list.length === 0) return;
  } else {
    try {
      const res = await fetch(`/api/users/search?q=${encodeURIComponent(q)}`);
      list = await res.json();
      if (list.length === 0) {
        emptyEl.textContent = t('players.empty');
        emptyEl.classList.remove('hidden');
        return;
      }
      emptyEl.classList.add('hidden');
    } catch (e) {
      emptyEl.textContent = t('common.networkError');
      emptyEl.classList.remove('hidden');
      return;
    }
  }

  list.forEach((u) => {
    const row = document.createElement('div');
    row.className = 'duel-result-row';
    const isSelf = currentUser && currentUser.id === u.id;
    row.innerHTML = `
      <img src="${u.avatar || defaultAvatarDataUri(u.displayName)}" alt="">
      <div class="duel-result-info">
        <div class="duel-result-name">${escapeHtml(u.displayName)}</div>
        <div class="duel-result-stats">${t('players.statsShort', { matches: u.stats.matches, points: u.stats.points })}</div>
      </div>
      <button class="btn btn-primary duel-result-btn"${isSelf ? ' disabled' : ''} data-i18n="public.challenge">${t('public.challenge')}</button>
    `;
    if (!isSelf) {
      row.querySelector('.duel-result-btn').addEventListener('click', () => openChallengeModalFor(u));
    }
    resultsEl.appendChild(row);
  });
}

document.getElementById('duelSearchBtn').addEventListener('click', runDuelSearch);
document.getElementById('duelSearchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runDuelSearch();
});

// ===================== PROFIL PUBLIC =====================

let viewedPublicUser = null;

async function openPublicProfile(userId) {
  try {
    const res = await fetch(`/api/users/${userId}`);
    const data = await res.json();
    if (!res.ok) { alert(data.error || t('public.notFound')); return; }
    viewedPublicUser = data.user;
    renderPublicProfile(viewedPublicUser);
    showView('publicProfile');
  } catch (e) {
    alert(t('common.networkError'));
  }
}

function renderPublicProfile(u) {
  document.getElementById('publicAvatar').src = u.avatar || defaultAvatarDataUri(u.displayName);
  document.getElementById('publicDisplayName').textContent = u.displayName;
  document.getElementById('publicBio').textContent = u.bio || t('public.noBio');
  document.getElementById('publicWallet').textContent = u.walletAddress ? t('public.walletLabel', { address: u.walletAddress }) : t('wallet.noneLinkedShort');

  const socials = document.getElementById('publicSocials');
  socials.innerHTML = '';
  const addSocial = (label, handle, urlBase) => {
    if (!handle) return;
    const clean = handle.replace('@', '');
    const a = document.createElement('a');
    a.href = `${urlBase}${encodeURIComponent(clean)}`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = label;
    socials.appendChild(a);
  };
  addSocial('X', u.socialX, 'https://x.com/');
  addSocial('Instagram', u.socialInstagram, 'https://instagram.com/');
  addSocial('TikTok', u.socialTiktok, 'https://tiktok.com/@');

  document.getElementById('publicStatMatches').textContent = u.stats.matches;
  document.getElementById('publicStatWins').textContent = u.stats.wins;
  document.getElementById('publicStatLosses').textContent = u.stats.losses;
  document.getElementById('publicStatDraws').textContent = u.stats.draws;
  document.getElementById('publicStatPoints').textContent = u.stats.points;
  document.getElementById('publicStatAvgPnl').textContent = `${u.stats.avgPnl > 0 ? '+' : ''}${u.stats.avgPnl}%`;
  document.getElementById('publicStatBestPnl').textContent = `${u.stats.bestPnl > 0 ? '+' : ''}${u.stats.bestPnl}%`;

  const challengeBtn = document.getElementById('challengeBtn');
  const selfHint = document.getElementById('challengeSelfHint');
  if (currentUser && currentUser.id === u.id) {
    challengeBtn.classList.add('hidden');
    selfHint.textContent = t('public.selfHint');
  } else {
    challengeBtn.classList.remove('hidden');
    selfHint.textContent = '';
  }
}

document.getElementById('backFromPublicProfile').addEventListener('click', () => showView('players'));

// ===================== DEFI 1v1 =====================

let selectedChallengeDuration = null;
let selectedChallengeStakeMode = 'free';
let challengeTargetUser = null;

function openChallengeModalFor(user) {
  if (!currentUser) { openAuthModal('login'); return; }
  if (!walletAddress) { openWalletModal(); return; }
  if (!user) return;

  challengeTargetUser = user;
  document.getElementById('challengeTargetName').textContent = user.displayName;
  document.querySelectorAll('#challengeDurationRow .chip').forEach((b) => b.classList.remove('selected'));
  selectedChallengeDuration = null;
  selectedChallengeStakeMode = 'free';
  document.querySelectorAll('#challengeStakeSwitch .stake-switch-opt').forEach((b) => b.classList.toggle('selected', b.dataset.stakeMode === 'free'));
  document.getElementById('challengeCashWarning').classList.add('hidden');
  document.getElementById('sendChallengeBtn').disabled = true;
  document.getElementById('challengeModalError').textContent = '';
  document.getElementById('challengeModal').classList.remove('hidden');
}

document.getElementById('challengeBtn').addEventListener('click', () => openChallengeModalFor(viewedPublicUser));

document.querySelectorAll('#challengeDurationRow .chip').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#challengeDurationRow .chip').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedChallengeDuration = btn.dataset.duration;
    document.getElementById('sendChallengeBtn').disabled = false;
  });
});

document.querySelectorAll('#challengeStakeSwitch .stake-switch-opt').forEach((btn) => {
  btn.addEventListener('click', () => {
    selectedChallengeStakeMode = btn.dataset.stakeMode;
    document.querySelectorAll('#challengeStakeSwitch .stake-switch-opt').forEach((b) => b.classList.toggle('selected', b.dataset.stakeMode === selectedChallengeStakeMode));
    document.getElementById('challengeCashWarning').classList.toggle('hidden', selectedChallengeStakeMode !== 'cash');
  });
});

document.getElementById('closeChallengeModal').addEventListener('click', () => {
  document.getElementById('challengeModal').classList.add('hidden');
});

document.getElementById('sendChallengeBtn').addEventListener('click', () => {
  if (!challengeTargetUser || !selectedChallengeDuration) return;
  const cash = selectedChallengeStakeMode === 'cash';
  socket.emit('challengeUser', { targetUserId: challengeTargetUser.id, duration: selectedChallengeDuration, cash });
  document.getElementById('challengeModal').classList.add('hidden');
  document.getElementById('challengeWaitingText').textContent = t('challenge.waitingFor', { name: challengeTargetUser.displayName });
  document.getElementById('challengeWaitingModal').classList.remove('hidden');
});

document.getElementById('cancelChallengeWaitBtn').addEventListener('click', () => {
  document.getElementById('challengeWaitingModal').classList.add('hidden');
});

socket.on('challengeSent', () => {
  // confirmation silencieuse : le modal d'attente est deja affiche
});

socket.on('challengeDeclined', () => {
  document.getElementById('challengeWaitingModal').classList.add('hidden');
  alert(t('challenge.declinedAlert'));
});

socket.on('challengeExpired', () => {
  document.getElementById('challengeWaitingModal').classList.add('hidden');
  alert(t('challenge.expiredAlert'));
});

let incomingChallengeId = null;
let incomingChallengeCountdownInterval = null;

socket.on('challengeReceived', (data) => {
  incomingChallengeId = data.challengeId;
  document.getElementById('incomingChallengeAvatar').src = data.fromAvatar || defaultAvatarDataUri(data.fromName);
  document.getElementById('incomingChallengeName').textContent = data.fromName;
  document.getElementById('incomingChallengeDuration').textContent = t('challenge.duration', { duration: formatDuration(data.durationSec) });
  document.getElementById('incomingChallengeCashBadge').classList.toggle('hidden', !data.cash);

  let secondsLeft = 60;
  const countdownEl = document.getElementById('incomingChallengeCountdown');
  countdownEl.textContent = t('common.expiresIn', { sec: secondsLeft });
  clearInterval(incomingChallengeCountdownInterval);
  incomingChallengeCountdownInterval = setInterval(() => {
    secondsLeft--;
    if (secondsLeft <= 0) {
      clearInterval(incomingChallengeCountdownInterval);
      document.getElementById('incomingChallengeModal').classList.add('hidden');
      return;
    }
    countdownEl.textContent = t('common.expiresIn', { sec: secondsLeft });
  }, 1000);

  document.getElementById('incomingChallengeModal').classList.remove('hidden');
});

document.getElementById('acceptChallengeBtn').addEventListener('click', () => {
  if (!incomingChallengeId) return;
  socket.emit('challengeRespond', { challengeId: incomingChallengeId, accept: true });
  clearInterval(incomingChallengeCountdownInterval);
  document.getElementById('incomingChallengeModal').classList.add('hidden');
});

document.getElementById('declineChallengeBtn').addEventListener('click', () => {
  if (!incomingChallengeId) return;
  socket.emit('challengeRespond', { challengeId: incomingChallengeId, accept: false });
  clearInterval(incomingChallengeCountdownInterval);
  document.getElementById('incomingChallengeModal').classList.add('hidden');
});

// ===================== AMBIANCE MARCHE (ticker + pouls) =====================

const TICKER_TOKENS = [
  { sym: 'BTC', id: 'bitcoin' },
  { sym: 'ETH', id: 'ethereum' },
  { sym: 'BNB', id: 'binancecoin' },
  { sym: 'SOL', id: 'solana' },
  { sym: 'XRP', id: 'ripple' },
  { sym: 'HYPE', id: 'hyperliquid' },
  { sym: 'USDT', id: 'tether' },
];

let tickerPrices = {};

async function fetchTickerPrices() {
  try {
    const ids = TICKER_TOKENS.map(t => t.id).join(',');
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`);
    tickerPrices = await res.json();
  } catch (e) {
    console.error('Failed to fetch ticker prices:', e);
  }
}

function fmtPrice(p) {
  if (p >= 1000) return '$' + p.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (p >= 1) return '$' + p.toFixed(2);
  return '$' + p.toFixed(4);
}

function changeIconSvg(cls, up) {
  return up
    ? `<svg class="${cls}" viewBox="0 0 10 10"><path d="M5,1 L9,7 L1,7 Z"/></svg>`
    : `<svg class="${cls}" viewBox="0 0 10 10"><path d="M5,9 L1,3 L9,3 Z"/></svg>`;
}

function buildTickerItem(tok) {
  const data = tickerPrices[tok.id];
  if (!data || !data.usd) return '';
  const price = data.usd;
  const change = data.usd_24h_change || 0;
  const up = change >= 0;
  return `<span class="ticker-item"><span class="ticker-sym">${tok.sym}</span><span class="ticker-price">${fmtPrice(price)}</span><span class="ticker-change ${up ? 'positive' : 'negative'}">${changeIconSvg('ticker-change-icon', up)}${up ? '+' : ''}${change.toFixed(1)}%</span></span>`;
}

function initTickerTape() {
  const track = document.getElementById('tickerTrack');
  if (!track) return;

  fetchTickerPrices().then(() => updateTickerContent(track));

  // Update prices every 30 seconds
  setInterval(() => {
    fetchTickerPrices().then(() => updateTickerContent(track));
  }, 30000);
}

function updateTickerContent(track) {
  const items = TICKER_TOKENS.map(buildTickerItem).join('');
  track.innerHTML = items;
}

async function fetchTraderRecap() {
  if (!currentUser) return null;
  try {
    const res = await fetch('/api/me/recap');
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

function buildTraderRecapContent(container, data) {
  container.innerHTML = '';
  if (!currentUser) {
    const msg = document.createElement('p');
    msg.className = 'hint recap-empty';
    msg.textContent = t('recap24h.loginPrompt');
    container.appendChild(msg);
    return;
  }
  if (!data || data.matches.length < 2) {
    const msg = document.createElement('p');
    msg.className = 'hint recap-empty';
    msg.textContent = t('recap24h.empty');
    container.appendChild(msg);
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.className = 'recap-chart';
  canvas.width = 260;
  canvas.height = 60;
  container.appendChild(canvas);
  drawSparkline(canvas, data.matches.map((m) => m.pnlPct));

  const stats = document.createElement('div');
  stats.className = 'recap-stats';
  [
    [t('recap24h.matches'), String(data.matches.length)],
    [t('recap24h.avgPnl'), `${data.avgPnl > 0 ? '+' : ''}${data.avgPnl.toFixed(2)}%`],
    [t('recap24h.bestPnl'), `${data.bestPnl > 0 ? '+' : ''}${data.bestPnl.toFixed(2)}%`],
  ].forEach(([label, value]) => {
    const chip = document.createElement('div');
    chip.className = 'recap-stat';
    const v = document.createElement('strong');
    v.textContent = value;
    const l = document.createElement('span');
    l.textContent = label;
    chip.appendChild(v);
    chip.appendChild(l);
    stats.appendChild(chip);
  });
  container.appendChild(stats);
}

async function initTraderRecap() {
  const containers = document.querySelectorAll('.trader-recap');
  if (!containers.length) return;
  const data = await fetchTraderRecap();
  containers.forEach((el) => buildTraderRecapContent(el, data));
}

initTickerTape();
initTraderRecap();
