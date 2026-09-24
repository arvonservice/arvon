const { PlayerTracker } = require('./playertracker');
const { MatchLogger } = require('./matchlog');
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

  // ===================== FILES D'ATTENTE (MODES EQUIPE) =====================

  joinQueue(socketId, mode, durationKey, cash = false) {
    if (!MODE_TEAM_SIZE[mode] || !DURATIONS[durationKey]) return;
    const player = this.players.get(socketId);
    if (!player || player.matchId || player.queueKey) return;

    const err = this.checkEligible(player);
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
      logger: new MatchLogger(matchId, { mode, durationSec, isCash: !!stakesMap, startedAt: Date.now() }),
    };

    await Promise.all(
      [...teamA, ...teamB].map(async (p) => {
        p.matchId = matchId;
        if (p.socket) p.socket.join(matchId);

        let tracker = null;
        let walletError = null;

        if (!p.isBot && p.wallet) {
          const candidate = new PlayerTracker({ playerId: p.id, name: p.name, wallet: p.wallet, logger: match.logger });
          try {
            await candidate.initialize();
            tracker = candidate;
          } catch (e) {
            walletError = 'Wallet illisible, PnL simule pour ce match';
            match.logger.addError(p.id, 'match.init', e);
          }
        }
        if (!tracker) {
          match.logger.registerPlayer(p.id, { name: p.name, wallet: p.wallet, simulated: true });
        }

        match.state.set(p.id, {
          name: p.name,
          avatar: p.avatar || null,
          userId: p.userId || null,
          isBot: p.isBot,
          wallet: p.wallet,
          tracker,
          simulated: !tracker,
          pnlPct: 0,
          history: [0],
          walletError,
        });
      })
    );

    this.matches.set(matchId, match);
    this.io.to(matchId).emit('matchStart', this.serializeMatch(match));
    match.tickTimer = setInterval(() => this.tickMatch(matchId), TICK_MS);
  }

  async tickMatch(matchId) {
    const match = this.matches.get(matchId);
    if (!match) return;

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
        }

        st.history.push(st.pnlPct);
        if (st.history.length > 60) st.history.shift();
      })
    );

    const remainingMs = Math.max(0, match.endsAt - Date.now());
    this.io.to(matchId).emit('matchUpdate', this.serializeMatch(match, remainingMs));

    if (remainingMs <= 0) this.endMatch(matchId);
  }

  async endMatch(matchId) {
    const match = this.matches.get(matchId);
    if (!match) return;
    clearInterval(match.tickTimer);

    // Snapshot final force : le score enregistre ne doit jamais provenir d'un
    // tick vieux de plusieurs secondes.
    await Promise.all(
      [...match.teams[0], ...match.teams[1]].map(async (p) => {
        const st = match.state.get(p.id);
        if (!st || !st.tracker) return;
        try {
          const { pnlPct, explain } = await st.tracker.finalize();
          st.pnlPct = pnlPct;
          console.log(
            `[final] ${st.name}: initial=$${explain.initialEquity.toFixed(2)} final=$${explain.finalEquity.toFixed(2)} ` +
            `flux=$${explain.totalExternalFlowUsd.toFixed(2)} pnl=${pnlPct}% (${explain.method})`
          );
        } catch (e) {
          match.logger.addError(p.id, 'match.finalize', e);
        }
      })
    );

    const teamAvg = (team) => {
      const vals = team.map((p) => match.state.get(p.id).pnlPct);
      return round2(vals.reduce((a, b) => a + b, 0) / vals.length);
    };
    const pnlA = teamAvg(match.teams[0]);
    const pnlB = teamAvg(match.teams[1]);
    let winner = 'draw';
    if (pnlA > pnlB) winner = 'A';
    else if (pnlB > pnlA) winner = 'B';

    const payouts = new Map(); // playerId -> montant recu
    let fee = 0;

    if (match.isCash) {
      if (winner === 'draw') {
        await Promise.all(
          [...match.teams[0], ...match.teams[1]].map(async (p) => {
            const staked = match.stakes.get(p.id) || 0;
            if (!p.isBot && staked > 0) {
              try {
                await escrow.houseTransfer(p.wallet, staked);
                payouts.set(p.id, staked);
              } catch (e) {
                console.error('[cash] Remboursement egalite echoue', p.wallet, e.message);
              }
            }
          })
        );
      } else {
        const winningTeam = winner === 'A' ? match.teams[0] : match.teams[1];
        const winningTeamStake = round2(winningTeam.reduce((sum, p) => sum + (match.stakes.get(p.id) || 0), 0));
        fee = round2(match.pot * PLATFORM_FEE_RATE);
        const netPot = round2(match.pot - fee);
        // Chacun recupere une part du gain proportionnelle a sa propre mise (les mises peuvent differer).
        await Promise.all(
          winningTeam.map(async (p) => {
            const staked = match.stakes.get(p.id) || 0;
            if (!p.isBot && staked > 0 && winningTeamStake > 0) {
              const share = round2(netPot * (staked / winningTeamStake));
              try {
                await escrow.houseTransfer(p.wallet, share);
                payouts.set(p.id, share);
              } catch (e) {
                console.error('[cash] Paiement gain echoue', p.wallet, e.message);
              }
            }
          })
        );
        try {
          await escrow.payFee(fee);
        } catch (e) {
          console.error('[cash] Transfert de la commission echoue', e.message);
        }
      }
    }

    const payload = {
      ...this.serializeMatch(match, 0),
      winner,
      teamPnl: [pnlA, pnlB],
      pot: match.pot,
      fee,
      payouts: Object.fromEntries(payouts),
    };
    this.io.to(matchId).emit('matchEnd', payload);

    const resultFor = (teamIdx) => (winner === 'draw' ? 'draw' : winner === (teamIdx === 0 ? 'A' : 'B') ? 'win' : 'loss');
    match.teams.forEach((team, teamIdx) => {
      for (const p of team) {
        const st = match.state.get(p.id);
        if (st.userId) {
          const staked = match.stakes.get(p.id) || 0;
          db.recordMatchResult(st.userId, {
            mode: match.mode,
            durationSec: match.durationSec,
            pnlPct: st.pnlPct,
            result: resultFor(teamIdx),
            staked,
            netCash: (payouts.get(p.id) || 0) - staked,
          });
        }
      }
    });

    for (const p of [...match.teams[0], ...match.teams[1]]) {
      if (p.socket) p.socket.leave(matchId);
      p.matchId = null;
    }

    match.logger.meta = { ...match.logger.meta, winner, teamPnl: [pnlA, pnlB], pot: match.pot, fee };
    await match.logger.write();
    this.matches.delete(matchId);
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

  sendChallenge(fromSocketId, targetUserId, durationKey, cash) {
    const from = this.players.get(fromSocketId);
    if (!from || !from.userId) return { error: 'Connecte-toi a ton compte pour defier un joueur.' };
    if (!from.wallet) return { error: 'Connecte ton wallet pour defier un joueur.' };
    if (from.matchId || from.queueKey) return { error: 'Tu es deja en file d\'attente ou en match.' };
    if (!DURATIONS[durationKey]) return { error: 'Duree invalide.' };
    if (from.userId === targetUserId) return { error: 'Tu ne peux pas te defier toi-meme.' };

    const target = this.findPlayerByUserId(targetUserId);
    if (!target) return { error: 'Ce joueur n\'est pas en ligne actuellement.' };
    if (target.matchId || target.queueKey) return { error: 'Ce joueur est deja occupe.' };

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

  respondChallenge(socketId, challengeId, accept) {
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

    if (ch.cash) {
      this.startCashStakePhase('1v1', ch.durationKey, [from, to]);
    } else {
      this.createMatch('1v1', ch.durationKey, [from, to], null);
    }
    return { ok: true };
  }

  // ===================== BATTLE ROYALE : FILE D'ATTENTE =====================

  joinBrQueue(socketId, cash) {
    const player = this.players.get(socketId);
    if (!player || player.matchId || player.queueKey) return;
    const err = this.checkEligible(player);
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
      logger: new MatchLogger(matchId, { mode: 'br', durationSec: BR_DURATION_SEC, isCash: stakes.size > 0, startedAt: Date.now() }),
    };

    await Promise.all(
      shuffled.map(async (p) => {
        p.matchId = matchId;
        if (p.socket) p.socket.join(matchId);

        let tracker = null;
        let walletError = null;

        if (!p.isBot && p.wallet) {
          const candidate = new PlayerTracker({ playerId: p.id, name: p.name, wallet: p.wallet, logger: match.logger });
          try {
            await candidate.initialize();
            tracker = candidate;
          } catch (e) {
            walletError = 'Wallet illisible, PnL simule pour ce match';
            match.logger.addError(p.id, 'match.init', e);
          }
        }
        if (!tracker) {
          match.logger.registerPlayer(p.id, { name: p.name, wallet: p.wallet, simulated: true });
        }

        match.state.set(p.id, {
          name: p.name,
          avatar: p.avatar || null,
          userId: p.userId || null,
          isBot: p.isBot,
          wallet: p.wallet,
          tracker,
          simulated: !tracker,
          pnlPct: 0,
          history: [0],
          walletError,
          alive: true,
        });
      })
    );

    this.brMatches.set(matchId, match);
    this.io.to(matchId).emit('brMatchStart', this.serializeBrMatch(match));
    match.tickTimer = setInterval(() => this.tickBrMatch(matchId), TICK_MS);
    match.eliminationTimer = setInterval(() => this.eliminateBrPlayer(matchId), BR_ELIMINATION_INTERVAL_MS);
  }

  async tickBrMatch(matchId) {
    const match = this.brMatches.get(matchId);
    if (!match) return;

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
        }

        st.history.push(st.pnlPct);
        if (st.history.length > 60) st.history.shift();
      })
    );

    const remainingMs = Math.max(0, match.endsAt - Date.now());
    this.io.to(matchId).emit('brMatchUpdate', this.serializeBrMatch(match, remainingMs));

    if (remainingMs <= 0) this.endBrMatch(matchId);
  }

  eliminateBrPlayer(matchId) {
    const match = this.brMatches.get(matchId);
    if (!match) return;

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
    if (!match) return;
    clearInterval(match.tickTimer);
    clearInterval(match.eliminationTimer);

    await Promise.all(
      match.players.map(async (p) => {
        const st = match.state.get(p.id);
        if (!st || !st.tracker) return;
        try {
          const { pnlPct } = await st.tracker.finalize();
          st.pnlPct = pnlPct;
        } catch (e) {
          match.logger.addError(p.id, 'match.finalize', e);
        }
      })
    );

    const aliveNow = match.players.filter((p) => match.state.get(p.id).alive);
    aliveNow.sort((a, b) => match.state.get(b.id).pnlPct - match.state.get(a.id).pnlPct);
    const eliminatedRanked = match.eliminationOrder
      .slice()
      .reverse()
      .map((id) => match.players.find((p) => p.id === id));
    const ranking = [...aliveNow, ...eliminatedRanked];

    let winnerPayout = 0;
    let fee = 0;
    if (match.isCash && ranking.length > 0) {
      const winner = ranking[0];
      fee = round2(match.pot * PLATFORM_FEE_RATE);
      const netPot = round2(match.pot - fee);
      if (!winner.isBot) {
        try {
          await escrow.houseTransfer(winner.wallet, netPot);
          winnerPayout = netPot;
          await escrow.payFee(fee);
        } catch (e) {
          console.error('[br-cash] Paiement du pot echoue', winner.wallet, e.message);
        }
      }
    }

    ranking.forEach((p, idx) => {
      const st = match.state.get(p.id);
      if (st.userId) {
        const staked = match.stakes.get(p.id) || 0;
        db.recordMatchResult(st.userId, {
          mode: 'br',
          durationSec: BR_DURATION_SEC,
          pnlPct: st.pnlPct,
          result: idx === 0 ? 'win' : 'loss',
          staked,
          netCash: (idx === 0 ? winnerPayout : 0) - staked,
        });
      }
    });

    const payload = {
      matchId: match.id,
      isCash: match.isCash,
      pot: match.pot,
      fee,
      winnerPayout,
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
        };
      }),
    };
    this.io.to(matchId).emit('brMatchEnd', payload);

    for (const p of match.players) {
      if (p.socket) p.socket.leave(matchId);
      p.matchId = null;
    }

    match.logger.meta = { ...match.logger.meta, pot: match.pot, fee, winnerPayout };
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
