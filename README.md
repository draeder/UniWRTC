# UniWRTC

A universal WebRTC signaling service that provides a simple and flexible WebSocket-based signaling server for WebRTC applications.

## Features

- 🚀 **Simple WebSocket-based signaling** - Easy to integrate with any WebRTC application
- 🏠 **Room-based architecture** - Support for multiple rooms with isolated peer groups
- 🔌 **Flexible client library** - Ready-to-use JavaScript client for browser and Node.js
- 📡 **Real-time messaging** - Efficient message routing between peers
- 🔄 **Auto-reconnection** - Built-in reconnection logic for reliable connections
- 📊 **Health monitoring** - HTTP health check endpoint for monitoring
- 🎯 **Minimal dependencies** - Lightweight implementation using only the `ws` package

## Quick Start

### Installation

#### From npm (recommended)
```bash
npm install uniwrtc
```

Run the bundled server locally (installed binary is `uniwrtc` via npm scripts):
```bash
npx uniwrtc start    # or: node server.js if using the cloned repo
```

#### From source
```bash
git clone https://github.com/draeder/UniWRTC.git
cd UniWRTC
npm install
npm start
```

The signaling server will start on port 8080 by default.

### Environment Configuration

Create a `.env` file based on `.env.example`:

```bash
cp .env.example .env
```

Configure the port:
```
PORT=8080
```

### Try the Demo

Open `demo.html` in your web browser to try the interactive demo:

1. Start the server with `npm start` (local signaling at `ws://localhost:8080`), **or** use the deployed Workers endpoint `wss://signal.peer.ooo`.
2. Open `demo.html` in your browser.
3. Click "Connect" to connect to the signaling server.
4. Enter a room ID and click "Join Room".
5. Open another browser window/tab with the same demo page.
6. Join the same room to see peer connections in action and P2P data channels open.

## Usage

### Server API

The signaling server accepts WebSocket connections and supports the following message types:

#### Client → Server Messages

**Join a room:**
```json
{
  "type": "join",
  "roomId": "room-123"
}
```

**Leave a room:**
```json
{
  "type": "leave",
  "roomId": "room-123"
}
```

**Send WebRTC offer:**
```json
{
  "type": "offer",
  "offer": { /* RTCSessionDescription */ },
  "targetId": "peer-client-id",
  "roomId": "room-123"
}
```

**Send WebRTC answer:**
```json
{
  "type": "answer",
  "answer": { /* RTCSessionDescription */ },
  "targetId": "peer-client-id",
  "roomId": "room-123"
}
```

**Send ICE candidate:**
```json
{
  "type": "ice-candidate",
  "candidate": { /* RTCIceCandidate */ },
  "targetId": "peer-client-id",
  "roomId": "room-123"
}
```

**List available rooms:**
```json
{
  "type": "list-rooms"
}
```

#### Server → Client Messages

**Welcome message (on connection):**
```json
{
  "type": "welcome",
  "clientId": "abc123",
  "message": "Connected to UniWRTC signaling server"
}
```

**Room joined confirmation:**
```json
{
  "type": "joined",
  "roomId": "room-123",
  "clientId": "abc123",
  "clients": ["xyz789", "def456"]
}
```

**Peer joined notification:**
```json
{
  "type": "peer-joined",
  "peerId": "new-peer-id",
  "clientId": "new-peer-id"
}
```

**Peer left notification:**
```json
{
  "type": "peer-left",
  "peerId": "departed-peer-id",
  "clientId": "departed-peer-id"
}
```

### Client Library Usage

Use directly from npm:
```javascript
// ESM
import { UniWRTCClient } from 'uniwrtc/client-browser.js';
// or CommonJS
const { UniWRTCClient } = require('uniwrtc/client-browser.js');
// For Node.js signaling client use 'uniwrtc/client.js'
```

The `client.js` library provides a convenient wrapper for the signaling protocol:

```javascript
// Create a client instance
const client = new UniWRTCClient('ws://localhost:8080');

// Set up event handlers
client.on('connected', (data) => {
  console.log('Connected with ID:', data.clientId);
});

client.on('joined', (data) => {
  console.log('Joined room:', data.roomId);
  console.log('Existing peers:', data.clients);
});

client.on('peer-joined', (data) => {
  console.log('New peer joined:', data.peerId);
  // Initiate WebRTC connection with new peer
});

client.on('offer', (data) => {
  console.log('Received offer from:', data.peerId);
  // Handle WebRTC offer
});

client.on('answer', (data) => {
  console.log('Received answer from:', data.peerId);
  // Handle WebRTC answer
});

client.on('ice-candidate', (data) => {
  console.log('Received ICE candidate from:', data.peerId);
  // Add ICE candidate to peer connection
});

// Connect to the server
await client.connect();

// Join a room
client.joinRoom('my-room');

// Send WebRTC signaling messages
client.sendOffer(offerObject, targetPeerId);
client.sendAnswer(answerObject, targetPeerId);
client.sendIceCandidate(candidateObject, targetPeerId);
```

