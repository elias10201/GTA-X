const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 20;
const SERVERS = ['srv-1', 'srv-2'];
const IDLE_TIMEOUT_MS = 120000;

const roomsState = {
  'srv-1': {},
  'srv-2': {}
};

function findGameHtml() {
  const candidates = [
    path.join(__dirname, 'index.html'),
    path.join(__dirname, 'public', 'index.html'),
    path.join(__dirname, 'GTAX-CameraLivre-Voz-PTBR-Online-2x20_2.html'),
    path.join(__dirname, 'public', 'GTAX-CameraLivre-Voz-PTBR-Online-2x20_2.html')
  ];

  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }

  const rootFiles = fs.readdirSync(__dirname).filter((f) => f.endsWith('.html'));
  if (rootFiles.length > 0) return path.join(__dirname, rootFiles[0]);

  const publicDir = path.join(__dirname, 'public');
  if (fs.existsSync(publicDir)) {
    const publicFiles = fs.readdirSync(publicDir).filter((f) => f.endsWith('.html'));
    if (publicFiles.length > 0) return path.join(publicDir, publicFiles[0]);
  }

  return null;
}

app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    servers: SERVERS.map((id) => ({
      id,
      players: Object.keys(roomsState[id]).length,
      maxPlayers: MAX_PLAYERS
    }))
  });
});

app.get('/', (req, res) => {
  const htmlPath = findGameHtml();
  if (!htmlPath) {
    return res.status(404).send('Arquivo HTML do jogo não encontrado no servidor.');
  }
  return res.sendFile(htmlPath);
});

function getLobbyStats() {
  return SERVERS.map((id) => ({
    id,
    players: Object.keys(roomsState[id]).length,
    maxPlayers: MAX_PLAYERS
  }));
}

function broadcastLobbyStats() {
  io.emit('lobby_stats', getLobbyStats());
}

io.on('connection', (socket) => {
  const rawServerId = String(socket.handshake.query.serverId || 'srv-1');
  const serverId = SERVERS.includes(rawServerId) ? rawServerId : 'srv-1';
  const rawNick = String(socket.handshake.query.nick || '').trim();
  const nick = rawNick.slice(0, 18) || `Jogador_${socket.id.slice(0, 4)}`;

  const currentCount = Object.keys(roomsState[serverId]).length;
  if (currentCount >= MAX_PLAYERS) {
    socket.emit('server_full', { serverId, maxPlayers: MAX_PLAYERS });
    socket.disconnect(true);
    return;
  }

  socket.join(serverId);
  roomsState[serverId][socket.id] = {
    id: socket.id,
    serverId,
    name: nick,
    x: 0,
    z: 0,
    yaw: 0,
    hp: 100,
    weapon: 'fists',
    inCar: false,
    lastSeen: Date.now()
  };

  socket.emit('lobby_stats', getLobbyStats());
  broadcastLobbyStats();

  socket.on('player_state', (data = {}) => {
    const player = roomsState[serverId]?.[socket.id];
    if (!player) return;

    player.name = typeof data.name === 'string' && data.name.trim()
      ? data.name.trim().slice(0, 18)
      : player.name;
    player.x = Number.isFinite(data.x) ? data.x : player.x;
    player.z = Number.isFinite(data.z) ? data.z : player.z;
    player.yaw = Number.isFinite(data.yaw) ? data.yaw : player.yaw;
    player.hp = Number.isFinite(data.hp) ? Math.max(0, Math.min(100, data.hp)) : player.hp;
    player.weapon = typeof data.weapon === 'string' ? data.weapon.slice(0, 24) : player.weapon;
    player.inCar = Boolean(data.inCar);
    player.lastSeen = Date.now();

    const others = {};
    for (const [id, p] of Object.entries(roomsState[serverId])) {
      if (id !== socket.id) {
        others[id] = p;
      }
    }
    socket.to(serverId).emit('players_snapshot', roomsState[serverId]);
    socket.emit('players_snapshot', others);
  });

  socket.on('disconnect', () => {
    if (roomsState[serverId]?.[socket.id]) {
      delete roomsState[serverId][socket.id];
      socket.to(serverId).emit('player_left', { id: socket.id, serverId });
      broadcastLobbyStats();
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const serverId of SERVERS) {
    for (const [id, p] of Object.entries(roomsState[serverId])) {
      if (now - p.lastSeen > IDLE_TIMEOUT_MS) {
        delete roomsState[serverId][id];
        io.to(serverId).emit('player_left', { id, serverId });
        io.sockets.sockets.get(id)?.disconnect(true);
      }
    }
  }
  broadcastLobbyStats();
}, 10000);

server.listen(PORT, () => {
  console.log(`GTA-X Multiplayer rodando na porta ${PORT}`);
});
