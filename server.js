import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const PORT = process.env.PORT || 8080;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLIENT_TTL_MS = 60_000;

// Top-level rooms are keyed by ?room=
// Each room contains multiple sessions keyed by sessionId.
const rooms = new Map();

function log(message, data = '') {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`, data);
}

function generateClientId() {
  return Math.random().toString(36).substring(2, 11);
}

function getRoomKey(reqUrl) {
  try {
    const u = new URL(reqUrl, `http://localhost:${PORT}`);
    return u.searchParams.get('room') || 'default';
  } catch {
    return 'default';
  }
}

function getRoomState(roomKey) {
  if (!rooms.has(roomKey)) {
    rooms.set(roomKey, {
      clients: new Map(), // clientId -> { clientId, sessionId, lastSeen }
      queues: new Map(), // clientId -> [messages]
      sessions: new Map() // sessionId -> Set(clientId)
    });
  }
  return rooms.get(roomKey);
}

function queueMessage(state, targetClientId, message) {
  if (!state.queues.has(targetClientId)) state.queues.set(targetClientId, []);
  state.queues.get(targetClientId).push(message);
}

function broadcastToSession(state, sessionId, message, excludeClientId = null) {
  const members = state.sessions.get(sessionId);
  if (!members) return;
  for (const memberId of members) {
    if (excludeClientId && memberId === excludeClientId) continue;
    queueMessage(state, memberId, message);
  }
}

