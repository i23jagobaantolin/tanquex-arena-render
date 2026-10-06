# Tanquex Arena — multijugador PvP

Juego web servido por Node.js y WebSockets. El cliente selecciona automáticamente `ws://` en local y `wss://` en HTTPS.

## Archivos

- `server.js`: servidor HTTP/WS, sirve `public/`, escucha en `process.env.PORT` y resuelve impactos y muertes PvP.
- `public/index.html`: juego con renderizado de jugadores remotos, barras de vida y controles integrados.
- `public/script.js`: conexión, reconexión, sincronización de jugadores y eventos de combate.
- `package.json` y `package-lock.json`: dependencias y ejecución reproducible con `npm start`.
- `render.yaml`: configuración de Blueprint para Render.

## Jugar con un amigo

1. Ambos abren la misma URL del servidor.
2. Cada uno elige su nombre y pulsa **Jugar**.
3. Esperad a que termine la protección breve de aparición. Apuntad al tanque rival y disparad.
4. El servidor registra el daño y la baja; el ganador recibe XP y gemas según el nivel del rival.

Los jugadores remotos y sus vidas se actualizan por WebSocket. El movimiento y la simulación PvE (bots, formas y obstáculos) siguen ejecutándose localmente en cada navegador; esta versión básica no comprueba oclusión de los disparos por paredes.

## Ejecutar en local

Requiere Node.js 20 o posterior.

```bash
npm install
npm start
```

Abre <http://localhost:3000> en dos navegadores o pestañas.

## Render

Conecta este repositorio como un **Web Service** Node.js. Comandos:

- Build: `npm install`
- Start: `npm start`
- Health check: `/healthz`

El servidor escucha en `process.env.PORT`. El plan gratuito mantiene la URL del servicio, pero puede suspender la instancia por inactividad y tardar en despertarla al siguiente acceso.
