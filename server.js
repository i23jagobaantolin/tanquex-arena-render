'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { WebSocket, WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.resolve(__dirname, 'public');
const MAX_COORD = 100000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm',
};

function reply(res, status, message, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType, 'X-Content-Type-Options': 'nosniff' });
  res.end(message);
}

function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return reply(res, 405, 'Method Not Allowed');
  }

  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { return reply(res, 400, 'Bad Request'); }

  if (pathname === '/healthz') {
    const active = [...players.values()].filter((player) => player.active).length;
    return reply(res, 200, JSON.stringify({ ok: true, players: players.size, activePlayers: active }), 'application/json; charset=utf-8');
  }

  const relative = pathname.replace(/^\/+/, '') || 'index.html';
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) return reply(res, 403, 'Forbidden');

  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) return reply(res, 404, 'Archivo no encontrado.');
    const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': ['.html', '.js'].includes(path.extname(filePath).toLowerCase()) ? 'no-cache' : 'public, max-age=3600',
    });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) reply(res, 500, 'Error al leer el archivo.');
      else res.destroy();
    });
    stream.pipe(res);
  });
}

const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
const players = new Map();

function numberInRange(value, min, max, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function sanitizeInput(input = {}) {
  return {
    mx: numberInRange(input.mx, -1, 1),
    my: numberInRange(input.my, -1, 1),
    aim: numberInRange(input.aim, -Math.PI * 100, Math.PI * 100),
    fire: Boolean(input.fire),
  };
}

function sanitizeState(state = {}) {
  const clean = {};
  for (const key of ['x', 'y']) if (state[key] !== undefined) clean[key] = numberInRange(state[key], -MAX_COORD, MAX_COORD);
  for (const key of ['hp', 'maxHp']) if (state[key] !== undefined) clean[key] = numberInRange(state[key], 0, 100000);
  for (const key of ['regen', 'damage']) if (state[key] !== undefined) clean[key] = numberInRange(state[key], 0, 1000);
  if (state.angle !== undefined) clean.angle = numberInRange(state.angle, -Math.PI * 100, Math.PI * 100);
  if (state.level !== undefined) clean.level = Math.round(numberInRange(state.level, 1, 120, 1));
  if (state.score !== undefined) clean.score = numberInRange(state.score, 0, 1e12);
  if (state.classId !== undefined) clean.classId = String(state.classId).slice(0, 40);
  if (state.name !== undefined) clean.name = String(state.name).trim().slice(0, 24) || 'Jugador';
  if (state.size !== undefined) clean.size = numberInRange(state.size, 10, 500, 25);
  if (state.reload !== undefined) clean.reload = numberInRange(state.reload, 0.12, 2, 0.55);
  if (state.range !== undefined) clean.range = numberInRange(state.range, 100, 3500, 1500);
  if (state.inv !== undefined) clean.inv = numberInRange(state.inv, 0, 5);
  if (typeof state.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(state.color)) clean.color = state.color;
  return clean;
}

function publicPlayer(player) {
  return {
    id: player.id,
    name: player.name,
    state: player.state,
    input: player.input,
    active: player.active,
    dead: player.dead,
    updatedAt: player.updatedAt,
  };
}

function send(ws, packet) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  try { ws.send(JSON.stringify(packet)); return true; }
  catch { return false; }
}

function broadcast(packet, exceptId = null) {
  const data = JSON.stringify(packet);
  for (const player of players.values()) {
    if (player.id === exceptId || player.ws.readyState !== WebSocket.OPEN) continue;
    try { player.ws.send(data); } catch { /* El close elimina la conexión. */ }
  }
}

function notifyUpdate(player) {
  broadcast({ type: 'playerUpdate', player: publicPlayer(player) });
}

