/**
 * Hybrid Signaling Coordinator - BROWSER-ONLY
 * 
 * Coordinates multiple signaling channels for WebRTC:
 * 1. Nostr - Primary signaling (offers/answers/ICE)
 * 2. WebSocket Tracker - Peer discovery (WebTorrent protocol)
 * 3. Gun - Alternative WebRTC signaling
 */

import Gun from 'gun';
import Client from 'bittorrent-tracker';
import { Buffer } from 'buffer';
import process from 'process';

// Known active Gun relays - curated list of community-maintained servers
const ACTIVE_GUN_RELAYS = [
  'https://relay.peer.ooo/gun'
];

// Ensure Buffer exists in browser
if (!globalThis.Buffer) {
  globalThis.Buffer = Buffer;
}

// Ensure process exists in browser for tracker libs
if (!globalThis.process) {
  globalThis.process = process;
}

// Ensure global alias for some deps
if (!globalThis.global) {
  globalThis.global = globalThis;
}

export class HybridSignaling {
  constructor(config = {}) {
    this.roomId = config.roomId;
    this.peerId = config.peerId;
    this.onPeerDiscovered = config.onPeerDiscovered || (() => {});
    this.onSignal = config.onSignal || (() => {});
    
    // WebSocket tracker client
    this.trackerClient = null;
    this.discoveredPeers = new Set();
    
    // Gun for alternative signaling
    this.gun = null;
    this.gunPeers = new Map();
    
    // Nostr handled externally (primary)
    this.nostrEnabled = true;
  }

  /**
   * Initialize WebSocket tracker for peer discovery (WebTorrent compatible)
   */
  initTracker(trackers = ['wss://tracker.openwebtorrent.com']) {
    if (!this.roomId) {
      console.warn('[Tracker] No room ID specified');
      return;
    }
    try {
      const infoHash = this.createInfoHashBuffer(this.roomId);
      // Use hex public key truncated to 20 bytes (40 hex chars) as tracker peerId
      const peerIdHex = (this.peerId || '').replace(/^0x/, '').padEnd(40, '0').slice(0, 40);
      const peerId = Buffer.from(peerIdHex, 'hex');

      this.trackerClient = new Client({
        infoHash,
        peerId,
        announce: trackers,
        rtcConfig: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:global.stun.twilio.com:3478' }
          ]
        }
      });

      this.trackerClient.on('peer', (peer) => {
        const discoveredHex = peer.id?.toString('hex') || peer.id || '';
        if (!discoveredHex) return;
        // Avoid self
        if (discoveredHex === peerIdHex) return;
        if (this.discoveredPeers.has(discoveredHex)) return;
        this.discoveredPeers.add(discoveredHex);
        console.log('[Tracker] Discovered peer:', discoveredHex.substring(0, 8));
        this.onPeerDiscovered({ source: 'tracker', peerId: discoveredHex, peer });
      });

      this.trackerClient.on('warning', (err) => {
        console.warn('[Tracker] Warning:', err?.message || err);
      });

      this.trackerClient.on('error', (err) => {
        console.error('[Tracker] Error:', err?.message || err);
      });

