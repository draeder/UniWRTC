import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function isHex64(s) {
  return typeof s === 'string' && /^[0-9a-fA-F]{64}$/.test(s);
}

/**
 * Minimal Nostr relay client using raw WebSocket protocol.
 * - Publishes kind:1 events tagged with ['t', room] and ['room', room]
 * - Subscribes to kind:1 events filtered by #t
 */
export function createNostrClient({ relayUrl, room, onMessage, onPeer, onState } = {}) {
  if (!relayUrl) throw new Error('relayUrl is required');
  if (!room) throw new Error('room is required');

  const state = {
    relayUrl,
    room,
    ws: null,
    subId: `sub-${room}-${Math.random().toString(36).slice(2, 8)}`,
    secretKeyHex: null,
    pubkey: null,
    seen: new Set(),
  };

  function ensureKeys() {
    if (state.pubkey && state.secretKeyHex) return;

    let stored = localStorage.getItem('nostr-secret-key');
    // If stored value looks like an array string from prior buggy storage, clear it
    if (stored && stored.includes(',')) {
      localStorage.removeItem('nostr-secret-key');
      stored = null;
    }

    if (!isHex64(stored)) {
      const secretBytes = generateSecretKey();
      state.secretKeyHex = bytesToHex(secretBytes);
      localStorage.setItem('nostr-secret-key', state.secretKeyHex);
    } else {
      state.secretKeyHex = stored;
    }

    state.pubkey = getPublicKey(state.secretKeyHex);
  }

  function getPublicKeyHex() {
    ensureKeys();
    return state.pubkey;
  }

  function setState(next) {
    try {
      onState?.(next);
    } catch {
      // ignore
    }
  }

  function parseIncoming(event) {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (!Array.isArray(msg) || msg.length < 2) return;
    const [type] = msg;

    if (type === 'EVENT') {
      const nostrEvent = msg[2];
      if (!nostrEvent || typeof nostrEvent !== 'object') return;
      if (nostrEvent.id && state.seen.has(nostrEvent.id)) return;
      if (nostrEvent.id) state.seen.add(nostrEvent.id);

      // Ensure it's for our room
      const tags = Array.isArray(nostrEvent.tags) ? nostrEvent.tags : [];
      const roomTag = tags.find((t) => Array.isArray(t) && t[0] === 'room');
      if (!roomTag || roomTag[1] !== state.room) return;

      // Content is JSON
      let payload;
      try {
        payload = JSON.parse(nostrEvent.content);
      } catch {
        return;
      }

      if (payload?.type === 'peer-join' && payload.peerId) {
        try {
          onPeer?.({ peerId: payload.peerId });
        } catch {
          // ignore
        }
        return;
      }

      if (payload?.type === 'message' && typeof payload.message === 'string') {
        const from = (payload.peerId || nostrEvent.pubkey || 'peer').substring(0, 8) + '...';
        try {
          onMessage?.({ from, text: payload.message });
        } catch {
          // ignore
        }
      }
    }
  }

  function sendRaw(frame) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Relay not connected');
    }
    state.ws.send(JSON.stringify(frame));
  }

  async function connect() {
    ensureKeys();

    setState('connecting');

    const ws = new WebSocket(state.relayUrl);
    state.ws = ws;

    await new Promise((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('Failed to connect to relay'));
      };
      const cleanup = () => {
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
      };
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
    });

    ws.addEventListener('message', parseIncoming);
    ws.addEventListener('close', () => setState('disconnected'));

    // Subscribe to this room (topic-tag filtered)
    const now = Math.floor(Date.now() / 1000);
    const filter = {
      kinds: [1],
      '#t': [state.room],
      since: now - 3600,
      limit: 200,
    };

    sendRaw(['REQ', state.subId, filter]);

    // Announce presence
    await sendJoin();

    setState('connected');
  }

  async function sendJoin() {
    ensureKeys();
    const created_at = Math.floor(Date.now() / 1000);
    const tags = [
      ['room', state.room],
      ['t', state.room],
    ];

    const eventTemplate = {
      kind: 1,
      created_at,
      tags,
      content: JSON.stringify({
        type: 'peer-join',
        peerId: state.pubkey,
        room: state.room,
        timestamp: Date.now(),
      }),
      pubkey: state.pubkey,
    };

    const signed = finalizeEvent(eventTemplate, state.secretKeyHex);
    sendRaw(['EVENT', signed]);
  }

  async function sendMessage(text) {
    ensureKeys();
    const created_at = Math.floor(Date.now() / 1000);
    const tags = [
      ['room', state.room],
      ['t', state.room],
    ];

    const eventTemplate = {
      kind: 1,
      created_at,
      tags,
      content: JSON.stringify({
        type: 'message',
        message: text,
        peerId: state.pubkey,
        room: state.room,
        timestamp: Date.now(),
      }),
      pubkey: state.pubkey,
    };

    const signed = finalizeEvent(eventTemplate, state.secretKeyHex);
    sendRaw(['EVENT', signed]);
  }

  async function disconnect() {
    const ws = state.ws;
    state.ws = null;

    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify(['CLOSE', state.subId]));
        } catch {
          // ignore
        }
        ws.close();
      }
    } finally {
      setState('disconnected');
    }
  }

  return {
    connect,
    disconnect,
    sendMessage,
    getPublicKey: getPublicKeyHex,
  };
}
