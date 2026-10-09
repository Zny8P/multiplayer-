const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  const file = path.join(__dirname, "index.html");

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("index.html não encontrado");
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });
const players = new Map();
const clients = new Map(); // id -> ws

let nextId = 1;

// Mapa expandido para 2000x2000
const WORLD_WIDTH = 2000;
const WORLD_HEIGHT = 2000;

const PLAYER_SIZE = 30;
const SPEED = 5;

// Geração de Arbustos Low-Poly fixos
const BUSHES_COUNT = 35;
const bushes = [];

function generateBushes() {
  for (let i = 0; i < BUSHES_COUNT; i++) {
    const radius = 45 + Math.random() * 25;
    const x = radius + Math.random() * (WORLD_WIDTH - radius * 2);
    const y = radius + Math.random() * (WORLD_HEIGHT - radius * 2);

    // Gera vértices para o visual low-poly
    const pointsCount = 6 + Math.floor(Math.random() * 3);
    const points = [];
    for (let j = 0; j < pointsCount; j++) {
      const angle = (j / pointsCount) * Math.PI * 2;
      const r = radius * (0.8 + Math.random() * 0.4);
      points.push({
        x: Math.cos(angle) * r,
        y: Math.sin(angle) * r
      });
    }

    bushes.push({
      id: i + 1,
      x,
      y,
      radius,
      points
    });
  }
}
generateBushes();

function createPlayer(id) {
  return {
    id,
    x: Math.random() * (WORLD_WIDTH - PLAYER_SIZE),
    y: Math.random() * (WORLD_HEIGHT - PLAYER_SIZE),
    angle: 0,
    color: `hsl(${Math.random() * 360}, 80%, 60%)`,
    inBush: null,
    input: {
      up: false,
      down: false,
      left: false,
      right: false,
      angle: 0
    }
  };
}

// Filtra jogadores visíveis para um cliente específico
function getVisiblePlayersFor(recipientId) {
  const result = [];
  for (const player of players.values()) {
    // O próprio jogador sempre se vê.
    // Inimigos só aparecem se NÃO estiverem dentro de um arbusto.
    if (player.id === recipientId || player.inBush === null) {
      result.push({
        id: player.id,
        x: player.x,
        y: player.y,
        angle: player.angle,
        color: player.color,
        inBush: player.inBush
      });
    }
  }
  return result;
}

// Retorna lista de IDs de arbustos que contêm ao menos um jogador
function getActiveBushIds() {
  const activeSet = new Set();
  for (const player of players.values()) {
    if (player.inBush !== null) {
      activeSet.add(player.inBush);
    }
  }
  return Array.from(activeSet);
}

wss.on("connection", ws => {
  const id = String(nextId++);
  const player = createPlayer(id);

  players.set(id, player);
  clients.set(id, ws);

  console.log(`Jogador ${id} entrou.`);

  // Dados iniciais
  ws.send(JSON.stringify({
    type: "init",
    id,
    players: getVisiblePlayersFor(id),
    world: { width: WORLD_WIDTH, height: WORLD_HEIGHT },
    bushes
  }));

  ws.on("message", message => {
    try {
      const data = JSON.parse(message);
      const player = players.get(id);
      if (!player) return;

      if (data.type === "input") {
        player.input.up = !!data.up;
        player.input.down = !!data.down;
        player.input.left = !!data.left;
        player.input.right = !!data.right;

        if (typeof data.angle === "number") {
          player.angle = data.angle;
        }
      }
    } catch (error) {
      console.log("Mensagem inválida.");
    }
  });

  ws.on("close", () => {
    players.delete(id);
    clients.delete(id);
    console.log(`Jogador ${id} saiu.`);
  });

  ws.on("error", () => {
    players.delete(id);
    clients.delete(id);
  });
});

// Loop principal do servidor (30 FPS)
setInterval(() => {
  for (const player of players.values()) {
    if (player.input.up) player.y -= SPEED;
    if (player.input.down) player.y += SPEED;
    if (player.input.left) player.x -= SPEED;
    if (player.input.right) player.x += SPEED;

    // Limites do mundo
    player.x = Math.max(0, Math.min(WORLD_WIDTH - PLAYER_SIZE, player.x));
    player.y = Math.max(0, Math.min(WORLD_HEIGHT - PLAYER_SIZE, player.y));

    // Verificação de arbusto (centro do personagem)
    const px = player.x + PLAYER_SIZE / 2;
    const py = player.y + PLAYER_SIZE / 2;
    let insideBushId = null;

    for (const bush of bushes) {
      const dx = px - bush.x;
      const dy = py - bush.y;
      if (dx * dx + dy * dy <= bush.radius * bush.radius) {
        insideBushId = bush.id;
        break;
      }
    }
    player.inBush = insideBushId;
  }

  // Envia atualização personalizada para cada cliente
  const activeBushes = getActiveBushIds();
  for (const [id, ws] of clients.entries()) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "players",
        players: getVisiblePlayersFor(id),
        activeBushes
      }));
    }
  }
}, 1000 / 30);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