      this.trackerClient.start();
      console.log('[Tracker] Started peer discovery for room:', this.roomId);
    } catch (err) {
      console.error('[Tracker] Failed to start tracker client:', err);
    }
  }

  /**
   * Initialize Gun for alternative WebRTC signaling with active relays
   */
  async initGun() {
    if (!this.roomId) {
      console.warn('[Gun] No room ID specified');
      return;
    }

    try {
      // Use curated list of active Gun relays
      console.log('[Gun] Using active relay list:', ACTIVE_GUN_RELAYS.length, 'relays');
      
      this.gun = Gun(ACTIVE_GUN_RELAYS);
      const room = this.gun.get(`uniwrtc-${this.roomId}`);
      
      // Listen for signals in this room
      room.get('signals').map().on((signal, peerId) => {
        if (!signal || peerId === this.peerId) return;
        
        try {
          const data = typeof signal === 'string' ? JSON.parse(signal) : signal;
          
          if (data.to === this.peerId || !data.to) {
            console.log('[Gun] Received signal from:', peerId.substring(0, 8));
            this.onSignal({
              source: 'gun',
              from: peerId,
              signal: data
            });
          }
        } catch (err) {
          console.error('[Gun] Parse error:', err);
        }
      });

      // Announce presence with roomId to scope peers to this room
      room.get('peers').get(this.peerId).put({
        id: this.peerId,
        roomId: this.roomId,
        timestamp: Date.now()
      });

      // Listen for peers - filter out stale entries AND ensure they belong to this room
      room.get('peers').map().on((peerData, gunKey) => {
        if (!peerData || !peerData.id) return;
        
        const peerId = peerData.id;
        if (peerId === this.peerId) return;
        
        // Filter out peers older than 2 minutes (likely offline) - DELETE from Gun to prevent resurrection
        const peerAge = Date.now() - (peerData.timestamp || 0);
        const MAX_PEER_AGE = 2 * 60 * 1000; // 2 minutes
        
        if (peerAge > MAX_PEER_AGE) {
          console.log('[Gun] Ignoring stale peer:', peerId.substring(0, 8), `(${Math.floor(peerAge / 1000)}s old) - removing from Gun`);
          // CRITICAL: Delete the stale peer entry from Gun using put(null)
          room.get('peers').get(peerId).put(null);
          this.gunPeers.delete(peerId);
          return;
        }
        
        if (!this.gunPeers.has(peerId)) {
          console.log('[Gun] Discovered peer:', peerId.substring(0, 8));
          this.gunPeers.set(peerId, peerData);
          this.onPeerDiscovered({
            source: 'gun',
            peerId,
            data: peerData
          });
        }
      });

      // Heartbeat: Update presence every 30 seconds with roomId to maintain scoping
      this.gunHeartbeat = setInterval(() => {
        room.get('peers').get(this.peerId).put({
          id: this.peerId,
          roomId: this.roomId,
          timestamp: Date.now()
        });
      }, 30000);

      console.log('[Gun] Initialized signaling for room:', this.roomId);
    } catch (err) {
      console.error('[Gun] Init error:', err);
    }
  }

  /**
   * Send a signal via Gun
   */
  sendGunSignal(toPeerId, signal) {
    if (!this.gun || !this.roomId) return;
    
    const room = this.gun.get(`uniwrtc-${this.roomId}`);
    const signalData = {
      from: this.peerId,
      to: toPeerId,
      timestamp: Date.now(),
      ...signal
    };
    
    room.get('signals').get(this.peerId).put(JSON.stringify(signalData));
    console.log('[Gun] Sent signal to:', toPeerId.substring(0, 8));
  }

  /**
   * Create a deterministic info hash hex from room ID (for tracker)
   */
  createInfoHashHex(roomId) {
    // Simple hash for demo - creates 40 char hex string
    let hash = '';
    for (let i = 0; i < roomId.length; i++) {
      hash += roomId.charCodeAt(i).toString(16).padStart(2, '0');
    }
    return hash.padEnd(40, '0').substring(0, 40);
  }

  createInfoHashBuffer(roomId) {
    const hex = this.createInfoHashHex(roomId);
    return Buffer.from(hex, 'hex');
  }

  /**
   * Update room/session
   */
  updateRoom(roomId) {
    this.roomId = roomId;
    this.shutdown();
  }

  /**
   * Get stats about discovered peers
   */
  getStats() {
    return {
      tracker: {
        peers: this.discoveredPeers.size,
        active: this.trackerSockets.length > 0
      },
      gun: {
        peers: this.gunPeers.size,
        active: !!this.gun
      }
    };
  }

  /**
   * Shutdown all signaling channels
   */
  shutdown() {
    if (this.trackerClient) {
      try {
        this.trackerClient.destroy();
      } catch (err) {
        console.error('[Tracker] Error closing client:', err);
      }
      this.trackerClient = null;
    }
    
    if (this.gunHeartbeat) {
      clearInterval(this.gunHeartbeat);
      this.gunHeartbeat = null;
    }
    
    this.discoveredPeers.clear();
    this.gunPeers.clear();
    
    console.log('[Hybrid] Signaling shutdown');
  }
}
