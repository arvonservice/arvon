// Regles de reglement d'un match. Fonctions pures : elles decident qui gagne,
// qui est rembourse et qui perd sa mise, sans rien envoyer. game.js execute.
//
// Statut de chaque joueur apres verification :
//   clean        rien a signaler
//   neutralized  depot detecte en match gratuit : score recalcule sans lui
//   disqualified depot detecte en match a mise : defaite, mise perdue
//   unverified   verification impossible (RPC indisponible)
//   simulated    bot, ou joueur dont le wallet n'a pas pu etre suivi
//
// Regles des matchs a mise :
//  - verification impossible pour un joueur reel : personne ne gagne, tout le
//    monde est rembourse. On ne paie jamais a l'aveugle.
//  - un tricheur perd sa mise. Le rembourser rendrait la triche gratuite : il
//    gagnerait si elle passe, et recupererait sa mise sinon.
//  - en equipe, un tricheur fait perdre toute son equipe (sinon une equipe
//    pourrait designer un tricheur sacrifiable).
//  - tricheurs des deux cotes : aucun gagnant ; les joueurs honnetes sont
//    rembourses, les tricheurs perdent leur mise.

function round2(n) {
  return Math.round(n * 100) / 100;
}

const isReal = (p) => !p.isBot;
const isCheater = (p) => p.status === 'disqualified';

function refundAll(players) {
  return players.filter((p) => isReal(p) && p.stake > 0).map((p) => ({ id: p.id, amount: p.stake }));
}

// teams : [[{ id, isBot, stake, pnlPct, status }], [...]]
function settleTeamMatch({ teams, isCash, feeRate }) {
  const all = [...teams[0], ...teams[1]];
  const average = (team) => round2(team.reduce((s, p) => s + p.pnlPct, 0) / team.length);
  const result = {
    outcome: null,
    winner: null,
    teamPnl: [average(teams[0]), average(teams[1])],
    payouts: [],
    refunds: [],
    forfeits: [],
    fee: 0,
  };

  if (isCash && all.some((p) => isReal(p) && p.status === 'unverified')) {
    result.outcome = 'refund';
    result.winner = 'draw';
    result.refunds = refundAll(all);
    return result;
  }

  const cheated = teams.map((team) => team.some(isCheater));
  if (cheated[0] && cheated[1]) {
    result.outcome = 'void';
    result.winner = 'draw';
    for (const p of all) {
      if (!isReal(p) || !(p.stake > 0)) continue;
      if (isCheater(p)) result.forfeits.push({ id: p.id, amount: p.stake });
      else result.refunds.push({ id: p.id, amount: p.stake });
    }
    return result;
  }

  let winner;
  if (cheated[0]) winner = 'B';
  else if (cheated[1]) winner = 'A';
  else if (result.teamPnl[0] > result.teamPnl[1]) winner = 'A';
  else if (result.teamPnl[1] > result.teamPnl[0]) winner = 'B';
  else winner = 'draw';
  result.winner = winner;
  result.outcome = cheated[0] || cheated[1] ? 'forfeit' : winner === 'draw' ? 'draw' : 'win';

  if (!isCash) return result;

  if (winner === 'draw') {
    result.refunds = refundAll(all);
    return result;
  }

  const winners = teams[winner === 'A' ? 0 : 1];
  const losers = teams[winner === 'A' ? 1 : 0];
  const pot = round2(all.reduce((s, p) => s + (p.stake || 0), 0));
  const winnersStake = round2(winners.reduce((s, p) => s + (p.stake || 0), 0));
  result.fee = round2(pot * feeRate);
  const netPot = round2(pot - result.fee);
  // Chacun recupere une part proportionnelle a sa propre mise.
  for (const p of winners) {
    if (isReal(p) && p.stake > 0 && winnersStake > 0) {
      result.payouts.push({ id: p.id, amount: round2(netPot * (p.stake / winnersStake)) });
    }
  }
  for (const p of losers) {
    if (isReal(p) && p.stake > 0 && isCheater(p)) result.forfeits.push({ id: p.id, amount: p.stake });
  }
  return result;
}

// players : [{ id, isBot, stake, pnlPct, alive, status }]
// eliminationOrder : ids dans l'ordre d'elimination (premier elimine d'abord).
function settleBrMatch({ players, eliminationOrder, isCash, feeRate }) {
  const byId = new Map(players.map((p) => [p.id, p]));
  const honest = (p) => !isCheater(p);

  // Classement : survivants honnetes par score, puis elimines honnetes du
  // dernier au premier, puis tricheurs.
  const aliveHonest = players.filter((p) => p.alive && honest(p)).sort((a, b) => b.pnlPct - a.pnlPct);
  const eliminatedHonest = eliminationOrder
    .slice()
    .reverse()
    .map((id) => byId.get(id))
    .filter((p) => p && honest(p));
  const cheaters = players.filter((p) => !honest(p)).sort((a, b) => b.pnlPct - a.pnlPct);
  const ranking = [...aliveHonest, ...eliminatedHonest, ...cheaters];

  const result = { outcome: null, ranking, winnerId: null, payouts: [], refunds: [], forfeits: [], fee: 0 };

  if (isCash && players.some((p) => isReal(p) && p.status === 'unverified')) {
    result.outcome = 'refund';
    result.refunds = refundAll(players);
    return result;
  }

  const winner = ranking.find(honest) || null;
  result.winnerId = winner ? winner.id : null;
  result.outcome = winner ? 'win' : 'void';
  if (!isCash) return result;

  for (const p of cheaters) {
    if (isReal(p) && p.stake > 0) result.forfeits.push({ id: p.id, amount: p.stake });
  }
  if (!winner || !isReal(winner)) return result;

  const pot = round2(players.reduce((s, p) => s + (p.stake || 0), 0));
  result.fee = round2(pot * feeRate);
  result.payouts.push({ id: winner.id, amount: round2(pot - result.fee) });
  return result;
}

module.exports = { settleTeamMatch, settleBrMatch };
