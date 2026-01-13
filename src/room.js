/**
 * Durable Object for WebRTC signaling (HTTP polling only)
 */
export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    // HTTP mode (no WebSockets)
    this.httpClients = new Map(); // clientId -> { lastSeen: number, sessionId: string | null }
    this.httpQueues = new Map(); // clientId -> Array<message>
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.headers.get('Upgrade') === 'websocket') {
      return new Response('WebSockets disabled; use /api (HTTP polling)', { status: 410 });
    }

    // HTTP signaling API (no WebSockets)
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return this.handleHttpApi(request, url);
    }

    return new Response('Not Found', { status: 404 });
  }

  json(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      }
    });
  }

  ensureHttpQueue(clientId) {
    if (!this.httpQueues.has(clientId)) this.httpQueues.set(clientId, []);
    return this.httpQueues.get(clientId);
  }

  enqueueHttpMessage(clientId, message) {
    const queue = this.ensureHttpQueue(clientId);
    queue.push(message);
  }

  pruneHttpClients(now = Date.now()) {
    const STALE_MS = 60_000;
    const stale = [];
    for (const [id, meta] of this.httpClients) {
      if (now - meta.lastSeen > STALE_MS) stale.push(id);
    }
    for (const id of stale) {
      this.httpClients.delete(id);
      this.httpQueues.delete(id);
      for (const [otherId] of this.httpClients) {
        this.enqueueHttpMessage(otherId, { type: 'peer-left', peerId: id, sessionId: null });
      }
    }
  }

  async readJson(request) {
    try {
      return await request.json();
    } catch {
      return null;
    }
  }

  async handleHttpApi(request, url) {
    this.pruneHttpClients();

    const path = url.pathname;

    if (request.method === 'POST' && (path === '/api/connect' || path === '/api')) {
      const clientId = crypto.randomUUID().substring(0, 9);
      this.httpClients.set(clientId, { lastSeen: Date.now(), sessionId: null });
      this.ensureHttpQueue(clientId);
      return this.json({ type: 'welcome', clientId, message: 'Connected (HTTP polling)' });
    }

    if (request.method === 'POST' && path === '/api/set-id') {
      const body = await this.readJson(request);
      const { clientId, customId } = body || {};
      if (!clientId || !this.httpClients.has(clientId)) return this.json({ type: 'error', message: 'Unknown clientId' }, 400);
      if (!customId || customId.length < 3 || customId.length > 20) return this.json({ type: 'error', message: 'Custom ID must be 3-20 characters' }, 400);
      if (this.httpClients.has(customId)) return this.json({ type: 'error', message: 'Peer ID already taken' }, 409);

      const meta = this.httpClients.get(clientId);
      const queue = this.ensureHttpQueue(clientId);

      this.httpClients.delete(clientId);
      this.httpClients.set(customId, { ...meta, lastSeen: Date.now() });
      this.httpQueues.delete(clientId);
      this.httpQueues.set(customId, queue);

      for (const [otherId] of this.httpClients) {
        if (otherId !== customId) {
          this.enqueueHttpMessage(otherId, { type: 'peer-id-changed', oldId: clientId, newId: customId });
        }
      }

      return this.json({ type: 'welcome', clientId: customId, message: 'Custom peer ID set' });
    }

    if (request.method === 'POST' && path === '/api/join') {
      const body = await this.readJson(request);
      const { clientId, sessionId } = body || {};
      if (!clientId || !this.httpClients.has(clientId)) return this.json({ type: 'error', message: 'Unknown clientId' }, 400);

      const meta = this.httpClients.get(clientId);
      meta.lastSeen = Date.now();
      meta.sessionId = sessionId || meta.sessionId || null;

      const peers = Array.from(this.httpClients.keys()).filter(id => id !== clientId);

      for (const [otherId, otherMeta] of this.httpClients) {
        if (otherId !== clientId) {
          this.enqueueHttpMessage(otherId, { type: 'peer-joined', peerId: clientId, sessionId: otherMeta.sessionId || meta.sessionId || null });
        }
      }

      return this.json({
        type: 'joined',
        sessionId: meta.sessionId,
        clientId,
        clients: peers
      });
    }

    if (request.method === 'POST' && path === '/api/leave') {
      const body = await this.readJson(request);
      const { clientId } = body || {};
      if (!clientId || !this.httpClients.has(clientId)) return this.json({ type: 'error', message: 'Unknown clientId' }, 400);

      this.httpClients.delete(clientId);
      this.httpQueues.delete(clientId);
      for (const [otherId] of this.httpClients) {
        this.enqueueHttpMessage(otherId, { type: 'peer-left', peerId: clientId, sessionId: null });
      }
      return this.json({ ok: true });
    }

    if (request.method === 'POST' && path === '/api/signal') {
      const body = await this.readJson(request);
      const { clientId, targetId, type, offer, answer, candidate, sessionId } = body || {};
      if (!clientId || !this.httpClients.has(clientId)) return this.json({ type: 'error', message: 'Unknown clientId' }, 400);
      if (!targetId) return this.json({ type: 'error', message: 'targetId is required' }, 400);
      if (!this.httpClients.has(targetId)) return this.json({ type: 'error', message: `Target peer ${targetId} not found` }, 404);
      if (!type) return this.json({ type: 'error', message: 'type is required' }, 400);

      const meta = this.httpClients.get(clientId);
      meta.lastSeen = Date.now();
      if (sessionId && !meta.sessionId) meta.sessionId = sessionId;

      const forwardMessage = { type, peerId: clientId };
      if (offer) forwardMessage.offer = offer;
      if (answer) forwardMessage.answer = answer;
      if (candidate) forwardMessage.candidate = candidate;

      this.enqueueHttpMessage(targetId, forwardMessage);
      return this.json({ ok: true });
    }

    if (request.method === 'GET' && path === '/api/poll') {
      const clientId = url.searchParams.get('clientId');
      if (!clientId || !this.httpClients.has(clientId)) return this.json({ type: 'error', message: 'Unknown clientId' }, 400);
      const meta = this.httpClients.get(clientId);
      meta.lastSeen = Date.now();

      const queue = this.ensureHttpQueue(clientId);
      const messages = queue.splice(0, queue.length);
      return this.json({ messages });
    }

    return this.json({ type: 'error', message: 'Not Found' }, 404);
  }
}
