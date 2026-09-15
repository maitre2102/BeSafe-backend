// Backend BeSafe — orchestre les alertes : SMS simultanés + appels séquentiels avec message vocal automatique.
// À déployer sur un service accessible en HTTPS (Render, Railway...). Ne jamais exposer ce code côté client.

const express = require('express');
const twilio = require('twilio');
const { Pool } = require('pg');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Autorise le frontend (hébergé sur un autre domaine, ex. Netlify) à appeler ce backend.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ---------------------------------------------------------------------------
// Base de données persistante — UNIQUEMENT les trajets liés à un incident
// (alerte rouge, alerte discrète, sirène). Volontairement, on ne stocke jamais
// les déplacements ordinaires d'un utilisateur en dehors de ces moments-là.
// ---------------------------------------------------------------------------
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function initDb() {
  if (!pool) {
    console.warn('DATABASE_URL absent : les trajets ne seront pas persistés (uniquement en mémoire, perdus au redémarrage).');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY,
      device_id TEXT,
      user_name TEXT,
      type TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ended_at TIMESTAMPTZ
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS incident_positions (
      id SERIAL PRIMARY KEY,
      incident_id TEXT REFERENCES incidents(id) ON DELETE CASCADE,
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log('Base de données prête (table incidents + incident_positions).');
}
initDb().catch((err) => console.error('Erreur init base de données :', err.message));

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

// ---------------------------------------------------------------------------
// Alerte discrète (bouton violet) : un seul SMS à un seul contact choisi,
// pour un simple inconfort qui ne justifie pas la procédure d'urgence complète.
// ---------------------------------------------------------------------------
app.post('/api/soft-alert', async (req, res) => {
  const { userName, contactPhone, latitude, longitude } = req.body;

  if (!contactPhone) {
    return res.status(400).json({ error: 'Aucun contact fourni.' });
  }

  const mapsLink = (latitude != null && longitude != null)
    ? `https://maps.google.com/?q=${latitude},${longitude}`
    : 'position indisponible';

  const message = `${userName || 'Une personne'} se trouve dans une situation inconfortable. Veuillez garder un œil sur sa position ou prendre contact avec elle : ${mapsLink}`;

  try {
    await client.messages.create({ to: contactPhone, from: fromNumber, body: message });
    res.json({ status: 'envoye' });
  } catch (err) {
    console.error('Erreur envoi SMS (alerte discrète) :', err.message);
    res.status(500).json({ error: 'Échec de l\'envoi du SMS.' });
  }
});

// ---------------------------------------------------------------------------
// Signalements partagés façon Waze : suspect / danger / sous influence.
// Stockage en mémoire, partagé entre tous les utilisateurs de l'app.
// Chaque signalement expire automatiquement 24h après sa création.
// ---------------------------------------------------------------------------
const REPORT_TYPES = ['suspect', 'danger', 'influence'];
const REPORT_TTL_MS = 24 * 60 * 60 * 1000;
const reports = {};

app.post('/api/reports', (req, res) => {
  const { type, description, latitude, longitude } = req.body;

  if (!REPORT_TYPES.includes(type)) {
    return res.status(400).json({ error: 'Type de signalement invalide.' });
  }
  if (latitude == null || longitude == null) {
    return res.status(400).json({ error: 'Position manquante.' });
  }

  const id = 'r_' + Date.now() + '_' + Math.round(Math.random() * 1000);
  const now = Date.now();
  reports[id] = {
    id,
    type,
    description: (description || '').slice(0, 200),
    latitude,
    longitude,
    createdAt: now,
    expiresAt: now + REPORT_TTL_MS,
    votes: { there: 0, notThere: 0 },
  };

  res.json({ report: reports[id] });
});

// Liste des signalements encore actifs (moins de 24h).
app.get('/api/reports', (req, res) => {
  const now = Date.now();
  const active = Object.values(reports).filter((r) => r.expiresAt > now);
  res.json({ reports: active });
});

// Vote "toujours là" / "plus là" par les autres utilisateurs, pour garder la carte à jour.
app.post('/api/reports/:id/vote', (req, res) => {
  const report = reports[req.params.id];
  const { vote } = req.body;
  if (!report) return res.status(404).json({ error: 'Signalement introuvable.' });
  if (vote === 'there') report.votes.there += 1;
  else if (vote === 'not_there') report.votes.notThere += 1;
  else return res.status(400).json({ error: 'Vote invalide.' });

  // Retiré dès que 5 utilisateurs indiquent que ce n'est plus le cas, plutôt que d'attendre les 24h.
  if (report.votes.notThere >= 5) {
    delete reports[report.id];
    return res.json({ removed: true });
  }
  res.json({ report });
});

// Nettoyage périodique des signalements expirés, pour ne pas accumuler en mémoire.
setInterval(() => {
  const now = Date.now();
  Object.keys(reports).forEach((id) => {
    if (reports[id].expiresAt <= now) delete reports[id];
  });
}, 10 * 60 * 1000);

// ---------------------------------------------------------------------------
// Assistant IA d'aide à l'utilisation de l'app, accessible depuis Paramètres.
// Nécessite une clé API Anthropic (console.anthropic.com) côté serveur.
// ---------------------------------------------------------------------------
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPPORT_SYSTEM_PROMPT = `Tu es l'assistant d'aide intégré à l'application BeSafe, une application de sécurité personnelle.
Tu aides les utilisatrices et utilisateurs à comprendre et utiliser l'app : le bouton bleu (sirène sonore), le bouton violet (prévenir discrètement un contact), le bouton rouge (alerte d'urgence vers les contacts de confiance), le bouton orange (signaler une situation suspecte/dangereuse sur la carte, visible 24h), la barre verte "je suis en sécurité", et les réglages du profil.
Réponds de façon brève, concrète et rassurante, en français. Si la question sort du cadre de l'app (question médicale, juridique complexe, urgence réelle en cours), invite clairement la personne à contacter les secours (112) ou un professionnel compétent plutôt que de répondre à sa place.`;

app.post('/api/support-chat', async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(503).json({ error: 'Assistant non configuré.' });
  const { messages } = req.body;
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'Aucun message fourni.' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system: SUPPORT_SYSTEM_PROMPT,
        messages: messages,
      }),
    });
    const data = await response.json();
    const text = (data.content || []).map((b) => b.text || '').join('');
    res.json({ reply: text || 'Désolé, je n\'ai pas pu répondre. Réessaie dans un instant.' });
  } catch (err) {
    console.error('Erreur assistant IA :', err.message);
    res.status(500).json({ error: 'Échec de la requête à l\'assistant.' });
  }
});

