const { PlayerTracker, checkWallet, eligibilityMessage } = require('./playertracker');
const { MatchLogger } = require('./matchlog');
const { VERDICT } = require('./verification');
const { settleTeamMatch, settleBrMatch } = require('./settlement');
const db = require('./db');
const escrow = require('./escrow');

const MODE_TEAM_SIZE = { '1v1': 1, '2v2': 2, '3v3': 3, '4v4': 4, '5v5': 5 };
const DURATIONS = { '1m': 60, '5m': 300, '10m': 600, '15m': 900, '30m': 1800, '1h': 3600 };

const QUEUE_FILL_WAIT_MS = 8000; // temps d'attente avant de completer avec des bots
const TICK_MS = 2000;
const CHALLENGE_TIMEOUT_MS = 60000;

const BR_SIZE = Number(process.env.BR_SIZE) || 15;
const BR_DURATION_SEC = Number(process.env.BR_DURATION_SEC) || 1800;
const BR_ELIMINATION_INTERVAL_MS = Number(process.env.BR_ELIMINATION_INTERVAL_MS) || 120000;
const BR_QUEUE_FILL_WAIT_MS = 10000;

const MIN_STAKE_USD = 1;
const CASH_DEPOSIT_WINDOW_MS = 45000;
const BR_STAKE_WINDOW_MS = 45000;
const BR_DEFAULT_BOT_STAKE = 5;
const PLATFORM_FEE_RATE = Number(process.env.PLATFORM_FEE_RATE) || 0.15;

// Match a mise dont la verification echoue : on reessaie avant de rembourser.
const VERIFY_RETRY_DELAYS_MS = (process.env.VERIFY_RETRY_DELAYS_MS || '5000,10000,20000').split(',').map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BOT_NAMES = [
  'DegenApe', 'MoonBoy', 'RugSurvivor', 'PaperHands', 'DiamondPaws',
  'SnipeKing', 'WhaleAlert', 'FloorSweeper', 'GemHunter', 'ChartWizard',
];

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

class GameEngine {
  constructor(io) {
    this.io = io;
    this.queues = new Map(); // key -> { players: [], timer, createdAt }
    this.matches = new Map(); // matchId -> match
    this.players = new Map(); // socketId -> player
    this.botCounter = 0;

    this.brQueues = { free: null, cash: null }; // { players: [], timer }
    this.brMatches = new Map(); // matchId -> br match

    this.pendingChallenges = new Map(); // challengeId -> { fromSocketId, toSocketId, durationKey, timer }
    this.pendingCash = new Map(); // pendingId -> team-mode deposit window
    this.pendingBrStakes = new Map(); // pendingId -> br stake proposal window
  }

  registerPlayer(socket, user) {
    this.players.set(socket.id, {
      id: socket.id,
      socket,
      userId: user ? user.id : null,
      name: user ? user.displayName : `Invite-${socket.id.slice(0, 4)}`,
      avatar: user ? user.avatar : null,
      wallet: null,
      isBot: false,
      queueKey: null,
      matchId: null,
      pendingCashId: null,
      pendingBrStakeId: null,
    });
  }

  setWallet(socketId, wallet) {
    const p = this.players.get(socketId);
    if (!p) return;
    p.wallet = wallet;
    if (p.userId) db.setWalletAddress(p.userId, wallet);
  }

  clearWallet(socketId) {
    const p = this.players.get(socketId);
    if (p) p.wallet = null;
  }

  findPlayerByUserId(userId) {
    for (const p of this.players.values()) {
      if (p.userId === userId) return p;
    }
    return null;
  }

  checkEligible(player) {
    if (!player.userId) return 'Connecte-toi a ton compte pour lancer un match.';
    if (!player.wallet) return 'Connecte ton wallet pour lancer un match.';
    return null;
  }

  // Depart propre : le wallet ne doit contenir que du SOL et des stablecoins.
  async checkWalletForMatch(player) {
    try {
      const eligibility = await checkWallet(player.wallet);
      return eligibility.eligible ? null : eligibilityMessage(eligibility);
    } catch (e) {
      return 'Impossible de lire ton wallet pour le moment. Reessaie dans quelques secondes.';
    }
  }

  // Controle complet avant une file d'attente. La lecture du wallet prend une
  // seconde : on ignore les doubles clics pendant ce temps.
  async gateForMatch(player) {
    const err = this.checkEligible(player);
    if (err) return err;
    if (player.checking) return 'Verification de ton wallet en cours...';
    player.checking = true;
    try {
      return await this.checkWalletForMatch(player);
    } finally {
      player.checking = false;
    }
  }

  platformAddresses() {
    return new Set([escrow.getHouseAddress(), escrow.getFeeWalletAddress()].filter(Boolean));
  }

  // ===================== FILES D'ATTENTE (MODES EQUIPE) =====================

  async joinQueue(socketId, mode, durationKey, cash = false) {
    if (!MODE_TEAM_SIZE[mode] || !DURATIONS[durationKey]) return;
    const player = this.players.get(socketId);
    if (!player || player.matchId || player.queueKey) return;

    const err = await this.gateForMatch(player);
    // Le joueur a pu se deconnecter ou entrer ailleurs pendant la lecture.
    if (this.players.get(socketId) !== player || player.matchId || player.queueKey) return;
    if (err) {
      if (player.socket) player.socket.emit('matchError', err);
      return;
    }

    const key = `${mode}_${durationKey}_${cash ? 'cash' : 'free'}`;
    const needed = MODE_TEAM_SIZE[mode] * 2;
    if (!this.queues.has(key)) {
      this.queues.set(key, { players: [], timer: null, createdAt: Date.now(), cash, needed });
    }
    const q = this.queues.get(key);
    q.players.push(player);
    player.queueKey = key;

    this.emitQueueStatus(key);

    if (q.players.length >= needed) {
      this.startMatchFromQueue(key, mode, durationKey, cash);
    } else if (!q.timer) {
      q.timer = setTimeout(() => {
        this.fillWithBotsAndStart(key, mode, durationKey, cash);
      }, QUEUE_FILL_WAIT_MS);
    }
  }

