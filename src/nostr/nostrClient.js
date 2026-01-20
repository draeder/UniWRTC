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
export function createNostrClient({ relayUrl, room, onPayload, onState, onNotice, onOk, storage, secretKeyHex } = {}) {
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

  // Track NIP-20 OK responses by event id
  const okWaiters = new Map();

  const storageKey = 'nostr-secret-key-tab';
  const fallbackStorage = (() => {
    const mem = new Map();
    return {
      getItem: (k) => (mem.has(k) ? String(mem.get(k)) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
    };
  })();

  const effectiveStorage = storage
    || (typeof sessionStorage !== 'undefined' ? sessionStorage : null)
    || fallbackStorage;

  function ensureKeys() {
    if (state.pubkey && state.secretKeyHex) return;

    if (isHex64(secretKeyHex)) {
      state.secretKeyHex = secretKeyHex;
      state.pubkey = getPublicKey(state.secretKeyHex);
      return;
    }

    // IMPORTANT: For this demo we want each browser tab to have a distinct peer ID.
    // sessionStorage is per-tab, while localStorage is shared across tabs.
    let stored = effectiveStorage.getItem(storageKey);

    // If stored value looks like an array string from prior buggy storage, clear it
    if (stored && stored.includes(',')) {
      effectiveStorage.removeItem(storageKey);
      stored = null;
    }

    if (!isHex64(stored)) {
      const secretBytes = generateSecretKey();
      state.secretKeyHex = bytesToHex(secretBytes);
      effectiveStorage.setItem(storageKey, state.secretKeyHex);
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

    if (type === 'NOTICE') {
      try {
        onNotice?.(msg[1]);
      } catch {
        // ignore
      }
      return;
    }

    // NIP-20: ["OK", <event_id>, <true|false>, <message>]
    if (type === 'OK') {
      const id = msg[1];
      const ok = msg[2];
      const message = msg[3];

      const waiter = okWaiters.get(id);
      if (waiter) {
        okWaiters.delete(id);
        waiter.resolve({ id, ok, message });
      }
      try {
        onOk?.({ id, ok, message });
      } catch {
        // ignore
      }
      return;
    }

    if (type === 'EVENT') {
      const nostrEvent = msg[2];
      if (!nostrEvent || typeof nostrEvent !== 'object') return;
      if (nostrEvent.id && state.seen.has(nostrEvent.id)) return;
      if (nostrEvent.id) state.seen.add(nostrEvent.id);

      // Ignore our own events
      if (nostrEvent.pubkey && nostrEvent.pubkey === state.pubkey) return;


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

      try {
        onPayload?.({
          from: nostrEvent.pubkey,
          payload,
          eventId: nostrEvent.id,
          createdAt: nostrEvent.created_at,
        });
      } catch {
        // ignore
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

    if (typeof WebSocket === 'undefined') {
      throw new Error('WebSocket is not available in this environment. This Nostr helper is browser-first; in Node you must provide a WebSocket global (e.g., via a polyfill).');
    }

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
      // Use a wider window to tolerate clock skew; app layer filters stale via session nonces.
      since: now - 600,
      limit: 200,
    };

    sendRaw(['REQ', state.subId, filter]);

    setState('connected');
  }

  async function send(payload) {
    ensureKeys();
    const signed = buildSignedEvent(payload);
    sendRaw(['EVENT', signed]);
    return signed.id;
  }

  function buildSignedEvent(payload) {
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
        ...payload,
        from: state.pubkey,
        room: state.room,
        timestamp: Date.now(),
      }),
      pubkey: state.pubkey,
    };

    return finalizeEvent(eventTemplate, state.secretKeyHex);
  }

  async function sendWithOk(payload, { timeoutMs = 4000 } = {}) {
    const signed = buildSignedEvent(payload);

    const okPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        okWaiters.delete(signed.id);
        reject(new Error('Timed out waiting for relay OK'));
      }, timeoutMs);

      okWaiters.set(signed.id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
      });
    });

    sendRaw(['EVENT', signed]);
    return await okPromise;
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
    send,
    sendWithOk,
    getPublicKey: getPublicKeyHex,
  };
}
