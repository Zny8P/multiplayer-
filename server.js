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
const clients = new Map();
let bullets = [];

let nextId = 1;
let nextBulletId = 1;

// Configurações do Mundo
const WORLD_WIDTH = 2000;
const WORLD_HEIGHT = 2000;
const PLAYER_SIZE = 30;
const SPEED = 5;

// Configurações da Arma
const BULLET_SPEED = 18;
const BULLET_DAMAGE = 10;
const SHOT_COOLDOWN = 500; // 0.5s por tiro
const RELOAD_TIME = 1500;   // 1.5s recarga
const REVEAL_TIME = 1500;   // 1.5s revelação na moita

// Arbustos
const BUSHES_COUNT = 35;
const bushes = [];

function generateBushes() {
  for (let i = 0; i < BUSHES_COUNT; i++) {
    const radius = 45 + Math.random() * 25;
    const x = radius + Math.random() * (WORLD_WIDTH - radius * 2);
    const y = radius + Math.random() * (WORLD_HEIGHT - radius * 2);

    const pointsCount = 6 + Math.floor(Math.random() * 3);
    const points = [];
    for (let j = 0; j < pointsCount; j++) {
      const angle = (j / pointsCount) * Math.PI * 2;
      const r = radius * (0.8 + Math.random() * 0.4);
      points.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r });
    }

    bushes.push({ id: i + 1, x, y, radius, points });
  }
}
generateBushes();

// Mecanismo Único e Idempotente de Limpeza de Jogadores
function removePlayer(id) {
  if (!id) return;
  if (players.has(id) || clients.has(id)) {
    players.delete(id);
    clients.delete(id);
    console.log(`Jogador ${id} desconectado e removido.`);
  }
}

function createPlayer(id, name) {
  return {
    id,
    name: name || `Jogador ${id}`,
    x: Math.random() * (WORLD_WIDTH - PLAYER_SIZE),
    y: Math.random() * (WORLD_HEIGHT - PLAYER_SIZE),
    angle: 0,
    hp: 200,
    maxHp: 200,
    ammo: 10,
    maxAmmo: 10,
    isReloading: false,
    reloadEndTime: 0,
    lastShotTime: 0,
    revealedUntil: 0,
    isDead: false,
    color: `hsl(${Math.random() * 360}, 80%, 60%)`,
    inBush: null,
    wasShooting: false,
    input: {
      up: false,
      down: false,
      left: false,
      right: false,
      angle: 0,
      shoot: false,
      reload: false
    }
  };
}

function getVisiblePlayersFor(recipientId, now) {
  const result = [];
  for (const player of players.values()) {
    if (player.isDead) continue;

    const isRevealed = now < player.revealedUntil;
    if (player.id === recipientId || player.inBush === null || isRevealed) {
      result.push({
        id: player.id,
        name: player.name,
        x: player.x,
        y: player.y,
        angle: player.angle,
        hp: player.hp,
        maxHp: player.maxHp,
        color: player.color,
        inBush: player.inBush
      });
    }
  }
  return result;
}

wss.on("connection", ws => {
  let id = null;

  function cleanup() {
    if (id) {
      const playerId = id;
      id = null;
      removePlayer(playerId);
    }
  }

  ws.on("message", message => {
    try {
      const data = JSON.parse(message);

      // Validação: Garante que a mensagem parsed seja um objeto não-nulo
      if (typeof data !== "object" || data === null) return;

      if (data.type === "join") {
        if (id) return; // Impede registros duplicados na mesma conexão

        id = String(nextId++);

        // Validação e sanitização do nome: máximo 20 caracteres e sem espaços em branco extras
        let cleanName = typeof data.name === "string" ? data.name.trim() : "";
        if (cleanName.length > 20) {
          cleanName = cleanName.slice(0, 20);
        }

        const player = createPlayer(id, cleanName);
        players.set(id, player);
        clients.set(id, ws);

        console.log(`Jogador ${player.name} (${id}) entrou.`);

        ws.send(JSON.stringify({
          type: "init",
          id,
          world: { width: WORLD_WIDTH, height: WORLD_HEIGHT },
          bushes
        }));
        return;
      }

      if (!id) return;
      const player = players.get(id);
      if (!player) return;

      if (data.type === "input") {
        // Aceita apenas valores do tipo booleano real; outros tipos são ignorados
        if (typeof data.up === "boolean") player.input.up = data.up;
        if (typeof data.down === "boolean") player.input.down = data.down;
        if (typeof data.left === "boolean") player.input.left = data.left;
        if (typeof data.right === "boolean") player.input.right = data.right;
        if (typeof data.shoot === "boolean") player.input.shoot = data.shoot;
        if (typeof data.reload === "boolean") player.input.reload = data.reload;

        // Validação estrita do ângulo: aceita apenas números finitos reais
        if (typeof data.angle === "number" && Number.isFinite(data.angle)) {
          player.angle = data.angle;
        }
        return;
      }

      if (data.type === "respawn") {
        if (player.isDead) {
          player.isDead = false;
          player.hp = player.maxHp;
          player.ammo = player.maxAmmo;
          player.isReloading = false;
          player.x = Math.random() * (WORLD_WIDTH - PLAYER_SIZE);
          player.y = Math.random() * (WORLD_HEIGHT - PLAYER_SIZE);
        }
        return;
      }

    } catch (error) {
      // Ignora com segurança mensagens que não sejam JSONs válidos
    }
  });

  ws.on("close", cleanup);
  ws.on("error", cleanup);
});

