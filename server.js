const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;

// Create HTTP server
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', connections: wss.clients.size }));
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

function broadcastToRoom(roomId, message, excludeClient = null) {
  const room = rooms.get(roomId);
  if (!room) return;

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

function handleJoin(ws, message) {
  const { roomId } = message;
  
  if (!roomId) {
    sendToClient(ws, { type: 'error', message: 'Room ID is required' });
    return;
  }

  // Leave current room if in one
  if (ws.room) {
    handleLeave(ws, { roomId: ws.room });
  }

  // Create room if it doesn't exist
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      clients: new Set(),
      createdAt: Date.now()
    });
    log('Room created:', roomId);
  }

  const room = rooms.get(roomId);
  room.clients.add(ws);
  ws.room = roomId;

  log(`Client ${ws.clientId} joined room ${roomId}`);

  // Get list of existing clients in the room
  const existingClients = Array.from(room.clients)
    .filter(client => client !== ws)
    .map(client => client.clientId);

  // Notify the joining client
  sendToClient(ws, {
    type: 'joined',
    roomId: roomId,
    clientId: ws.clientId,
    clients: existingClients
  });

  // Notify other clients in the room
  broadcastToRoom(roomId, {
    type: 'peer-joined',
    clientId: ws.clientId
  }, ws);
}

function handleLeave(ws, message) {
  const { roomId } = message;
  
  if (!roomId || !rooms.has(roomId)) {
    return;
  }

  const room = rooms.get(roomId);
  room.clients.delete(ws);

  log(`Client ${ws.clientId} left room ${roomId}`);

  // Notify other clients
  broadcastToRoom(roomId, {
    type: 'peer-left',
    clientId: ws.clientId
  });

  // Clean up empty rooms
  if (room.clients.size === 0) {
    rooms.delete(roomId);
    log('Room deleted:', roomId);
  }

  ws.room = null;
}

function handleSignaling(ws, message) {
  const { targetId, roomId } = message;

  if (!ws.room) {
    sendToClient(ws, { type: 'error', message: 'Not in a room' });
    return;
  }

  if (!targetId) {
    // Broadcast to all in room if no specific target
    broadcastToRoom(ws.room, {
      ...message,
      senderId: ws.clientId
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
        senderId: ws.clientId
      });
      break;
    }
  }
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
  server.close(() => {
    log('Server closed');
    process.exit(0);
  });
});