  leaveQueue(socketId) {
    const player = this.players.get(socketId);
    if (!player || !player.queueKey) return;
    const q = this.queues.get(player.queueKey);
    if (q) {
      q.players = q.players.filter((p) => p.id !== socketId);
      if (q.players.length === 0 && q.timer) {
        clearTimeout(q.timer);
        this.queues.delete(player.queueKey);
      } else {
        this.emitQueueStatus(player.queueKey);
      }
    }
    player.queueKey = null;
  }

  emitQueueStatus(key) {
    const q = this.queues.get(key);
    if (!q) return;
    for (const p of q.players) {
      if (p.socket) p.socket.emit('queueStatus', { inQueue: q.players.length, needed: q.needed, cash: q.cash });
    }
  }

  fillWithBotsAndStart(key, mode, durationKey, cash) {
    const q = this.queues.get(key);
    if (!q || q.players.length === 0) return;
    const needed = MODE_TEAM_SIZE[mode] * 2;
    while (q.players.length < needed) {
      q.players.push(this.createBot());
    }
    this.startMatchFromQueue(key, mode, durationKey, cash);
  }

  createBot() {
    this.botCounter++;
    const name = `${BOT_NAMES[this.botCounter % BOT_NAMES.length]}${this.botCounter}`;
    return { id: `bot_${this.botCounter}_${Date.now()}`, socket: null, isBot: true, name, wallet: null, matchId: null };
  }

  startMatchFromQueue(key, mode, durationKey, cash) {
    const q = this.queues.get(key);
    if (!q) return;
    if (q.timer) clearTimeout(q.timer);

    const teamSize = MODE_TEAM_SIZE[mode];
    const totalNeeded = teamSize * 2;
    const participants = q.players.splice(0, totalNeeded);
    for (const p of participants) if (!p.isBot) p.queueKey = null;

    if (q.players.length === 0) this.queues.delete(key);
    else {
      q.timer = null;
      this.emitQueueStatus(key);
    }

    if (cash) {
      this.startCashStakePhase(mode, durationKey, participants);
    } else {
      this.createMatch(mode, durationKey, participants, null);
    }
  }

  // ===================== FENETRE DE MISE (MODES EQUIPE) =====================
  // Chaque joueur reel propose son propre montant (pas de montant impose par la file).
  // Les bots ne misent jamais : s'ils gagnent, l'argent du/des joueur(s) reste dans le wallet maison.

  startCashStakePhase(mode, durationKey, participants) {
    const pendingId = `pend_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const pending = {
      id: pendingId,
      mode,
      durationKey,
      participants,
      stakes: new Map(),
      status: new Map(),
      timer: setTimeout(() => this.resolveCashStakePhase(pendingId), CASH_DEPOSIT_WINDOW_MS),
    };
    this.pendingCash.set(pendingId, pending);

    for (const p of participants) {
      if (p.isBot) {
        pending.status.set(p.id, 'confirmed');
        pending.stakes.set(p.id, 0);
      } else {
        pending.status.set(p.id, 'pending');
        p.pendingCashId = pendingId;
        if (p.socket) {
          p.socket.emit('cashStakePhaseStart', {
            pendingId,
            minStake: MIN_STAKE_USD,
            deadlineMs: CASH_DEPOSIT_WINDOW_MS,
            mode,
            durationSec: DURATIONS[durationKey],
            totalPlayers: participants.length,
          });
        }
      }
    }
    this.emitCashStakeUpdate(pending);
  }

  emitCashStakeUpdate(pending) {
    const summary = pending.participants.map((p) => ({
      id: p.id,
      name: p.name,
      isBot: p.isBot,
      status: pending.status.get(p.id),
      stake: pending.stakes.has(p.id) ? pending.stakes.get(p.id) : null,
    }));
    const pot = round2([...pending.stakes.values()].reduce((a, b) => a + b, 0));
    for (const p of pending.participants) {
      if (p.socket) p.socket.emit('cashStakeUpdate', { pendingId: pending.id, summary, pot });
    }
  }

  maybeResolveCashStakeEarly(pending) {
    const allDone = pending.participants.every((p) => pending.status.get(p.id) !== 'pending');
    if (allDone) this.resolveCashStakePhase(pending.id);
  }

  async prepareCashStake(socketId, pendingId, amountDollars) {
    const pending = this.pendingCash.get(pendingId);
    if (!pending) return { error: 'Cette fenetre de mise a expire.' };
    const player = this.players.get(socketId);
    if (!player || player.pendingCashId !== pendingId) return { error: 'Mise invalide.' };
    if (pending.status.get(player.id) !== 'pending') return { error: 'Deja traite.' };
    amountDollars = Number(amountDollars);
    if (!(amountDollars >= MIN_STAKE_USD)) return { error: `Mise minimum : ${MIN_STAKE_USD}$.` };

    try {
      const tx = await escrow.buildDepositTransaction(player.wallet, amountDollars);
      return { ok: true, tx, amount: amountDollars };
    } catch (e) {
      return { error: 'Impossible de preparer la transaction. Reessaie.' };
    }
  }

  async confirmCashStake(socketId, pendingId, signedBase64, amountDollars) {
    const pending = this.pendingCash.get(pendingId);
    if (!pending) return { error: 'Cette fenetre de mise a expire.' };
    const player = this.players.get(socketId);
    if (!player || player.pendingCashId !== pendingId) return { error: 'Mise invalide.' };
    if (pending.status.get(player.id) !== 'pending') return { error: 'Deja traite.' };

    try {
      await escrow.submitSignedDeposit(signedBase64);
    } catch (e) {
      return { error: 'Le depot a echoue sur la blockchain. Reessaie.' };
    }
    pending.status.set(player.id, 'confirmed');
    pending.stakes.set(player.id, Number(amountDollars));
    this.emitCashStakeUpdate(pending);
    this.maybeResolveCashStakeEarly(pending);
    return { ok: true };
  }

  declineCashStake(socketId, pendingId) {
    const pending = this.pendingCash.get(pendingId);
    if (!pending) return;
    const player = this.players.get(socketId);
    if (!player || player.pendingCashId !== pendingId) return;
    if (pending.status.get(player.id) !== 'pending') return;
    pending.status.set(player.id, 'declined');
    // En mode equipe les effectifs sont fixes : un refus annule tout de suite le groupe.
    this.resolveCashStakePhase(pending.id);
  }

  async resolveCashStakePhase(pendingId) {
    const pending = this.pendingCash.get(pendingId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingCash.delete(pendingId);

    for (const p of pending.participants) if (!p.isBot) p.pendingCashId = null;

    const allConfirmed = pending.participants.every((p) => pending.status.get(p.id) === 'confirmed');

    if (!allConfirmed) {
      await Promise.all(
        pending.participants.map(async (p) => {
          if (!p.isBot && pending.status.get(p.id) === 'confirmed') {
            const amount = pending.stakes.get(p.id);
            if (amount > 0) {
              try {
                await escrow.houseTransfer(p.wallet, amount);
              } catch (e) {
                console.error('[cash] Remboursement echoue pour', p.wallet, e.message);
              }
            }
          }
        })
      );
      for (const p of pending.participants) {
        if (p.socket) {
          p.socket.emit('cashCancelled', {
            reason: "Un ou plusieurs joueurs n'ont pas confirme leur mise a temps. Les depots ont ete rembourses.",
          });
        }
      }
      return;
    }

    this.createMatch(pending.mode, pending.durationKey, pending.participants, pending.stakes);
  }

  // ===================== MATCH EQUIPE =====================

  async createMatch(mode, durationKey, participants, stakesMap) {
    const matchId = `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const teamSize = MODE_TEAM_SIZE[mode];
    const shuffled = shuffle(participants.slice());
    const teamA = shuffled.slice(0, teamSize);
    const teamB = shuffled.slice(teamSize, teamSize * 2);

    const durationSec = DURATIONS[durationKey];
    const stakes = stakesMap || new Map();
    const pot = round2([...stakes.values()].reduce((a, b) => a + b, 0));
    const match = {
      id: matchId,
      mode,
      durationSec,
      isCash: !!stakesMap,
      stakes,
      pot,
      startedAt: Date.now(),
      endsAt: Date.now() + durationSec * 1000,
      teams: [teamA, teamB],
      state: new Map(),
      tickTimer: null,
      ending: false,
      logger: new MatchLogger(matchId, { mode, durationSec, isCash: !!stakesMap, startedAt: Date.now() }),
    };

    const problems = await this.initializeTrackers(match, [...teamA, ...teamB]);
    // De l'argent ne se joue jamais sur un score simule : un wallet illisible ou
    // non conforme annule le match a mise avant qu'il commence.
    if (match.isCash && problems.length) {
      await this.abortCashMatch(match, [...teamA, ...teamB], problems);
      return;
    }

    this.matches.set(matchId, match);
    this.io.to(matchId).emit('matchStart', this.serializeMatch(match));
    match.tickTimer = setInterval(() => this.tickMatch(matchId), TICK_MS);
  }

