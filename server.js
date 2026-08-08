/**
 * DebatIA — Backend de débat vocal multijoueur
 * Node.js + Express + Socket.io
 * Déployable tel quel sur Railway.
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const MAX_JOUEURS = 10;
const MIN_JOUEURS = 2;

/* ═══════════════════════════════════════════════════════════
   ÉTAT EN MÉMOIRE
   ═══════════════════════════════════════════════════════════ */

// salles : Map<roomId, { players: Map<socketId, joueur>, arguments: [], createdAt }>
const salles = new Map();

function getSalle(roomId) {
  if (!salles.has(roomId)) {
    salles.set(roomId, { players: new Map(), arguments: [], createdAt: Date.now() });
  }
  return salles.get(roomId);
}

function listeJoueurs(roomId) {
  const salle = salles.get(roomId);
  if (!salle) return [];
  return Array.from(salle.players.values());
}

function diffuserSalle(io, roomId) {
  const players = listeJoueurs(roomId);
  io.to(roomId).emit('room-update', {
    roomId,
    players,
    count: players.length,
    max: MAX_JOUEURS,
    ready: players.length >= MIN_JOUEURS,
  });
}

/* ═══════════════════════════════════════════════════════════
   SIMULATION IA (à remplacer par un vrai modèle plus tard)
   ═══════════════════════════════════════════════════════════ */

const TRANSCRIPTIONS = [
  "Les faits ne se plient pas à ton opinion, ils la contredisent.",
  "Tu confonds corrélation et causalité depuis le début.",
  "Si ta logique tenait, la conclusion inverse serait tout aussi vraie.",
  "Trois sources indépendantes disent l'exact opposé de ton point.",
  "Tu déplaces le sujet parce que tu ne peux pas défendre le premier.",
  "Ton exemple est une exception, pas une règle.",
  "Aucune de tes prémisses ne survit à un examen sérieux.",
];

const MOTIFS_VERDICT = [
  "argumentation la plus structurée",
  "meilleure maîtrise des faits",
  "raisonnement le moins contredit",
  "position la plus difficile à réfuter",
];

function transcrire() {
  return TRANSCRIPTIONS[Math.floor(Math.random() * TRANSCRIPTIONS.length)];
}

function rendreVerdict(roomId) {
  const salle = salles.get(roomId);
  if (!salle) return null;

  // Compte les arguments par joueur
  const scores = {};
  for (const arg of salle.arguments) {
    scores[arg.player] = (scores[arg.player] || 0) + 1;
  }

  const classement = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (classement.length === 0) return null;

  const [gagnant, total] = classement[0];
  const motif = MOTIFS_VERDICT[Math.floor(Math.random() * MOTIFS_VERDICT.length)];

  return {
    winner: gagnant,
    reason: `${gagnant} l'emporte : ${motif}.`,
    scores: classement.map(([name, count]) => ({ name, count })),
    totalArguments: salle.arguments.length,
    at: Date.now(),
  };
}

/* ═══════════════════════════════════════════════════════════
   SERVEUR HTTP + EXPRESS
   ═══════════════════════════════════════════════════════════ */

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    service: 'debatia-backend',
    status: 'ok',
    salles: salles.size,
    uptime: Math.round(process.uptime()),
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/rooms/:roomId', (req, res) => {
  const roomId = String(req.params.roomId).toLowerCase();
  const salle = salles.get(roomId);
  if (!salle) return res.status(404).json({ error: 'Salle introuvable.' });
  res.json({
    roomId,
    players: listeJoueurs(roomId),
    arguments: salle.arguments.length,
  });
});

const server = http.createServer(app);

/* ═══════════════════════════════════════════════════════════
   SOCKET.IO
   ═══════════════════════════════════════════════════════════ */

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 25000,
  pingInterval: 10000,
});

function quitterSalle(socket) {
  const { roomId, playerName } = socket.data;
  if (!roomId) return;

  const salle = salles.get(roomId);
  if (!salle) return;

  salle.players.delete(socket.id);
  socket.leave(roomId);

  if (salle.players.size === 0) {
    salles.delete(roomId);
    console.log(`[salle] ${roomId} vide — supprimée`);
  } else {
    diffuserSalle(io, roomId);
    console.log(`[sortie] ${playerName} quitte ${roomId}`);
  }

  socket.data.roomId = null;
}

