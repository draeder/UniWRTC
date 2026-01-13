/**
 * UniWRTC Client - Cloudflare Durable Objects (HTTP polling)
 * No WebSockets.
 */

class UniWRTCClient {
  constructor(serverUrl, options = {}) {
    this.serverUrl = serverUrl;
    this.clientId = null;
    this.sessionId = null;
    this._pollTimer = null;

    this.options = {
      autoReconnect: true,
      reconnectDelay: 3000,
      pollIntervalMs: 500,
      roomId: options.roomId || 'default',
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

  baseOrigin() {
    const parsed = new URL(this.serverUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Server URL must start with http(s):// (WebSockets are disabled)');
    }
    return parsed.origin;
  }

  apiUrl(pathname, extraSearch = {}) {
    const origin = this.baseOrigin();
    const url = new URL(origin + pathname);
    url.searchParams.set('room', this.options.roomId);
    for (const [k, v] of Object.entries(extraSearch)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  async postJson(pathname, body) {
    const res = await fetch(this.apiUrl(pathname), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const message = data?.message || `HTTP ${res.status}`;
      throw new Error(message);
    }
    return data;
  }

  startPolling() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(() => {
      this.pollOnce().catch((err) => {
        this.emit('error', { message: err?.message || String(err) });
      });
    }, this.options.pollIntervalMs);
  }

  stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  async connect() {
    try {
      const welcome = await this.postJson('/api/connect', {});
      this.clientId = welcome.clientId;

      if (this.options.customPeerId) {
        const res = await this.postJson('/api/set-id', {
          clientId: this.clientId,
          customId: this.options.customPeerId
        });
        this.clientId = res.clientId;
      }

      this.emit('connected', { clientId: this.clientId });
      this.startPolling();
      return this.clientId;
    } catch (error) {
      this.emit('error', { message: error?.message || String(error) });
      if (this.options.autoReconnect) {
        setTimeout(() => this.connect(), this.options.reconnectDelay);
      }
      throw error;
    }
  }

  async disconnect() {
    this.options.autoReconnect = false;
    this.stopPolling();
    if (this.clientId) {
      try {
        await this.postJson('/api/leave', { clientId: this.clientId });
      } catch {
        // ignore
      }
    }
    this.emit('disconnected');
  }

  async joinSession(sessionId) {
    if (!this.clientId) throw new Error('Not connected');
    if (this.sessionId === sessionId) return;
    this.sessionId = sessionId;

    const joined = await this.postJson('/api/join', {
      clientId: this.clientId,
      sessionId
    });

    this.emit('joined', {
      sessionId: joined.sessionId,
      clientId: joined.clientId,
      clients: joined.clients
    });
  }

  async leaveSession() {
    this.sessionId = null;
  }

  async pollOnce() {
    if (!this.clientId) return;
    const url = this.apiUrl('/api/poll', { clientId: this.clientId });
    const res = await fetch(url, { method: 'GET' });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(data?.message || `HTTP ${res.status}`);
    }

    const messages = Array.isArray(data?.messages) ? data.messages : [];
    for (const msg of messages) {
      this.handleMessage(msg);
    }
  }

  async sendSignal(payload) {
    if (!this.clientId) throw new Error('Not connected');
    await this.postJson('/api/signal', {
      clientId: this.clientId,
      sessionId: this.sessionId,
      ...payload
    });
  }

  sendOffer(offer, targetId) {
    const offerSdp = typeof offer === 'string' ? offer : offer?.sdp;
    return this.sendSignal({ type: 'offer', offer: offerSdp, targetId });
  }

  sendAnswer(answer, targetId) {
    const answerSdp = typeof answer === 'string' ? answer : answer?.sdp;
    return this.sendSignal({ type: 'answer', answer: answerSdp, targetId });
  }

  sendIceCandidate(candidate, targetId) {
    const candidateText =
      typeof candidate === 'string'
        ? candidate
        : candidate && typeof candidate === 'object' && typeof candidate.candidate === 'string'
          ? `${candidate.candidate}|${candidate.sdpMid ?? ''}|${candidate.sdpMLineIndex ?? ''}`
          : candidate;
    return this.sendSignal({ type: 'ice-candidate', candidate: candidateText, targetId });
  }

  listRooms() {
    console.log('Room listing not available with Durable Objects');
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
        this.clientId = message.clientId;
        break;
      case 'joined':
        this.sessionId = message.sessionId;
        this.emit('joined', {
          sessionId: message.sessionId,
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
      case 'error':
        this.emit('error', {
          message: message.message
        });
        break;
      default:
        console.log('Unknown message type:', message.type);
    }
  }
}

export default UniWRTCClient;
