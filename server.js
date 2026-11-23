const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS_PER_ROOM = 35;
const P = 64;
const AIRPORT_X = 14 * P + 32;
const AIRPORT_Z = 13 * P + 32;

const htmlCandidates = [
  path.join(__dirname, 'Index.html'),
  path.join(__dirname, 'index.html'),
  path.join(__dirname, 'public', 'Index.html'),
  path.join(__dirname, 'public', 'index.html'),
  path.join(__dirname, 'www', 'Index.html'),
  path.join(__dirname, 'www', 'index.html')
];

function findHtmlFile() {
  for (const file of htmlCandidates) {
    if (fs.existsSync(file)) return file;
  }
  return null;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: ['1', '2'] });
});

app.get('/', (_req, res) => {
  const htmlFile = findHtmlFile();
  if (htmlFile) {
    return res.sendFile(htmlFile);
  }
  res.status(200).send('GTA X Server online');
});

app.use(express.static(__dirname));
if (fs.existsSync(path.join(__dirname, 'public'))) {
  app.use(express.static(path.join(__dirname, 'public')));
}
if (fs.existsSync(path.join(__dirname, 'www'))) {
  app.use(express.static(path.join(__dirname, 'www')));
}

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

function createInitialCars() {
  return [
    { id: 'carro_1', x: 24, y: 50, angle: 0, speed: 0, driverId: null },
    { id: 'carro_2', x: 40, y: 10, angle: Math.PI, speed: 0, driverId: null },
    { id: 'carro_3', x: 74, y: 38, angle: Math.PI / 2, speed: 0, driverId: null },
    { id: 'carro_4', x: -8, y: 38, angle: -Math.PI / 2, speed: 0, driverId: null },
    { id: 'carro_fusca', x: 12, y: 32, angle: 0, speed: 0, driverId: null },
    { id: 'moto_1', x: 50, y: 34, angle: Math.PI / 2, speed: 0, driverId: null },
    {
      id: 'aviao_aeroporto',
      x: AIRPORT_X - 76,
      y: AIRPORT_Z,
      angle: Math.PI / 2,
      speed: 0,
      altitude: 0,
      pitch: 0,
      roll: 0,
      driverId: null
    }
  ];
}

const rooms = {
  '1': { players: {}, cars: createInitialCars() },
  '2': { players: {}, cars: createInitialCars() }
};

function normalizeRoomId(raw) {
  return String(raw) === '2' ? '2' : '1';
}

function removePlayerFromRoom(socket, roomId) {
  const room = rooms[roomId];
  if (!room) return;

  if (room.players[socket.id]) {
    delete room.players[socket.id];
    socket.to('srv_' + roomId).emit('player:leave', socket.id);
  }

  room.cars.forEach((car) => {
    if (car.driverId === socket.id) {
      car.driverId = null;
      car.speed = 0;
      io.to('srv_' + roomId).emit('car:update', car);
    }
  });

  socket.leave('srv_' + roomId);
}

function joinRoom(socket, nextRoomId) {
  const targetRoom = normalizeRoomId(nextRoomId);
  const currentRoom = socket.data.roomId;

  if (currentRoom && currentRoom !== targetRoom) {
    removePlayerFromRoom(socket, currentRoom);
  }

  const room = rooms[targetRoom];
  const playerCount = Object.keys(room.players).length;
  if (!room.players[socket.id] && playerCount >= MAX_PLAYERS_PER_ROOM) {
    socket.emit('room:full', { room: targetRoom, max: MAX_PLAYERS_PER_ROOM });
    return;
  }

  socket.data.roomId = targetRoom;
  socket.join('srv_' + targetRoom);

  room.players[socket.id] = {
    id: socket.id,
    name: socket.data.name || ('Player_' + socket.id.slice(0, 4)),
    x: 32,
    y: 32,
    angle: 0,
    inCarId: null,
    seatRole: 'foot',
    elevation: 0
  };

  socket.emit('init', {
    room: targetRoom,
    players: room.players,
    cars: room.cars
  });

  socket.to('srv_' + targetRoom).emit('player:join', room.players[socket.id]);
}

