const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS_PER_SERVER = 20;

const SERVERS = {
  'srv-1': { id: 'srv-1', name: 'Servidor Brasil #1 — Centro', maxPlayers: MAX_PLAYERS_PER_SERVER, players: new Map() },
  'srv-2': { id: 'srv-2', name: 'Servidor Brasil #2 — Aeroporto & Praia', maxPlayers: MAX_PLAYERS_PER_SERVER, players: new Map() }
};

function getLobbyStats() {
  return Object.values(SERVERS).map(s => ({
    id: s.id,
    name: s.name,
    players: s.players.size,
    maxPlayers: s.maxPlayers
  }));
}

function broadcastLobby() {
  io.emit('lobby_stats', getLobbyStats());
}

function broadcastRoomPlayers(serverId) {
  const srv = SERVERS[serverId];
  if (!srv) return;
  io.to(serverId).emit('players_snapshot', Array.from(srv.players.values()));
}

function resolveIndexHtml() {
  const candidates = [
    path.join(__dirname, 'index.html'),
    path.join(__dirname, 'public', 'index.html'),
    path.join(__dirname, 'GTAX-CameraLivre-Voz-PTBR-Online-2x20.html')
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }
  return null;
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

app.get('/', (_req, res) => {
  const htmlFile = resolveIndexHtml();
  if (htmlFile) {
    return res.sendFile(htmlFile);
  }
  return res.status(404).send('index.html nao encontrado na raiz do projeto.');
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, servers: getLobbyStats() });
});

io.on('connection', (socket) => {
  const qServerId = String((socket.handshake.query && socket.handshake.query.serverId) || 'srv-1');
  const serverId = SERVERS[qServerId] ? qServerId : 'srv-1';
  const srv = SERVERS[serverId];

  const rawNick = String((socket.handshake.query && socket.handshake.query.nick) || '').trim();
  const nick = (rawNick || ('Player_' + socket.id.slice(0, 4))).slice(0, 16);

  if (srv.players.size >= srv.maxPlayers) {
    socket.emit('server_full', {
      serverId,
      maxPlayers: srv.maxPlayers,
      message: `O ${srv.name} atingiu o limite de ${srv.maxPlayers} jogadores.`
    });
    socket.disconnect(true);
    return;
  }

  socket.join(serverId);
  srv.players.set(socket.id, {
    id: socket.id,
    name: nick,
    x: 32,
    z: 32,
    yaw: 0,
    hp: 200,
    weapon: 0,
    inCar: false,
    updatedAt: Date.now()
  });

  socket.emit('lobby_stats', getLobbyStats());
  broadcastLobby();
  broadcastRoomPlayers(serverId);

  socket.on('player_state', (data) => {
    if (!data || typeof data !== 'object') return;
    const current = srv.players.get(socket.id);
    if (!current) return;

    const cleanName = String(data.name || current.name || nick).trim().slice(0, 16);
    current.name = cleanName || current.name;
    if (Number.isFinite(Number(data.x))) current.x = Number(data.x);
    if (Number.isFinite(Number(data.z))) current.z = Number(data.z);
    if (Number.isFinite(Number(data.yaw))) current.yaw = Number(data.yaw);
    if (Number.isFinite(Number(data.hp))) current.hp = Math.max(0, Math.min(200, Number(data.hp)));
    if (Number.isFinite(Number(data.weapon))) current.weapon = Number(data.weapon);
    current.inCar = Boolean(data.inCar);
    current.updatedAt = Date.now();
  });

  socket.on('chat_message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    const text = String(msg.text || '').trim().slice(0, 120);
    if (!text) return;
    const playerInfo = srv.players.get(socket.id);
    const senderName = String((playerInfo && playerInfo.name) || msg.name || nick).trim().slice(0, 16) || 'Player';
    io.to(serverId).emit('chat_message', {
      id: socket.id,
      serverId,
      name: senderName,
      text,
      ts: Date.now()
    });
  });

  socket.on('disconnect', () => {
    srv.players.delete(socket.id);
    io.to(serverId).emit('player_left', socket.id);
    broadcastLobby();
    broadcastRoomPlayers(serverId);
  });
});

setInterval(() => {
  Object.keys(SERVERS).forEach(broadcastRoomPlayers);
}, 100);

server.listen(PORT, () => {
  console.log(`GTA X Multiplayer Server rodando na porta ${PORT}`);
});