  // Prepare le suivi de chaque joueur. Renvoie les joueurs reels qui ne
  // peuvent pas etre suivis (wallet illisible ou depart non conforme) : en
  // match gratuit ils jouent avec un score simule, hors classement.
  async initializeTrackers(match, players, extraState = {}) {
    const problems = [];
    await Promise.all(
      players.map(async (p) => {
        p.matchId = match.id;
        if (p.socket) p.socket.join(match.id);

        let tracker = null;
        let walletError = null;

        if (!p.isBot && p.wallet) {
          const candidate = new PlayerTracker({ playerId: p.id, name: p.name, wallet: p.wallet, logger: match.logger });
          try {
            const { eligible, eligibility } = await candidate.initialize();
            if (eligible) {
              tracker = candidate;
            } else {
              walletError = 'Depart non conforme : hors classement';
              problems.push({ player: p, reason: eligibilityMessage(eligibility) });
            }
          } catch (e) {
            walletError = 'Wallet illisible : hors classement';
            problems.push({ player: p, reason: 'Wallet illisible au lancement du match.' });
            match.logger.addError(p.id, 'match.init', e);
          }
        }
        if (!tracker) {
          match.logger.registerPlayer(p.id, { name: p.name, wallet: p.wallet, simulated: true, reason: walletError });
        }

        match.state.set(p.id, {
          name: p.name,
          avatar: p.avatar || null,
          userId: p.userId || null,
          isBot: p.isBot,
          wallet: p.wallet,
          tracker,
          simulated: !tracker,
          unranked: !p.isBot && !tracker,
          pnlPct: 0,
          history: [0],
          walletError,
          alert: null,
          status: null,
          ...extraState,
        });
      })
    );
    return problems;
  }

  async refundStakes(match, players) {
    await Promise.all(
      players.map(async (p) => {
        const amount = match.stakes.get(p.id) || 0;
        if (p.isBot || !(amount > 0)) return;
        try {
          await escrow.houseTransfer(p.wallet, amount);
        } catch (e) {
          console.error('[cash] Remboursement echoue', p.wallet, e.message);
        }
      })
    );
  }

  async ejectFromCashMatch(match, problems) {
    const offenders = problems.map((x) => x.player);
    for (const p of offenders) {
      if (p.socket) p.socket.leave(match.id);
      p.matchId = null;
    }
    await this.refundStakes(match, offenders);
    for (const { player, reason } of problems) {
      if (player.socket) {
        player.socket.emit('cashCancelled', { reason: `Tu as ete retire de la partie, ta mise est remboursee. ${reason}` });
      }
    }
    match.logger.meta = {
      ...match.logger.meta,
      ejected: problems.map((x) => ({ player: x.player.name, reason: x.reason })),
    };
  }

