# MemeDrop

Application Windows qui ecoute un channel Discord et affiche en overlay transparent les images + texte poses dedans, sur l'ecran de tous les utilisateurs connectes. Demarre automatiquement avec Windows.

## Architecture

```
   Toi (Discord)                 Bot Discord                Friends (MemeDrop client)
+--------------+   message    +---------------+   relay   +-------------------------+
| Channel meme | -----------> | Ecoute MSG    | --------> | Overlay transparent     |
| (image+text) |              | Content Intent|           | always-on-top + auto-   |
+--------------+              +---------------+           | start Windows           |
                                                          +-------------------------+
```

Une seule app Electron, installee par toi + chaque ami. Tous configures avec le meme token de bot et le meme channel.

## Setup du bot Discord (une seule fois)

1. Va sur https://discord.com/developers/applications -> **New Application** -> nomme-la "MemeDrop".
2. Onglet **Bot** -> **Add Bot** -> dans "Privileged Gateway Intents" active **MESSAGE CONTENT INTENT**.
3. Onglet **Bot** -> **Reset Token** -> copie le token (garde-le secret).
4. Onglet **OAuth2 > URL Generator** :
   - Scopes : `bot`
   - Bot Permissions : `View Channels`, `Read Message History`
   - Copie l'URL en bas, ouvre-la et invite le bot dans ton serveur.
5. Dans Discord, active le **mode developpeur** (Parametres > Avances > Mode developpeur), clic droit sur ton channel meme -> **Copier l'identifiant** = `channelId`.

## Installation (developpement)

```powershell
cd c:\Users\Toyger\Desktop\MemeDrop
npm install
npm start
```

Au premier lancement la fenetre Parametres s'ouvre. Colle le token + channelId, clique **Enregistrer & connecter**. L'app se met ensuite dans le **system tray** (icone en bas a droite). Double-clic dessus = reouvrir les parametres.

Teste avec le bouton **Test overlay** ou en envoyant une image dans le channel.

## Build de l'installeur Windows (.exe)

```powershell
npm run build
```

Genere `dist/MemeDrop Setup 0.1.0.exe`. Envoie ce fichier a tes amis. Ils l'installent, lancent l'app, collent **le meme token et channelId**, et c'est bon.

## Comportement attendu

- App tourne en arriere-plan via le system tray.
- Quand quelqu'un poste dans le channel configure, **tous les amis avec MemeDrop ouvert** voient un overlay transparent apparaitre par-dessus toutes leurs apps (jeux full screen y compris).
- L'overlay disparait apres la duree configuree (defaut 8s).
- Lancement automatique au demarrage Windows (case a cocher dans les parametres).

## Limites / notes

- Si un ami ferme l'app, il rate les memes en attendant. Pas de "rattrapage" (intentionnel).
- Le token de bot est partage entre tous les clients. Ne le mets pas sur GitHub. Tout client avec le token peut lire le channel.
- Pour un usage plus serieux : faire passer par un petit serveur relais (websocket) au lieu de donner le token a chacun. Pour un usage entre potes c'est OK.
- Pour ajouter une vraie icone, mets un `assets/icon.ico` (256x256) et `assets/icon.png` (256x256) avant de build.

## Structure

- `src/main.js` - Process principal Electron (bot Discord, tray, fenetres).
- `src/overlay.html` - Overlay transparent always-on-top.
- `src/settings.html` - UI de configuration.
- `src/preload.js` - Bridge IPC securise.
- `package.json` - Config electron-builder pour NSIS Windows.