const port = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Trajets liés à un incident (alerte rouge, alerte discrète, sirène).
// Créé au déclenchement, mis à jour à intervalle régulier tant que l'incident
// est actif, clôturé quand l'utilisateur confirme être en sécurité.
// ---------------------------------------------------------------------------
const INCIDENT_TYPES = ['alerte_urgence', 'alerte_discrete', 'sirene'];

app.post('/api/incidents', async (req, res) => {
  const { type, deviceId, userName, latitude, longitude } = req.body;
  if (!INCIDENT_TYPES.includes(type)) return res.status(400).json({ error: 'Type d\'incident invalide.' });

  const id = 'inc_' + Date.now() + '_' + Math.round(Math.random() * 1000);

  if (pool) {
    try {
      await pool.query(
        'INSERT INTO incidents (id, device_id, user_name, type) VALUES ($1, $2, $3, $4)',
        [id, deviceId || null, userName || null, type]
      );
      if (latitude != null && longitude != null) {
        await pool.query(
          'INSERT INTO incident_positions (incident_id, latitude, longitude) VALUES ($1, $2, $3)',
          [id, latitude, longitude]
        );
      }
    } catch (err) {
      console.error('Erreur création incident :', err.message);
    }
  }

  res.json({ incidentId: id });
});

// Appelé à intervalle régulier pendant qu'un incident reste actif, pour construire le trajet.
app.post('/api/incidents/:id/position', async (req, res) => {
  const { latitude, longitude } = req.body;
  if (latitude == null || longitude == null) return res.status(400).json({ error: 'Position manquante.' });
  if (!pool) return res.json({ status: 'non-persisté (pas de base de données configurée)' });

  try {
    await pool.query(
      'INSERT INTO incident_positions (incident_id, latitude, longitude) VALUES ($1, $2, $3)',
      [req.params.id, latitude, longitude]
    );
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: 'Échec de l\'enregistrement de la position.' });
  }
});