  async abortCashMatch(match, players, problems, fallbackReason = null) {
    for (const p of players) {
      if (p.socket) p.socket.leave(match.id);
      p.matchId = null;
    }
    await this.refundStakes(match, players);

    const own = new Map(problems.map((x) => [x.player.id, x.reason]));
    const names = problems.map((x) => x.player.name).join(', ');
    const generic = fallbackReason || `le wallet de ${names} n'est pas conforme au depart`;
    for (const p of players) {
      if (!p.socket) continue;
      const reason = own.get(p.id);
      p.socket.emit('cashCancelled', {
        reason: reason ? `Match annule, mises remboursees. ${reason}` : `Match annule, mises remboursees : ${generic}.`,
      });
    }
    match.logger.meta = {
      ...match.logger.meta,
      aborted: true,
      abortReasons: problems.map((x) => ({ player: x.player.name, reason: x.reason })),
      fallbackReason,
    };
    await match.logger.write();
  }

  async tickMatch(matchId) {
    const match = this.matches.get(matchId);
    if (!match || match.ending) return;

    const allPlayers = [...match.teams[0], ...match.teams[1]];

    await Promise.all(
      allPlayers.map(async (p) => {
        const st = match.state.get(p.id);
        if (!st) return;

        if (st.simulated) {
          const step = (Math.random() - 0.48) * 4;
          st.pnlPct = round2(st.pnlPct + step);
        } else {
          // Le tracker decide lui-meme s'il doit interroger la blockchain :
          // le tick UI (2 s) est decouple du refresh wallet (5 s).
          st.pnlPct = await st.tracker.refresh();
          st.walletError = st.tracker.error;
          st.alert = st.tracker.alert;
        }

        st.history.push(st.pnlPct);
        if (st.history.length > 60) st.history.shift();
      })
    );

    // La fin de match a pu commencer pendant les lectures.
    if (match.ending) return;
    const remainingMs = Math.max(0, match.endsAt - Date.now());
    this.io.to(matchId).emit('matchUpdate', this.serializeMatch(match, remainingMs));

    if (remainingMs <= 0) this.endMatch(matchId);
  }

  async endMatch(matchId) {
    const match = this.matches.get(matchId);
    if (!match || match.ending) return;
    // Un tick en retard peut rappeler endMatch pendant la verification : sans
    // ce verrou, les gains pourraient partir deux fois.
    match.ending = true;
    clearInterval(match.tickTimer);

    const everyone = [...match.teams[0], ...match.teams[1]];
    await this.closeAndVerify(match, everyone.map((player) => ({ player, closing: true })));

    const settlement = settleTeamMatch({
      teams: match.teams.map((team) => team.map((p) => this.settlementEntry(match, p))),
      isCash: match.isCash,
      feeRate: PLATFORM_FEE_RATE,
    });
    const received = match.isCash ? await this.executeSettlement(settlement, everyone) : new Map();

    this.io.to(matchId).emit('matchEnd', {
      ...this.serializeMatch(match, 0),
      winner: settlement.winner,
      outcome: settlement.outcome,
      teamPnl: settlement.teamPnl,
      pot: match.pot,
      fee: settlement.fee,
      payouts: Object.fromEntries(received),
    });

    match.teams.forEach((team, teamIdx) => {
      const letter = teamIdx === 0 ? 'A' : 'B';
      const teamResult = settlement.winner === 'draw' ? 'draw' : settlement.winner === letter ? 'win' : 'loss';
      for (const p of team) {
        const st = match.state.get(p.id);
        this.recordResult(match, p, st, this.resultFor(settlement.outcome, st, teamResult), received, match.mode, match.durationSec);
      }
    });

    for (const p of everyone) {
      if (p.socket) p.socket.leave(matchId);
      p.matchId = null;
    }

    match.logger.meta = {
      ...match.logger.meta,
      winner: settlement.winner,
      outcome: settlement.outcome,
      teamPnl: settlement.teamPnl,
      pot: match.pot,
      fee: settlement.fee,
      settlement,
    };
    this.finalizeLogs(match, everyone);
    await match.logger.write();
    this.matches.delete(matchId);
  }

  // Cloture (snapshot final) puis verification anti-triche de chaque joueur
  // suivi. En match a mise, une verification impossible est retentee avant
  // de conclure : on ne paie jamais a l'aveugle.
  async closeAndVerify(match, entries) {
    const tracked = entries.filter(({ player }) => match.state.get(player.id)?.tracker);
    if (!tracked.length) return;
    this.io.to(match.id).emit('matchVerifying', { matchId: match.id });
    const ignoredSources = this.platformAddresses();

    const runVerify = async ({ player }) => {
      const st = match.state.get(player.id);
      try {
        await st.tracker.verify({ ignoredSources });
      } catch (e) {
        match.logger.addError(player.id, 'match.verify', e);
      }
      this.applyVerification(match, st);
    };

    await Promise.all(
      tracked.map(async (entry) => {
        if (entry.closing) {
          const st = match.state.get(entry.player.id);
          try {
            await st.tracker.close();
          } catch (e) {
            match.logger.addError(entry.player.id, 'match.close', e);
          }
        }
        await runVerify(entry);
      })
    );

    if (!match.isCash) return;
    for (const delay of VERIFY_RETRY_DELAYS_MS) {
      const pending = tracked.filter(({ player }) => match.state.get(player.id).status === 'unverified');
      if (!pending.length) return;
      await sleep(delay);
      await Promise.all(pending.map(runVerify));
    }
  }

  applyVerification(match, st) {
    const tracker = st.tracker;
    const report = tracker.verification;
    st.alert = tracker.alert;
    if (!report || report.status === VERDICT.UNVERIFIED) {
      st.status = 'unverified';
      st.pnlPct = tracker.pnlPct;
      return;
    }
    // Score recalcule : depots neutralises, cautions offertes par des tiers aussi.
    st.pnlPct = tracker.neutralizedPnlPct;
    if (report.status === VERDICT.INFLOWS) st.status = match.isCash ? 'disqualified' : 'neutralized';
    else st.status = 'clean';
  }

