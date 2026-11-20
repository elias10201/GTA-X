const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Lista de jogadores online (sem carros nem NPCs por enquanto)
const players = {};

app.get('/', (req, res) => {
  res.send('Servidor GTA-X Online! Jogadores ativos: ' + Object.keys(players).length);
});

io.on('connection', (socket) => {
  console.log('Jogador conectado:', socket.id);

  // Cria o boneco na posição inicial
  players[socket.id] = {
    id: socket.id,
    x: 0,
    y: 0,
    z: 0,
    rotY: 0
  };

  // Envia todos os jogadores atuais para quem acabou de entrar
  socket.emit('currentPlayers', players);

  // Avisa os outros que um novo jogador entrou
  socket.broadcast.emit('newPlayer', players[socket.id]);

  // Atualiza posição e rotação quando o jogador anda
  socket.on('playerMovement', (data) => {
    if (players[socket.id]) {
      players[socket.id].x = data.x;
      players[socket.id].y = data.y;
      players[socket.id].z = data.z;
      players[socket.id].rotY = data.rotY;
      socket.broadcast.emit('playerMoved', players[socket.id]);
    }
  });

  // Remove o boneco quando desconectar
  socket.on('disconnect', () => {
    console.log('Jogador saiu:', socket.id);
    delete players[socket.id];
    io.emit('playerDisconnected', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor GTA-X rodando na porta ${PORT}`);
});