io.on('connection', (socket) => {
  console.log(`[connexion] ${socket.id}`);
  socket.data.combo = 0;
  socket.data.jokerUtilise = false;

  /* ── Rejoindre une salle ────────────────────────────────── */
  socket.on('join-room', (payload = {}) => {
    const roomId = String(payload.roomId ?? '').trim().toLowerCase().slice(0, 24);
    const playerName = String(payload.playerName ?? '').trim().slice(0, 18);

    if (roomId.length < 2 || playerName.length < 2) {
      socket.emit('join-error', {
        message: 'Nom de salle et prénom : 2 caractères minimum.',
      });
      return;
    }

    quitterSalle(socket);

    const salle = getSalle(roomId);

    if (salle.players.size >= MAX_JOUEURS) {
      socket.emit('join-error', {
        message: `La salle est complète (${MAX_JOUEURS} orateurs).`,
      });
      return;
    }

    const dejaPris = Array.from(salle.players.values()).some(
      (p) => p.name.toLowerCase() === playerName.toLowerCase()
    );
    if (dejaPris) {
      socket.emit('join-error', {
        message: 'Ce prénom est déjà utilisé dans cette salle.',
      });
      return;
    }

    salle.players.set(socket.id, {
      id: socket.id,
      name: playerName,
      joinedAt: Date.now(),
    });

    socket.data.roomId = roomId;
    socket.data.playerName = playerName;
    socket.join(roomId);

    console.log(`[entrée] ${playerName} → ${roomId} (${salle.players.size}/${MAX_JOUEURS})`);

    socket.emit('join-success', { roomId, playerName });
    diffuserSalle(io, roomId);

    // Historique pour le nouvel arrivant
    if (salle.arguments.length > 0) {
      socket.emit('history', { arguments: salle.arguments.slice(-30) });
    }

    // Annonce aux autres
    socket.to(roomId).emit('defi-divin', {
      player: playerName,
      message: `${playerName} entre dans l'arène.`,
    });
  });

  /* ── Quitter volontairement ─────────────────────────────── */
  socket.on('leave-room', () => quitterSalle(socket));

  /* ── Prise de parole (audio simulé) ─────────────────────── */
  socket.on('submit-audio', (payload = {}) => {
    const roomId = socket.data.roomId;
    const playerName = socket.data.playerName;
    if (!roomId) return;

    const salle = salles.get(roomId);
    if (!salle) return;

    if (salle.players.size < MIN_JOUEURS) {
      socket.emit('join-error', {
        message: `Il faut ${MIN_JOUEURS} orateurs pour débattre.`,
      });
      return;
    }

    const argument = {
      id: `${socket.id}-${Date.now()}`,
      player: playerName,
      text: payload.text ? String(payload.text).slice(0, 600) : transcrire(),
      durationMs: Number(payload.durationMs) || 0,
      at: Date.now(),
    };

    salle.arguments.push(argument);
    if (salle.arguments.length > 100) salle.arguments.shift();

    io.to(roomId).emit('new-argument', argument);
    console.log(`[argument] ${roomId} · ${playerName}`);

    /* Combo Divin : 3 arguments consécutifs du même orateur */
    const derniers = salle.arguments.slice(-3);
    if (
      derniers.length === 3 &&
      derniers.every((a) => a.player === playerName)
    ) {
      io.to(roomId).emit('combo-divin', {
        player: playerName,
        count: 3,
        message: `${playerName} enchaîne trois arguments sans faillir.`,
      });
      console.log(`[combo] ${roomId} · ${playerName}`);
    }

    /* Verdict automatique tous les 6 arguments */
    if (salle.arguments.length > 0 && salle.arguments.length % 6 === 0) {
      const verdict = rendreVerdict(roomId);
      if (verdict) {
        io.to(roomId).emit('verdict', verdict);
        console.log(`[verdict] ${roomId} → ${verdict.winner}`);
      }
    }
  });

  /* ── Défi Divin ─────────────────────────────────────────── */
  socket.on('defi-divin', () => {
    const roomId = socket.data.roomId;
    const playerName = socket.data.playerName;
    if (!roomId) return;

    io.to(roomId).emit('defi-divin', {
      player: playerName,
      message: `${playerName} défie l'arène. Qui relève le gant ?`,
    });
  });

  /* ── Appel aux Dieux (Joker) ────────────────────────────── */
  socket.on('joker-activated', () => {
    const roomId = socket.data.roomId;
    const playerName = socket.data.playerName;
    if (!roomId) return;

    if (socket.data.jokerUtilise) {
      socket.emit('join-error', { message: 'Ton joker est déjà consumé.' });
      return;
    }
    socket.data.jokerUtilise = true;

    io.to(roomId).emit('joker-activated', {
      player: playerName,
      message: `${playerName} invoque l'arbitrage des Dieux.`,
    });

    // Le joker déclenche un verdict immédiat
    const verdict = rendreVerdict(roomId);
    if (verdict) {
      setTimeout(() => io.to(roomId).emit('verdict', verdict), 1500);
    }
  });

  /* ── Demande de verdict manuelle ────────────────────────── */
  socket.on('request-verdict', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const verdict = rendreVerdict(roomId);
    if (verdict) io.to(roomId).emit('verdict', verdict);
  });

  socket.on('disconnect', () => {
    quitterSalle(socket);
    console.log(`[déconnexion] ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`DebatIA backend en écoute sur le port ${PORT}`);
});