function applyState(player, rawState, rawInput, { respawn = false } = {}) {
  const clean = sanitizeState(rawState || {});
  const now = Date.now();
  if (clean.name) player.name = clean.name;
  if (rawInput) player.input = sanitizeInput(rawInput);
  else if (rawState && rawState.input) player.input = sanitizeInput(rawState.input);

  if (respawn) {
    player.dead = false;
    player.active = true;
    player.pvpMaxHp = Math.max(1, clean.maxHp || clean.hp || 60);
    player.pvpHp = numberInRange(clean.hp, 0, player.pvpMaxHp, player.pvpMaxHp);
    player.lastStateAt = now;
    player.invulnerableUntil = now + Math.max(0, Number(clean.inv) || 0) * 1000;
    player.lastShotAt = 0;
  } else {
    if (player.dead) return false;
    if (clean.x === undefined || clean.y === undefined) {
      player.state = { ...player.state, ...clean };
      player.updatedAt = now;
      return true;
    }

    const requestedMaxHp = Math.max(1, clean.maxHp || player.pvpMaxHp || clean.hp || 60);
    if (!player.active) {
      player.active = true;
      player.pvpMaxHp = requestedMaxHp;
      player.pvpHp = numberInRange(clean.hp, 0, requestedMaxHp, requestedMaxHp);
      player.lastStateAt = now;
      player.invulnerableUntil = now + Math.max(0, Number(clean.inv) || 0) * 1000;
    } else {
      const elapsed = Math.min(0.25, Math.max(0, (now - player.lastStateAt) / 1000));
      if (requestedMaxHp !== player.pvpMaxHp) {
        const fraction = player.pvpMaxHp > 0 ? player.pvpHp / player.pvpMaxHp : 1;
        player.pvpMaxHp = requestedMaxHp;
        player.pvpHp = Math.min(player.pvpMaxHp, fraction * player.pvpMaxHp);
      }
      player.pvpHp = Math.min(player.pvpMaxHp, player.pvpHp + numberInRange(clean.regen, 0, 1000) * elapsed);
      if (clean.hp !== undefined) player.pvpHp = Math.min(player.pvpHp, numberInRange(clean.hp, 0, player.pvpMaxHp));
      player.lastStateAt = now;
      if (clean.inv > 0) player.invulnerableUntil = Math.max(player.invulnerableUntil, now + clean.inv * 1000);
    }
  }

  player.state = {
    ...player.state,
    ...clean,
    hp: Math.max(0, player.pvpHp),
    maxHp: player.pvpMaxHp,
  };
  if (player.pvpHp <= 0) player.active = false;
  player.updatedAt = now;
  return true;
}

function resolvePvPShot(shooter) {
  if (!shooter.active || shooter.dead || !shooter.input.fire) return;
  const now = Date.now();
  const reload = numberInRange(shooter.state.reload, 0.12, 2, 0.55);
  const cooldown = Math.max(220, reload * 900);
  if (now - shooter.lastShotAt < cooldown) return;
  shooter.lastShotAt = now;

  const sx = Number(shooter.state.x), sy = Number(shooter.state.y);
  const aim = numberInRange(shooter.input.aim, -Math.PI * 100, Math.PI * 100, Number(shooter.state.angle) || 0);
  const ca = Math.cos(aim), sa = Math.sin(aim);
  const range = numberInRange(shooter.state.range, 100, 3500, 1500);
  let target = null, nearest = Infinity;

  for (const candidate of players.values()) {
    if (candidate.id === shooter.id || !candidate.active || candidate.dead || candidate.pvpHp <= 0) continue;
    if (candidate.invulnerableUntil > now) continue;
    if (!Number.isFinite(Number(candidate.state.x)) || !Number.isFinite(Number(candidate.state.y))) continue;
    const dx = Number(candidate.state.x) - sx, dy = Number(candidate.state.y) - sy;
    const forward = dx * ca + dy * sa;
    if (forward <= 0 || forward > range || forward >= nearest) continue;
    const side = Math.abs(-dx * sa + dy * ca);
    const radius = numberInRange(candidate.state.size, 10, 500, 25) * 0.8 + numberInRange(shooter.state.size, 10, 500, 25) * 0.25 + 8;
    if (side > radius) continue;
    target = candidate;
    nearest = forward;
  }
  if (!target) return;

  const damage = numberInRange(shooter.state.damage, 2, 500, 8) * 1.75;
  target.pvpHp = Math.max(0, target.pvpHp - damage);
  target.state.hp = target.pvpHp;
  target.lastPvPDamageAt = now;
  send(target.ws, {
    type: 'pvpHit', damage, hp: target.pvpHp, maxHp: target.pvpMaxHp,
    attacker: { id: shooter.id, name: shooter.name },
  });
  send(shooter.ws, {
    type: 'pvpDamage', damage, victimId: target.id, victimName: target.name,
    hp: target.pvpHp, maxHp: target.pvpMaxHp,
  });

  if (target.pvpHp <= 0) {
    target.dead = true;
    target.active = false;
    target.input = { ...target.input, fire: false };
    const victimLevel = Math.max(1, Math.floor(Number(target.state.level) || 1));
    const xp = Math.max(80, Math.round((Number(target.state.score) || 0) * 0.5));
    const gems = Math.max(1, Math.ceil(victimLevel / 10));
    send(target.ws, { type: 'pvpDeath', killerId: shooter.id, killerName: shooter.name });
    send(shooter.ws, {
      type: 'pvpKill', victimId: target.id, victimName: target.name,
      victimLevel, xp, gems,
    });
    target.updatedAt = now;
    broadcast({ type: 'playerUpdate', player: publicPlayer(target) }, target.id);
  } else {
    target.updatedAt = now;
    notifyUpdate(target);
  }
}

