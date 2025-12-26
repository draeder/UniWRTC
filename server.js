const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;

// Create HTTP server
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', connections: wss.clients.size }));
  } else if (req.url === '/' || req.url === '/demo.html') {
    const filePath = path.join(__dirname, 'demo.html');
    fs.readFile(filePath, 'utf-8', (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Demo not found');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
      }
    });
  } else if (req.url === '/client-browser.js') {
    const filePath = path.join(__dirname, 'client-browser.js');
    fs.readFile(filePath, 'utf-8', (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Client not found');
      } else {
        res.writeHead(200, { 
          'Content-Type': 'application/javascript',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        });
        res.end(data);
      }
    });
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('UniWRTC Signaling Server');
  }
});

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Store rooms and their participants
const rooms = new Map();

function log(message, data = '') {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`, data);
}

function broadcastToRoom(sessionId, message, excludeClient = null) {
  const room = rooms.get(sessionId);
  if (!room) {
    log(`WARNING: Attempted to broadcast to non-existent session: ${sessionId}`);
    return;
  }

  room.clients.forEach(client => {
    if (client !== excludeClient && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

function sendToClient(client, message) {
  if (client.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify(message));
  }
}

wss.on('connection', (ws) => {
  log('New connection established');
  
  ws.clientId = generateClientId();
  ws.room = null;

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      log('Message received:', message.type);

      switch (message.type) {
        case 'set-id':
          handleSetId(ws, message);
          break;
        case 'join':
          handleJoin(ws, message);
          break;
        case 'leave':
          handleLeave(ws, message);
          break;
        case 'offer':
        case 'answer':
        case 'ice-candidate':
          handleSignaling(ws, message);
          break;
        case 'chat':
          handleChat(ws, message);
          break;
        case 'list-rooms':
          handleListRooms(ws);
          break;
        default:
          sendToClient(ws, { type: 'error', message: 'Unknown message type' });
      }
    } catch (error) {
      log('Error processing message:', error.message);
      sendToClient(ws, { type: 'error', message: 'Invalid message format' });
    }
  });

  ws.on('close', () => {
    log('Connection closed', ws.clientId);
    if (ws.room) {
      handleLeave(ws, { roomId: ws.room });
    }
  });

  ws.on('error', (error) => {
    log('WebSocket error:', error.message);
  });

  // Send welcome message
  sendToClient(ws, {
    type: 'welcome',
    clientId: ws.clientId,
    message: 'Connected to UniWRTC signaling server'
  });
});

function handleSetId(ws, message) {
  const { customId } = message;
  
  if (!customId || customId.length < 3 || customId.length > 20) {
    sendToClient(ws, { type: 'error', message: 'Custom ID must be between 3-20 characters' });
    return;
  }

  // Check if ID is already taken
  let idTaken = false;
  wss.clients.forEach(client => {
    if (client.clientId === customId && client !== ws) {
      idTaken = true;
    }
  });

  if (idTaken) {
    sendToClient(ws, { type: 'error', message: 'Peer ID already taken' });
    return;
  }

  log(`Client ${ws.clientId} changed ID to ${customId}`);
  ws.clientId = customId;
  
  // Send updated welcome message
  sendToClient(ws, {
    type: 'welcome',
    clientId: ws.clientId,
    message: 'Custom peer ID set'
  });
}

function handleJoin(ws, message) {
  const { sessionId } = message;
  
  if (!sessionId) {
    sendToClient(ws, { type: 'error', message: 'Session ID is required' });
    return;
  }

  // Leave current session if in one
  if (ws.room) {
    handleLeave(ws, { sessionId: ws.room });
  }

  // Create session if it doesn't exist
  if (!rooms.has(sessionId)) {
    rooms.set(sessionId, {
      id: sessionId,
      clients: new Set(),
      createdAt: Date.now()
    });
    log('Session created:', sessionId);
  }

  const room = rooms.get(sessionId);
  room.clients.add(ws);
  ws.room = sessionId;

  log(`Client ${ws.clientId} joined session ${sessionId}`);

  // Get list of existing clients in the room
  const existingClients = Array.from(room.clients)
    .filter(client => client !== ws)
    .map(client => client.clientId);

  // Notify the joining client
  sendToClient(ws, {
    type: 'joined',
    sessionId: sessionId,
    clientId: ws.clientId,
    clients: existingClients
  });

  // Notify other clients in the session
  broadcastToRoom(sessionId, {
    type: 'peer-joined',
    sessionId: sessionId,
    peerId: ws.clientId
  }, ws);
}

function handleLeave(ws, message) {
  const { sessionId } = message;
  
  if (!sessionId || !rooms.has(sessionId)) {
    return;
  }

  const room = rooms.get(sessionId);
  room.clients.delete(ws);

  log(`Client ${ws.clientId} left session ${sessionId}`);

  // Notify other clients
  broadcastToRoom(sessionId, {
    type: 'peer-left',
    sessionId: sessionId,
    peerId: ws.clientId
  });

  // Clean up empty sessions
  if (room.clients.size === 0) {
    rooms.delete(sessionId);
    log('Session deleted:', sessionId);
  }

  ws.room = null;
}

function handleSignaling(ws, message) {
  const { targetId, sessionId } = message;

  if (!ws.room) {
    sendToClient(ws, { type: 'error', message: 'Not in a session' });
    return;
  }

  if (!targetId) {
    // Broadcast to all in room if no specific target
    broadcastToRoom(ws.room, {
      ...message,
      peerId: ws.clientId
    }, ws);
    return;
  }

  // Send to specific client
  const room = rooms.get(ws.room);
  if (!room) return;

  for (const client of room.clients) {
    if (client.clientId === targetId) {
      sendToClient(client, {
        ...message,
        peerId: ws.clientId
      });
      break;
    }
  }
}

function handleChat(ws, message) {
  const { sessionId, text } = message;
  
  if (!sessionId || !text) {
    sendToClient(ws, { type: 'error', message: 'Session ID and text are required' });
    return;
  }

  log(`Chat message in session ${sessionId}: ${text.substring(0, 50)}`);

  const room = rooms.get(sessionId);
  if (!room) {
    sendToClient(ws, { type: 'error', message: 'Session not found' });
    return;
  }

  // Broadcast chat to ALL clients in the session (including sender)
  room.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: 'chat',
        text: text,
        peerId: ws.clientId,
        sessionId: sessionId
      }));
    }
  });
}

function handleListRooms(ws) {
  const roomList = Array.from(rooms.entries()).map(([id, room]) => ({
    id,
    clients: room.clients.size,
    createdAt: room.createdAt
  }));

  sendToClient(ws, {
    type: 'room-list',
    rooms: roomList
  });
}

function generateClientId() {
  return Math.random().toString(36).substring(2, 11);
}

server.listen(PORT, () => {
  log(`UniWRTC Signaling Server listening on port ${PORT}`);
  console.log(`\n>>> Demo available at: http://localhost:${PORT}\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log('SIGTERM received, closing server...');
  server.close(() => {
    log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  log('SIGINT received, closing server...');
  // Close all WebSocket connections
  wss.clients.forEach(client => {
    client.close();
  });
  server.close(() => {
    log('Server closed');
    process.exit(0);
  });
  // Force exit after 5 seconds if still hanging
  setTimeout(() => {
    log('Forced shutdown');
    process.exit(1);
  }, 5000);
});
