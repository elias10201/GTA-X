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
  const candidates = ["Index.html", "index.html"];
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
  res.status(404).send("Index.html não encontrado.");
});

const players = {};

const cars = {
  carro_1: { id: "carro_1", x: 24, y: 50, angle: 0, speed: 0, driverId: null },
  carro_2: { id: "carro_2", x: 40, y: 10, angle: Math.PI, speed: 0, driverId: null },
  carro_3: { id: "carro_3", x: 74, y: 38, angle: Math.PI / 2, speed: 0, driverId: null },
  carro_4: { id: "carro_4", x: -8, y: 38, angle: -Math.PI / 2, speed: 0, driverId: null }
};

io.on("connection", (socket) => {
  players[socket.id] = {
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
    players,
    cars
  });

  socket.broadcast.emit("player:join", players[socket.id]);

  socket.on("player:move", (data) => {
    const p = players[socket.id];
    if (!p || !data) return;

    if (typeof data.x === "number") p.x = data.x;
    if (typeof data.y === "number") p.y = data.y;
    if (typeof data.angle === "number") p.angle = data.angle;
    if (typeof data.elevation === "number") p.elevation = data.elevation;
    if (typeof data.name === "string" && data.name.trim()) {
      p.name = data.name.trim().slice(0, 16);
    }
    if (data.inCarId !== undefined) {
      p.inCarId = data.inCarId || null;
    }

    socket.broadcast.emit("player:move", p);
  });

  socket.on("car:toggle", () => {
    const p = players[socket.id];
    if (!p) return;

    if (p.inCarId && cars[p.inCarId]) {
      const car = cars[p.inCarId];
      car.driverId = null;
      car.speed = 0;
      p.inCarId = null;
      io.emit("car:update", car);
      io.emit("player:update", p);
      return;
    }

    let bestCar = null;
    let bestDist = 18;
    for (const id of Object.keys(cars)) {
      const car = cars[id];
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
      io.emit("car:update", bestCar);
      io.emit("player:update", p);
    }
  });

  socket.on("car:drive", (data) => {
    const p = players[socket.id];
    if (!p || !p.inCarId || !cars[p.inCarId] || !data) return;

    const car = cars[p.inCarId];
    if (car.driverId !== socket.id) return;

    if (typeof data.x === "number") {
      car.x = data.x;
      p.x = data.x;
    }
    if (typeof data.y === "number") {
      car.y = data.y;
      p.y = data.y;
    }
    if (typeof data.angle === "number") {
      car.angle = data.angle;
      p.angle = data.angle;
    }
    if (typeof data.speed === "number") {
      car.speed = data.speed;
    }
    if (typeof data.altitude === "number") {
      car.altitude = data.altitude;
    }
    if (typeof data.pitch === "number") {
      car.pitch = data.pitch;
    }
    if (typeof data.roll === "number") {
      car.roll = data.roll;
    }

    socket.broadcast.emit("car:drive", car);
  });

  socket.on("chat:msg", (data) => {
    const p = players[socket.id];
    const text = data && typeof data.text === "string" ? data.text.trim().slice(0, 110) : "";
    if (!text) return;

    const name =
      (data && typeof data.name === "string" && data.name.trim().slice(0, 16)) ||
      (p && p.name) ||
      "Jogador";

    if (p) p.name = name;
    io.emit("chat:msg", { id: socket.id, name, text });
  });

  socket.on("disconnect", () => {
    const p = players[socket.id];
    if (p && p.inCarId && cars[p.inCarId]) {
      const car = cars[p.inCarId];
      car.driverId = null;
      car.speed = 0;
      io.emit("car:update", car);
    }
    delete players[socket.id];
    io.emit("player:leave", socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor GTA X rodando na porta ${PORT}`);
});