wss.on('connection', (ws) => {
  const id = randomUUID();
  const player = {
    id,
    ws,
    name: `Jugador-${id.slice(0, 4)}`,
    state: {},
    input: { mx: 0, my: 0, aim: 0, fire: false },
    active: false,
    dead: false,
    pvpHp: 0,
    pvpMaxHp: 0,
    lastStateAt: Date.now(),
    lastShotAt: 0,
    invulnerableUntil: 0,
    updatedAt: Date.now(),
  };
  players.set(id, player);
  ws.isAlive = true;
  ws.playerId = id;
  ws.on('pong', () => { ws.isAlive = true; });

  send(ws, {
    type: 'welcome',
    player: publicPlayer(player),
    players: [...players.values()].filter((other) => other.id !== id).map(publicPlayer),
  });
  broadcast({ type: 'playerJoined', player: publicPlayer(player) }, id);

  ws.on('message', (raw) => {
    let message;
    try { message = JSON.parse(raw.toString('utf8')); }
    catch { return send(ws, { type: 'error', message: 'Mensaje JSON no válido.' }); }
    if (!message || typeof message.type !== 'string') return send(ws, { type: 'error', message: 'Falta el tipo de mensaje.' });

    if (message.type === 'join') {
      player.name = typeof message.name === 'string' ? message.name.trim().slice(0, 24) || player.name : player.name;
      player.updatedAt = Date.now();
      return notifyUpdate(player);
    }

    if (message.type === 'respawn') {
      const ok = applyState(player, message.state || {}, message.input, { respawn: true });
      if (ok) {
        broadcast({ type: 'playerRespawned', player: publicPlayer(player) });
        notifyUpdate(player);
      }
      return;
    }

    if (message.type === 'leaveGame') {
      player.active = false;
      player.dead = false;
      player.input = { ...player.input, fire: false };
      player.updatedAt = Date.now();
      return notifyUpdate(player);
    }

    if (message.type === 'input') {
      if (player.dead) return;
      player.input = sanitizeInput(message.input || message);
      if (message.input && message.input.aim !== undefined) player.state.angle = player.input.aim;
      player.updatedAt = Date.now();
      resolvePvPShot(player);
      return notifyUpdate(player);
    }

    if (message.type === 'move' || message.type === 'state') {
      if (!applyState(player, message.state || message, message.input)) return;
      resolvePvPShot(player);
      return notifyUpdate(player);
    }

    if (message.type === 'ping') return send(ws, { type: 'pong', time: Date.now() });
    send(ws, { type: 'error', message: 'Tipo de mensaje desconocido.' });
  });

  ws.on('close', () => {
    players.delete(id);
    broadcast({ type: 'playerLeft', id });
  });
  ws.on('error', (error) => console.warn(`WebSocket ${id}:`, error.message));
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, HOST, () => {
  console.log(`Servidor listo en ${HOST}:${PORT}`);
  console.log(`Archivos estáticos: ${PUBLIC_DIR}`);
});

function shutdown() {
  clearInterval(heartbeat);
  for (const ws of wss.clients) ws.close(1001, 'Servidor apagándose');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
