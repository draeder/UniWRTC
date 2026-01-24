/**
 * WebRTC Peer Coordinator
 * 
 * Selects one peer (coordinator) in a room to:
 * 1. Maintain persistent connection to Nostr relay
 * 2. Relay signaling messages for other peers
 * 3. Broadcast peer presence and availability
 * 
 * Non-coordinator peers send signals to the coordinator, which forwards them.
 * This reduces the number of concurrent relay subscriptions and connections.
 */

export class PeerCoordinator {
  constructor({ myPeerId, room, sendSignal, nostrClient }) {
    if (!myPeerId) throw new Error('myPeerId is required');
    if (!room) throw new Error('room is required');
    if (!sendSignal) throw new Error('sendSignal is required');
    if (!nostrClient) throw new Error('nostrClient is required');

    this.myPeerId = myPeerId;
    this.room = room;
    this.sendSignal = sendSignal;
    this.nostrClient = nostrClient;

    this.isCoordinator = false;
    this.coordinatorId = null;
    this.knownPeers = new Map(); // peerId -> { joinedAt, isAlive, lastSeen }
    this.coordinatorHeartbeatTimer = null;
    this.coordinatorElectionTimer = null;

    // Tracks if we've announced ourselves as a candidate
    this.electionAnnounced = false;

    // Configuration
    this.COORDINATOR_HEARTBEAT_INTERVAL = 5000; // 5s
    this.COORDINATOR_ALIVE_TIMEOUT = 15000; // 15s
    this.PEER_ALIVE_TIMEOUT = 20000; // 20s
    this.ELECTION_WAIT_BEFORE_ANNOUNCE = 1000; // 1s after joining
  }

  /**
   * Initialize the coordinator system.
   * Call this when a peer joins the room.
   */
  async initialize() {
    this.knownPeers.clear();
    this.knownPeers.set(this.myPeerId, {
      joinedAt: Date.now(),
      isAlive: true,
      lastSeen: Date.now(),
    });

    console.log('[Coordinator] Initialized. Self:', this.myPeerId.substring(0, 6) + '...');

    // Announce ourselves as a coordinator candidate
    this.announcePresence();

    // Start listening for coordinator heartbeats
    this.startCoordinatorWatchdog();
    // NOTE: Do NOT elect here. Watchdog will trigger election on timeout.
  }

  /**
   * Announce presence and eligibility as coordinator candidate
   */
  announcePresence() {
    if (this.electionAnnounced) return;
    this.electionAnnounced = true;

    console.log('[Coordinator] Announcing candidacy:', this.myPeerId.substring(0, 6) + '...');

    try {
      this.sendSignal(null, {
        type: 'coordinator-candidate',
        role: 'coordinator',
        candidateId: this.myPeerId,
        joinedAt: Date.now(),
        timestamp: Date.now(),
      });
    } catch (e) {
      console.warn('[Coordinator] Failed to announce candidacy:', e?.message);
    }
  }

  /**
   * Start watchdog timer to trigger election if coordinator dies
   */
  startCoordinatorWatchdog() {
    this.stopCoordinatorWatchdog();
    this.coordinatorElectionTimer = setInterval(() => {
      this.checkCoordinatorHealth();
    }, this.COORDINATOR_ALIVE_TIMEOUT);
  }

  stopCoordinatorWatchdog() {
    if (this.coordinatorElectionTimer) {
      clearInterval(this.coordinatorElectionTimer);
      this.coordinatorElectionTimer = null;
    }
  }

  /**
   * Check if current coordinator is healthy
   */
  checkCoordinatorHealth() {
    if (!this.coordinatorId) {
      // No coordinator selected yet; attempt deterministic election
      this.triggerCoordinatorElection();
      return;
    }
    if (this.coordinatorId === this.myPeerId) return; // We're the coordinator

    const coordinator = this.knownPeers.get(this.coordinatorId);
    if (!coordinator) {
      // Coordinator is unknown, trigger election
      this.triggerCoordinatorElection();
      return;
    }

    const timeSinceLastHeartbeat = Date.now() - coordinator.lastSeen;
    if (timeSinceLastHeartbeat > this.COORDINATOR_ALIVE_TIMEOUT) {
      // Coordinator is dead, trigger election
      this.triggerCoordinatorElection();
    }
  }

  /**
   * Trigger coordinator election: peer with lowest ID becomes coordinator
   */
  triggerCoordinatorElection() {
    console.log(`[Coordinator] Triggering election. Old: ${this.coordinatorId}`);

    const candidates = Array.from(this.knownPeers.keys()).filter((id) => {
      const peer = this.knownPeers.get(id);
      const timeSinceLastSeen = Date.now() - peer.lastSeen;
      return timeSinceLastSeen < this.PEER_ALIVE_TIMEOUT;
    });

    if (candidates.length === 0) {
      this.coordinatorId = null;
      return;
    }

    // Sort lexicographically; lowest ID is coordinator
    candidates.sort();
    const newCoordinator = candidates[0];

    if (newCoordinator !== this.coordinatorId) {
      const wasCoordinator = this.isCoordinator;
      this.coordinatorId = newCoordinator;
      this.isCoordinator = newCoordinator === this.myPeerId;

      console.log(
        `[Coordinator] Elected: ${newCoordinator.substring(0, 6)}... (was I coordinator: ${wasCoordinator}, am I now: ${this.isCoordinator})`
      );

      // Notify observers of coordinator change
      this.onCoordinatorChanged?.({
        coordinatorId: this.coordinatorId,
        isNowCoordinator: this.isCoordinator,
      });

      if (this.isCoordinator) {
        this.startCoordinatorHeartbeat();
      } else {
        this.stopCoordinatorHeartbeat();
      }
    }
  }

