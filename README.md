# UniWRTC

A WebRTC demo + signaling utilities.

The default demo flow uses **Nostr relays for WebRTC signaling** (offer/answer/ICE + presence) and a **WebRTC data channel for app data**.

This repo also includes an optional **legacy HTTP polling signaling server** (useful for local development), but the live demo is now fully static/serverless.

Available on npm: https://www.npmjs.com/package/uniwrtc

## Features

- 🤝 **Nostr signaling (demo default)** - WebRTC offer/answer/ICE + presence over Nostr relays
- 📦 **WebRTC for data** - App/chat data rides the data channel (not the relay)
- 🏠 **Session-based rooms** - Multiple sessions with isolated peer groups
- 🔌 **Optional legacy server** - HTTP polling signaling server (local/dev)
- 🧊 **STUN-only** - No TURN in the default demo

## Quick Start

## Using with `simple-peer` (Nostr signaling)

The repo’s default demo uses Nostr relays for signaling. Here’s a minimal `simple-peer` example that uses the built-in Nostr client for signaling messages.

`createNostrClient` is available from the published package as `uniwrtc/nostr`.

Example (browser, two tabs):

```js
import Peer from 'simple-peer';
import { createNostrClient } from 'uniwrtc/nostr';

const relayUrl = 'wss://relay.damus.io';
const room = 'my-room';

const nostr = createNostrClient({
  relayUrl,
  room,
  onPayload: ({ from, payload }) => {
    // Only accept signals intended for us
    if (payload?.type !== 'sp-signal') return;
    if (payload?.to !== myId) return;
    if (targetId && from !== targetId) return;

    try {
      peer.signal(payload.signal);
    } catch (e) {
      console.warn('Failed to apply signal:', e);
    }
  },
});

await nostr.connect();

const myId = nostr.getPublicKey();
console.log('My Peer ID:', myId);

// Set this in each tab (copy/paste from the other tab)
const targetId = prompt('Paste the other Peer ID:')?.trim();
if (!targetId) throw new Error('Missing targetId');

// Deterministic initiator prevents offer collisions
const initiator = myId.localeCompare(targetId) < 0;

const peer = new Peer({ initiator, trickle: true });

peer.on('signal', async (signal) => {
  // Send signaling via Nostr; WebRTC data stays P2P.
  await nostr.send({
    type: 'sp-signal',
    to: targetId,
    signal,
  });
});

peer.on('connect', () => {
  console.log('WebRTC connected');
  peer.send('hello over datachannel');
});

peer.on('data', (data) => {
  console.log('Got data:', data.toString());
});
```

Note: Nostr relays are generally public. Don’t send secrets in signaling payloads.

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

The interactive demo is available live at **https://signal.peer.ooo/** (Cloudflare Pages static site) or run locally.

The demo uses:
- Nostr relays for signaling
- WebRTC data channels for data/chat

**Using the deployed demo (recommended):**
1. Open https://signal.peer.ooo/ in two browser tabs
2. Default room is `demo-room`—both tabs will auto-connect
3. Click "Connect" to join
4. Watch the activity log to see peers connecting
5. Open the P2P chat and send messages between tabs

**Or run locally:**
1. Install deps: `npm install`
2. Start Vite: `npm run dev` (demo at `http://localhost:5173/`)
3. Open the demo in two browser tabs
4. Enter the same session ID in both, then Connect
5. Chat P2P once data channels open

### Nostr Relay “Check” (Demo)

When you click **Connect**, the demo doesn’t just pick the first relay that opens a WebSocket.

It tries relay URLs (in small parallel batches) and selects the first relay that:

1. Connects successfully over WebSocket, and
2. Accepts a published signed event and replies with a NIP-20 `OK` response.

This publish check uses a short timeout (currently ~3.5s) so the UI doesn’t hang on relays that connect but won’t accept publishes.

## Usage

### Legacy HTTP Signaling Server API (optional)

