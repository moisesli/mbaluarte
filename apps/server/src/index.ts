import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { MAPS, type ClientMsg } from '@td/shared';
import { RoomManager } from './roomManager.js';
import type { Room } from './room.js';
import { loadHighscores } from './highscores.js';

const PORT = Number(process.env.PORT ?? 3000);
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
// en producción el bundle vive en apps/server/dist → el cliente en apps/client/dist
const CLIENT_DIST = process.env.TD_CLIENT_DIST ?? path.resolve(__dirname, '../../client/dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url ?? '/', `http://${req.headers.host}`);

  if (reqUrl.pathname === '/api/highscores') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(loadHighscores()));
    return;
  }
  if (reqUrl.pathname === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.count(), maps: MAPS.length }));
    return;
  }

  // archivos estáticos del cliente con fallback a index.html (SPA)
  let filePath = path.join(CLIENT_DIST, path.normalize(reqUrl.pathname).replace(/^([.\\/])+/, ''));
  if (!filePath.startsWith(CLIENT_DIST)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (reqUrl.pathname === '/' || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(CLIENT_DIST, 'index.html');
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Cliente no compilado. Corre: pnpm build');
    return;
  }
  const ext = path.extname(filePath);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  fs.createReadStream(filePath).pipe(res);
});

const rooms = new RoomManager();
const wss = new WebSocketServer({ server, path: '/ws' });
const socketRoom = new Map<WebSocket, Room>();

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(raw)) as ClientMsg;
    } catch {
      return;
    }

    // red de seguridad: un mensaje malformado jamás debe tumbar el proceso
    // (afectaría a TODAS las salas)
    try {
      handleClientMsg(ws, msg);
    } catch (err) {
      console.error('[ws] error procesando mensaje', msg?.type, err);
      ws.send(JSON.stringify({ type: 'error', msg: 'Mensaje inválido' }));
    }
  });

  function handleClientMsg(ws: WebSocket, msg: ClientMsg): void {
    const room = socketRoom.get(ws);

    if (msg.type === 'create_room') {
      if (room) return;
      const created = rooms.create(msg.settings);
      const res = created.addPlayer(msg.name, msg.token, ws);
      if (res.kind === 'error') {
        ws.send(JSON.stringify({ type: 'error', msg: res.msg }));
        return;
      }
      socketRoom.set(ws, created);
      // crear una sala nunca produce espectador (no hay partida en curso), pero
      // por simetría con join_room lo tratamos igual
      if (res.kind === 'spectator') {
        const spec = res.spectator;
        created.sendTo(ws, { type: 'room_joined', code: created.code, playerId: spec.id, isHost: false, spectator: true });
        created.broadcastLobby();
        created.sendGameStateToSpectator(spec);
        return;
      }
      const player = res.player;
      created.send(player, {
        type: 'room_joined',
        code: created.code,
        playerId: player.id,
        isHost: player.isHost,
      });
      created.broadcastLobby();
      created.sendGameStateTo(player);
      return;
    }

    if (msg.type === 'join_room') {
      if (room) return;
      const found = rooms.get(msg.code ?? '');
      if (!found) {
        ws.send(JSON.stringify({ type: 'error', msg: `No existe la sala "${(msg.code ?? '').toUpperCase()}"` }));
        return;
      }
      const res = found.addPlayer(msg.name, msg.token, ws);
      if (res.kind === 'error') {
        ws.send(JSON.stringify({ type: 'error', msg: res.msg }));
        return;
      }
      socketRoom.set(ws, found);
      if (res.kind === 'spectator') {
        const spec = res.spectator;
        found.sendTo(ws, { type: 'room_joined', code: found.code, playerId: spec.id, isHost: false, spectator: true });
        found.broadcastLobby();
        found.sendGameStateToSpectator(spec);
        return;
      }
      const player = res.player;
      found.send(player, {
        type: 'room_joined',
        code: found.code,
        playerId: player.id,
        isHost: player.isHost,
      });
      found.broadcastLobby();
      found.sendGameStateTo(player);
      return;
    }

    if (room) room.handleMessage(ws, msg);
  }

  ws.on('close', () => {
    const room = socketRoom.get(ws);
    socketRoom.delete(ws);
    room?.dropSocket(ws);
  });
});

server.listen(PORT, () => {
  console.log('🏰 Fortaleza TD listo. Abre el juego en:');
  console.log(`   → en esta PC:  http://localhost:${PORT}`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) {
        console.log(`   → en tu red:   http://${a.address}:${PORT}   (celulares y otras PCs)`);
      }
    }
  }
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`⚠️  El puerto ${PORT} ya está ocupado (¿otro pnpm start o pnpm dev abierto?).`);
    console.error('   Cierra el otro proceso o usa: PORT=3001 pnpm start');
    process.exit(1);
  }
  throw err;
});
