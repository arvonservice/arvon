# 🚀 Guide de Déploiement - Arvon

## 📋 Prérequis

- Node.js 18+
- Compte Vercel (https://vercel.com)
- Git
- Wallet Solana avec SOL pour les frais

---

## 🔧 Configuration Locale (Avant de Déployer)

### 1. Cloner et Installer

```bash
git clone <ton-repo>
cd Arvon
npm install
```

### 2. Configurer les Variables d'Environnement

Copie `.env.example` en `.env` et remplis les valeurs:

```bash
cp .env.example .env
```

Édite `.env` avec tes vraies valeurs:

```env
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
HOUSE_WALLET_PRIVATE_KEY=your_actual_private_key
USDT_MINT_ADDRESS=Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB
FEE_WALLET_ADDRESS=your_fee_wallet
PLATFORM_FEE_RATE=0.15
PORT=3000
SESSION_SECRET=your_random_secret_here
```

### 3. Tester Localement

```bash
npm start
# Visite http://localhost:3000
```

---

## 🌐 Déployer sur Vercel

### Étape 1: Créer un Repo GitHub

```bash
git init
git add .
git commit -m "Initial commit - Arvon ready for deployment"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/arvon.git
git push -u origin main
```

### Étape 2: Configurer Vercel

1. Va sur https://vercel.com/new
2. Importe ton repo GitHub
3. Choisis "Other" comme framework
4. Configure les variables d'environnement:
   - Clique sur "Environment Variables"
   - Ajoute toutes les variables de `.env`
5. Clique "Deploy"

### Étape 3: Configurer le Domaine Chelou

Vercel te donne un domaine par défaut du style `arvon-abc123.vercel.app`.

Pour un domaine personnalisé chelou (pour tester):
1. Dans Vercel: Settings → Domains
2. Ajoute un domaine personnalisé (ex: `arvon-test-xyz.vercel.app`)
3. Configure le DNS selon les instructions Vercel

---

## ⚙️ Configuration du Serverless (Vercel)

Créer un fichier `vercel.json` à la racine du projet:

```json
{
  "version": 2,
  "builds": [
    {
      "src": "server.js",
      "use": "@vercel/node"
    },
    {
      "src": "public/**/*",
      "use": "@vercel/static"
    }
  ],
  "routes": [
    {
      "src": "^/public/.*",
      "dest": "public/$1"
    },
    {
      "src": "/(.*)",
      "dest": "server.js"
    }
  ]
}
```

Mais attendez... Vercel + Socket.io = problème. Socket.io nécessite des connections persistantes, Vercel les tue après 25 secondes.

**Solution:** Utiliser Railway ou Render à la place.

---

## 🚄 MEILLEURE OPTION: Railway

Railway supporte les WebSockets et les connections persistantes.

### Étape 1: Créer un compte Railway
https://railway.app

### Étape 2: Connecter GitHub
1. Clique "New Project"
2. Choisis "Deploy from GitHub repo"
3. Sélectionne ton repo arvon

### Étape 3: Configurer les Variables
1. Dans Railway: Settings
2. Ajoute tes variables d'environnement
3. Railway les détecte et configure automatiquement

### Étape 4: Déployer
Railway redéploie automatiquement à chaque `git push`.

Le domaine sera du style: `arvon-production-abc123.railway.app`

---

## 🎯 ENCORE MIEUX: Render

Render est gratuit et stable pour les WebSockets.

### Étape 1: https://render.com

### Étape 2: New → Web Service
1. Connecte ton repo GitHub
2. Configure:
   - **Name:** arvon-app
   - **Environment:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Plan:** Free (ou Starter)

### Étape 3: Ajoute les Variables
Settings → Environment → ajoute tes `.env` variables

### Étape 4: Deploy
Render génère un domaine auto, style: `arvon-app-xyz.onrender.com`

---

## ✅ Checklist Avant Production

- [ ] Tester localement (`npm start`)
- [ ] Verifier que le wallet maison a du SOL (pour les frais)
- [ ] Tester connexion wallet en ligne (Phantom, Magic Eden)
- [ ] Faire un match test avec de vrais trades
- [ ] Vérifier les logs du serveur pour erreurs
- [ ] Tester la déconnexion/reconnexion
- [ ] Vérifier les prix de CoinGecko (API calls)

---

## 🐛 Troubleshooting

### "Wallet n'arrive pas à se connecter"
- Le site doit être sur un domaine public (pas localhost)
- Les wallets refusent les connections localhost pour sécurité

### "RPC Rate Limited"
- Solana mainnet a des limites de débit
- Solution: Déployer et attendre que le caching s'active (refetch toutes les 10s au lieu de 2s)

### "Socket.io ne marche pas"
- Vérifier que le hosting supporte WebSockets
- Vercel = NON. Railway/Render = OUI.

### "Ledger sur Discord: lien broken"
- Vérifier le lien dans le code (`https://discord.gg/B2euCT5Xga`)
- Peut être expiré ou supprimé

---

## 📝 Variables d'Environnement Détail

| Variable | Description | Exemple |
|----------|-------------|---------|
| `SOLANA_RPC_URL` | Node Solana pour fetcher données | `https://api.mainnet-beta.solana.com` |
| `HOUSE_WALLET_PRIVATE_KEY` | Clé du wallet qui paie les transactions | `base64-encoded-private-key` |
| `USDT_MINT_ADDRESS` | Address du token USDT sur Solana | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` |
| `FEE_WALLET_ADDRESS` | Wallet qui reçoit les frais | `66pTBSkYkAnPVJAq1XvSqmEr3ZXeYKD8bGw7xybDRMDC` |
| `PLATFORM_FEE_RATE` | % de commission (0.15 = 15%) | `0.15` |
| `PORT` | Port du serveur | `3000` |
| `SESSION_SECRET` | Secret pour les sessions Express | `random-string-here` |

---

## 🎉 Une fois Déployé

Ton URL sera style:
```
https://arvon-app-xyz.onrender.com
ou
https://arvon-production.railway.app
```

Cette URL peut avoir un nom chelou (comme tu l'as demandé), donc les autres ne la trouveront pas facilement.

Partage le lien direct avec tes testeurs!

---

## 📞 Support

Si ça marche pas, vérifier:
1. Les logs du serveur (Railway/Render affichent tout)
2. La console du navigateur (F12)
3. Les variables d'environnement sont bien set
4. Le wallet a du SOL pour les frais
