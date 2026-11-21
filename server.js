const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());

const dirAtual = __dirname;
const dirAcima = path.join(__dirname, "..");

app.use(express.static(dirAtual));
app.use(express.static(dirAcima));

app.get("/", (req, res) => {
  const candidatos = [
    path.join(dirAtual, "index.html"),
    path.join(dirAcima, "index.html")
  ];

  const htmlEncontrado = candidatos.find((p) => fs.existsSync(p));
  if (htmlEncontrado) {
    return res.sendFile(htmlEncontrado);
  }

  res.status(200).send("Servidor multiplayer rodando! (Nenhum index.html encontrado na pasta)");
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Sem NPCs: apenas jogadores e carros estacionados
const players = {};

const cars = {
  carro_1: { id: "carro_1", x: 260, y: 180, angle: 0, speed: 0, driverId: null },
  carro_2: { id: "carro_2", x: 540, y: 220, angle: 1.57, speed: 0, driverId: null },
  carro_3: { id: "carro_3", x: 380, y: 460, angle: 3.14, speed: 0, driverId: null }
};

io.on("connection", (socket) => {
  players[socket.id] = {
    id: socket.id,
    x: 150,
    y: 150,
    angle: 0,
    inCarId: null
  };

  socket.emit("init", { myId: socket.id, players, cars });
  socket.broadcast.emit("player:join", players[socket.id]);

  socket.on("player:move", (data) => {
    const p = players[socket.id];
    if (!p || p.inCarId) return;
    p.x = data.x;
    p.y = data.y;
    p.angle = data.angle;
    socket.broadcast.emit("player:move", p);
  });

  socket.on("car:toggle", () => {
    const p = players[socket.id];
    if (!p) return;

    if (p.inCarId) {
      const car = cars[p.inCarId];
      if (car && car.driverId === socket.id) {
        car.driverId = null;
        car.speed = 0;
        p.x = car.x + 32;
        p.y = car.y;
        p.inCarId = null;
        io.emit("car:update", car);
        io.emit("player:update", p);
      }
      return;
    }

    const freeCar = Object.values(cars).find(
      (c) => c.driverId === null && Math.hypot(c.x - p.x, c.y - p.y) < 60
    );

    if (freeCar) {
      freeCar.driverId = socket.id;
      p.inCarId = freeCar.id;
      p.x = freeCar.x;
      p.y = freeCar.y;
      io.emit("car:update", freeCar);
      io.emit("player:update", p);
    }
  });

  socket.on("car:drive", (data) => {
    const p = players[socket.id];
    const car = p && p.inCarId ? cars[p.inCarId] : null;
    if (!car || car.driverId !== socket.id) return;

    car.x = data.x;
    car.y = data.y;
    car.angle = data.angle;
    car.speed = data.speed;
    p.x = data.x;
    p.y = data.y;
    p.angle = data.angle;

    socket.broadcast.emit("car:drive", car);
  });

  socket.on("disconnect", () => {
    const p = players[socket.id];
    if (p && p.inCarId && cars[p.inCarId] && cars[p.inCarId].driverId === socket.id) {
      cars[p.inCarId].driverId = null;
      cars[p.inCarId].speed = 0;
      io.emit("car:update", cars[p.inCarId]);
    }
    delete players[socket.id];
    socket.broadcast.emit("player:leave", socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Servidor rodando na porta " + PORT);
});
