// Genere un dossier imprimable sur le tracking de performance.
//   node tools/build-dossier.js
// Produit dossier-tracking-performance.html a la racine du projet.
// Ouvrir dans un navigateur puis Ctrl+P -> Enregistrer en PDF.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dossier-tracking-performance.html');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function codeBlock(relPath, { from, to, title } = {}) {
  const full = path.join(ROOT, relPath);
  if (!fs.existsSync(full)) return `<p class="warn">Fichier absent : ${esc(relPath)}</p>`;
  const all = fs.readFileSync(full, 'utf-8').split('\n');
  const start = from ? from - 1 : 0;
  const end = to ? to : all.length;
  const lines = all.slice(start, end);
  const width = String(start + lines.length).length;

  const body = lines
    .map((l, i) => {
      const n = String(start + i + 1).padStart(width, ' ');
      return `<span class="ln">${n}</span>${esc(l)}`;
    })
    .join('\n');

  const label = title || relPath;
  const range = from ? ` &nbsp;<span class="range">lignes ${from}–${end}</span>` : '';
  return `<div class="file"><div class="filename">${esc(label)}${range}</div><pre>${body}</pre></div>`;
}

const FILES = [
  ['lib/performance.js', 'Source de verite du calcul. Valorisation + performance.'],
  ['lib/wallet.js', 'Lecture des balances on-chain (SPL Token + Token-2022).'],
  ['lib/pricing.js', 'Prix USD, statuts FRESH / STALE / UNPRICED.'],
  ['lib/pricecheck.js', 'Contre-verification independante via DexScreener.'],
  ['lib/playertracker.js', 'Orchestration par joueur.'],
  ['lib/txclassify.js', 'Classification des transactions.'],
  ['lib/matchlog.js', 'Diagnostic persistant par match.'],
];

