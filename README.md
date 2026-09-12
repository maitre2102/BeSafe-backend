# Backend BeSafe

Ce backend automatise ce que l'app faisait manuellement jusqu'ici : dès qu'il reçoit une alerte, il envoie un SMS à tous les contacts de confiance en simultané, puis les appelle un par un jusqu'à ce que l'un d'eux décroche, en lui faisant entendre un message vocal automatique avec la position de la personne en danger.

## 1. Prérequis

- Un compte Twilio (twilio.com) avec facturation activée et un numéro capable d'appeler/envoyer des SMS vers la Belgique.
- Node.js 18+ si vous testez en local.
- Un hébergeur pour le déploiement (Render, Railway, ou équivalent), car Twilio doit pouvoir joindre ce serveur en HTTPS.

## 2. Installation locale (optionnel, pour tester avant de déployer)

```
npm install
cp .env.example .env
# renseigner les vraies valeurs dans .env
npm start
```

Pour tester en local, Twilio doit pouvoir atteindre votre machine : utilisez un tunnel comme ngrok (`ngrok http 3000`) et mettez l'URL ngrok dans `PUBLIC_BASE_URL`.

## 3. Déploiement (exemple avec Render)

1. Créez un nouveau dépôt Git contenant ce dossier, poussez-le sur GitHub.
2. Sur Render, créez un "Web Service" à partir de ce dépôt.
3. Render détecte Node.js automatiquement ; commande de démarrage : `npm start`.
4. Dans les variables d'environnement du service, ajoutez `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, et `PUBLIC_BASE_URL` (l'URL que Render vous attribue, ex. `https://besafe-backend.onrender.com`).
5. Déployez. Une fois en ligne, notez l'URL — c'est celle à renseigner dans les Paramètres de l'app BeSafe.

## 4. Sécurité — à ne pas négliger avant un usage réel

- Ce prototype n'a **aucune authentification** sur `/api/alerts` : n'importe qui connaissant l'URL pourrait déclencher un appel vers vos contacts. Avant un usage au-delà d'un test personnel, ajoutez une clé secrète partagée entre l'app et le backend (vérifiée sur chaque requête).
- Le stockage des alertes est en mémoire : il est perdu si le serveur redémarre, et ne fonctionne pas si vous scalez sur plusieurs instances. Pour un usage sérieux, remplacez `alerts` par une vraie base de données (PostgreSQL, Redis...).
- Twilio facture chaque SMS et chaque minute d'appel : surveillez votre consommation depuis la console Twilio.