  startCoordinatorHeartbeat() {
    if (!this.isCoordinator) return;
    this.stopCoordinatorHeartbeat();

    console.log('[Coordinator] Starting heartbeat');

    this.coordinatorHeartbeatTimer = setInterval(() => {
      try {
        this.sendSignal(null, {
          type: 'coordinator-heartbeat',
          role: 'coordinator',
          coordinatorId: this.myPeerId,
          timestamp: Date.now(),
          knownPeers: Array.from(this.knownPeers.keys()),
        });
      } catch (e) {
        console.warn('[Coordinator] Failed to send heartbeat:', e?.message);
      }
    }, this.COORDINATOR_HEARTBEAT_INTERVAL);
  }

  stopCoordinatorHeartbeat() {
    if (this.coordinatorHeartbeatTimer) {
      clearInterval(this.coordinatorHeartbeatTimer);
      this.coordinatorHeartbeatTimer = null;
    }
  }

  /**
   * Register a new peer (do NOT trigger election - coordinator is sticky)
   */
  registerPeer(peerId) {
    if (!this.knownPeers.has(peerId)) {
      this.knownPeers.set(peerId, {
        joinedAt: Date.now(),
        isAlive: true,
        lastSeen: Date.now(),
      });
      console.log(`[Coordinator] Registered peer: ${peerId.substring(0, 6)}...`);
      // NOTE: Do NOT trigger election here. NEVER.
      // Coordinator is determined only by watchdog timeout or explicit disconnect.
      // No registration-triggered elections.
    }
  }

  /**
   * Update heartbeat timestamp for a peer
   */
  updatePeerHeartbeat(peerId) {
    if (!this.knownPeers.has(peerId)) {
      this.registerPeer(peerId);
      return;
    }
    this.knownPeers.get(peerId).lastSeen = Date.now();
  }

  /**
   * Mark a peer as disconnected and trigger re-election if needed
   */
  markPeerDisconnected(peerId) {
    if (!this.knownPeers.has(peerId)) return;

    console.log(`[Coordinator] Peer disconnected: ${peerId.substring(0, 6)}...`);
    this.knownPeers.delete(peerId);

    // If the coordinator disconnected, trigger immediate re-election
    if (peerId === this.coordinatorId) {
      console.log('[Coordinator] Coordinator disconnected! Triggering new election...');
      this.triggerCoordinatorElection();
    }
  }

  /**
   * Handle incoming coordinator messages
   */
  handleCoordinatorMessage(payload) {
    if (!payload || typeof payload !== 'object') return;

    const { type } = payload;

    if (type === 'coordinator-candidate') {
      const { candidateId } = payload;
      if (candidateId) {
        this.registerPeer(candidateId);
      }
      // If no coordinator yet, elect deterministically now
      if (!this.coordinatorId) {
        this.triggerCoordinatorElection();
      }
      return;
    }

    if (type === 'coordinator-heartbeat') {
      const { coordinatorId, knownPeers: peers } = payload;
      if (coordinatorId) {
        this.updatePeerHeartbeat(coordinatorId);
        // Adopt coordinator if we don't have one yet
        if (!this.coordinatorId) {
          this.coordinatorId = coordinatorId;
          this.isCoordinator = this.coordinatorId === this.myPeerId;
          if (this.isCoordinator) this.startCoordinatorHeartbeat();
        }
      }

      // Register peers mentioned in heartbeat
      if (Array.isArray(peers)) {
        for (const peerId of peers) {
          this.registerPeer(peerId);
        }
      }

      // Do NOT re-run election on heartbeat. Coordinator is sticky unless dead.
      return;
    }
  }

  /**
   * If we're the coordinator, relay a signaling message to the target
   */
  relaySignal(payload, targetId) {
    if (!this.isCoordinator) {
      console.warn('[Coordinator] Not coordinator, cannot relay');
      return;
    }

    if (!targetId) {
      console.warn('[Coordinator] Cannot relay without targetId');
      return;
    }

    const relayedPayload = {
      ...payload,
      relayedBy: this.myPeerId,
      relayedAt: Date.now(),
    };

    try {
      this.sendSignal(targetId, relayedPayload);
    } catch (e) {
      console.warn(`[Coordinator] Failed to relay to ${targetId}:`, e?.message);
    }
  }

  /**
   * Get coordinator status
   */
  getStatus() {
    return {
      isCoordinator: this.isCoordinator,
      coordinatorId: this.coordinatorId,
      knownPeersCount: this.knownPeers.size,
      knownPeers: Array.from(this.knownPeers.keys()),
    };
  }

  /**
   * Cleanup on disconnect
   */
  destroy() {
    this.stopCoordinatorHeartbeat();
    this.stopCoordinatorWatchdog();
    this.knownPeers.clear();
    this.isCoordinator = false;
    this.coordinatorId = null;
  }
}