The signaling server supports:
- HTTP polling signaling (no WebSockets)

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
  "offer": "v=0\r\n...",
  "targetId": "peer-client-id",
  "sessionId": "session-123"
}
```

**Send WebRTC answer:**
```json
{
  "type": "answer",
  "answer": "v=0\r\n...",
  "targetId": "peer-client-id",
  "sessionId": "session-123"
}
```

**Send ICE candidate:**
```json
{
  "type": "ice-candidate",
  "candidate": "candidate:...|0|0",
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
```

The `client.js` library provides a convenient wrapper for the signaling protocol:

```javascript
// Create a client instance
const client = new UniWRTCClient('http://localhost:8080', { roomId: 'my-room' });

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
await client.joinSession('my-session');

// Send WebRTC signaling messages
client.sendOffer(offerObject, targetPeerId);
client.sendAnswer(answerObject, targetPeerId);
client.sendIceCandidate(candidateObject, targetPeerId);
```

### Integration Example

Here's a complete example of creating a WebRTC peer connection:

```javascript
const client = new UniWRTCClient('http://localhost:8080', { roomId: 'my-room' });
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
  
  await pc.setRemoteDescription({ type: 'offer', sdp: data.offer });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  client.sendAnswer(answer, data.peerId);
});

// Handle incoming answer
client.on('answer', async (data) => {
  const pc = peerConnections.get(data.peerId);
  if (pc) {
    await pc.setRemoteDescription({ type: 'answer', sdp: data.answer });
  }
});

// Handle ICE candidates
client.on('ice-candidate', async (data) => {
  const pc = peerConnections.get(data.peerId);
  if (pc) {
    const [candidate, sdpMidRaw, sdpMLineIndexRaw] = String(data.candidate).split('|');
    await pc.addIceCandidate(new RTCIceCandidate({
      candidate,
      sdpMid: sdpMidRaw || undefined,
      sdpMLineIndex: sdpMLineIndexRaw !== undefined && sdpMLineIndexRaw !== '' ? Number(sdpMLineIndexRaw) : undefined
    }));
  }
});

// Connect and join session
await client.connect();
client.joinSession('my-video-session');

// Note: https://signal.peer.ooo is the static demo site (Nostr signaling),
// not an HTTP polling signaling server endpoint.
```

## API Reference

### UniWRTCClient

#### Constructor
```javascript
new UniWRTCClient(serverUrl, options)
```

**Parameters:**
- `serverUrl` (string): HTTP(S) URL of the signaling server
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

### Nostr Signaling (Demo Default)

- Peers publish signaling messages (offer/answer/ICE/presence) to a Nostr relay.
- Messages are scoped to a room/session and targeted to a specific peer session.
- Once the WebRTC data channel opens, application data/chat is sent P2P.
- This is designed to work without running your own signaling server.

### Session-based Peer Isolation

- **Sessions**: Each session is identified by a unique string ID (also called "room" in the UI)
- **Peer routing**: Each peer gets a unique client ID; signaling messages are routed only to intended targets
- **Session isolation**: Peers in different sessions cannot see or communicate with each other
- Clients join with `joinSession(sessionId)` and receive notifications when other peers join the same session

### Message Flow

This section applies to the legacy HTTP polling server:

1. Client connects via HTTP(S)
2. Server assigns a unique client ID
3. Client sends join message with session ID
4. Server broadcasts `peer-joined` to other peers in the same session only
5. Peers exchange WebRTC offers/answers/ICE candidates via the server
6. Server routes signaling messages to specific peers by target ID (unicast, not broadcast)

Notes:
- Server signaling uses JSON over HTTPS requests to `/api` (polling).
- Offers/answers are transmitted as SDP strings (text-only) in the `offer`/`answer` fields.
- ICE candidates are transmitted as a compact text string: `candidate|sdpMid|sdpMLineIndex`.

## Security Considerations

This is a basic signaling server suitable for development and testing. For production use, consider:

- Adding authentication and authorization
- Implementing rate limiting
- Using TLS/HTTPS for encrypted connections
- Adding room access controls
- Implementing message validation
- Monitoring and logging
- Setting up CORS policies

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