function pruneStaleClients(state) {
  const now = Date.now();
  for (const [clientId, client] of state.clients.entries()) {
    if (now - client.lastSeen > CLIENT_TTL_MS) {
      // Treat as disconnect
      if (client.sessionId) {
        const members = state.sessions.get(client.sessionId);
        if (members) {
          members.delete(clientId);
          if (members.size === 0) state.sessions.delete(client.sessionId);
        }
        broadcastToSession(state, client.sessionId, {
          type: 'peer-left',
          sessionId: client.sessionId,
          peerId: clientId
        });
      }
      state.clients.delete(clientId);
      state.queues.delete(clientId);
    }
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function writeJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function writeText(res, status, text, contentType = 'text/plain') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store'
  });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  const roomKey = getRoomKey(req.url);
  const state = getRoomState(roomKey);
  pruneStaleClients(state);

  // Health endpoint
  if (req.url?.startsWith('/health')) {
    return writeJson(res, 200, { status: 'ok', clients: state.clients.size });
  }

  // Basic static files for demo.html usage (optional)
  if (req.method === 'GET' && (req.url === '/' || req.url?.startsWith('/demo.html'))) {
    const filePath = path.join(__dirname, 'demo.html');
    return fs.readFile(filePath, 'utf-8', (err, data) => {
      if (err) return writeText(res, 404, 'Demo not found');
      return writeText(res, 200, data, 'text/html');
    });
  }

  if (req.method === 'GET' && req.url?.startsWith('/client-browser.js')) {
    const filePath = path.join(__dirname, 'client-browser.js');
    return fs.readFile(filePath, 'utf-8', (err, data) => {
      if (err) return writeText(res, 404, 'Client not found');
      res.writeHead(200, {
        'Content-Type': 'application/javascript',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      });
      res.end(data);
    });
  }

  // API routes (HTTP polling signaling; no WebSockets)
  if (req.url?.startsWith('/api/')) {
    try {
      const u = new URL(req.url, `http://localhost:${PORT}`);
      const pathname = u.pathname;

      if (pathname === '/api/connect' && req.method === 'POST') {
        const clientId = generateClientId();
        state.clients.set(clientId, { clientId, sessionId: null, lastSeen: Date.now() });
        state.queues.set(clientId, []);
        return writeJson(res, 200, { type: 'welcome', clientId, message: 'Connected to UniWRTC signaling server' });
      }

      if (pathname === '/api/set-id' && req.method === 'POST') {
        const body = await readJson(req);
        const { clientId, customId } = body || {};
        if (!clientId || !state.clients.has(clientId)) return writeJson(res, 400, { message: 'Invalid clientId' });
        if (!customId || typeof customId !== 'string' || customId.length < 3 || customId.length > 20) {
          return writeJson(res, 400, { message: 'Custom ID must be between 3-20 characters' });
        }
        if (state.clients.has(customId) && customId !== clientId) return writeJson(res, 409, { message: 'Peer ID already taken' });

        const client = state.clients.get(clientId);
        const existingQueue = state.queues.get(clientId) || [];
        state.clients.delete(clientId);
        state.queues.delete(clientId);
        state.clients.set(customId, { ...client, clientId: customId, lastSeen: Date.now() });
        state.queues.set(customId, existingQueue);

        // Update membership sets
        if (client.sessionId) {
          const members = state.sessions.get(client.sessionId);
          if (members) {
            members.delete(clientId);
            members.add(customId);
          }
        }

        return writeJson(res, 200, { type: 'welcome', clientId: customId, message: 'Custom peer ID set' });
      }

      if (pathname === '/api/join' && req.method === 'POST') {
        const body = await readJson(req);
        const { clientId, sessionId } = body || {};
        if (!clientId || !state.clients.has(clientId)) return writeJson(res, 400, { message: 'Invalid clientId' });
        if (!sessionId) return writeJson(res, 400, { message: 'Session ID is required' });

        const client = state.clients.get(clientId);
        client.lastSeen = Date.now();

        // Leave previous session
        if (client.sessionId && client.sessionId !== sessionId) {
          const prevMembers = state.sessions.get(client.sessionId);
          if (prevMembers) {
            prevMembers.delete(clientId);
            if (prevMembers.size === 0) state.sessions.delete(client.sessionId);
          }
          broadcastToSession(state, client.sessionId, {
            type: 'peer-left',
            sessionId: client.sessionId,
            peerId: clientId
          }, null);
        }

        client.sessionId = sessionId;
        if (!state.sessions.has(sessionId)) state.sessions.set(sessionId, new Set());
        state.sessions.get(sessionId).add(clientId);

        const members = state.sessions.get(sessionId);
        const existingClients = Array.from(members).filter((id) => id !== clientId);

        // Notify others
        broadcastToSession(state, sessionId, {
          type: 'peer-joined',
          sessionId,
          peerId: clientId
        }, clientId);

        return writeJson(res, 200, {
          type: 'joined',
          sessionId,
          clientId,
          clients: existingClients
        });
      }

      if (pathname === '/api/leave' && req.method === 'POST') {
        const body = await readJson(req);
        const { clientId } = body || {};
        if (!clientId || !state.clients.has(clientId)) return writeJson(res, 400, { message: 'Invalid clientId' });
        const client = state.clients.get(clientId);
        client.lastSeen = Date.now();

        if (client.sessionId) {
          const sessionId = client.sessionId;
          const members = state.sessions.get(sessionId);
          if (members) {
            members.delete(clientId);
            if (members.size === 0) state.sessions.delete(sessionId);
          }
          broadcastToSession(state, sessionId, {
            type: 'peer-left',
            sessionId,
            peerId: clientId
          }, null);
        }

        state.clients.delete(clientId);
        state.queues.delete(clientId);
        return writeJson(res, 200, { ok: true });
      }

      if (pathname === '/api/signal' && req.method === 'POST') {
        const body = await readJson(req);
        const { clientId, sessionId, targetId, type } = body || {};
        if (!clientId || !state.clients.has(clientId)) return writeJson(res, 400, { message: 'Invalid clientId' });
        if (!sessionId) return writeJson(res, 400, { message: 'Session ID is required' });
        if (!type) return writeJson(res, 400, { message: 'Message type is required' });

        const client = state.clients.get(clientId);
        client.lastSeen = Date.now();
        if (!client.sessionId) return writeJson(res, 400, { message: 'Not in a session' });

        const message = {
          ...body,
          peerId: clientId,
          sessionId
        };

        if (targetId) {
          if (!state.clients.has(targetId)) return writeJson(res, 404, { message: 'Target peer not found' });
          queueMessage(state, targetId, message);
          return writeJson(res, 200, { ok: true });
        }

        broadcastToSession(state, client.sessionId, message, clientId);
        return writeJson(res, 200, { ok: true });
      }

      if (pathname === '/api/poll' && req.method === 'GET') {
        const clientId = u.searchParams.get('clientId');
        if (!clientId) return writeJson(res, 400, { message: 'clientId is required' });
        if (!state.clients.has(clientId)) return writeJson(res, 404, { message: 'Unknown clientId' });
        const client = state.clients.get(clientId);
        client.lastSeen = Date.now();
        const q = state.queues.get(clientId) || [];
        state.queues.set(clientId, []);
        return writeJson(res, 200, { messages: q });
      }

      return writeJson(res, 404, { message: 'Not found' });
    } catch (err) {
      log('API error:', err?.message || String(err));
      return writeJson(res, 500, { message: err?.message || 'Internal error' });
    }
  }

  return writeText(res, 200, 'UniWRTC Signaling Server');
});

server.listen(PORT, () => {
  log(`UniWRTC Signaling Server listening on port ${PORT}`);
  console.log(`\n>>> Demo available at: http://localhost:${PORT}\n`);
});

process.on('SIGTERM', () => {
  log('SIGTERM received, closing server...');
  server.close(() => {
    log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  log('SIGINT received, closing server...');
  server.close(() => {
    log('Server closed');
    process.exit(0);
  });
  setTimeout(() => {
    log('Forced shutdown');
    process.exit(1);
  }, 5000);
});
