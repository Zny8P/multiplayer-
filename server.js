const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;

// Servidor HTTP.
// No desenvolvimento local ele continua servindo o index.html.
// Quando colocarmos o frontend no Netlify, essa parte deixa de ser necessária,
// mas podemos mantê-la para facilitar os testes locais.

const server = http.createServer((req, res) => {
  const file = path.join(__dirname, "index.html");

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("index.html não encontrado");
    }

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8"
    });

    res.end(data);
  });
});

// WebSocket
const wss = new WebSocket.Server({ server });

const players = new Map();

let nextId = 1;

// Tamanho lógico do mapa
const WORLD_WIDTH = 800;
const WORLD_HEIGHT = 600;

const PLAYER_SIZE = 30;
const SPEED = 4;

function createPlayer(id) {
  return {
    id,

    x: Math.random() * (WORLD_WIDTH - PLAYER_SIZE),
    y: Math.random() * (WORLD_HEIGHT - PLAYER_SIZE),

    color: `hsl(${Math.random() * 360}, 80%, 60%)`,

    // Estado dos controles
    input: {
      up: false,
      down: false,
      left: false,
      right: false
    }
  };
}

function getPublicPlayers() {
  return [...players.values()].map(player => ({
    id: player.id,
    x: player.x,
    y: player.y,
    color: player.color
  }));
}

function broadcast(data) {
  const message = JSON.stringify(data);

  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

wss.on("connection", ws => {
  const id = String(nextId++);

  const player = createPlayer(id);

  players.set(id, player);

  console.log(`Jogador ${id} entrou.`);

  // Envia as informações iniciais para o jogador
  ws.send(JSON.stringify({
    type: "init",
    id,
    players: getPublicPlayers(),
    world: {
      width: WORLD_WIDTH,
      height: WORLD_HEIGHT
    }
  }));

  // Atualiza todos
  broadcast({
    type: "players",
    players: getPublicPlayers()
  });

  ws.on("message", message => {
    try {
      const data = JSON.parse(message);

      const player = players.get(id);

      if (!player) return;

      // Cliente envia apenas o estado dos controles.
      // O servidor calcula a posição.
      if (data.type === "input") {
        player.input.up = !!data.up;
        player.input.down = !!data.down;
        player.input.left = !!data.left;
        player.input.right = !!data.right;
      }

    } catch (error) {
      console.log("Mensagem inválida recebida.");
    }
  });

  ws.on("close", () => {
    players.delete(id);

    console.log(`Jogador ${id} saiu.`);

    broadcast({
      type: "players",
      players: getPublicPlayers()
    });
  });

  ws.on("error", () => {
    players.delete(id);
  });
});

// Loop do servidor.
// O servidor calcula as posições dos jogadores.
setInterval(() => {

  for (const player of players.values()) {

    if (player.input.up) {
      player.y -= SPEED;
    }

    if (player.input.down) {
      player.y += SPEED;
    }

    if (player.input.left) {
      player.x -= SPEED;
    }

    if (player.input.right) {
      player.x += SPEED;
    }

    // Limites do mapa
    player.x = Math.max(
      0,
      Math.min(WORLD_WIDTH - PLAYER_SIZE, player.x)
    );

    player.y = Math.max(
      0,
      Math.min(WORLD_HEIGHT - PLAYER_SIZE, player.y)
    );
  }

  // Envia as posições atualizadas
  if (players.size > 0) {
    broadcast({
      type: "players",
      players: getPublicPlayers()
    });
  }

}, 1000 / 30); // 30 atualizações por segundo

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
