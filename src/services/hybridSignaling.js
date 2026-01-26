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

// Ensure Buffer exists in browser
if (!globalThis.Buffer) {
  globalThis.Buffer = Buffer;
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
      const peerId = Buffer.from(this.peerId.substring(0, 20).padEnd(20, '0'));

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
        const peerIdHex = peer.id?.toString('hex') || peer.id || '';
        if (!peerIdHex || peerIdHex === this.peerId) return;
        if (this.discoveredPeers.has(peerIdHex)) return;
        this.discoveredPeers.add(peerIdHex);
        console.log('[Tracker] Discovered peer:', peerIdHex.substring(0, 8));
        this.onPeerDiscovered({ source: 'tracker', peerId: peerIdHex, peer });
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
   * Initialize Gun for alternative WebRTC signaling
   */
  initGun(peers = ['https://gun-manhattan.herokuapp.com/gun']) {
    if (!this.roomId) {
      console.warn('[Gun] No room ID specified');
      return;
    }

    this.gun = Gun(peers);
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

    // Announce presence
    room.get('peers').get(this.peerId).put({
      id: this.peerId,
      timestamp: Date.now()
    });

    // Listen for peers
    room.get('peers').map().on((peerData, peerId) => {
      if (!peerData || peerId === this.peerId) return;
      
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

    console.log('[Gun] Initialized signaling for room:', this.roomId);
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
    
    this.discoveredPeers.clear();
    this.gunPeers.clear();
    
    // Gun doesn't need explicit cleanup
    console.log('[Hybrid] Signaling shutdown');
  }
}
