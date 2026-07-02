# MemeDrop Server

Backend Node.js : bot Discord + WebSocket broadcast aux clients MemeDrop.

## Fonctionnement

```
        Toi (Discord)
            |
            v
   [Channel Discord]
            |
       bot ecoute
            v
+-------------------------+                          +-------------------------+
| memedrop-server (Docker)| <----------------------- |   Amis (MemeDrop client)|
| - discord.js (gateway)  |                            |   overlay s'affiche     |
| - ws server :8787       |                            +-------------------------+
| - admin HTTP API        |
+-------------------------+
```

Le serveur tourne en conteneur Docker sur une machine que tu controles (VPS, mini-PC, serveur perso...) et reste connecte 24/7 a Discord. Comment rendre ce serveur joignable par tes amis (port forwarding, reverse proxy, tunnel...) depend de ton infra — pas couvert ici, cette section se concentre sur le service lui-meme.

Quand tu postes dans le channel configure, le serveur pousse le meme a tous les clients MemeDrop connectes au bon salon, meme si tu es hors ligne.

## Endpoints

- `GET  /health` -> `{ ok: true }`
- `WS   /feed` -> broadcast des memes aux clients (parametre `?code=<salon>`)
- `GET  /admin/status` (header `X-Admin-Password`) -> statut bot + nb clients + salons
- `POST /admin/token` (header `X-Admin-Password`, body `{ botToken }`) -> set le token et (re)connecte le bot
- `POST /admin/rooms` (header `X-Admin-Password`, body `{ code, channelId, name? }`) -> cree/met a jour un salon
- `DELETE /admin/rooms/:code` (header `X-Admin-Password`) -> supprime un salon
- `POST /admin/test` (header `X-Admin-Password`) -> broadcast un test "Test depuis le panneau admin !"

## Variables d'environnement

Definies dans `server/.env` (a creer, jamais commit — voir `.env.example`) :

| Variable         | Defaut                  | Description                                              |
|------------------|--------------------------|------------------------------------------------------------|
| `PORT`           | `8787`                   | Port HTTP/WS ecoute par le serveur                        |
| `ADMIN_PASSWORD` | `123456` (⚠️ a changer)   | Mot de passe qui protege toutes les routes `/admin/*`      |
| `CONFIG_PATH`    | `/data/config.json`      | Chemin du fichier persistant (token bot, salons). Deja mappe sur le volume Docker, pas besoin d'y toucher. |

```bash
cp .env.example .env
nano .env   # mets un vrai mot de passe, ex: openssl rand -hex 16
```

## Deploiement avec Docker

Prerequis : Docker + Docker Compose installes sur la machine hote.

```bash
cd server
cp .env.example .env
nano .env                       # ADMIN_PASSWORD obligatoire
docker compose up -d --build
```

Verifie que ca tourne :

```bash
docker compose ps               # doit afficher "Up (healthy)"
curl http://localhost:8787/health   # doit repondre {"ok":true}
```

Le conteneur :
- redemarre automatiquement (`restart: unless-stopped`) apres un reboot de la machine ou un crash
- persiste sa config (token, salons) dans un volume Docker nomme (`memedrop-data`), independant du cycle de vie du conteneur
- tourne avec des limites de ressources (`mem_limit: 256m`, `cpus: 0.5`) pour ne pas impacter d'autres services sur la meme machine
- expose un healthcheck sur `/health`, verifiable via `docker compose ps`

### Logs

```bash
docker compose logs -f
```

### Mettre a jour apres un changement de code

```bash
docker compose up -d --build
```

## Test local rapide (sans Docker)

```bash
cd server
npm install
node server.js
```

Cote client, URL serveur = `ws://localhost:8787`.

## Securite

- Ne commit jamais `.env` ni `server/config.json` (contient le token bot en clair) — deja couverts par `.gitignore`.
- Change imperativement `ADMIN_PASSWORD` (defaut `123456`).
- Le token de bot Discord ne quitte jamais ce serveur : seul le panneau Admin du client le pousse via `POST /admin/token`, jamais expose aux clients User.
- Si tu changes `ADMIN_PASSWORD` dans `.env` apres coup, il faut aussi le remettre a jour dans le panneau Admin du client, sinon les requetes `/admin/*` echouent en `401`.