app.post('/api/incidents/:id/close', async (req, res) => {
  if (!pool) return res.json({ status: 'non-persisté (pas de base de données configurée)' });
  try {
    await pool.query('UPDATE incidents SET ended_at = now() WHERE id = $1', [req.params.id]);
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: 'Échec de la clôture.' });
  }
});

// Réservé à la page d'admin : liste des incidents avec leur trajet complet.
app.get('/api/incidents', requireAdmin, async (req, res) => {
  if (!pool) return res.json({ incidents: [] });
  try {
    const incidents = await pool.query('SELECT * FROM incidents ORDER BY started_at DESC LIMIT 200');
    const positions = await pool.query(
      'SELECT * FROM incident_positions WHERE incident_id = ANY($1) ORDER BY recorded_at ASC',
      [incidents.rows.map((i) => i.id)]
    );
    const byIncident = {};
    positions.rows.forEach((p) => {
      (byIncident[p.incident_id] = byIncident[p.incident_id] || []).push({
        latitude: p.latitude, longitude: p.longitude, recordedAt: p.recorded_at,
      });
    });
    res.json({
      incidents: incidents.rows.map((i) => ({ ...i, positions: byIncident[i.id] || [] })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Échec de la lecture.' });
  }
});

// ---------------------------------------------------------------------------
// Registre des appareils ayant installé l'app — alimente la page d'admin
// (compteur, liste des profils, qui est actif). Protégé par une clé secrète :
// seule la page d'admin qui connaît ADMIN_KEY peut lire cette liste.
// ---------------------------------------------------------------------------
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-me';
const ACTIVE_WINDOW_MS = 5 * 60 * 1000; // considéré "actif" si vu il y a moins de 5 minutes
const devices = {};

function requireAdmin(req, res, next) {
  const key = req.query.key || req.headers['x-admin-key'];
  if (!ADMIN_KEY || key !== ADMIN_KEY) return res.status(401).json({ error: 'Non autorisé.' });
  next();
}

// Appelé au démarrage de l'app et à chaque modification du profil.
app.post('/api/devices/register', (req, res) => {
  const { deviceId, name, phone, contactsCount } = req.body;
  if (!deviceId) return res.status(400).json({ error: 'deviceId manquant.' });
  const now = Date.now();
  const existing = devices[deviceId] || { registeredAt: now };
  devices[deviceId] = {
    deviceId,
    registeredAt: existing.registeredAt,
    lastSeen: existing.lastSeen || now,
    latitude: existing.latitude,
    longitude: existing.longitude,
    name: name || 'Sans nom',
    phone: phone || '',
    contactsCount: contactsCount || 0,
  };
  res.json({ status: 'ok' });
});

// Appelé régulièrement pendant que l'app est ouverte, pour signaler "toujours là" + position.
app.post('/api/devices/:id/ping', (req, res) => {
  const d = devices[req.params.id];
  if (!d) return res.status(404).json({ error: 'Appareil non enregistré.' });
  d.lastSeen = Date.now();
  if (req.body.latitude != null && req.body.longitude != null) {
    d.latitude = req.body.latitude;
    d.longitude = req.body.longitude;
  }
  res.json({ status: 'ok' });
});

// Réservé à la page d'admin.
app.get('/api/devices', requireAdmin, (req, res) => {
  const now = Date.now();
  const list = Object.values(devices).map((d) => ({
    ...d,
    active: (now - d.lastSeen) < ACTIVE_WINDOW_MS,
  }));
  list.sort((a, b) => b.lastSeen - a.lastSeen);
  res.json({ count: list.length, devices: list });
});

// Nettoyage : on oublie les appareils inactifs depuis plus de 30 jours.
setInterval(() => {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  Object.keys(devices).forEach((id) => {
    if (devices[id].lastSeen < cutoff) delete devices[id];
  });
}, 60 * 60 * 1000);

app.listen(port, () => console.log(`Backend BeSafe démarré sur le port ${port}`));