const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Arvon — Tracking de performance</title>
<style>
  @page { margin: 15mm 12mm; }
  * { box-sizing: border-box; }
  body {
    font-family: Georgia, "Times New Roman", serif;
    font-size: 10.5pt; line-height: 1.5; color: #000; background: #fff;
    max-width: 190mm; margin: 0 auto; padding: 10mm;
  }
  h1 { font-size: 20pt; margin: 0 0 2mm; letter-spacing: -0.3pt; }
  h2 { font-size: 14pt; margin: 0 0 4mm; padding-bottom: 2mm; border-bottom: 1.5pt solid #000; page-break-before: always; page-break-after: avoid; }
  h2.first { page-break-before: avoid; }
  h3 { font-size: 11.5pt; margin: 6mm 0 2mm; page-break-after: avoid; }
  p { margin: 0 0 3mm; }
  .sub { color: #444; font-size: 10pt; margin-bottom: 6mm; }
  .meta { font-size: 9pt; color: #555; border-top: 0.5pt solid #bbb; padding-top: 2mm; margin-top: 8mm; }

  table { border-collapse: collapse; width: 100%; margin: 3mm 0 5mm; font-size: 9.5pt; page-break-inside: avoid; }
  th, td { border: 0.5pt solid #999; padding: 1.6mm 2.5mm; text-align: left; vertical-align: top; }
  th { background: #eee; font-weight: bold; }
  td.num, th.num { text-align: right; font-family: "Consolas", monospace; white-space: nowrap; }

  pre, code, .mono { font-family: "Consolas", "DejaVu Sans Mono", monospace; }
  .box { border: 1pt solid #000; padding: 4mm; margin: 4mm 0; page-break-inside: avoid; }
  .box.key { border-width: 2pt; background: #f4f4f4; }
  .box h3 { margin-top: 0; }
  .calc { font-family: "Consolas", monospace; font-size: 9.5pt; white-space: pre; line-height: 1.45; margin: 2mm 0; }

  .file { margin: 0 0 6mm; page-break-inside: auto; }
  .filename {
    font-family: "Consolas", monospace; font-size: 9.5pt; font-weight: bold;
    background: #000; color: #fff; padding: 1.5mm 2.5mm; margin-bottom: 0;
  }
  .filename .range { font-weight: normal; color: #ccc; }
  pre {
    font-size: 7.6pt; line-height: 1.38; margin: 0;
    border: 0.5pt solid #999; border-top: none; padding: 2.5mm 2mm;
    white-space: pre-wrap; word-wrap: break-word; overflow-wrap: break-word;
  }
  .ln { display: inline-block; width: 7mm; color: #888; text-align: right;
        margin-right: 3mm; -webkit-user-select: none; user-select: none; }
  .desc { font-size: 9.5pt; color: #333; font-style: italic; margin: 0 0 2mm; }
  ul, ol { margin: 0 0 4mm; padding-left: 6mm; }
  li { margin-bottom: 1.5mm; }
  .q { border-left: 3pt solid #000; padding-left: 4mm; margin: 4mm 0; page-break-inside: avoid; }
  .warn { color: #a00; font-weight: bold; }
  .toc { font-size: 10pt; }
  .toc li { margin-bottom: 1mm; }
  @media print { body { padding: 0; } a { text-decoration: none; color: #000; } }
</style>
</head>
<body>

<h1>Arvon — Tracking de performance du wallet</h1>
<p class="sub">Dossier de reference pour reflexion hors ligne &middot; genere le ${new Date().toLocaleString('fr-FR')}</p>

<h2 class="first">1. Ou en est-on</h2>

<p>Le calcul de performance a ete entierement refait. Il reste <strong>une decision de
conception a prendre</strong>, et c'est l'objet principal de ce dossier.</p>

<div class="box key">
<h3>Le constat qui declenche la question</h3>
<p>Match reel. L'utilisateur estime avoir perdu <strong>62 %</strong>. La plateforme affiche
<strong>&minus;8 %</strong>. Les deux chiffres sont exacts : ils ne mesurent pas la meme chose.</p>

<table>
<tr><th>&nbsp;</th><th class="num">Avant le match</th><th class="num">Apres</th><th class="num">Delta</th></tr>
<tr><td>SOL depensable</td><td class="num">0.005866 SOL</td><td class="num">0.000768 SOL</td><td class="num">&minus;0.005098</td></tr>
<tr><td>SOL en caution (rent)</td><td class="num">0.037358 SOL</td><td class="num">0.038872 SOL</td><td class="num">+0.001514</td></tr>
<tr><td><strong>Equity totale</strong></td><td class="num"><strong>$5.084</strong></td><td class="num"><strong>$4.683</strong></td><td class="num"><strong>&minus;7.9 %</strong></td></tr>
</table>

<div class="calc">Decomposition des 0.005098 SOL sortis du solde depensable :

    0.001514 SOL  ->  caution d'un nouveau casier (recuperable)
    0.003584 SOL  ->  reellement perdu (trade + frais)

Les deux lectures :

    perte / capital depensable :  0.003584 / 0.005866  =  -61 %    &lt;- ressenti utilisateur
    perte / patrimoine total   :  0.401 $  / 5.084 $   =  -7.9 %   &lt;- affiche par Arvon</div>
</div>

<h3>Pourquoi cet ecart de facteur 6,8</h3>
<p>Sur un patrimoine de $4,68, <strong>$4,57 sont immobilises en caution</strong> dans une
vingtaine de comptes de token vides, restes de trades passes. Ce capital ne bouge jamais :
il ne peut ni gagner ni perdre. Mais il est au denominateur, donc il ecrase tous les
pourcentages.</p>

<h2>2. La decision a prendre</h2>

<p>Sur Solana, un wallet ne detient pas les tokens directement : chaque token occupe un
compte dedie, et chaque compte immobilise environ 0,0015 SOL de caution, rendue a la
fermeture du compte.</p>

<p>Cette caution pose un dilemme, parce que les deux traitements possibles ont chacun
un defaut :</p>

<table>
<tr><th style="width:26%">Traitement</th><th>Consequence</th></tr>
<tr>
  <td><strong>Caution exclue</strong><br>de l'equity</td>
  <td>Ouvrir une position deplace du SOL vers la caution &rarr; l'equity baisse &rarr;
      <strong>acheter ressemble a une perte seche.</strong> C'etait le bug d'origine.</td>
</tr>
<tr>
  <td><strong>Caution incluse</strong><br>(etat actuel)</td>
  <td>Ouvrir une position est neutre, mais le capital mort dilue le score.
      <strong>Un joueur avec 500 casiers vides aurait un score quasi fige</strong> :
      impossible a battre, incapable de gagner. C'est exploitable.</td>
</tr>
</table>

<div class="box key">
<h3>Solution proposee : les deux a la fois</h3>
<p>Sortir la caution du denominateur, mais neutraliser ses <em>variations</em> comme un
flux, exactement comme un depot ou un retrait externe.</p>
<ul>
  <li>denominateur = SOL depensable + tokens &mdash; le capital reellement expose au marche</li>
  <li>ouvrir un casier n'est plus une perte : le SOL deplace vers la caution est neutralise</li>
  <li>fermer un casier n'est plus un gain</li>
</ul>
<p>Avec ce traitement, le match cite plus haut aurait affiche <strong>&minus;61 %</strong>,
c'est-a-dire le chiffre attendu.</p>
</div>

<div class="q">
<h3>Questions a trancher hors ligne</h3>
<ol>
  <li><strong>Arvon recompense quoi ?</strong> La performance du patrimoine, ou la qualite
      du trading pendant le match ? Aujourd'hui c'est la premiere. Un joueur qui detient
      un memecoin qui pompe gagne sans avoir trade.</li>
  <li><strong>Faut-il un capital minimum pour jouer ?</strong> A $5 de portefeuille, les
      frais fixes Solana pesent ~3 % par position ouverte. Les scores sont mecaniquement
      instables, independamment de la qualite du code.</li>
  <li><strong>Que faire du capital non expose ?</strong> Un joueur 100 % en USDC a un score
      quasi fige. Faut-il l'exclure du classement, ou l'accepter comme une strategie ?</li>
  <li><strong>Que faire d'un actif non cotable ?</strong> Aujourd'hui le score est gele
      plutot que fausse. Acceptable, ou faut-il une autre regle ?</li>
</ol>
</div>

<h2>3. Ce qui a ete corrige</h2>

<p>Cause racine : l'equity mesuree ne couvrait qu'une fraction du portefeuille, ce qui
amplifiait mecaniquement chaque variation. Sur le wallet de test, l'ancien code voyait
<strong>$1,24 d'un portefeuille de $5,59</strong>.</p>

<table>
<tr><th>Defaut</th><th>Effet</th><th>Correction</th></tr>
<tr><td>Token-2022 jamais lu</td><td>Positions entieres invisibles</td><td>Les deux programmes sont interroges</td></tr>
<tr><td>Caution non comptee</td><td>$4+ hors patrimoine</td><td>Comptee (a revoir, cf. section 2)</td></tr>
<tr><td>Actif non cote exclu</td><td>Valorise a $0 en silence</td><td>Dernier prix reporte, sinon score gele</td></tr>
<tr><td>Score final = dernier tick</td><td>Jusqu'a 10 s de retard</td><td>Snapshot final force</td></tr>
<tr><td><code>uiAmount</code> flottant</td><td>Perte de precision</td><td>Entier brut + decimales</td></tr>
<tr><td>Source de prix unique</td><td>Divergence x11 observee</td><td>Contre-verification DexScreener</td></tr>
<tr><td>Depots comptes en gain</td><td>Envoyer $500 = +50 %</td><td>Flux externes neutralises (TWR)</td></tr>
</table>

<h3>Formule actuelle</h3>
<div class="calc">Sans flux externe :

    performancePct = ((equityFinale / equityInitiale) - 1) x 100

Avec flux (depot / retrait pendant le match), rendement temporel pondere :

    r_i     = (V_i - F_i) / V_(i-1) - 1        F_i = flux net de la sous-periode
    facteur = produit des (1 + r_i)
    performancePct = (facteur - 1) x 100

Sans flux, la chaine se telescope exactement en V_n / V_0 - 1 : les deux
formules sont rigoureusement identiques. Verifie par test automatique.</div>

<h3>Ce qui n'est PAS neutralise</h3>
<p>Les frais reseau, les frais de swap et le slippage restent dans la performance : ce sont
des couts de trading reels, ils doivent peser. Seuls les mouvements de capital entrants
et sortants sont neutralises.</p>

<h2>4. Bugs connus, non corriges</h2>

<ol>
  <li><strong>Transactions version 1 illisibles.</strong> La bibliotheque <code>@solana/web3.js</code>
      installee (1.95.3) ne sait pas deserialiser les transactions de version 1, que le
      reseau emet desormais. Consequence : <strong>la detection des transferts externes ne
      fonctionne pas en production</strong> &mdash; elle echoue silencieusement. Piste : rendre
      le parsing tolerant signature par signature, ou monter la version de la bibliotheque.</li>
  <li><strong>RPC public sature.</strong> <code>getParsedTransactions</code> sur un lot de
      40 signatures renvoie des erreurs 429. Piste : lots plus petits, etalement dans le
      temps, ou un fournisseur RPC dedie.</li>
  <li><strong>Prix d'un flux errone.</strong> Un transfert est valorise au prix courant, pas
      au prix du slot ou il a eu lieu.</li>
  <li><strong>Actifs non valorises.</strong> Staking, positions de liquidite, NFT et ordres
      ouverts ne comptent pas dans l'equity.</li>
  <li><strong>Logs ephemeres.</strong> Sur Render en plan gratuit, <code>logs/matches/</code>
      disparait a chaque redeploiement.</li>
</ol>

<h2>5. Architecture</h2>

<div class="calc">  blockchain Solana
        |
  wallet.js          balances : SOL natif + SPL Token + Token-2022, en entiers bruts
        |
  pricing.js         prix USD par mint, statut FRESH / STALE / UNPRICED
        |            (pricecheck.js contre-verifie chaque prix via DexScreener)
        |
  performance.js     valorisation par actif -> equity -> performance
        |            *** SEUL ENDROIT OU UN POURCENTAGE EST CALCULE ***
        |
  playertracker.js   orchestration par joueur, cadences de rafraichissement
        |            (txclassify.js detecte les flux externes a neutraliser)
        |
  game.js            etat du match, appelle tracker.refresh(), ne calcule rien
        |
  WebSocket          evenements matchUpdate / matchEnd
        |
  public/app.js      affichage seul : aucune formule cote client (verifie)
        |
  matchlog.js        logs/matches/{matchId}.json : tout le detail par actif</div>

<h3>Cadences</h3>
<table>
<tr><th>Element</th><th class="num">Intervalle</th><th>Raison</th></tr>
<tr><td>Tick interface</td><td class="num">2 s</td><td>Fluidite de l'affichage</td></tr>
<tr><td>Rafraichissement wallet</td><td class="num">5 s</td><td>Cout RPC maitrise</td></tr>
<tr><td>Rafraichissement prix</td><td class="num">3 s</td><td>La volatilite prime sur les balances</td></tr>
<tr><td>Contre-verification</td><td class="num">10 s</td><td>Controle, pas source primaire</td></tr>
<tr><td>Snapshot final</td><td class="num">force</td><td>Le score enregistre doit etre frais</td></tr>
</table>

<h2>6. Code source du pipeline</h2>
<p class="toc">Sept fichiers, ${1292} lignes. Le fichier decisif est <code>lib/performance.js</code> :
c'est le seul endroit ou un pourcentage est calcule.</p>

${FILES.map(([f, d]) => `<h3>${esc(f)}</h3><p class="desc">${esc(d)}</p>${codeBlock(f)}`).join('\n')}

<h2>7. Integration dans le moteur de jeu</h2>
<p class="desc">Extraits de lib/game.js : creation du match, tick, fin de match.
Noter qu'aucun pourcentage n'y est calcule.</p>
${codeBlock('lib/game.js', { from: 338, to: 500 })}

<p class="meta">
Genere par <code>node tools/build-dossier.js</code> depuis le depot Arvon.
Pour obtenir un PDF : ouvrir ce fichier dans un navigateur, puis Ctrl+P et
&laquo;&nbsp;Enregistrer au format PDF&nbsp;&raquo;.
</p>

</body>
</html>`;

fs.writeFileSync(OUT, html, 'utf-8');
const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log(`Dossier ecrit : ${OUT} (${kb} Ko)`);