  settlementEntry(match, p) {
    const st = match.state.get(p.id);
    return {
      id: p.id,
      isBot: p.isBot,
      stake: match.stakes.get(p.id) || 0,
      pnlPct: st.pnlPct,
      alive: st.alive,
      status: st.status || 'simulated',
    };
  }

  async executeSettlement(settlement, players) {
    const byId = new Map(players.map((p) => [p.id, p]));
    const received = new Map();
    const send = async ({ id, amount }, label) => {
      const p = byId.get(id);
      if (!p || p.isBot || !(amount > 0)) return;
      try {
        await escrow.houseTransfer(p.wallet, amount);
        received.set(id, round2((received.get(id) || 0) + amount));
      } catch (e) {
        console.error(`[cash] ${label} echoue`, p.wallet, e.message);
      }
    };
    await Promise.all([
      ...settlement.refunds.map((r) => send(r, 'Remboursement')),
      ...settlement.payouts.map((r) => send(r, 'Paiement du gain')),
    ]);
    if (settlement.fee > 0) {
      try {
        await escrow.payFee(settlement.fee);
      } catch (e) {
        console.error('[cash] Transfert de la commission echoue', e.message);
      }
    }
    return received;
  }

  // null = resultat non enregistre (match rembourse faute de verification).
  resultFor(outcome, st, teamResult) {
    if (outcome === 'refund') return null;
    if (st.status === 'disqualified') return 'loss';
    if (outcome === 'void') return 'draw';
    return teamResult;
  }

  recordResult(match, p, st, result, received, mode, durationSec) {
    // Un score simule (wallet illisible ou depart non conforme) ne compte pas
    // dans les statistiques du joueur.
    if (!st.userId || st.unranked || result === null) return;
    const staked = match.stakes.get(p.id) || 0;
    db.recordMatchResult(st.userId, {
      mode,
      durationSec,
      pnlPct: st.pnlPct,
      result,
      staked,
      netCash: (received.get(p.id) || 0) - staked,
      verification: st.status,
    });
  }

  finalizeLogs(match, players) {
    for (const p of players) {
      const st = match.state.get(p.id);
      if (!st?.tracker?.ready) continue;
      const calculation = st.tracker.explain({
        livePnlPct: st.tracker.pnlPct,
        neutralizedPnlPct: st.tracker.neutralizedPnlPct,
        retainedPnlPct: st.pnlPct,
      });
      match.logger.finalize(p.id, { calculation, status: st.status, finalPnlPct: st.pnlPct });
      console.log(
        `[final] ${st.name}: capital=${calculation.startCapitalSol.toFixed(6)} SOL ` +
          `valeur=${calculation.finalValueSol.toFixed(6)} SOL direct=${st.tracker.pnlPct}% ` +
          `retenu=${st.pnlPct}% verification=${st.status}`
      );
    }
  }

  serializeMatch(match, remainingMsOverride) {
    const remainingMs = remainingMsOverride !== undefined ? remainingMsOverride : Math.max(0, match.endsAt - Date.now());
    const teamOut = (team) =>
      team.map((p) => {
        const st = match.state.get(p.id);
        return {
          id: p.id,
          name: st.name,
          avatar: st.avatar,
          isBot: st.isBot,
          simulated: st.simulated,
          unranked: !!st.unranked,
          alert: !!st.alert,
          status: st.status || null,
          pnlPct: st.pnlPct,
          history: st.history,
          walletError: st.walletError,
          staked: match.stakes.get(p.id) || 0,
        };
      });

    return {
      matchId: match.id,
      mode: match.mode,
      durationSec: match.durationSec,
      remainingMs,
      isCash: match.isCash,
      pot: match.pot,
      teams: [teamOut(match.teams[0]), teamOut(match.teams[1])],
    };
  }

  disconnect(socketId) {
    this.leaveQueue(socketId);
    this.leaveBrQueue(socketId);
    const player = this.players.get(socketId);
    if (player && player.pendingCashId) this.declineCashStake(socketId, player.pendingCashId);
    if (player && player.pendingBrStakeId) this.declineBrStake(socketId, player.pendingBrStakeId);
    this.players.delete(socketId);
  }

  // ===================== DEFIS 1v1 =====================

