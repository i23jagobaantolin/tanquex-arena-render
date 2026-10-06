/* Cliente WebSocket para Tanquex Arena.
 * API global: window.TanquexMultiplayer
 */
(() => {
  'use strict';

  if (!('WebSocket' in window)) {
    console.error('[Tanquex] Este navegador no admite WebSocket.');
    return;
  }

  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socketUrl = `${scheme}//${window.location.host}`;
  const listeners = new Map();
  const remotePlayers = new Map();
  let socket = null;
  let playerId = null;
  let connected = false;
  let stopped = false;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let lastInput = null;
  let lastState = null;
  let pendingRespawn = null;

  function emit(eventName, detail) {
    const callbacks = listeners.get(eventName);
    if (callbacks) for (const callback of callbacks) {
      try { callback(detail); } catch (error) { console.error(error); }
    }
    window.dispatchEvent(new CustomEvent(`tanquex:${eventName}`, { detail }));
  }

  function send(packet) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try { socket.send(JSON.stringify(packet)); return true; }
    catch (error) { console.warn('[Tanquex] No se pudo enviar el mensaje:', error); return false; }
  }

  function rememberPlayer(player) {
    if (!player || !player.id || player.id === playerId) return;
    remotePlayers.set(player.id, player);
  }

  function handlePacket(packet) {
    emit('message', packet);
    switch (packet.type) {
      case 'welcome':
        playerId = packet.player && packet.player.id ? packet.player.id : null;
        remotePlayers.clear();
        for (const player of packet.players || []) rememberPlayer(player);
        emit('welcome', { player: packet.player || null, players: [...remotePlayers.values()] });
        break;
      case 'playerJoined':
        rememberPlayer(packet.player);
        emit('playerJoined', packet.player);
        break;
      case 'playerUpdate':
      case 'playerRespawned':
        rememberPlayer(packet.player);
        emit(packet.type, packet.player);
        break;
      case 'playerLeft':
        remotePlayers.delete(packet.id);
        emit('playerLeft', { id: packet.id });
        break;
      case 'pvpHit':
        emit('pvpHit', packet);
        break;
      case 'pvpDeath':
        lastState = null;
        lastInput = null;
        pendingRespawn = null;
        emit('pvpDeath', packet);
        break;
      case 'pvpKill':
        emit('pvpKill', packet);
        break;
      case 'pvpDamage':
        emit('pvpDamage', packet);
        break;
      case 'error':
        emit('serverError', packet.message || 'Error del servidor.');
        break;
      case 'pong':
        emit('pong', packet.time);
        break;
      default:
        emit('unknown', packet);
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(15000, 500 * (2 ** Math.min(reconnectAttempt, 5))) + Math.random() * 300;
    reconnectAttempt += 1;
    reconnectTimer = window.setTimeout(() => { reconnectTimer = null; connect(); }, delay);
  }

  function connect() {
    if (stopped || socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    let ws;
    try { ws = new WebSocket(socketUrl); }
    catch (error) { emit('connectionError', error); scheduleReconnect(); return; }
    socket = ws;

    ws.addEventListener('open', () => {
      connected = true;
      reconnectAttempt = 0;
      emit('connected', { url: socketUrl });
      const name = typeof window.TANQUE_PLAYER_NAME === 'string' ? window.TANQUE_PLAYER_NAME : 'Jugador';
      send({ type: 'join', name });
      if (pendingRespawn) {
        send({ type: 'respawn', state: pendingRespawn });
        pendingRespawn = null;
      } else if (lastState) {
        send({ type: 'state', state: lastState, input: lastInput || undefined });
      } else if (lastInput) send({ type: 'input', input: lastInput });
    });

    ws.addEventListener('message', (event) => {
      try { handlePacket(JSON.parse(event.data)); }
      catch { emit('connectionError', new Error('El servidor envió un mensaje inválido.')); }
    });
    ws.addEventListener('error', () => emit('connectionError', new Error('No se pudo conectar al servidor WebSocket.')));
    ws.addEventListener('close', (event) => {
      connected = false;
      playerId = null;
      remotePlayers.clear();
      emit('disconnected', { code: event.code, reason: event.reason });
      scheduleReconnect();
    });
  }

  const api = {
    sendInput(input = {}) {
      lastInput = {
        mx: Number.isFinite(Number(input.mx)) ? Number(input.mx) : 0,
        my: Number.isFinite(Number(input.my)) ? Number(input.my) : 0,
        aim: Number.isFinite(Number(input.aim)) ? Number(input.aim) : 0,
        fire: Boolean(input.fire),
      };
      return send({ type: 'input', input: lastInput });
    },
    sendState(state = {}) {
      lastState = { ...state };
      if (state.input && typeof state.input === 'object') lastInput = { ...state.input };
      return send({ type: 'state', state: lastState, input: lastInput || undefined });
    },
    sendMove(state = {}) { return this.sendState(state); },
    respawn(state = {}) {
      lastState = { ...state };
      if (state.input && typeof state.input === 'object') lastInput = { ...state.input };
      pendingRespawn = { ...state };
      const sent = send({ type: 'respawn', state: pendingRespawn, input: lastInput || undefined });
      if (sent) pendingRespawn = null;
      return sent;
    },
    setInactive() {
      lastState = null;
      lastInput = null;
      pendingRespawn = null;
      return send({ type: 'leaveGame' });
    },
    on(eventName, callback) {
      if (typeof callback !== 'function') return () => {};
      if (!listeners.has(eventName)) listeners.set(eventName, new Set());
      listeners.get(eventName).add(callback);
      return () => listeners.get(eventName)?.delete(callback);
    },
    getPlayers() { return [...remotePlayers.values()]; },
    ping() { return send({ type: 'ping' }); },
    disconnect() {
      stopped = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'Cliente cerrado');
    },
  };
  Object.defineProperties(api, {
    connected: { enumerable: true, get: () => connected },
    playerId: { enumerable: true, get: () => playerId },
  });

  window.TanquexMultiplayer = api;
  window.addEventListener('tanquex:input', (event) => api.sendInput(event.detail || {}));
  window.addEventListener('tanquex:state', (event) => api.sendState(event.detail || {}));
  emit('clientReady', { url: socketUrl });
  connect();
})();
