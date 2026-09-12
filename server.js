// Backend BeSafe — orchestre les alertes : SMS simultanés + appels séquentiels avec message vocal automatique.
// À déployer sur un service accessible en HTTPS (Render, Railway...). Ne jamais exposer ce code côté client.

const express = require('express');
const twilio = require('twilio');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_FROM_NUMBER;
const publicBaseUrl = process.env.PUBLIC_BASE_URL; // ex : https://votre-backend.onrender.com

if (!accountSid || !authToken || !fromNumber || !publicBaseUrl) {
  console.warn('Attention : une ou plusieurs variables d\'environnement Twilio sont manquantes.');
}

const client = twilio(accountSid, authToken);

// Stockage en mémoire, uniquement pour un usage personnel / prototype.
// Pour un usage réel avec plusieurs comptes, remplacer par une vraie base de données.
const alerts = {};

// Déclenchée par le bouton rouge de l'app.
app.post('/api/alerts', async (req, res) => {
  const { userName, latitude, longitude, contacts } = req.body;

  if (!Array.isArray(contacts) || contacts.length === 0) {
    return res.status(400).json({ error: 'Aucun contact de confiance fourni.' });
  }

  const alertId = 'a_' + Date.now();
  const mapsLink = (latitude != null && longitude != null)
    ? `https://maps.google.com/?q=${latitude},${longitude}`
    : 'position indisponible';

  const message = `${userName || 'Une personne'} a besoin d'une assistance d'urgence. Voici sa position en direct : ${mapsLink}`;

  alerts[alertId] = {
    contacts,
    currentIndex: 0,
    resolved: false,
    message,
  };

  try {
    // SMS envoyés simultanément à tous les contacts
    await Promise.all(contacts.map((c) =>
      client.messages.create({ to: c.phone, from: fromNumber, body: message })
    ));
  } catch (err) {
    console.error('Erreur envoi SMS :', err.message);
  }

  // Démarre la séquence d'appels (un par un, dans l'ordre fourni)
  callNextContact(alertId);

  res.json({ alertId, status: 'declenchee' });
});

function callNextContact(alertId) {
  const alert = alerts[alertId];
  if (!alert || alert.resolved || alert.currentIndex >= alert.contacts.length) return;

  const contact = alert.contacts[alert.currentIndex];

  client.calls
    .create({
      to: contact.phone,
      from: fromNumber,
      url: `${publicBaseUrl}/voice/${alertId}`,
      statusCallback: `${publicBaseUrl}/status/${alertId}/${alert.currentIndex}`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
    })
    .catch((err) => {
      console.error('Erreur appel Twilio :', err.message);
      alert.currentIndex += 1;
      callNextContact(alertId);
    });
}

// Twilio appelle cette URL dès que le contact décroche : c'est ici qu'on définit le message lu.
app.post('/voice/:alertId', (req, res) => {
  const alert = alerts[req.params.alertId];
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say(
    { voice: 'Polly.Celine', language: 'fr-FR' },
    alert ? alert.message : "Alerte de sécurité. Merci de contacter la personne concernée."
  );
  res.type('text/xml');
  res.send(twiml.toString());
});

// Callback de statut d'appel Twilio : décide s'il faut appeler le contact suivant.
app.post('/status/:alertId/:index', (req, res) => {
  const { alertId, index } = req.params;
  const alert = alerts[alertId];
  const status = req.body.CallStatus;

  if (alert && !alert.resolved) {
    if (status === 'in-progress') {
      // Le contact a décroché : on considère l'alerte prise en charge.
      alert.resolved = true;
    } else if (['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(status)) {
      alert.currentIndex = Number(index) + 1;
      callNextContact(alertId);
    }
  }

  res.sendStatus(200);
});

// Permet à l'app de vérifier où en est une alerte (optionnel, utile pour l'UI).
app.get('/api/alerts/:alertId', (req, res) => {
  const alert = alerts[req.params.alertId];
  if (!alert) return res.status(404).json({ error: 'Alerte introuvable.' });
  res.json({
    resolved: alert.resolved,
    currentIndex: alert.currentIndex,
    totalContacts: alert.contacts.length,
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Backend BeSafe démarré sur le port ${port}`));
