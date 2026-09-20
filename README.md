# Arvon

PvP de trading memecoin en temps reel : 1v1, 2v2, 3v3, 4v4, 5v5, et un mode **Battle Royale** (15 joueurs). Chaque duel dure un temps limite (1, 5, 10, 15, 30 ou 60 minutes) et le gagnant est celui/celle avec le plus gros **PnL en pourcentage**. Egalite en cas de PnL identique.

Chaque mode existe en version **Gratuite** ou **Cash** (mise reelle en USDT, minimum 1$, le vainqueur remporte le pot moins 15% de commission).

## ⚠️ IMPORTANT : le mode Cash utilise de l'ARGENT REEL

Contrairement a une version precedente de ce projet, le mode Cash fonctionne desormais sur le **reseau principal Solana (mainnet)** avec du **vrai USDT**. Ce n'est plus un bac a sable :

- Chaque mise est une **transaction blockchain reelle et irreversible**. Il n'y a pas de "annuler" apres coup.
- Le serveur detient un **wallet "maison"** qui recoit les mises et paie les gagnants. Si ce wallet est compromis (cle volee, bug serveur exploitable), l'argent qu'il detient a ce moment-la peut etre perdu **definitivement**. Ne laisse jamais une grosse somme dessus : ne le finance qu'au fil de l'eau, juste assez pour les frais de transaction (voir plus bas — le SOL ne sert qu'aux frais, pas aux mises elles-memes qui transitent directement entre joueurs et wallet maison).
- La plateforme preleve **15% de commission** sur le pot a chaque match Cash gagne (rien n'est preleve en cas d'egalite : les mises sont simplement remboursees). En prenant une commission sur des mises d'argent reel, tu **operes ce qui ressemble juridiquement a un service de paris/jeu d'argent** dans beaucoup de pays, meme si le resultat depend d'une performance de trading (skill-based). Renseigne-toi sur la reglementation qui s'applique a toi avant d'ouvrir ca a d'autres personnes que des proches consentants — ce n'est pas quelque chose que ce README peut trancher a ta place.
- **Les bots peuvent aussi jouer en Cash.** Ils ne misent jamais d'argent : si un bot "gagne" contre un joueur reel, la mise de ce joueur reste acquise a la plateforme (wallet maison). Concretement, dans ces matchs-la, **c'est toi (l'operateur) qui joues contre le joueur avec ton propre argent en jeu**, pas un autre joueur qui prend une commission au passage. C'est la definition meme d'un jeu banque par la maison (comme un casino), pas d'un concours entre joueurs — c'est traite beaucoup plus severement par la reglementation presque partout. En plus, comme c'est ce code qui decide si le bot "gagne" (une simulation aleatoire, pas un vrai trade), un joueur qui perd n'a aucun moyen de verifier que ce n'est pas truque en ta faveur.
- Personne ne peut recuperer des fonds envoyes par erreur a une mauvaise adresse. Teste avec de tres petits montants (1$) avant de faire confiance au systeme avec plus.

## Comment ca marche

- Tu crees un **compte** (pseudo + mot de passe) et tu connectes un wallet Solana. Le serveur lit la valeur totale du portefeuille (SOL + tokens) sur Solana mainnet au debut du match, puis recalcule cette valeur toutes les 2 secondes pour suivre le PnL % en temps reel.
- A la creation du compte, **5 mots secrets** te sont montres une seule fois (ex : "temple cascade orage tigre diamant"). Note-les quelque part : ils permettent de reinitialiser ton mot de passe **et** ton pseudo si tu les oublies, via le lien "Mot de passe ou pseudo oublie ?" sur l'ecran de connexion. Chaque utilisation genere automatiquement 5 nouveaux mots (les anciens ne fonctionnent plus).
- Deux facons de connecter un wallet : le bouton **Connecter avec Phantom** (si l'extension est installee), ou **coller directement une adresse Solana publique** — pratique si tu n'as pas Phantom ou si tu veux juste suivre une adresse. Dans les deux cas c'est en lecture seule : aucune signature ni transaction n'est demandee. Tu peux le **deconnecter** a tout moment depuis le menu du wallet (en haut a droite).
- Sans compte + wallet connectes, tu peux naviguer sur le site (classement, recherche de joueurs, configuration des modes) mais **pas lancer de match** — le bouton reste desactive tant que les deux conditions ne sont pas remplies.
- Le matchmaking place les joueurs par format + duree choisis. S'il n'y a pas assez de joueurs humains apres quelques secondes, des **bots** (PnL simule) completent automatiquement le match pour que tu puisses tester seul.
- Pendant le match, tu vois le PnL % de tout le monde en temps reel, avec un petit graphique d'evolution par joueur. En 2v2/3v3/4v4/5v5, le PnL moyen de chaque equipe s'affiche aussi en gros sous son nom.
- Chaque match termine met a jour ton **profil** (victoires/defaites/egalites, PnL moyen, meilleur PnL) et le **classement general**.
- Depuis "Mon profil", tu peux changer ta photo, ton pseudo affiche, ta bio et ajouter tes comptes X / Instagram / TikTok (facultatif).
- Onglet **"Joueurs"** : recherche n'importe quel trader par pseudo ou par adresse wallet, consulte son profil public, et **defie-le en 1v1** directement (il recoit une notification en temps reel avec 60 secondes pour accepter ou refuser).
- **Battle Royale** (dans l'onglet "Jouer", comme un format de plus) : 15 joueurs s'affrontent pendant 30 minutes. Toutes les 2 minutes, le PnL % le plus bas est elimine. Une fois elimine, tu peux rester pour regarder la suite ou retourner au lobby. Dernier survivant = vainqueur.

### Mode Cash (mises en USDT reel)

- Choisis "Cash" dans le panneau "Format de mise" du lobby. Le mode Cash necessite une connexion **Phantom** (une adresse collee manuellement ne peut pas signer de transaction, donc pas miser) et de l'USDT reel deja present dans le wallet (achete sur un exchange comme Binance/Coinbase puis envoye sur Solana).
- **Chacun choisit son propre montant** (minimum 1$), il n'y a pas besoin de miser la meme somme que ton adversaire. Le matchmaking te met en relation avec d'autres joueurs (et eventuellement des bots) sans condition de montant ; une fois le groupe forme, chacun a 45 secondes pour proposer et confirmer sa mise (ce qui declenche une signature Phantom reelle) ou refuser.
- **1v1 a 5v5** : si tout le monde confirme, le match demarre ; sinon (quelqu'un refuse ou ne confirme pas a temps), tout le monde est rembourse et le match est annule. En cas de victoire, le pot (moins 15%) est reparti entre les gagnants **proportionnellement a ce que chacun a mise** (pas forcement a parts egales).
- **Battle Royale Cash** : meme principe, sauf qu'il suffit qu'au moins 2 personnes confirment pour lancer le match ; le vainqueur (dernier survivant) remporte le pot moins 15%.
- **Les bots peuvent completer une table Cash** (apres quelques secondes, comme en gratuit) mais ne misent jamais d'argent — voir l'avertissement en haut de ce document sur ce que ca implique.

## Lancer le site (aucune connaissance technique requise)

1. Installe [Node.js](https://nodejs.org/) (version LTS) si ce n'est pas deja fait.
2. Ouvre un terminal dans ce dossier.
3. Installe les dependances (une seule fois) :

```bash
npm install
```

4. Lance le serveur :

```bash
npm start
```

5. Ouvre ton navigateur sur [http://localhost:3000](http://localhost:3000). Idealement avec l'extension **Phantom** installee pour tester la connexion wallet.

Pour arreter le serveur, retourne dans le terminal et fais `Ctrl + C`.

## Comptes et donnees

Les comptes, profils et l'historique des matchs sont stockes dans un simple fichier `data/db.json` (cree automatiquement au premier lancement). Pas de base de donnees externe a installer. Pour repartir de zero (tout supprimer), il suffit de supprimer ce fichier serveur eteint.

## Le systeme de mises (wallet "maison", argent reel)

Au tout premier lancement, le serveur genere automatiquement un **wallet "maison"** (une paire de cles Solana) qui sert d'escrow : c'est lui qui recoit les mises et paie les gagnants (moins 15%). Son adresse est affichee dans les logs au demarrage (`[escrow] Wallet maison : ...`).

### Etape obligatoire avant d'utiliser le mode Cash : financer ce wallet en SOL

Le wallet maison a besoin d'un **petit peu de vrai SOL** (0.05 a 0.1 SOL, quelques dollars) pour payer les frais de transaction — pas pour les mises elles-memes, juste le "carburant" du reseau. Envoie ce montant depuis n'importe quel exchange ou wallet, en choisissant le reseau **Solana**, vers l'adresse affichee dans les logs du serveur. Sans ca, les depots/paiements Cash echoueront proprement (message d'erreur clair, rien n'est perdu) jusqu'a ce que le wallet soit approvisionne.

### Configurer ton wallet de commission (optionnel)

Par defaut, la commission de 15% reste simplement dans le wallet maison — tu peux la retirer plus tard avec sa cle privee (stockee dans `data/escrow-config.json`). Si tu preferes qu'elle parte automatiquement vers un wallet separe que tu controles deja, lance une fois :

```bash
node set_fee_wallet.js TON_ADRESSE_SOLANA
```

Puis redemarre le serveur.

### Securite du wallet maison

- La cle privee du wallet maison est stockee en clair dans `data/escrow-config.json`, sur cette machine uniquement. Ne la partage jamais, ne commite jamais ce fichier dans un depot public, et ne deploie pas ce projet sur un serveur auquel tu ne fais pas confiance.
- Ne garde sur ce wallet que ce dont tu as besoin a court terme (le SOL pour les frais). L'USDT des joueurs n'y transite que le temps d'un match — pense a retirer regulierement les gains de commission accumules plutot que de les laisser s'accumuler.
- Le jeton USDT utilise est l'adresse officielle du mint Tether sur Solana mainnet (`Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`). **Verifie cette adresse toi-meme** (par exemple sur [Solscan](https://solscan.io)) avant de faire confiance a ce systeme avec de l'argent reel — tu peux la redefinir via la variable d'environnement `USDT_MINT_ADDRESS` si besoin.

## Limites de cette premiere version (a ameliorer ensuite)

- Les matchs en cours (pas les comptes/profils) sont en memoire : si tu redemarres le serveur pendant un match, ce match est perdu. Les comptes et statistiques, eux, sont sauvegardes dans `data/db.json`.
- L'API RPC publique de Solana (mainnet-beta) a des limites de debit. Pour un usage avec plusieurs joueurs simultanes ou du mode Cash regulier, un fournisseur RPC dedie (Helius, QuickNode...) est fortement recommande, via `SOLANA_RPC_URL` (lecture PnL) et `ESCROW_RPC_URL` (mises).
- Les tokens de type "Token-2022" ne sont pas encore pris en compte dans le calcul du portefeuille (seulement le programme SPL Token classique + SOL).
- Les sessions de connexion sont stockees en memoire serveur : elles sont perdues si tu redemarres le serveur (il faudra se reconnecter).
- Les defis 1v1 ne fonctionnent que si le joueur cible est actuellement connecte au site (sinon le defi ne peut pas lui parvenir). Ils expirent automatiquement au bout de 60 secondes sans reponse.
- Le classement des matchs Battle Royale attribue une victoire au vainqueur et une defaite a tous les autres (pas de systeme de points par palier de classement pour l'instant).

## Variables d'environnement optionnelles

- `PORT` : port du serveur (par defaut 3000).
- `SOLANA_RPC_URL` : endpoint RPC Solana a utiliser pour lire les portefeuilles (PnL), par defaut l'endpoint public mainnet.
- `ESCROW_RPC_URL` : endpoint RPC Solana a utiliser pour le systeme de mises (par defaut le meme mainnet public, ou `SOLANA_RPC_URL` si defini).
- `USDT_MINT_ADDRESS` : adresse du jeton utilise pour les mises, si tu veux utiliser autre chose que l'USDT officiel (ex. USDC).
- `PLATFORM_FEE_RATE` : commission prelevee sur chaque pot Cash gagne (par defaut `0.15` = 15%).
- `BR_SIZE` : nombre de joueurs par match Battle Royale (par defaut 15).
- `BR_DURATION_SEC` : duree maximum d'un Battle Royale en secondes (par defaut 1800 = 30 min).
- `BR_ELIMINATION_INTERVAL_MS` : intervalle entre deux eliminations en millisecondes (par defaut 120000 = 2 min).
