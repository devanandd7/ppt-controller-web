// Next.js API route that hosts a WebSocket relay on the same dev server
// Endpoint: ws(s)://<host>/api/ws?token=<TOKEN>&role=desktop|web
// Pairs one desktop and one web client per token and forwards signals between them.

import { WebSocketServer } from 'ws';

// token -> { desktop: WebSocket|null, web: WebSocket|null }
const rooms = new Map();

function getOrCreateRoom(token) {
  if (!rooms.has(token)) {
    rooms.set(token, { desktop: null, web: null });
  }
  return rooms.get(token);
}

function cleanupSocket(room, role) {
  if (!room) return;
  try {
    room[role] = null;
  } catch {}
}

function broadcastStatus(token) {
  const room = rooms.get(token);
  if (!room) return;
  const statusPayload = JSON.stringify({ type: 'status', desktop: !!room.desktop, web: !!room.web });
  for (const ws of [room.desktop, room.web]) {
    if (ws && ws.readyState === ws.OPEN) {
      try { ws.send(statusPayload); } catch {}
    }
  }
}

export const config = {
  api: {
    bodyParser: false,
  },
};

export default function handler(req, res) {
  if (!res.socket.server._wss) {
    // Create one WSS instance and store on the server to persist across hot reloads
    const wss = new WebSocketServer({ noServer: true });
    res.socket.server._wss = wss;

    res.socket.server.on('upgrade', (request, socket, head) => {
      const { url } = request;
      // Only handle our endpoint
      if (!url || !url.startsWith('/api/ws')) return;
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    });

    wss.on('connection', (ws, request) => {
      const base = `http://${request.headers.host}`;
      const u = new URL(request.url, base);
      const token = u.searchParams.get('token');
      const role = u.searchParams.get('role');

      if (!token || !role || !['desktop', 'web'].includes(role)) {
        try { ws.send(JSON.stringify({ type: 'error', message: 'Invalid token or role' })); } catch {}
        try { ws.close(1008, 'Invalid token/role'); } catch {}
        return;
      }

      const room = getOrCreateRoom(token);

      if (room[role] && room[role].readyState === room[role].OPEN) {
        try { room[role].close(4000, 'Replaced by new connection'); } catch {}
      }

      room[role] = ws;
      try { ws.send(JSON.stringify({ type: 'connected', role, token })); } catch {}
      broadcastStatus(token);

      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch {
          try { ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' })); } catch {}
          return;
        }
        if (msg && msg.type === 'signal' && (msg.name === 'signal-1' || msg.name === 'signal-2')) {
          const peerRole = role === 'desktop' ? 'web' : 'desktop';
          const peer = room[peerRole];
          if (peer && peer.readyState === peer.OPEN) {
            try { peer.send(JSON.stringify({ type: 'signal', name: msg.name })); } catch {}
          } else {
            try { ws.send(JSON.stringify({ type: 'error', message: 'Peer not connected' })); } catch {}
          }
          return;
        }
        if (msg && msg.type === 'ping') {
          try { ws.send(JSON.stringify({ type: 'pong' })); } catch {}
          return;
        }
      });

      const onCloseOrError = () => {
        cleanupSocket(room, role);
        broadcastStatus(token);
      };

      ws.on('close', onCloseOrError);
      ws.on('error', onCloseOrError);
    });
  }

  res.status(200).json({ ok: true });
}