  async sendChallenge(fromSocketId, targetUserId, durationKey, cash) {
    const from = this.players.get(fromSocketId);
    if (!from || !from.userId) return { error: 'Connecte-toi a ton compte pour defier un joueur.' };
    if (!from.wallet) return { error: 'Connecte ton wallet pour defier un joueur.' };
    if (from.matchId || from.queueKey) return { error: 'Tu es deja en file d\'attente ou en match.' };
    if (!DURATIONS[durationKey]) return { error: 'Duree invalide.' };
    if (from.userId === targetUserId) return { error: 'Tu ne peux pas te defier toi-meme.' };

    const walletErr = await this.checkWalletForMatch(from);
    if (walletErr) return { error: walletErr };

    const target = this.findPlayerByUserId(targetUserId);
    if (!target) return { error: 'Ce joueur n\'est pas en ligne actuellement.' };
    if (target.matchId || target.queueKey) return { error: 'Ce joueur est deja occupe.' };
    if (from.matchId || from.queueKey) return { error: 'Tu es deja en file d\'attente ou en match.' };

    const challengeId = `ch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const timer = setTimeout(() => this.expireChallenge(challengeId), CHALLENGE_TIMEOUT_MS);
    this.pendingChallenges.set(challengeId, { fromSocketId, toSocketId: target.id, durationKey, cash: !!cash, timer });

    if (target.socket) {
      target.socket.emit('challengeReceived', {
        challengeId,
        fromName: from.name,
        fromAvatar: from.avatar || null,
        durationKey,
        durationSec: DURATIONS[durationKey],
        cash: !!cash,
      });
    }
    return { ok: true, challengeId };
  }

  expireChallenge(challengeId) {
    const ch = this.pendingChallenges.get(challengeId);
    if (!ch) return;
    this.pendingChallenges.delete(challengeId);
    const from = this.players.get(ch.fromSocketId);
    if (from && from.socket) from.socket.emit('challengeExpired', { challengeId });
  }

  async respondChallenge(socketId, challengeId, accept) {
    const ch = this.pendingChallenges.get(challengeId);
    if (!ch) return { error: 'Ce defi n\'existe plus (peut-etre expire).' };
    if (ch.toSocketId !== socketId) return { error: 'Ce defi ne te concerne pas.' };

    clearTimeout(ch.timer);
    this.pendingChallenges.delete(challengeId);

    const from = this.players.get(ch.fromSocketId);
    const to = this.players.get(ch.toSocketId);

    if (!accept) {
      if (from && from.socket) from.socket.emit('challengeDeclined');
      return { ok: true };
    }

    if (!from || from.matchId || from.queueKey) {
      return { error: 'Ce joueur n\'est plus disponible.' };
    }
    if (!to || !to.wallet) {
      return { error: 'Connecte ton wallet pour accepter ce defi.' };
    }

    // Les deux wallets ont pu changer depuis l'envoi du defi.
    const [fromErr, toErr] = await Promise.all([this.checkWalletForMatch(from), this.checkWalletForMatch(to)]);
    if (toErr) {
      if (from.socket) from.socket.emit('matchError', `${to.name} ne peut pas accepter ton defi : son wallet n'est pas conforme.`);
      return { error: toErr };
    }
    if (fromErr) {
      if (from.socket) from.socket.emit('matchError', `Defi annule. ${fromErr}`);
      return { error: `${from.name} ne peut pas jouer pour le moment : son wallet n'est pas conforme.` };
    }
    if (from.matchId || from.queueKey || to.matchId || to.queueKey) {
      return { error: 'Ce joueur n\'est plus disponible.' };
    }

