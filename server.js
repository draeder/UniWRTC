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
    peerId: ws.clientId
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
    peerId: ws.clientId
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
  const { roomId, text } = message;
  
  if (!roomId || !text) {
    sendToClient(ws, { type: 'error', message: 'Room ID and text are required' });
    return;
  }

  log(`Chat message in room ${roomId}: ${text.substring(0, 50)}`);

  const room = rooms.get(roomId);
  if (!room) {
    sendToClient(ws, { type: 'error', message: 'Room not found' });
    return;
  }

  // Broadcast chat to ALL clients in the room (including sender)
  room.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: 'chat',
        text: text,
        peerId: ws.clientId,
        roomId: roomId
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
