/**
 * DebatIA — Serveur de salles de débat (socket.io)
 * Prêt pour Railway · Node 20+
 *
 * Déploiement :
 *   npm install
 *   npm start
 *
 * Railway injecte la variable PORT automatiquement.
 */

const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const MAX_JOUEURS = 10;

/* ── Serveur HTTP minimal (healthcheck Railway) ─────────────── */

const app = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        service: 'debatia-backend',
        status: 'ok',
        salles: salles.size,
        uptime: Math.round(process.uptime()),
      })
    );
    return;
  }
  res.writeHead(404);
  res.end();
});

/* ── Socket.io ──────────────────────────────────────────────── */

const io = new Server(app, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 25000,
  pingInterval: 10000,
});

// salles : Map<nomSalle, Map<socketId, { id, name }>>
const salles = new Map();

function membres(room) {
  return Array.from(salles.get(room)?.values() ?? []);
}

function diffuserSalle(room) {
  io.to(room).emit('room-update', { room, users: membres(room) });
}

function retirer(socket) {
  const { room, name } = socket.data;
  if (!room) return;

  const salle = salles.get(room);
  if (!salle) return;

  salle.delete(socket.id);
  socket.leave(room);

  if (salle.size === 0) {
    salles.delete(room);
    console.log(`[salle vide] ${room} — supprimée`);
  } else {
    diffuserSalle(room);
    console.log(`[sortie] ${name} quitte ${room} (${salle.size} restants)`);
  }

  socket.data.room = null;
}

io.on('connection', (socket) => {
  console.log(`[connexion] ${socket.id}`);

  /* Rejoindre une salle */
  socket.on('join-room', ({ room, name } = {}) => {
    const r = String(room ?? '').trim().toLowerCase();
    const n = String(name ?? '').trim().slice(0, 18);

    if (r.length < 2 || n.length < 2) {
      socket.emit('join-error', { reason: 'Nom de salle ou prénom trop court.' });
      return;
    }

    retirer(socket); // au cas où il était déjà ailleurs

    if (!salles.has(r)) salles.set(r, new Map());
    const salle = salles.get(r);

    if (salle.size >= MAX_JOUEURS) {
      socket.emit('join-error', { reason: `La salle est pleine (${MAX_JOUEURS} orateurs).` });
      return;
    }

    salle.set(socket.id, { id: socket.id, name: n });
    socket.data.room = r;
    socket.data.name = n;
    socket.join(r);

    console.log(`[entrée] ${n} rejoint ${r} (${salle.size}/${MAX_JOUEURS})`);
    diffuserSalle(r);

    // Annonce aux autres
    socket.to(r).emit('power', {
      type: 'challenge',
      name: n,
      message: `${n} entre dans l'arène.`,
    });
  });

  /* Quitter une salle */
  socket.on('leave-room', () => retirer(socket));

  /* Argument parlé */
  socket.on('argument', ({ text, durationMs } = {}) => {
    const room = socket.data.room;
    const name = socket.data.name;
    if (!room || !text) return;

    const paquet = {
      id: `${socket.id}-${Date.now()}`,
      name,
      text: String(text).slice(0, 600),
      durationMs: durationMs ?? 0,
      at: Date.now(),
    };

    // Uniquement aux autres : l'émetteur affiche déjà son message localement
    socket.to(room).emit('argument', paquet);
    console.log(`[argument] ${room} · ${name} : ${paquet.text.slice(0, 50)}…`);
  });

  /* Pouvoirs : Défi Divin, Combo Divin, Appel aux Dieux */
  socket.on('power', ({ type } = {}) => {
    const room = socket.data.room;
    const name = socket.data.name;
    if (!room || !['challenge', 'combo', 'joker'].includes(type)) return;

    const messages = {
      challenge: `${name} défie l'arène. Qui répond ?`,
      combo: `${name} enchaîne trois arguments d'affilée.`,
      joker: `${name} invoque l'arbitrage de l'IA.`,
    };

    socket.to(room).emit('power', { type, name, message: messages[type] });
    console.log(`[pouvoir] ${room} · ${name} → ${type}`);
  });

  socket.on('disconnect', () => {
    retirer(socket);
    console.log(`[déconnexion] ${socket.id}`);
  });
});

app.listen(PORT, () => {
  console.log(`DebatIA backend en écoute sur le port ${PORT}`);
});
