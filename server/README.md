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
+-------------------------+
| memedrop-server         |
| - discord.js (gateway)  |
| - ws server :8787       |
| - admin HTTP API        |
+-------------------------+
            |
   broadcast WebSocket
            v
   [Clients MemeDrop]
   (overlay s'affiche)
```

Le serveur reste connecte 24/7 a Discord. Quand tu postes dans le channel, il pousse a tous les clients MemeDrop ouverts. Si t'es pas la, ton serveur tourne quand meme.

## Endpoints

- `GET  /health` -> `{ ok: true }`
- `WS   /feed` -> broadcast des memes aux clients
- `GET  /admin/status` (header `X-Admin-Password`) -> statut bot + nb clients
- `POST /admin/config` (header `X-Admin-Password`, body `{ botToken, channelId }`) -> set config + restart bot
- `POST /admin/test` (header `X-Admin-Password`) -> broadcast un test "Test depuis le panneau admin !"

## Variables d'environnement

- `PORT` : port HTTP/WS (defaut 8787)
- `ADMIN_PASSWORD` : mot de passe admin (defaut "123456" - **a changer en prod**)
- `CONFIG_PATH` : chemin du fichier config persistant (defaut `./config.json`)

## Deploiement sur Oracle Cloud Free Tier

Oracle donne une VM ARM gratuite a vie (24 GB RAM, 4 vCPU). Etapes :

### 1. Creer le compte et la VM

1. Va sur https://www.oracle.com/cloud/free/
2. Cree un compte (carte bancaire demandee pour validation, jamais facturee sur Free Tier)
3. Console Oracle Cloud -> **Compute** -> **Instances** -> **Create instance**
4. Image : **Canonical Ubuntu 22.04** (ARM minimal)
5. Shape : **VM.Standard.A1.Flex** (4 OCPU, 24 GB RAM) - tout en gratuit
6. Reseau : laisse les defauts (cree un VCN si demande)
7. **Add SSH key** : genere une cle locale avec `ssh-keygen -t ed25519 -f memedrop_key`, upload `memedrop_key.pub`
8. Note l'**IP publique** affichee apres creation

### 2. Ouvrir le port 8787

Dans Oracle Cloud :
1. **Networking** -> **Virtual Cloud Networks** -> ton VCN -> **Security Lists** -> Default
2. **Add Ingress Rules** :
   - Source CIDR : `0.0.0.0/0`
   - IP Protocol : TCP
   - Destination Port Range : `8787`
3. Save

Sur la VM Ubuntu, autoriser le port dans iptables aussi :

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 8787 -j ACCEPT
sudo netfilter-persistent save
```

### 3. Installer Node.js + cloner le repo

SSH dans la VM : `ssh -i memedrop_key ubuntu@<IP_PUBLIQUE>`

```bash
sudo apt update
sudo apt install -y nodejs npm git
# Optionnel : Node 20 LTS au lieu de la version d'Ubuntu
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

git clone <ton-repo>  # ou scp -r le dossier server/
cd MemeDrop/server
npm install --omit=dev
```

### 4. Lancer comme service systemd

Cree `/etc/systemd/system/memedrop.service` :

```ini
[Unit]
Description=MemeDrop Server
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/MemeDrop/server
Environment=PORT=8787
Environment=ADMIN_PASSWORD=ChangeMoiSTP
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Active et lance :

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now memedrop
sudo systemctl status memedrop   # doit afficher "active (running)"
```

Voir les logs en temps reel :

```bash
journalctl -u memedrop -f
```

### 5. Tester depuis ton PC

Depuis ton PC Windows :

```powershell
curl http://<IP_PUBLIQUE>:8787/health
```

Doit renvoyer `{"ok":true}`.

### 6. Configurer le bot Discord

Dans l'app MemeDrop (mode Admin) :
- URL serveur : `ws://<IP_PUBLIQUE>:8787`
- Mot de passe admin : celui defini dans `ADMIN_PASSWORD` du service systemd
- Token bot + ID channel : depuis le Discord Developer Portal
- Clic "Envoyer au serveur"

Le statut doit passer a `connected (TonBot#1234)`.

### 7. Hardening (optionnel, recommande)

- **HTTPS/WSS** : installe Caddy avec un nom de domaine (ou DuckDNS gratuit). Caddy fait l'auto-TLS via Let's Encrypt. Le mdp admin transitera chiffre.
- **fail2ban** : pour proteger SSH
- **Mot de passe admin fort** : edite `ADMIN_PASSWORD` dans le service systemd (`sudo systemctl daemon-reload && sudo systemctl restart memedrop`).
- **Sauvegarde `config.json`** : il contient le token bot (en clair).

## Test local rapide

```bash
cd server
npm install
node server.js
```

Puis dans l'app cliente, URL serveur = `ws://localhost:8787`.

## Docker (optionnel)

```bash
cd server
docker build -t memedrop-server .
docker run -d --name memedrop \
  -p 8787:8787 \
  -e ADMIN_PASSWORD=ChangeMoi \
  -v memedrop-data:/data \
  --restart unless-stopped \
  memedrop-server
```
