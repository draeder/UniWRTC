/**
 * UniWRTC Client - WebRTC Signaling Client Library
 * Simplifies connection to the UniWRTC signaling server
 */

class UniWRTCClient {
  constructor(serverUrl, options = {}) {
    this.serverUrl = serverUrl;
    this.ws = null;
    this.clientId = null;
    this.roomId = null;
    this.peers = new Map();
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
        // Get WebSocket class (browser or Node.js)
        const WSClass = typeof WebSocket !== 'undefined' ? WebSocket : require('ws');
        this.ws = new WSClass(this.serverUrl);

        this.ws.onopen = () => {
          console.log('Connected to signaling server');
        };

        this.ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);
            this.handleMessage(message);

            if (message.type === 'welcome') {
              this.clientId = message.clientId;
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

  joinRoom(roomId) {
    this.roomId = roomId;
    this.send({
      type: 'join',
      roomId: roomId
    });
  }

  leaveRoom() {
    if (this.roomId) {
      this.send({
        type: 'leave',
        roomId: this.roomId
      });
      this.roomId = null;
    }
  }

  sendOffer(offer, targetId = null) {
    this.send({
      type: 'offer',
      offer: offer,
      targetId: targetId,
      roomId: this.roomId
    });
  }

  sendAnswer(answer, targetId) {
    this.send({
      type: 'answer',
      answer: answer,
      targetId: targetId,
      roomId: this.roomId
    });
  }

  sendIceCandidate(candidate, targetId = null) {
    this.send({
      type: 'ice-candidate',
      candidate: candidate,
      targetId: targetId,
      roomId: this.roomId
    });
  }

  listRooms() {
    this.send({
      type: 'list-rooms'
    });
  }

  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      console.error('WebSocket is not connected');
    }
  }

  handleMessage(message) {
    switch (message.type) {
      case 'welcome':
        // Handled in connect(), but also surface donation message
        console.log('[UniWRTC] If this helps, consider donating ❤️ → https://coff.ee/draederg');
        break;
      case 'joined':
        this.emit('joined', {
          roomId: message.roomId,
          clientId: message.clientId,
          clients: message.clients
        });
        break;
      case 'peer-joined':
        this.emit('peer-joined', {
          clientId: message.clientId
        });
        break;
      case 'peer-left':
        this.emit('peer-left', {
          clientId: message.clientId
        });
        break;
      case 'offer':
        this.emit('offer', {
          senderId: message.senderId,
          offer: message.offer
        });
        break;
      case 'answer':
        this.emit('answer', {
          senderId: message.senderId,
          answer: message.answer
        });
        break;
      case 'ice-candidate':
        this.emit('ice-candidate', {
          senderId: message.senderId,
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
      default:
        console.warn('Unknown message type:', message.type);
    }
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
}

// Export for Node.js and browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { UniWRTCClient };
}