// Loop principal (30 FPS)
setInterval(() => {
  const now = Date.now();

  for (const player of players.values()) {
    if (player.isDead) continue;

    // Movimentação
    if (player.input.up) player.y -= SPEED;
    if (player.input.down) player.y += SPEED;
    if (player.input.left) player.x -= SPEED;
    if (player.input.right) player.x += SPEED;

    player.x = Math.max(0, Math.min(WORLD_WIDTH - PLAYER_SIZE, player.x));
    player.y = Math.max(0, Math.min(WORLD_HEIGHT - PLAYER_SIZE, player.y));

    // Arbusto
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

    // Recarga
    if (player.input.reload && !player.isReloading && player.ammo < player.maxAmmo) {
      player.isReloading = true;
      player.reloadEndTime = now + RELOAD_TIME;
    }

    if (player.isReloading) {
      if (now >= player.reloadEndTime) {
        player.ammo = player.maxAmmo;
        player.isReloading = false;
      }
    }

    // Disparo
    const isShootTriggered = player.input.shoot && !player.wasShooting;
    player.wasShooting = player.input.shoot;

    if (isShootTriggered && !player.isReloading) {
      if (player.ammo > 0 && now - player.lastShotTime >= SHOT_COOLDOWN) {
        player.ammo--;
        player.lastShotTime = now;

        if (player.inBush !== null) {
          player.revealedUntil = now + REVEAL_TIME;
        }

        const spawnX = px + Math.cos(player.angle) * (PLAYER_SIZE / 2 + 6);
        const spawnY = py + Math.sin(player.angle) * (PLAYER_SIZE / 2 + 6);

        bullets.push({
          id: nextBulletId++,
          ownerId: player.id,
          x: spawnX,
          y: spawnY,
          vx: Math.cos(player.angle) * BULLET_SPEED,
          vy: Math.sin(player.angle) * BULLET_SPEED,
          travelled: 0,
          maxDistance: 1200
        });

        if (player.ammo === 0) {
          player.isReloading = true;
          player.reloadEndTime = now + RELOAD_TIME;
        }
      }
    }
  }

  // Colisões de Tiros
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.x += b.vx;
    b.y += b.vy;
    b.travelled += BULLET_SPEED;

    let hit = false;

    if (b.x < 0 || b.x > WORLD_WIDTH || b.y < 0 || b.y > WORLD_HEIGHT || b.travelled >= b.maxDistance) {
      hit = true;
    } else {
      for (const target of players.values()) {
        if (target.isDead || target.id === b.ownerId) continue;

        const tx = target.x + PLAYER_SIZE / 2;
        const ty = target.y + PLAYER_SIZE / 2;
        const dx = b.x - tx;
        const dy = b.y - ty;

        if (dx * dx + dy * dy <= (PLAYER_SIZE / 2 + 4) * (PLAYER_SIZE / 2 + 4)) {
          target.hp -= BULLET_DAMAGE;
          if (target.hp <= 0) {
            target.hp = 0;
            target.isDead = true;
          }
          hit = true;
          break;
        }
      }
    }

    if (hit) {
      bullets.splice(i, 1);
    }
  }

  // Broadcast de Estado
  const activeBushesList = [];
  for (const player of players.values()) {
    if (!player.isDead && player.inBush !== null) {
      activeBushesList.push(player.inBush);
    }
  }

  const publicBullets = bullets.map(b => ({ x: Math.round(b.x), y: Math.round(b.y) }));

  for (const [id, ws] of clients.entries()) {
    if (ws.readyState === WebSocket.OPEN) {
      const p = players.get(id);
      ws.send(JSON.stringify({
        type: "state",
        players: getVisiblePlayersFor(id, now),
        bullets: publicBullets,
        activeBushes: activeBushesList,
        self: p ? {
          hp: p.hp,
          maxHp: p.maxHp,
          ammo: p.ammo,
          maxAmmo: p.maxAmmo,
          isReloading: p.isReloading,
          isDead: p.isDead
        } : null
      }));
    } else if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      removePlayer(id);
    }
  }
}, 1000 / 30);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
