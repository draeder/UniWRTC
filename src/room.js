/**
 * Durable Object for WebRTC Signaling Room
 * Manages peers in a room and routes signaling messages
 */
export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.clients = new Map(); // Map of clientId -> WebSocket
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') === 'websocket') {
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();

      const clientId = crypto.randomUUID().substring(0, 9);
      this.clients.set(clientId, server);

      console.log(`[Room] Client ${clientId} connected (total: ${this.clients.size})`);

      // Send welcome message
      server.send(JSON.stringify({
        type: 'welcome',
        clientId: clientId,
        message: 'Connected to UniWRTC signaling room'
      }));

      // NOTE: peer-joined is sent when client explicitly joins via 'join' message

      server.onmessage = async (event) => {
        try {
          const message = JSON.parse(event.data);
          await this.handleMessage(clientId, message);
        } catch (error) {
          console.error('[Room] Message error:', error);
          server.send(JSON.stringify({ type: 'error', message: error.message }));
        }
      };

      server.onclose = () => {
        console.log(`[Room] Client ${clientId} left`);
        this.clients.delete(clientId);
        // Note: sessionId should be tracked per client if needed
        this.broadcast({
          type: 'peer-left',
          peerId: clientId
        });
      };

      server.onerror = (error) => {
        console.error('[Room] WebSocket error:', error);
      };

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Not a WebSocket request', { status: 400 });
  }

  async handleMessage(clientId, message) {
    switch (message.type) {
      case 'join':
        await this.handleJoin(clientId, message);
        break;
      case 'set-id':
        await this.handleSetId(clientId, message);
        break;
      case 'offer':
      case 'answer':
      case 'ice-candidate':
        await this.handleSignaling(clientId, message);
        break;
      default:
        console.log(`[Room] Unknown message type: ${message.type}`);
    }
  }

  async handleJoin(clientId, message) {
    const { sessionId, peerId } = message;
    
    // Get list of other peers
    const peers = Array.from(this.clients.keys())
      .filter(id => id !== clientId);
    
    const client = this.clients.get(clientId);
    if (client && client.readyState === WebSocket.OPEN) {
      // Send joined confirmation (align with server schema)
      client.send(JSON.stringify({
        type: 'joined',
        sessionId: sessionId,
        clientId: clientId,
        clients: peers
      }));
    }
    
    // Notify other peers
    this.broadcast({
      type: 'peer-joined',
      sessionId: sessionId,
      peerId: clientId
    }, clientId);
  }

  async handleSetId(clientId, message) {
    const { customId } = message;
    
    if (!customId || customId.length < 3 || customId.length > 20) {
      const client = this.clients.get(clientId);
      if (client && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'error',
          message: 'Custom ID must be 3-20 characters'
        }));
      }
      return;
    }

    // Check if ID is already taken
    let idTaken = false;
    for (const [id, ws] of this.clients) {
      if (id !== clientId && id === customId) {
        idTaken = true;
        break;
      }
    }

    if (idTaken) {
      const client = this.clients.get(clientId);
      if (client && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'error',
          message: 'Peer ID already taken'
        }));
      }
      return;
    }

    // Update client ID
    const ws = this.clients.get(clientId);
    this.clients.delete(clientId);
    this.clients.set(customId, ws);

    console.log(`[Room] Client changed ID from ${clientId} to ${customId}`);

    // Send confirmation
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'welcome',
        clientId: customId,
        message: 'Custom peer ID set'
      }));
    }

    // Notify others of ID change
    this.broadcast({
      type: 'peer-id-changed',
      oldId: clientId,
      newId: customId
    });
  }

  async handleSignaling(clientId, message) {
    const { targetId, type, offer, answer, candidate } = message;

    if (!targetId) {
      console.log(`[Room] Signaling without target`);
      return;
    }

    const targetClient = this.clients.get(targetId);
    if (!targetClient || targetClient.readyState !== WebSocket.OPEN) {
      console.log(`[Room] Target client ${targetId} not found or closed`);
      const client = this.clients.get(clientId);
      if (client && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'error',
          message: `Target peer ${targetId} not found`
        }));
      }
      return;
    }

    console.log(`[Room] Routing ${type} from ${clientId} to ${targetId}`);

    // Route signaling message to target
    const forwardMessage = {
      type: type,
      peerId: clientId
    };

    if (offer) forwardMessage.offer = offer;
    if (answer) forwardMessage.answer = answer;
    if (candidate) forwardMessage.candidate = candidate;

    targetClient.send(JSON.stringify(forwardMessage));
  }

  broadcast(message, excludeClientId = null) {
    const payload = JSON.stringify(message);
    for (const [clientId, client] of this.clients) {
      if (clientId !== excludeClientId && client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }
}
