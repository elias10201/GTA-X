const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS_PER_SERVER = 20;

// 2 servidores independentes com limite estrito de 20 jogadores cada
const SERVERS = {
  'srv-1': {
    id: 'srv-1',
    name: 'Servidor Brasil #1 — Centro',
    maxPlayers: MAX_PLAYERS_PER_SERVER,
    players: new Map()
  },
  'srv-2': {
    id: 'srv-2',
    name: 'Servidor Brasil #2 — Aeroporto & Praia',
    maxPlayers: MAX_PLAYERS_PER_SERVER,
    players: new Map()
  }
};

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'GTAX-CameraLivre-Voz-PTBR-Online-2x20.html'));
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    servers: Object.values(SERVERS).map(s => ({
      id: s.id,
      name: s.name,
      players: s.players.size,
      maxPlayers: s.maxPlayers
    }))
  });
});

function broadcastLobbyStats() {
  const stats = Object.values(SERVERS).map(s => ({
    id: s.id,
    name: s.name,
    players: s.players.size,
    maxPlayers: s.maxPlayers
  }));
  io.emit('lobby_stats', stats);
}

function broadcastSnapshot(serverId) {
  const srv = SERVERS[serverId];
  if (!srv) return;
  const list = Array.from(srv.players.values());
  io.to(serverId).emit('players_snapshot', list);
}

io.on('connection', (socket) => {
  const reqServerId = String(socket.handshake.query.serverId || 'srv-1');
  const serverId = SERVERS[reqServerId] ? reqServerId : 'srv-1';
  const srv = SERVERS[serverId];
  const rawNick = String(socket.handshake.query.nick || '').trim().slice(0, 16);
  const nick = rawNick || ('Player_' + socket.id.slice(0, 4));

  if (srv.players.size >= MAX_PLAYERS_PER_SERVER) {
    socket.emit('server_full', {
      serverId,
      maxPlayers: MAX_PLAYERS_PER_SERVER,
      message: `O ${srv.name} está cheio (${MAX_PLAYERS_PER_SERVER}/${MAX_PLAYERS_PER_SERVER} jogadores).`
    });
    broadcastLobbyStats();
    socket.disconnect(true);
    return;
  }

  socket.join(serverId);
  srv.players.set(socket.id, {
    id: socket.id,
    serverId,
    name: nick,
    x: 32,
    z: 32,
    yaw: 0,
    hp: 200,
    weapon: 0,
    inCar: false,
    updatedAt: Date.now()
  });

  broadcastLobbyStats();
  broadcastSnapshot(serverId);

  socket.on('player_state', (data) => {
    if (!data || typeof data !== 'object') return;
    const targetSrvId = SERVERS[data.serverId] ? data.serverId : serverId;
    if (targetSrvId !== serverId) return;
    const current = srv.players.get(socket.id);
    if (!current) return;

    const cleanName = String(data.name || current.name || 'Jogador').trim().slice(0, 16);
    current.name = cleanName || current.name;
    current.x = Number.isFinite(Number(data.x)) ? Number(data.x) : current.x;
    current.z = Number.isFinite(Number(data.z)) ? Number(data.z) : current.z;
    current.yaw = Number.isFinite(Number(data.yaw)) ? Number(data.yaw) : current.yaw;
    current.hp = Number.isFinite(Number(data.hp)) ? Number(data.hp) : current.hp;
    current.weapon = Number.isFinite(Number(data.weapon)) ? Number(data.weapon) : current.weapon;
    current.inCar = Boolean(data.inCar);
    current.updatedAt = Date.now();
  });

  socket.on('disconnect', () => {
    if (srv.players.has(socket.id)) {
      srv.players.delete(socket.id);
      io.to(serverId).emit('player_left', socket.id);
      broadcastLobbyStats();
      broadcastSnapshot(serverId);
    }
  });
});

setInterval(() => {
  Object.keys(SERVERS).forEach(broadcastSnapshot);
}, 100);

server.listen(PORT, () => {
  console.log(`GTA X Online (2 servidores x 20 players) rodando em http://localhost:${PORT}`);
});
