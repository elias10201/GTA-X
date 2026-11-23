const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors({ origin: "*" }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

function getIndexFile() {
  const candidates = [
    "index.html",
    "Index.html",
    "Index (2).html",
    "GTA-X-ONLINE-COMPLETO-v2.html"
  ];
  for (const name of candidates) {
    const full = path.join(__dirname, name);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

app.use(express.static(__dirname));

app.get("/", (req, res) => {
  const indexFile = getIndexFile();
  if (indexFile) return res.sendFile(indexFile);
  res.status(404).send("Arquivo HTML do jogo não encontrado na pasta.");
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

const AIRPORT_X = 14 * 64 + 32;
const AIRPORT_Z = 13 * 64 + 32;

function createInitialCars() {
  return {
    carro_1: { id: "carro_1", x: 24, y: 50, angle: 0, speed: 0, altitude: 0, pitch: 0, roll: 0, driverId: null },
    carro_2: { id: "carro_2", x: 40, y: 10, angle: Math.PI, speed: 0, altitude: 0, pitch: 0, roll: 0, driverId: null },
    carro_3: { id: "carro_3", x: 74, y: 38, angle: Math.PI / 2, speed: 0, altitude: 0, pitch: 0, roll: 0, driverId: null },
    carro_4: { id: "carro_4", x: -8, y: 38, angle: -Math.PI / 2, speed: 0, altitude: 0, pitch: 0, roll: 0, driverId: null },
    carro_fusca: { id: "carro_fusca", x: 12, y: 32, angle: 0, speed: 0, altitude: 0, pitch: 0, roll: 0, driverId: null },
    moto_1: { id: "moto_1", x: 50, y: 34, angle: Math.PI / 2, speed: 0, altitude: 0, pitch: 0, roll: 0, driverId: null },
    aviao_aeroporto: { id: "aviao_aeroporto", x: AIRPORT_X - 76, y: AIRPORT_Z, angle: Math.PI / 2, speed: 0, altitude: 0, pitch: 0, roll: 0, driverId: null }
  };
}

const rooms = {
  srv_1: { players: {}, cars: createInitialCars() },
  srv_2: { players: {}, cars: createInitialCars() }
};

function normalizeRoom(raw) {
  return String(raw) === "2" || raw === "srv_2" ? "srv_2" : "srv_1";
}

function releaseDriver(roomState, socketId) {
  const p = roomState.players[socketId];
  if (!p) return null;
  let releasedCar = null;
  if (p.inCarId && roomState.cars[p.inCarId]) {
    const car = roomState.cars[p.inCarId];
    if (car.driverId === socketId) {
      car.driverId = null;
      car.speed = 0;
      releasedCar = car;
    }
    p.inCarId = null;
  }
  return releasedCar;
}

io.on("connection", (socket) => {
  let currentRoom = normalizeRoom(socket.handshake.query && socket.handshake.query.server);
  socket.join(currentRoom);

  const initPlayer = () => {
    const state = rooms[currentRoom];
    state.players[socket.id] = {
      id: socket.id,
      name: `Player_${socket.id.slice(0, 4)}`,
      x: 32,
      y: 32,
      angle: 0,
      elevation: 0,
      inCarId: null
    };
    socket.emit("init", {
      id: socket.id,
      room: currentRoom,
      players: state.players,
      cars: state.cars
    });
    socket.to(currentRoom).emit("player:join", state.players[socket.id]);
  };

  initPlayer();

  socket.on("room:select", (rawServer) => {
    const nextRoom = normalizeRoom(rawServer);
    if (nextRoom === currentRoom) return;
    const prevState = rooms[currentRoom];
    const released = releaseDriver(prevState, socket.id);
    if (released) io.to(currentRoom).emit("car:update", released);
    delete prevState.players[socket.id];
    socket.leave(currentRoom);
    socket.to(currentRoom).emit("player:leave", socket.id);

    currentRoom = nextRoom;
    socket.join(currentRoom);
    initPlayer();
  });

  socket.on("player:move", (data) => {
    const state = rooms[currentRoom];
    const p = state.players[socket.id];
    if (!p || !data) return;

    if (typeof data.x === "number" && Number.isFinite(data.x)) p.x = data.x;
    if (typeof data.y === "number" && Number.isFinite(data.y)) p.y = data.y;
    if (typeof data.angle === "number" && Number.isFinite(data.angle)) p.angle = data.angle;
    if (typeof data.elevation === "number" && Number.isFinite(data.elevation)) p.elevation = data.elevation;
    if (typeof data.name === "string" && data.name.trim()) {
      p.name = data.name.trim().slice(0, 16);
    }
    if (data.inCarId !== undefined) {
      p.inCarId = data.inCarId || null;
    }

    socket.to(currentRoom).emit("player:move", p);
  });

  socket.on("car:toggle", () => {
    const state = rooms[currentRoom];
    const p = state.players[socket.id];
    if (!p) return;

    if (p.inCarId && state.cars[p.inCarId]) {
      const car = state.cars[p.inCarId];
      car.driverId = null;
      car.speed = 0;
      p.inCarId = null;
      io.to(currentRoom).emit("car:update", car);
      io.to(currentRoom).emit("player:update", p);
      return;
    }

    let bestCar = null;
    let bestDist = 18;
    for (const id of Object.keys(state.cars)) {
      const car = state.cars[id];
      if (car.driverId) continue;
      const dist = Math.hypot(car.x - p.x, car.y - p.y);
      if (dist < bestDist) {
        bestDist = dist;
        bestCar = car;
      }
    }

    if (bestCar) {
      bestCar.driverId = socket.id;
      p.inCarId = bestCar.id;
      p.x = bestCar.x;
      p.y = bestCar.y;
      io.to(currentRoom).emit("car:update", bestCar);
      io.to(currentRoom).emit("player:update", p);
    }
  });

  socket.on("car:drive", (data) => {
    const state = rooms[currentRoom];
    const p = state.players[socket.id];
    if (!p || !p.inCarId || !state.cars[p.inCarId] || !data) return;

    const car = state.cars[p.inCarId];
    if (car.driverId !== socket.id) return;

    if (typeof data.x === "number" && Number.isFinite(data.x)) {
      car.x = data.x;
      p.x = data.x;
    }
    if (typeof data.y === "number" && Number.isFinite(data.y)) {
      car.y = data.y;
      p.y = data.y;
    }
    if (typeof data.angle === "number" && Number.isFinite(data.angle)) {
      car.angle = data.angle;
      p.angle = data.angle;
    }
    if (typeof data.speed === "number" && Number.isFinite(data.speed)) {
      car.speed = data.speed;
    }
    if (typeof data.altitude === "number" && Number.isFinite(data.altitude)) {
      car.altitude = data.altitude;
    }
    if (typeof data.pitch === "number" && Number.isFinite(data.pitch)) {
      car.pitch = data.pitch;
    }
    if (typeof data.roll === "number" && Number.isFinite(data.roll)) {
      car.roll = data.roll;
    }

    socket.to(currentRoom).emit("car:drive", car);
  });

  socket.on("chat:msg", (data) => {
    const state = rooms[currentRoom];
    const p = state.players[socket.id];
    const text = data && typeof data.text === "string" ? data.text.trim().slice(0, 110) : "";
    if (!text) return;

    const name =
      (data && typeof data.name === "string" && data.name.trim().slice(0, 16)) ||
      (p && p.name) ||
      "Jogador";

    if (p) p.name = name;
    io.to(currentRoom).emit("chat:msg", { id: socket.id, name, text });
  });

  socket.on("disconnect", () => {
    const state = rooms[currentRoom];
    const released = releaseDriver(state, socket.id);
    if (released) io.to(currentRoom).emit("car:update", released);
    delete state.players[socket.id];
    socket.to(currentRoom).emit("player:leave", socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor GTA X rodando na porta ${PORT}`);
});
