/**
 * Hybrid Signaling Coordinator - BROWSER-ONLY
 * 
 * Coordinates multiple signaling channels for WebRTC:
 * 1. Nostr - Primary signaling (offers/answers/ICE)
 * 2. WebSocket Tracker - Peer discovery (WebTorrent protocol)
 * 3. Gun - Alternative WebRTC signaling
 */

import Gun from 'gun';

export class HybridSignaling {
  constructor(config = {}) {
    this.roomId = config.roomId;
    this.peerId = config.peerId;
    this.onPeerDiscovered = config.onPeerDiscovered || (() => {});
    this.onSignal = config.onSignal || (() => {});
    
    // WebSocket tracker connections
    this.trackerSockets = [];
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

    trackers.forEach(trackerUrl => {
      try {
        const ws = new WebSocket(trackerUrl);
        
        ws.onopen = () => {
          console.log('[Tracker] Connected to', trackerUrl);
          
          // Send announce message (simplified WebTorrent protocol)
          const announce = {
            action: 'announce',
            info_hash: this.createInfoHashHex(this.roomId),
            peer_id: this.peerId.substring(0, 20).padEnd(20, '0'),
            numwant: 50,
            uploaded: 0,
            downloaded: 0,
            left: 0,
            event: 'started',
            compact: 0
          };
          
          ws.send(JSON.stringify(announce));
        };
        
        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            
            if (data.offer || data.answer) {
              // WebRTC offer/answer from tracker
              console.log('[Tracker] Received WebRTC signal');
              return;
            }
            
            if (data.peer_id && data.peer_id !== this.peerId) {
              const peerId = data.peer_id;
              
              if (!this.discoveredPeers.has(peerId)) {
                console.log('[Tracker] Discovered peer:', peerId.substring(0, 8));
                this.discoveredPeers.add(peerId);
                this.onPeerDiscovered({
                  source: 'tracker',
                  peerId,
                  data
                });
              }
            }
          } catch (err) {
            console.error('[Tracker] Message parse error:', err);
          }
        };
        
        ws.onerror = (err) => {
          console.warn('[Tracker] Error:', trackerUrl, err);
        };
        
        ws.onclose = () => {
          console.log('[Tracker] Disconnected:', trackerUrl);
        };
        
        this.trackerSockets.push(ws);
      } catch (err) {
        console.error('[Tracker] Failed to connect:', trackerUrl, err);
      }
    });

    console.log('[Tracker] Started peer discovery for room:', this.roomId);
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
    // Close all tracker WebSockets
    this.trackerSockets.forEach(ws => {
      try {
        ws.close();
      } catch (err) {
        console.error('[Tracker] Error closing:', err);
      }
    });
    this.trackerSockets = [];
    
    this.discoveredPeers.clear();
    this.gunPeers.clear();
    
    // Gun doesn't need explicit cleanup
    console.log('[Hybrid] Signaling shutdown');
  }
}
