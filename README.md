# UniWRTC

A universal WebRTC signaling service that provides a simple and flexible WebSocket-based signaling server for WebRTC applications.

Available on npm: https://www.npmjs.com/package/uniwrtc

## Features

- 🚀 **Simple WebSocket-based signaling** - Easy to integrate with any WebRTC application
- 🏠 **Session-based architecture** - Support for multiple sessions with isolated peer groups
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

The interactive demo is available live at **https://signal.peer.ooo/** (Cloudflare Workers deployment) or run locally:

**Using the deployed demo (recommended):**
1. Open https://signal.peer.ooo/ in two browser tabs
2. Default room is `demo-room`—both tabs will auto-connect
3. Click "Connect" to join
4. Watch the activity log to see peers connecting
5. Open the P2P chat and send messages between tabs

**Or run locally:**
1. Start the server: `npm start` (signaling at `ws://localhost:8080`)
2. Start the Vite dev server: `npm run dev` (demo at `http://localhost:5173/`)
3. Open the demo in two browser tabs
4. Enter the same session ID in both, then Connect
5. Chat P2P once data channels open

## Usage

### Server API

The signaling server accepts WebSocket connections and supports the following message types:

#### Client → Server Messages

**Join a session:**
```json
{
  "type": "join",
  "sessionId": "session-123"
}
```

**Leave a session:**
```json
{
  "type": "leave",
  "sessionId": "session-123"
}
```

**Send WebRTC offer:**
```json
{
  "type": "offer",
  "offer": { /* RTCSessionDescription */ },
  "targetId": "peer-client-id",
  "sessionId": "session-123"
}
```

**Send WebRTC answer:**
```json
{
  "type": "answer",
  "answer": { /* RTCSessionDescription */ },
  "targetId": "peer-client-id",
  "sessionId": "session-123"
}
```

**Send ICE candidate:**
```json
{
  "type": "ice-candidate",
  "candidate": { /* RTCIceCandidate */ },
  "targetId": "peer-client-id",
  "sessionId": "session-123"
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

**Session joined confirmation:**
```json
{
  "type": "joined",
  "sessionId": "session-123",
  "clientId": "abc123",
  "clients": ["xyz789", "def456"]
}
```

**Peer joined notification:**
```json
{
  "type": "peer-joined",
  "sessionId": "session-123",
  "peerId": "new-peer-id"
}
```

**Peer left notification:**
```json
{
  "type": "peer-left",
  "sessionId": "session-123",
  "peerId": "departed-peer-id"
}
```

### Client Library Usage

Use directly from npm:
```javascript
// ESM (browser)
import UniWRTCClient from 'uniwrtc/client-browser.js';

// CommonJS (Node.js)
const UniWRTCClient = require('uniwrtc/client.js');
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
  console.log('Joined session:', data.sessionId);
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

// Join a session
client.joinSession('my-session');

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

// Connect and join session
await client.connect();
client.joinSession('my-video-session');

// Or use Cloudflare Durable Objects deployment
const cfClient = new UniWRTCClient('wss://signal.peer.ooo?room=my-session');
await cfClient.connect();
cfClient.joinSession('my-session');
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
- `joinSession(sessionId)`: Join a specific session (peers isolated by session)
- `leaveSession()`: Leave the current session
- `sendOffer(offer, targetId)`: Send a WebRTC offer to a specific peer
- `sendAnswer(answer, targetId)`: Send a WebRTC answer to a specific peer
- `sendIceCandidate(candidate, targetId)`: Send an ICE candidate to a specific peer
- `listRooms()`: Request list of available sessions (legacy)
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

The server provides an HTTP health check endpoint for monitoring:

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

### Session-based Peer Isolation

- **Sessions**: Each session is identified by a unique string ID (also called "room" in the UI)
- **Peer routing**: Each peer gets a unique client ID; signaling messages are routed only to intended targets
- **Session isolation**: Peers in different sessions cannot see or communicate with each other
- **Cloudflare Durable Objects**: Uses DO state to isolate sessions; routing by `?room=` query param per session
- Clients join with `joinSession(sessionId)` and receive notifications when other peers join the same session

### Message Flow

1. Client connects via WebSocket (or WS-over-HTTP for Cloudflare)
2. Server/Durable Object assigns a unique client ID
3. Client sends join message with session ID
4. Server broadcasts `peer-joined` to other peers in the same session only
5. Peers exchange WebRTC offers/answers/ICE candidates via the server
6. Server routes signaling messages to specific peers by target ID (unicast, not broadcast)

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
