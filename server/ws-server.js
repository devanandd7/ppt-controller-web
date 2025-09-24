// Simple token-based WebSocket relay server
// Roles: "desktop" and "web" join using the same token. Server forwards messages between paired clients.

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.WS_PORT ? Number(process.env.WS_PORT) : 8081;

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
      ws.send(statusPayload);
    }
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('WebSocket relay is running');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  // Expect query string: ?token=...&role=desktop|web
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  const role = url.searchParams.get('role');

  if (!token || !role || !['desktop', 'web'].includes(role)) {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid token or role' }));
    ws.close(1008, 'Invalid token/role');
    return;
  }

  const room = getOrCreateRoom(token);

  // If role already occupied, kick previous client
  if (room[role] && room[role].readyState === WebSocket.OPEN) {
    try { room[role].close(4000, 'Replaced by new connection'); } catch {}
  }

  room[role] = ws;
  ws.send(JSON.stringify({ type: 'connected', role, token }));
  broadcastStatus(token);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch {
      return ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
    }

    // Forward signals between paired clients. Expect { type: 'signal', name: 'signal-1' | 'signal-2' }
    if (msg && msg.type === 'signal' && (msg.name === 'signal-1' || msg.name === 'signal-2')) {
      const peerRole = role === 'desktop' ? 'web' : 'desktop';
      const peer = room[peerRole];
      if (peer && peer.readyState === WebSocket.OPEN) {
        peer.send(JSON.stringify({ type: 'signal', name: msg.name }));
      } else {
        ws.send(JSON.stringify({ type: 'error', message: 'Peer not connected' }));
      }
      return;
    }

    // Heartbeat ping-pong
    if (msg && msg.type === 'ping') {
      return ws.send(JSON.stringify({ type: 'pong' }));
    }
  });

  ws.on('close', () => {
    cleanupSocket(room, role);
    broadcastStatus(token);
  });

  ws.on('error', () => {
    cleanupSocket(room, role);
    broadcastStatus(token);
  });
});

server.listen(PORT, () => {
  console.log(`WS relay listening on ws://localhost:${PORT}`);
});