### Integration Example

Here's a complete example of creating a WebRTC peer connection:

```javascript
const client = new UniWRTCClient('ws://localhost:8080');
const peerConnections = new Map();

// ICE server configuration
const configuration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

// Create peer connection
function createPeerConnection(peerId) {
  const pc = new RTCPeerConnection(configuration);
  
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      client.sendIceCandidate(event.candidate, peerId);
    }
  };
  
  pc.ontrack = (event) => {
    // Handle incoming media stream
    console.log('Received remote track');
  };
  
  peerConnections.set(peerId, pc);
  return pc;
}

// Handle new peer
client.on('peer-joined', async (data) => {
  const pc = createPeerConnection(data.peerId);
  
  // Add local tracks
  const stream = await navigator.mediaDevices.getUserMedia({ 
    video: true, 
    audio: true 
  });
  stream.getTracks().forEach(track => pc.addTrack(track, stream));
  
  // Create and send offer
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  client.sendOffer(offer, data.peerId);
});

// Handle incoming offer
client.on('offer', async (data) => {
  const pc = createPeerConnection(data.peerId);
  
  await pc.setRemoteDescription(data.offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  client.sendAnswer(answer, data.peerId);
});

// Handle incoming answer
client.on('answer', async (data) => {
  const pc = peerConnections.get(data.peerId);
  if (pc) {
    await pc.setRemoteDescription(data.answer);
  }
});

// Handle ICE candidates
client.on('ice-candidate', async (data) => {
  const pc = peerConnections.get(data.peerId);
  if (pc) {
    await pc.addIceCandidate(data.candidate);
  }
});

// Connect and join room
await client.connect();
client.joinRoom('my-video-room');
```

## API Reference

### UniWRTCClient

#### Constructor
```javascript
new UniWRTCClient(serverUrl, options)
```

**Parameters:**
- `serverUrl` (string): WebSocket URL of the signaling server
- `options` (object, optional):
  - `autoReconnect` (boolean): Enable automatic reconnection (default: true)
  - `reconnectDelay` (number): Delay between reconnection attempts in ms (default: 3000)

#### Methods

- `connect()`: Connect to the signaling server (returns Promise)
- `disconnect()`: Disconnect from the server
- `joinRoom(roomId)`: Join a specific room
- `leaveRoom()`: Leave the current room
- `sendOffer(offer, targetId)`: Send a WebRTC offer
- `sendAnswer(answer, targetId)`: Send a WebRTC answer
- `sendIceCandidate(candidate, targetId)`: Send an ICE candidate
- `listRooms()`: Request list of available rooms
- `on(event, handler)`: Register event handler
- `off(event, handler)`: Unregister event handler

#### Events

- `connected`: Fired when connected to the server
- `disconnected`: Fired when disconnected from the server
- `joined`: Fired when successfully joined a room
- `peer-joined`: Fired when another peer joins the room
- `peer-left`: Fired when a peer leaves the room
- `offer`: Fired when receiving a WebRTC offer
- `answer`: Fired when receiving a WebRTC answer
- `ice-candidate`: Fired when receiving an ICE candidate
- `room-list`: Fired when receiving the list of rooms
- `error`: Fired on error

## Health Check

The server provides an HTTP health check endpoint:

```bash
curl http://localhost:8080/health
```

Response:
```json
{
  "status": "ok",
  "connections": 5
}
```

## Architecture

### Room Management

- Each room is identified by a unique room ID (string)
- Clients can join/leave rooms dynamically
- Messages can be sent to specific peers or broadcast to all peers in a room
- Empty rooms are automatically cleaned up

### Message Flow

1. Client connects via WebSocket
2. Server assigns a unique client ID
3. Client joins a room
4. Server notifies existing peers about the new client
5. Peers exchange WebRTC signaling messages through the server
6. Server routes messages based on target ID or broadcasts to room

## Security Considerations

This is a basic signaling server suitable for development and testing. For production use, consider:

- Adding authentication and authorization
- Implementing rate limiting
- Using TLS/WSS for encrypted connections
- Adding room access controls
- Implementing message validation
- Monitoring and logging
- Setting up CORS policies

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