io.on('connection', (socket) => {
  socket.data.name = 'Player_' + socket.id.slice(0, 4);
  const initialRoom = normalizeRoomId(socket.handshake.query && socket.handshake.query.server);
  joinRoom(socket, initialRoom);

  socket.on('room:select', (roomChoice) => {
    joinRoom(socket, roomChoice);
  });

  socket.on('player:move', (data) => {
    const roomId = socket.data.roomId || '1';
    const room = rooms[roomId];
    if (!room || !data) return;

    const p = room.players[socket.id] || { id: socket.id };
    if (typeof data.name === 'string' && data.name.trim()) {
      p.name = data.name.trim().slice(0, 16);
      socket.data.name = p.name;
    }
    if (Number.isFinite(data.x)) p.x = data.x;
    if (Number.isFinite(data.y)) p.y = data.y;
    if (Number.isFinite(data.angle)) p.angle = data.angle;
    p.inCarId = data.inCarId || null;
    p.seatRole = data.seatRole || 'foot';
    if (Number.isFinite(data.elevation)) p.elevation = data.elevation;

    room.players[socket.id] = p;
    socket.to('srv_' + roomId).emit('player:move', p);
  });

  socket.on('car:toggle', () => {
    const roomId = socket.data.roomId || '1';
    const room = rooms[roomId];
    if (!room) return;

    const existingCar = room.cars.find((c) => c.driverId === socket.id);
    if (existingCar) {
      existingCar.driverId = null;
      existingCar.speed = 0;
      if (room.players[socket.id]) room.players[socket.id].inCarId = null;
      io.to('srv_' + roomId).emit('car:update', existingCar);
      return;
    }

    const player = room.players[socket.id];
    if (!player) return;

    let nearest = null;
    let bestDist = 18;
    for (const car of room.cars) {
      if (car.driverId && car.driverId !== socket.id) continue;
      const d = Math.hypot(car.x - player.x, car.y - player.y);
      if (d < bestDist) {
        bestDist = d;
        nearest = car;
      }
    }

    if (nearest) {
      nearest.driverId = socket.id;
      player.inCarId = nearest.id;
      io.to('srv_' + roomId).emit('car:update', nearest);
    }
  });

  socket.on('car:drive', (data) => {
    const roomId = socket.data.roomId || '1';
    const room = rooms[roomId];
    if (!room || !data || !data.id) return;

    const car = room.cars.find((c) => c.id === data.id);
    if (!car) return;
    if (car.driverId && car.driverId !== socket.id) return;

    car.driverId = socket.id;
    if (Number.isFinite(data.x)) car.x = data.x;
    if (Number.isFinite(data.y)) car.y = data.y;
    if (Number.isFinite(data.angle)) car.angle = data.angle;
    if (Number.isFinite(data.speed)) car.speed = data.speed;
    if (Number.isFinite(data.altitude)) car.altitude = data.altitude;
    if (Number.isFinite(data.pitch)) car.pitch = data.pitch;
    if (Number.isFinite(data.roll)) car.roll = data.roll;

    socket.to('srv_' + roomId).emit('car:drive', car);
  });

  socket.on('chat:msg', (payload) => {
    const roomId = socket.data.roomId || '1';
    if (!payload || typeof payload.text !== 'string') return;
    const text = payload.text.trim().slice(0, 110);
    if (!text) return;

    const sender =
      (typeof payload.name === 'string' && payload.name.trim().slice(0, 16)) ||
      socket.data.name ||
      'Jogador';

    io.to('srv_' + roomId).emit('chat:msg', {
      id: socket.id,
      name: sender,
      text
    });
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId || '1';
    removePlayerFromRoom(socket, roomId);
  });
});

server.listen(PORT, () => {
  console.log('GTA X Server rodando na porta ' + PORT);
});