    if (ch.cash) {
      this.startCashStakePhase('1v1', ch.durationKey, [from, to]);
    } else {
      this.createMatch('1v1', ch.durationKey, [from, to], null);
    }
    return { ok: true };
  }

  // ===================== BATTLE ROYALE : FILE D'ATTENTE =====================

  async joinBrQueue(socketId, cash) {
    const player = this.players.get(socketId);
    if (!player || player.matchId || player.queueKey) return;
    const err = await this.gateForMatch(player);
    if (this.players.get(socketId) !== player || player.matchId || player.queueKey) return;
    if (err) {
      if (player.socket) player.socket.emit('matchError', err);
      return;
    }

    const queueType = cash ? 'cash' : 'free';
    if (!this.brQueues[queueType]) this.brQueues[queueType] = { players: [], timer: null };
    const q = this.brQueues[queueType];
    q.players.push(player);
    player.queueKey = `br_${queueType}`;
    this.emitBrQueueStatus(queueType);

    if (q.players.length >= BR_SIZE) {
      this.startBrMatch(queueType);
    } else if (queueType === 'free' && !q.timer) {
      // Les bots ne jouent qu'en mode gratuit : ils n'ont pas de vrai argent a miser.
      q.timer = setTimeout(() => this.fillBrWithBotsAndStart(queueType), BR_QUEUE_FILL_WAIT_MS);
    }
  }

  leaveBrQueue(socketId) {
    const player = this.players.get(socketId);
    if (!player || !player.queueKey || !player.queueKey.startsWith('br_')) return;
    const queueType = player.queueKey.slice(3);
    const q = this.brQueues[queueType];
    if (q) {
      q.players = q.players.filter((p) => p.id !== socketId);
      if (q.players.length === 0 && q.timer) {
        clearTimeout(q.timer);
        this.brQueues[queueType] = null;
      } else {
        this.emitBrQueueStatus(queueType);
      }
    }
    player.queueKey = null;
  }

  emitBrQueueStatus(queueType) {
    const q = this.brQueues[queueType];
    if (!q) return;
    for (const p of q.players) {
      if (p.socket) p.socket.emit('brQueueStatus', { inQueue: q.players.length, needed: BR_SIZE, cash: queueType === 'cash' });
    }
  }

  fillBrWithBotsAndStart(queueType) {
    const q = this.brQueues[queueType];
    if (!q || q.players.length === 0) return;
    while (q.players.length < BR_SIZE) q.players.push(this.createBot());
    this.startBrMatch(queueType);
  }

  startBrMatch(queueType) {
    const q = this.brQueues[queueType];
    if (!q) return;
    if (q.timer) clearTimeout(q.timer);
    const participants = q.players.splice(0, BR_SIZE);
    for (const p of participants) if (!p.isBot) p.queueKey = null;
    this.brQueues[queueType] = q.players.length > 0 ? q : null;
    if (this.brQueues[queueType]) this.emitBrQueueStatus(queueType);

    if (queueType === 'cash') {
      this.startBrStakePhase(participants);
    } else {
      this.createBrMatch(participants);
    }
  }

  // ===================== BATTLE ROYALE : FENETRE DE MISE =====================

  startBrStakePhase(participants) {
    const pendingId = `brstake_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const pending = {
      id: pendingId,
      participants,
      stakes: new Map(),
      status: new Map(),
      timer: setTimeout(() => this.resolveBrStakePhase(pendingId), BR_STAKE_WINDOW_MS),
    };
    this.pendingBrStakes.set(pendingId, pending);

    for (const p of participants) {
      if (p.isBot) {
        pending.status.set(p.id, 'confirmed');
        pending.stakes.set(p.id, BR_DEFAULT_BOT_STAKE);
      } else {
        pending.status.set(p.id, 'pending');
        p.pendingBrStakeId = pendingId;
        if (p.socket) {
          p.socket.emit('brStakePhaseStart', {
            pendingId,
            minStake: MIN_STAKE_USD,
            deadlineMs: BR_STAKE_WINDOW_MS,
            totalPlayers: participants.length,
          });
        }
      }
    }
    this.emitBrStakeUpdate(pending);
  }

  emitBrStakeUpdate(pending) {
    const summary = pending.participants.map((p) => ({
      id: p.id,
      name: p.name,
      status: pending.status.get(p.id),
      stake: pending.stakes.has(p.id) ? pending.stakes.get(p.id) : null,
    }));
    const pot = round2([...pending.stakes.values()].reduce((a, b) => a + b, 0));
    for (const p of pending.participants) {
      if (p.socket) p.socket.emit('brStakeUpdate', { pendingId: pending.id, summary, pot });
    }
  }

  maybeResolveBrStakeEarly(pending) {
    const allDone = pending.participants.every((p) => pending.status.get(p.id) !== 'pending');
    if (allDone) this.resolveBrStakePhase(pending.id);
  }

  async prepareBrStakeDeposit(socketId, pendingId, amountDollars) {
    const pending = this.pendingBrStakes.get(pendingId);
    if (!pending) return { error: 'Cette fenetre de mise a expire.' };
    const player = this.players.get(socketId);
    if (!player || player.pendingBrStakeId !== pendingId) return { error: 'Mise invalide.' };
    if (pending.status.get(player.id) !== 'pending') return { error: 'Deja traite.' };
    amountDollars = Number(amountDollars);
    if (!(amountDollars >= MIN_STAKE_USD)) return { error: `Mise minimum : ${MIN_STAKE_USD}$.` };

    try {
      const tx = await escrow.buildDepositTransaction(player.wallet, amountDollars);
      return { ok: true, tx, amount: amountDollars };
    } catch (e) {
      return { error: 'Impossible de preparer la transaction (probleme reseau devnet). Reessaie.' };
    }
  }

  async confirmBrStakeDeposit(socketId, pendingId, signedBase64, amountDollars) {
    const pending = this.pendingBrStakes.get(pendingId);
    if (!pending) return { error: 'Cette fenetre de mise a expire.' };
    const player = this.players.get(socketId);
    if (!player || player.pendingBrStakeId !== pendingId) return { error: 'Mise invalide.' };
    if (pending.status.get(player.id) !== 'pending') return { error: 'Deja traite.' };

    try {
      await escrow.submitSignedDeposit(signedBase64);
    } catch (e) {
      return { error: 'Le depot a echoue sur la blockchain devnet. Reessaie.' };
    }
    pending.status.set(player.id, 'confirmed');
    pending.stakes.set(player.id, Number(amountDollars));
    this.emitBrStakeUpdate(pending);
    this.maybeResolveBrStakeEarly(pending);
    return { ok: true };
  }

  declineBrStake(socketId, pendingId) {
    const pending = this.pendingBrStakes.get(pendingId);
    if (!pending) return;
    const player = this.players.get(socketId);
    if (!player || player.pendingBrStakeId !== pendingId) return;
    if (pending.status.get(player.id) !== 'pending') return;
    pending.status.set(player.id, 'declined');
    this.maybeResolveBrStakeEarly(pending);
  }

  async resolveBrStakePhase(pendingId) {
    const pending = this.pendingBrStakes.get(pendingId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingBrStakes.delete(pendingId);

    for (const p of pending.participants) if (!p.isBot) p.pendingBrStakeId = null;

    const confirmed = pending.participants.filter((p) => pending.status.get(p.id) === 'confirmed');

    if (confirmed.length < 2) {
      await Promise.all(
        confirmed.map(async (p) => {
          if (!p.isBot) {
            try {
              await escrow.houseTransfer(p.wallet, pending.stakes.get(p.id));
            } catch (e) {
              console.error('[br-cash] Remboursement echoue', p.wallet, e.message);
            }
          }
        })
      );
      for (const p of pending.participants) {
        if (p.socket) p.socket.emit('cashCancelled', { reason: "Pas assez de joueurs ont confirme leur mise. Les depots ont ete rembourses." });
      }
      return;
    }

    this.createBrMatch(confirmed, pending.stakes);
  }

  // ===================== BATTLE ROYALE : MATCH =====================

  async createBrMatch(participants, stakesMap) {
    const matchId = `br_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const shuffled = shuffle(participants.slice());
    const stakes = stakesMap || new Map();
    const pot = round2([...stakes.values()].reduce((a, b) => a + b, 0));

    const match = {
      id: matchId,
      type: 'br',
      isCash: stakes.size > 0,
      stakes,
      pot,
      startedAt: Date.now(),
      endsAt: Date.now() + BR_DURATION_SEC * 1000,
      players: shuffled,
      state: new Map(),
      tickTimer: null,
      eliminationTimer: null,
      eliminationOrder: [],
      ending: false,
      logger: new MatchLogger(matchId, { mode: 'br', durationSec: BR_DURATION_SEC, isCash: stakes.size > 0, startedAt: Date.now() }),
    };

    const problems = await this.initializeTrackers(match, shuffled, { alive: true });
    if (match.isCash && problems.length) {
      // Les joueurs non conformes sont retires et rembourses ; la partie
      // continue s'il reste de quoi jouer.
      await this.ejectFromCashMatch(match, problems);
      const out = new Set(problems.map((x) => x.player.id));
      match.players = match.players.filter((p) => !out.has(p.id));
      for (const id of out) {
        match.state.delete(id);
        match.stakes.delete(id);
      }
      match.pot = round2([...match.stakes.values()].reduce((a, b) => a + b, 0));
      if (match.players.filter((p) => !p.isBot).length < 2) {
        await this.abortCashMatch(match, match.players, [], 'pas assez de joueurs avec un wallet conforme');
        return;
      }
    }

    this.brMatches.set(matchId, match);
    this.io.to(matchId).emit('brMatchStart', this.serializeBrMatch(match));
    match.tickTimer = setInterval(() => this.tickBrMatch(matchId), TICK_MS);
    match.eliminationTimer = setInterval(() => this.eliminateBrPlayer(matchId), BR_ELIMINATION_INTERVAL_MS);
  }

  async tickBrMatch(matchId) {
    const match = this.brMatches.get(matchId);
    if (!match || match.ending) return;

    await Promise.all(
      match.players.map(async (p) => {
        const st = match.state.get(p.id);
        if (!st || !st.alive) return;

        if (st.simulated) {
          const step = (Math.random() - 0.48) * 4;
          st.pnlPct = round2(st.pnlPct + step);
        } else {
          // Le tracker decide lui-meme s'il doit interroger la blockchain :
          // le tick UI (2 s) est decouple du refresh wallet (5 s).
          st.pnlPct = await st.tracker.refresh();
          st.walletError = st.tracker.error;
          st.alert = st.tracker.alert;
        }

        st.history.push(st.pnlPct);
        if (st.history.length > 60) st.history.shift();
      })
    );

    if (match.ending) return;
    const remainingMs = Math.max(0, match.endsAt - Date.now());
    this.io.to(matchId).emit('brMatchUpdate', this.serializeBrMatch(match, remainingMs));

    if (remainingMs <= 0) this.endBrMatch(matchId);
  }

  eliminateBrPlayer(matchId) {
    const match = this.brMatches.get(matchId);
    if (!match || match.ending) return;

    const alive = match.players.filter((p) => match.state.get(p.id).alive);
    if (alive.length <= 1) {
      this.endBrMatch(matchId);
      return;
    }

    let minPnl = Infinity;
    for (const p of alive) minPnl = Math.min(minPnl, match.state.get(p.id).pnlPct);
    const lowest = alive.filter((p) => match.state.get(p.id).pnlPct === minPnl);
    const eliminated = lowest[Math.floor(Math.random() * lowest.length)];

    const st = match.state.get(eliminated.id);
    st.alive = false;
    match.eliminationOrder.push(eliminated.id);

    const remainingAlive = alive.length - 1;

    this.io.to(matchId).emit('brElimination', {
      eliminatedId: eliminated.id,
      eliminatedName: st.name,
      remainingAlive,
    });
    if (eliminated.socket) {
      eliminated.socket.emit('brYouEliminated', { rank: remainingAlive + 1, totalPlayers: match.players.length });
    }

    this.io.to(matchId).emit('brMatchUpdate', this.serializeBrMatch(match));

    if (remainingAlive <= 1) this.endBrMatch(matchId);
  }

  async endBrMatch(matchId) {
    const match = this.brMatches.get(matchId);
    if (!match || match.ending) return;
    match.ending = true;
    clearInterval(match.tickTimer);
    clearInterval(match.eliminationTimer);

    // Les survivants sont clotures maintenant. Un elimine est verifie jusqu'a
    // son dernier snapshot : son score est fige depuis son elimination.
    await this.closeAndVerify(
      match,
      match.players.map((player) => ({ player, closing: match.state.get(player.id).alive }))
    );

    const settlement = settleBrMatch({
      players: match.players.map((p) => this.settlementEntry(match, p)),
      eliminationOrder: match.eliminationOrder,
      isCash: match.isCash,
      feeRate: PLATFORM_FEE_RATE,
    });
    const received = match.isCash ? await this.executeSettlement(settlement, match.players) : new Map();
    const ranking = settlement.ranking.map((entry) => match.players.find((p) => p.id === entry.id));

    for (const p of ranking) {
      const st = match.state.get(p.id);
      const result = settlement.outcome === 'refund' ? null : p.id === settlement.winnerId ? 'win' : 'loss';
      this.recordResult(match, p, st, result, received, 'br', BR_DURATION_SEC);
    }

    this.io.to(matchId).emit('brMatchEnd', {
      matchId: match.id,
      isCash: match.isCash,
      pot: match.pot,
      fee: settlement.fee,
      outcome: settlement.outcome,
      winnerPayout: received.get(settlement.winnerId) || 0,
      ranking: ranking.map((p, idx) => {
        const st = match.state.get(p.id);
        return {
          id: p.id,
          name: st.name,
          avatar: st.avatar,
          isBot: st.isBot,
          pnlPct: st.pnlPct,
          rank: idx + 1,
          staked: match.stakes.get(p.id) || 0,
          status: st.status || null,
          unranked: !!st.unranked,
        };
      }),
    });

    for (const p of match.players) {
      if (p.socket) p.socket.leave(matchId);
      p.matchId = null;
    }

    match.logger.meta = { ...match.logger.meta, pot: match.pot, fee: settlement.fee, outcome: settlement.outcome, settlement };
    this.finalizeLogs(match, match.players);
    await match.logger.write();
    this.brMatches.delete(matchId);
  }

  serializeBrMatch(match, remainingMsOverride) {
    const remainingMs = remainingMsOverride !== undefined ? remainingMsOverride : Math.max(0, match.endsAt - Date.now());
    const players = match.players.map((p) => {
      const st = match.state.get(p.id);
      return {
        id: p.id,
        name: st.name,
        avatar: st.avatar,
        isBot: st.isBot,
        simulated: st.simulated,
        unranked: !!st.unranked,
        alert: !!st.alert,
        status: st.status || null,
        pnlPct: st.pnlPct,
        history: st.history,
        walletError: st.walletError,
        alive: st.alive,
        staked: match.stakes.get(p.id) || 0,
      };
    });
    const aliveCount = players.filter((p) => p.alive).length;
    return {
      matchId: match.id,
      remainingMs,
      totalPlayers: match.players.length,
      aliveCount,
      eliminationIntervalMs: BR_ELIMINATION_INTERVAL_MS,
      isCash: match.isCash,
      pot: match.pot,
      players,
    };
  }
}

module.exports = { GameEngine, MODE_TEAM_SIZE, DURATIONS, BR_SIZE, MIN_STAKE_USD };
