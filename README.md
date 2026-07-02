# MemeDrop

Application Windows qui ecoute un channel Discord et affiche en overlay transparent les images + texte poses dedans, sur l'ecran de tous les utilisateurs connectes. Demarre automatiquement avec Windows.

> Ce depot contient le client Electron. Le backend (bot Discord + relais WebSocket) vit dans [`server/`](./server) et a son propre README pour le deploiement (Docker, Cloudflare Tunnel, etc).

## Architecture

```
   Toi (Discord)                 Bot Discord                Friends (MemeDrop client)
+--------------+   message    +---------------+   relay   +-------------------------+
| Channel meme | -----------> | Ecoute MSG    | --------> | Overlay transparent     |
| (image+text) |              | Content Intent|           | always-on-top + auto-   |
+--------------+              +---------------+           | start Windows           |
                                                          +-------------------------+
```

Le client Electron (ce depot) se connecte a **un** serveur MemeDrop (voir `server/`) via WebSocket. Un meme poste dans le channel Discord configure est relaye a tous les clients connectes au salon correspondant.

Deux modes au lancement de l'app :

- **Admin** : configure le bot Discord, cree/gere les salons, pousse le token au serveur.
- **User** : rejoint un ou plusieurs salons avec un simple code (ou un code d'invitation, voir plus bas) pour recevoir les memes en overlay.

## Setup du bot Discord (une seule fois, cote Admin)

1. Va sur https://discord.com/developers/applications -> **New Application** -> nomme-la "MemeDrop".
2. Onglet **Bot** -> **Add Bot** -> dans "Privileged Gateway Intents" active **MESSAGE CONTENT INTENT**.
3. Onglet **Bot** -> **Reset Token** -> copie le token (garde-le secret, ne le partage jamais).
4. Onglet **OAuth2 > URL Generator** :
   - Scopes : `bot`
   - Bot Permissions : `View Channels`, `Read Message History`
   - Copie l'URL en bas, ouvre-la et invite le bot dans ton serveur Discord.
5. Dans Discord, active le **mode developpeur** (Parametres > Avances > Mode developpeur), clic droit sur ton channel meme -> **Copier l'identifiant** = `channelId`.

## Installation (developpement)

```powershell
git clone <ce-repo>
cd MemeDrop
npm install
npm start
```

Au premier lancement, l'ecran d'accueil propose **User** ou **Admin**.

### Premier lancement en mode Admin

1. Choisis **Admin**, entre le mot de passe admin de l'app (defini en dur dans `src/main.js`, voir section Configuration).
2. Dans le panneau, renseigne l'**URL de ton serveur MemeDrop** (voir `server/README.md` pour le deployer) et le **mot de passe API serveur** (celui defini cote serveur, variable `ADMIN_PASSWORD`).
3. Colle le token du bot Discord -> **Envoyer au serveur**.
4. Cree un salon : un **code** (ex `lycee2025`), le **channel ID** Discord, un nom optionnel.
5. Clique **Copier l'invitation** a cote du salon pour recuperer une chaine du type `lycee2025@wss://ton-serveur` a partager a tes amis.

### Rejoindre en mode User

Sur l'ecran d'accueil (ou dans l'ecran User via "Ajouter un salon"), colle ce que l'admin t'a donne :

- **Code simple** (`lycee2025`) : fonctionne si le serveur a deja ete configure une fois sur cette machine (l'URL serveur est memorisee localement).
- **Code d'invitation complet** (`lycee2025@wss://ton-serveur`) : configure automatiquement le bon serveur en plus de rejoindre le salon — a utiliser pour le tout premier salon ajoute sur une machine.

Une fois qu'une machine a rejoint un salon avec une URL serveur, tous les codes simples suivants reutilisent cette meme URL automatiquement.

## Build de l'installeur Windows (.exe)

```powershell
npm run build
```

Genere `dist/MemeDrop Setup <version>.exe`. Envoie ce fichier a tes amis avec le code d'invitation genere depuis le panneau Admin — ils installent, lancent, choisissent **User**, collent le code, et c'est bon.

## Comportement attendu

- App tourne en arriere-plan via le system tray.
- Quand quelqu'un poste dans le channel configure, **tous les amis avec MemeDrop ouvert et connectes au bon salon** voient un overlay transparent apparaitre par-dessus toutes leurs apps (jeux full screen y compris).
- L'overlay disparait apres la duree configuree (defaut 8s).
- Lancement automatique au demarrage Windows (case a cocher dans les parametres).
- Bibliotheque (`library.html`) : historique des memes recus, favoris, et renvoi vers un autre salon.

## Configuration

- **Mot de passe admin de l'app** : constante `APP_ADMIN_PASSWORD` dans `src/main.js`. C'est le mot de passe qui protege l'acces au panneau Admin depuis l'ecran d'accueil — a ne pas confondre avec le mot de passe API serveur (`ADMIN_PASSWORD` cote `server/`, qui protege les routes HTTP `/admin/*`).
- **URL du serveur** : plus aucune valeur en dur dans le code. Elle est configuree soit manuellement dans le panneau Admin, soit automatiquement au premier salon rejoint via un code d'invitation complet (`moncode@wss://ton-serveur`) — voir section precedente. Tant qu'aucun serveur n'est configure, l'ecran User affiche un badge "Pas de serveur configure" au lieu d'echouer silencieusement.

## Limites / notes

- Si un ami ferme l'app, il rate les memes en attendant. Pas de "rattrapage" (intentionnel).
- Le token de bot Discord ne quitte jamais le serveur — seul l'Admin le pousse une fois via une route protegee par mot de passe. Les clients User n'y ont jamais acces.
- Pour ajouter une vraie icone, mets un `assets/icon.ico` (256x256) et `assets/icon.png` (256x256) avant de build.

## Structure

```
src/
  main.js          - Process principal Electron (IPC, connexions WebSocket, tray, fenetres)
  preload.js       - Bridge IPC securise (contextBridge)
  welcome.html     - Choix du mode (User / Admin) au premier lancement
  admin.html       - Panneau de configuration (bot, salons, serveur)
  user.html        - Ecran User (salons rejoints, volume, invitations)
  overlay.html     - Overlay transparent always-on-top qui affiche les memes
  library.html     - Historique / bibliotheque des memes recus
  tray-popup.html  - Mini-popup depuis l'icone system tray
server/
  server.js        - Bot Discord + relais WebSocket + API admin HTTP
  Dockerfile        - Image de production (voir server/README.md)
  docker-compose.yml
package.json        - Config electron-builder pour NSIS Windows
```

Voir [`server/README.md`](./server/README.md) pour le deploiement du backend (Docker, variables d'environnement, exposition via tunnel ou VPS).