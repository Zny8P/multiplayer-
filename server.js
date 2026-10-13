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

const wss = new WebSocket.Server({ server, maxPayload: 512 });
const players = new Map();
const clients = new Map();
let bullets = [];

let nextId = 1;
let nextBulletId = 1;

const WORLD_WIDTH = 2000;
const WORLD_HEIGHT = 2000;
const PLAYER_SIZE = 30;
const SPEED = 5;

const BULLET_SPEED = 18;
const BULLET_DAMAGE = 10;
const SHOT_COOLDOWN = 500;
const RELOAD_TIME = 1500;
const REVEAL_TIME = 1500;

const MAX_MESSAGE_SIZE = 512;
const MIN_INPUT_INTERVAL = 20;
const MIN_RESPAWN_INTERVAL = 500;

function normalizeAngle(angle) {
  const TWO_PI = Math.PI * 2;
  let norm = angle % TWO_PI;
  if (norm < 0) norm += TWO_PI;
  return norm;
}

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

function removePlayer(id) {
  if (!id) return;
  if (players.has(id) || clients.has(id)) {
    players.delete(id);
    clients.delete(id);
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
    lastInputTime: 0,
    reloadTriggered: false,
    input: {
      moveX: 0,
      moveY: 0,
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
  let hasJoined = false;
  let lastRespawnTime = 0;

  function cleanup() {
    if (id) {
      const playerId = id;
      id = null;
      removePlayer(playerId);
    }
  }

  ws.on("message", message => {
    try {
      if (typeof message !== "string" && !Buffer.isBuffer(message)) return;
      if (message.length > MAX_MESSAGE_SIZE) return;

      const data = JSON.parse(message);
      if (typeof data !== "object" || data === null) return;
      if (typeof data.type !== "string") return;

      const now = Date.now();

      if (data.type === "join") {
        if (id || hasJoined) return;
        hasJoined = true;

        id = String(nextId++);

        let cleanName = typeof data.name === "string" ? data.name.trim() : "Jogador";
        if (cleanName.length === 0) cleanName = "Jogador";
        if (cleanName.length > 20) {
          cleanName = cleanName.slice(0, 20);
        }

        const player = createPlayer(id, cleanName);
        players.set(id, player);
        clients.set(id, ws);

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
        if (player.isDead) return;

        if (now - player.lastInputTime < MIN_INPUT_INTERVAL) {
          return;
        }

        player.lastInputTime = now;

        const candidateInput = { ...player.input };
        let candidateAngle = player.angle;
        let candidateReloadTrigger = false;

        if (data.moveX !== undefined) {
          if (typeof data.moveX !== "number" || !Number.isFinite(data.moveX)) return;
          candidateInput.moveX = Math.max(-1, Math.min(1, data.moveX));
        }
        if (data.moveY !== undefined) {
          if (typeof data.moveY !== "number" || !Number.isFinite(data.moveY)) return;
          candidateInput.moveY = Math.max(-1, Math.min(1, data.moveY));
        }
        if (data.shoot !== undefined) {
          if (typeof data.shoot !== "boolean") return;
          candidateInput.shoot = data.shoot;
        }
        if (data.reload !== undefined) {
          if (typeof data.reload !== "boolean") return;
          candidateInput.reload = data.reload;
          if (data.reload) {
            candidateReloadTrigger = true;
          }
        }
        if (data.angle !== undefined) {
          if (typeof data.angle !== "number" || !Number.isFinite(data.angle)) return;
          candidateAngle = normalizeAngle(data.angle);
        }

        player.input = candidateInput;
        player.angle = candidateAngle;

        if (candidateReloadTrigger && !player.isDead && !player.isReloading && player.ammo < player.maxAmmo && !player.reloadTriggered) {
          player.reloadTriggered = true;
        }
        return;
      }

      if (data.type === "respawn") {
        if (!player.isDead) return;
        if (now - lastRespawnTime < MIN_RESPAWN_INTERVAL) return;
        lastRespawnTime = now;

        player.isDead = false;
        player.hp = player.maxHp;
        player.ammo = player.maxAmmo;
        player.isReloading = false;
        player.reloadEndTime = 0;
        player.lastShotTime = 0;
        player.revealedUntil = 0;
        player.inBush = null;
        player.wasShooting = true;
        player.reloadTriggered = false;

        player.input = {
          moveX: 0,
          moveY: 0,
          angle: player.angle,
          shoot: false,
          reload: false
        };

        player.x = Math.random() * (WORLD_WIDTH - PLAYER_SIZE);
        player.y = Math.random() * (WORLD_HEIGHT - PLAYER_SIZE);
        return;
      }

    } catch (error) {}
  });

  ws.on("close", cleanup);
  ws.on("error", cleanup);
});

let lastLoopTime = Date.now();

setInterval(() => {
  const now = Date.now();
  let dt = (now - lastLoopTime) / 1000;
  lastLoopTime = now;
  dt = Math.min(dt, 0.1);

  const playersArr = Array.from(players.values());

  for (const player of playersArr) {
    if (player.isDead) continue;

    let moveX = player.input.moveX || 0;
    let moveY = player.input.moveY || 0;

    const mag = Math.sqrt(moveX * moveX + moveY * moveY);
    if (mag > 1) {
      moveX /= mag;
      moveY /= mag;
    }

    const frameFactor = dt * 30;
    player.x += moveX * SPEED * frameFactor;
    player.y += moveY * SPEED * frameFactor;

    player.x = Math.max(0, Math.min(WORLD_WIDTH - PLAYER_SIZE, player.x));
    player.y = Math.max(0, Math.min(WORLD_HEIGHT - PLAYER_SIZE, player.y));
  }

  const collisionIterations = 3;
  const radius = PLAYER_SIZE / 2;
  const minDist = PLAYER_SIZE;

  function clampPosition(p) {
    p.x = Math.max(0, Math.min(WORLD_WIDTH - PLAYER_SIZE, p.x));
    p.y = Math.max(0, Math.min(WORLD_HEIGHT - PLAYER_SIZE, p.y));
  }

  for (let iter = 0; iter < collisionIterations; iter++) {
    for (let i = 0; i < playersArr.length; i++) {
      const p1 = playersArr[i];
      if (p1.isDead) continue;
      const c1x = p1.x + radius;
      const c1y = p1.y + radius;

      for (let j = i + 1; j < playersArr.length; j++) {
        const p2 = playersArr[j];
        if (p2.isDead) continue;
        const c2x = p2.x + radius;
        const c2y = p2.y + radius;

        let dx = c2x - c1x;
        let dy = c2y - c1y;
        let distSq = dx * dx + dy * dy;

        let nx = 0;
        let ny = 0;
        let overlap = 0;

        if (distSq < minDist * minDist && distSq > 0) {
          let dist = Math.sqrt(distSq);
          overlap = minDist - dist;
          nx = dx / dist;
          ny = dy / dist;
        } else if (distSq === 0) {
          overlap = minDist;
          const angle = (i * 13 + j * 17) % (Math.PI * 2);
          nx = Math.cos(angle);
          ny = Math.sin(angle);
        }

        if (overlap > 0) {
          p1.x -= nx * (overlap * 0.5);
          p1.y -= ny * (overlap * 0.5);
          clampPosition(p1);

          p2.x += nx * (overlap * 0.5);
          p2.y += ny * (overlap * 0.5);
          clampPosition(p2);
        }
      }
    }
  }

  for (const player of players.values()) {
    if (player.isDead) continue;

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

    if (player.reloadTriggered) {
      player.reloadTriggered = false;
      if (!player.isDead && !player.isReloading && player.ammo < player.maxAmmo) {
        player.isReloading = true;
        player.reloadEndTime = now + RELOAD_TIME;
      }
    }

    if (player.isReloading) {
      if (now >= player.reloadEndTime) {
        player.ammo = player.maxAmmo;
        player.isReloading = false;
      }
    }

    const isShootTriggered = player.input.shoot && !player.wasShooting;
    player.wasShooting = player.input.shoot;

    if (isShootTriggered) {
      if (!player.isDead && !player.isReloading && player.ammo > 0 && (now - player.lastShotTime >= SHOT_COOLDOWN)) {
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
          player.reloadTriggered = false;
        }
      }
    }
  }

  const bulletFrameFactor = dt * 30;

  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    const stepDist = BULLET_SPEED * bulletFrameFactor;

    b.x += b.vx * bulletFrameFactor;
    b.y += b.vy * bulletFrameFactor;
    b.travelled += stepDist;

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

            target.isReloading = false;
            target.reloadEndTime = 0;
            target.revealedUntil = 0;
            target.inBush = null;
            target.reloadTriggered = false;
            target.input.moveX = 0;
            target.input.moveY = 0;
            target.input.shoot = false;
            target.input.reload = false;
          }
          hit = type = true; // Mantém a compatibilidade de remoção
          break;
        }
      }
    }

    if (hit) {
      bullets.splice(i, 1);
    }
  }

  // Identifica quais arbustos têm jogadores vivos a ocupá-los (activeBushes)
  const activeBushesSet = new Set();
  for (const player of players.values()) {
    if (!player.isDead && player.inBush !== null) {
      activeBushesSet.add(player.inBush);
    }
  }
  const activeBushes = Array.from(activeBushesSet);

  const publicBullets = bullets.map(b => ({ x: Math.round(b.x), y: Math.round(b.y) }));

  for (const [id, ws] of clients.entries()) {
    if (ws.readyState === WebSocket.OPEN) {
      const p = players.get(id);
      ws.send(JSON.stringify({
        type: "state",
        players: getVisiblePlayersFor(id, now),
        bullets: publicBullets,
        activeBushes: activeBushes,
        self: p ? {
          hp: p.hp,
          maxHp: p.maxHp,
          ammo: p.ammo,
          maxAmmo: p.maxAmmo,
          isReloading: p.isReloading,
          isDead: p.isDead
        } : null
      }));
    } else if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
      removePlayer(id);
    }
  }
}, 1000 / 30);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
