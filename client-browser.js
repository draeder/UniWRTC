/**
 * UniWRTC Client - WebRTC Signaling Client Library
 * Browser-only version
 */

class UniWRTCClient {
  constructor(serverUrl, options = {}) {
    this.serverUrl = serverUrl;
    this.ws = null;
    this.clientId = null;
    this.sessionId = null;
    this.peers = new Map();
    this._connectedOnce = false;
    this.options = {
      autoReconnect: true,
      reconnectDelay: 3000,
      ...options
    };
    this.eventHandlers = {
      'connected': [],
      'disconnected': [],
      'joined': [],
      'peer-joined': [],
      'peer-left': [],
      'offer': [],
      'answer': [],
      'ice-candidate': [],
      'room-list': [],
      'error': []
    };
  }

  connect() {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.serverUrl);

        this.ws.onopen = () => {
          console.log('Connected to signaling server');
          
          // Send custom peer ID if provided
          if (this.options.customPeerId) {
            this.send({
              type: 'set-id',
              customId: this.options.customPeerId
            });
          }
        };

        this.ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);
            this.handleMessage(message);

            if (message.type === 'welcome' && !this._connectedOnce) {
              this.clientId = message.clientId;
              this._connectedOnce = true;
              this.emit('connected', { clientId: this.clientId });
              resolve(this.clientId);
            }
          } catch (error) {
            console.error('Error parsing message:', error);
          }
        };

        this.ws.onclose = () => {
          console.log('Disconnected from signaling server');
          this.emit('disconnected');
          
          if (this.options.autoReconnect) {
            setTimeout(() => {
              console.log('Attempting to reconnect...');
              this.connect();
            }, this.options.reconnectDelay);
          }
        };

        this.ws.onerror = (error) => {
          console.error('WebSocket error:', error);
          reject(error);
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  disconnect() {
    if (this.ws) {
      this.options.autoReconnect = false;
      this.ws.close();
      this.ws = null;
    }
  }

  joinSession(sessionId) {
    // Prevent duplicate join calls for the same session
    if (this.sessionId === sessionId) return;
    this.sessionId = sessionId;
    
    // Send join message
    this.send({
      type: 'join',
      sessionId: sessionId,
      peerId: this.clientId
    });
  }

  leaveSession() {
    if (this.sessionId) {
      this.send({
        type: 'leave',
        sessionId: this.sessionId
      });
      this.sessionId = null;
    }
  }

  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      console.warn('WebSocket is not connected');
    }
  }

  sendOffer(offer, targetId) {
    this.send({
      type: 'offer',
      offer: offer,
      targetId: targetId,
      sessionId: this.sessionId
    });
  }

  sendAnswer(answer, targetId) {
    this.send({
      type: 'answer',
      answer: answer,
      targetId: targetId,
      sessionId: this.sessionId
    });
  }

  sendIceCandidate(candidate, targetId) {
    this.send({
      type: 'ice-candidate',
      candidate: candidate,
      targetId: targetId,
      sessionId: this.sessionId
    });
  }

  listRooms() {
    this.send({
      type: 'list-rooms'
    });
  }

  on(event, handler) {
    if (this.eventHandlers[event]) {
      this.eventHandlers[event].push(handler);
    }
  }

  off(event, handler) {
    if (this.eventHandlers[event]) {
      this.eventHandlers[event] = this.eventHandlers[event].filter(h => h !== handler);
    }
  }

  emit(event, data) {
    if (this.eventHandlers[event]) {
      this.eventHandlers[event].forEach(handler => {
        try {
          handler(data);
        } catch (error) {
          console.error(`Error in ${event} handler:`, error);
        }
      });
    }
  }

  handleMessage(message) {
    switch (message.type) {
      case 'welcome':
        // Only set clientId here; 'connected' is emitted in connect() with a guard
        this.clientId = message.clientId;
        console.log('[UniWRTC] If this helps, consider donating ❤️ → https://coff.ee/draederg');
        break;
      case 'joined':
        this.sessionId = message.sessionId;
        this.emit('joined', {
          sessionId: message.sessionId,
          peerId: message.peerId,
          clientId: message.clientId,
          clients: message.clients
        });
        break;
      case 'peer-joined':
        this.emit('peer-joined', {
          sessionId: message.sessionId,
          peerId: message.peerId
        });
        break;
      case 'peer-left':
        this.emit('peer-left', {
          sessionId: message.sessionId,
          peerId: message.peerId
        });
        break;
      case 'offer':
        this.emit('offer', {
          peerId: message.peerId,
          offer: message.offer
        });
        break;
      case 'answer':
        this.emit('answer', {
          peerId: message.peerId,
          answer: message.answer
        });
        break;
      case 'ice-candidate':
        this.emit('ice-candidate', {
          peerId: message.peerId,
          candidate: message.candidate
        });
        break;
      case 'room-list':
        this.emit('room-list', {
          rooms: message.rooms
        });
        break;
      case 'error':
        this.emit('error', {
          message: message.message
        });
        break;
      case 'chat':
        this.emit('chat', {
          text: message.text,
          peerId: message.peerId,
          sessionId: message.sessionId
        });
        break;
      default:
        console.log('Unknown message type:', message.type);
    }
  }
}

// Attach to window for non-module script usage
if (typeof window !== 'undefined') {
  window.UniWRTCClient = UniWRTCClient;
}
