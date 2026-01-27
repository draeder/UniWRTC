import './style.css';
import UniWRTCClient from '../client-browser.js';
import { createNostrClient } from './nostr/nostrClient.js';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { wrapEncryptedPayload, unwrapEncryptedPayload, deriveSharedSecret, registerPeerPublicKey, getPeerPublicKey } from './crypto.js';
import { generateRandomPair } from 'unsea';
import { HybridSignaling } from './services/hybridSignaling.js';

// Make UniWRTCClient available globally for backwards compatibility
window.UniWRTCClient = UniWRTCClient;

// Hybrid signaling: Nostr (primary) + Tracker + Gun
let nostrClient = null;
let hybridSignaling = null;
let nostrEnabled = true;
let trackerEnabled = true;
let gunEnabled = true;
let myPeerId = null;
let mySessionNonce = null;
let encryptionEnabled = true; // Encryption toggle - defaults to ON
let myKeyPair = null; // unsea key pair for encryption { publicKey, privateKey }
const peerSessions = new Map();
const peerProbeState = new Map();
const peerResyncState = new Map();
const readyPeers = new Set();
const deferredHelloPeers = new Set();

// Curated public relays (best-effort). Users can override in the UI.
const DEFAULT_RELAYS = [
    'wss://relay.primal.net',
    'wss://relay.nostr.band',
    'wss://nos.lol',
    'wss://relay.snort.social',
    'wss://nostr.wine',
    'wss://relay.damus.io',
];

const DEFAULT_TRACKERS = [
    'wss://tracker.openwebtorrent.com',
    'wss://tracker.webtorrent.dev',
    'wss://tracker.btorrent.xyz'
];

const DEFAULT_GUN_RELAY = 'https://relay.peer.ooo/gun';


let client = null;
const peerConnections = new Map();
const dataChannels = new Map();
const pendingIce = new Map();
const outboundIceBatches = new Map();
const trackerPeers = new Map(); // simple-peer instances from tracker
const initiatedPeers = new Set(); // Track peers we've already sent offers to (any method)
const peerSources = new Map(); // Track connection source for each peer (nostr/tracker/gun)
const lastSignalSource = new Map(); // Track last signaling transport per peer (nostr/gun)
const peerPreferredSource = new Map(); // First ACTIVE connection wins per peer
const trackerConnectedAt = new Map();
const rtcConnectedAt = new Map();

function setPreferredSource(peerId, source) {
    if (!source) return;
    
    // Normalize peerId: trim whitespace and use consistent casing to prevent duplicates
    const normalized = peerId.trim();
    
    if (peerPreferredSource.has(normalized)) {
        const existing = peerPreferredSource.get(normalized);
        console.log(`[Select] ${normalized.substring(0, 8)} already preferred as ${existing}, rejecting ${source}`);
        return; // already chosen
    }
    
    peerPreferredSource.set(normalized, source);
    console.log(`[Select] ${source} is preferred for ${normalized.substring(0, 8)}`);

    // Close lower-priority connections when a preferred source becomes active
    // Priority is based on the chosen source only; others are closed for stability.
    if (source === 'Tracker') {
        // Close any RTCPeerConnection for this peer
        const pc = peerConnections.get(peerId);
        if (pc instanceof RTCPeerConnection) {
            try { pc.close(); } catch {}
            peerConnections.delete(peerId);
            dataChannels.delete(peerId);
        }
    } else { // Nostr or Gun via RTCPeerConnection
        // Close any tracker peer for this peer
        const sp = trackerPeers.get(peerId);
        if (sp) {
            try { sp.destroy?.(); } catch {}
            trackerPeers.delete(peerId);
        }
    }
    updatePeerList();
}

function enforcePreferredConnections() {
    for (const [peerId, preferred] of peerPreferredSource.entries()) {
        if (preferred === 'Tracker') {
            const pc = peerConnections.get(peerId);
            if (pc instanceof RTCPeerConnection) {
                try { pc.close(); } catch {}
                peerConnections.delete(peerId);
                dataChannels.delete(peerId);
            }
        } else {
            const sp = trackerPeers.get(peerId);
            if (sp) {
                try { sp.destroy?.(); } catch {}
                trackerPeers.delete(peerId);
            }
        }
    }
}

function enforcePriorityConnections(peerId) {
    const source = peerSources.get(peerId);
    if (!source) return;

    // Nostr > Tracker > Gun
    if (source === 'Nostr') {
        const trackerPeer = trackerPeers.get(peerId);
        if (trackerPeer) {
            console.log(`[Dedupe] Closing Tracker because Nostr is preferred for ${peerId.substring(0, 8)}`);
            trackerPeer.destroy?.();
            trackerPeers.delete(peerId);
        }
    } else if (source === 'Tracker') {
        // Close lower-priority Gun RTCPeerConnection
        const pc = peerConnections.get(peerId);
        if (pc instanceof RTCPeerConnection && peerSources.get(peerId) === 'Gun') {
            console.log(`[Dedupe] Closing Gun because Tracker is preferred for ${peerId.substring(0, 8)}`);
            pc.close();
            peerConnections.delete(peerId);
            dataChannels.delete(peerId);
        }
    }
}

function bytesToHex(bytes) {
    return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

function isHex64(s) {
    return typeof s === 'string' && /^[0-9a-fA-F]{64}$/.test(s);
}

// Store the secret key for use with all Nostr clients
let mySecretKeyHex = null;

function ensureIdentity() {
    // Generate a fresh unique peer ID on every page load
    // This ensures each browser tab/reload gets a new identity
    if (!mySecretKeyHex) {
        const secretBytes = generateSecretKey();
        mySecretKeyHex = bytesToHex(secretBytes);
    }
    return getPublicKey(mySecretKeyHex);
}

// Initialize app
document.getElementById('app').innerHTML = `
    <div class="container">
        <div class="header">
            <h1>🌐 UniWRTC Demo</h1>
            <p>WebRTC Signaling made simple</p>
        </div>

        <div class="card">
            <h2>Connection</h2>
            <div class="connection-controls">
                <div>
                    <label style="display: block; margin-bottom: 5px; color: #64748b; font-size: 13px;">Relay/Tracker URLs</label>
                    <input type="text" id="relayUrl" data-testid="relayUrl" placeholder="wss://relay.primal.net, wss://relay.damus.io" value="" style="width: 100%; padding: 8px; border: 1px solid #e2e8f0; border-radius: 4px; font-family: monospace; font-size: 12px;">
                </div>
                <div>
                    <label style="display: block; margin-bottom: 5px; color: #64748b; font-size: 13px;">Room / Session ID</label>
                    <input type="text" id="roomId" data-testid="roomId" placeholder="my-room">
                </div>
            </div>
            <div style="display: flex; gap: 10px; align-items: center; justify-content: space-between; margin-bottom: 10px;">
                <div style="display: flex; gap: 10px; align-items: center;">
                    <button onclick="window.connect()" class="btn-primary" id="connectBtn" data-testid="connectBtn">Connect</button>
                    <button onclick="window.disconnect()" class="btn-danger" id="disconnectBtn" data-testid="disconnectBtn" disabled>Disconnect</button>
                    <span id="statusBadge" data-testid="statusBadge" class="status-badge status-disconnected">Disconnected</span>
                </div>
                <label style="display: flex; align-items: center; gap: 8px; color: #64748b; font-size: 13px; white-space: nowrap;">
                    <input type="checkbox" id="encryptionToggle" onchange="window.toggleEncryption()" checked style="cursor: pointer; width: 16px; height: 16px;">
                    Encrypt
                </label>
            </div>
            <div style="display: flex; gap: 15px; padding: 10px; background: #f8fafc; border-radius: 4px; border: 1px solid #e2e8f0;">
                <label style="display: flex; align-items: center; gap: 6px; color: #64748b; font-size: 13px; font-weight: 600;">
                    <input type="checkbox" id="signalFabricToggle" onchange="window.toggleSignalFabric()" style="cursor: pointer; width: 16px; height: 16px;">
                    Signal Fabric
                </label>
                <div style="width: 1px; background: #cbd5e1;"></div>
                <label style="display: flex; align-items: center; gap: 6px; color: #64748b; font-size: 13px;">
                    <input type="checkbox" id="nostrToggle" checked style="cursor: pointer; width: 16px; height: 16px;">
                    Nostr
                </label>
                <label style="display: flex; align-items: center; gap: 6px; color: #64748b; font-size: 13px;">
                    <input type="checkbox" id="trackerToggle" checked style="cursor: pointer; width: 16px; height: 16px;">
                    Tracker
                </label>
                <label style="display: flex; align-items: center; gap: 6px; color: #64748b; font-size: 13px;">
                    <input type="checkbox" id="gunToggle" checked style="cursor: pointer; width: 16px; height: 16px;">
                    Gun
                </label>
            </div>
        </div>

        <div class="card">
            <h2>Client Info</h2>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                <div>
                    <strong style="color: #64748b;">Client ID:</strong>
                    <div id="clientId" data-testid="clientId" style="font-family: monospace; color: #333; margin-top: 5px;">Not connected</div>
                </div>
                <div>
                    <strong style="color: #64748b;">Session ID:</strong>
                    <div id="sessionId" data-testid="sessionId" style="font-family: monospace; color: #333; margin-top: 5px;">Not joined</div>
                </div>
            </div>
        </div>

        <div class="card">
            <h2>Connected Peers</h2>
            <div id="peerList" data-testid="peerList" class="peer-list">
                <p style="color: #94a3b8;">No peers connected</p>
            </div>
        </div>

        <div class="card">
            <h2>Peer-to-Peer Chat</h2>
            <div id="chatContainer" data-testid="chatContainer">
                <p>Connect to a room and wait for peers to start chatting</p>
            </div>
            <div class="chat-controls">
                <input type="text" id="chatMessage" data-testid="chatMessage" placeholder="Type a message..." onkeypress="if(event.key === 'Enter') window.sendChatMessage()">
                <button onclick="window.sendChatMessage()" class="btn-primary" data-testid="sendBtn">Send</button>
            </div>
        </div>

        <div class="card">
            <h2>Activity Log</h2>
            <div id="logContainer" data-testid="logContainer" class="log-container">
                <div class="log-entry success">UniWRTC Demo ready</div>
            </div>
        </div>
    </div>
`;

// FORCE ENCRYPTION DEFAULT ON IMMEDIATELY AFTER HTML IS CREATED
const encryptCb = document.getElementById('encryptionToggle');
if (encryptCb) {
    console.log('[ENCRYPTION] Found checkbox, forcing ON');
    encryptCb.defaultChecked = true;
    encryptCb.checked = true;
    encryptionEnabled = true;
    console.log('[ENCRYPTION] Set encryptionEnabled=true, checkbox.checked=' + encryptCb.checked);
}

// Prefill room input from URL (?room= or ?session=); otherwise set a visible default the user can override
const roomInput = document.getElementById('roomId');
const params = new URLSearchParams(window.location.search);
const urlRoom = params.get('room') || params.get('session');
if (urlRoom) {
    roomInput.value = urlRoom;
    log(`Prefilled room ID from URL: ${urlRoom}`, 'info');
} else {
    const defaultRoom = 'demo-room';
    roomInput.value = defaultRoom;
    log(`Using default room ID: ${defaultRoom}`, 'info');
}

// Client/session identity should not depend on relay connectivity.
try {
    myPeerId = ensureIdentity();
    document.getElementById('clientId').textContent = myPeerId.substring(0, 16) + '...';
} catch {
    // Leave as-is if identity init fails.
}

document.getElementById('sessionId').textContent = roomInput.value || 'Not joined';
roomInput.addEventListener('input', () => {
    document.getElementById('sessionId').textContent = roomInput.value.trim() || 'Not joined';
});

// Force encryption toggle to default ON on load
const encryptionCheckbox = document.getElementById('encryptionToggle');
if (encryptionCheckbox) {
    encryptionCheckbox.defaultChecked = true; // force default state
    encryptionCheckbox.checked = true; // override any persisted form state
    encryptionEnabled = true;
    window.toggleEncryption?.(); // ensure UI + state sync on load
    log('Signaling encryption defaulted to ON', 'success');
}

// ICE servers: STUN-only by default (no TURN). For deterministic local testing,
// support host-only ICE via URL flag: ?ice=host (or ?ice=none)
const iceMode = (params.get('ice') || '').toLowerCase();
const ICE_SERVERS = iceMode === 'host' || iceMode === 'none'
    ? []
    : [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
        { urls: ['stun:stun2.l.google.com:19302', 'stun:stun3.l.google.com:19302'] },
        { urls: ['stun:stun.cloudflare.com:3478'] },
    ];

if (ICE_SERVERS.length === 0) {
    log('Using host-only ICE candidates (no STUN)', 'info');
}

function log(message, type = 'info') {
    // Reduce noise in the Activity Log by default.
    // Use ?debug=1 to see everything.
    const debugMode = (params.get('debug') || '').toLowerCase();
    const noisy =
        message.startsWith('Dropped ') ||
        message.startsWith('ICE state (') ||
        message.startsWith('Conn state (') ||
        message.startsWith('Relay NOTICE') ||
        message.includes('Failed to add ICE candidate') ||
        message.includes('Failed to add queued ICE candidate') ||
        message.includes('Failed to send ICE batch') ||
        message.startsWith('Disconnected');

    if (noisy && debugMode !== '1' && debugMode !== 'true') {
        // Keep available for debugging without spamming the UI.
        console.debug(message);
        return;
    }

    const logContainer = document.getElementById('logContainer');
    const entry = document.createElement('div');
        entry.className = `log-entry ${type}`;
    const timestamp = new Date().toLocaleTimeString();
        entry.textContent = `[${timestamp}] ${message}`;
    
    // Add testid for specific log messages
    if (message.includes('Connected with client ID') || message.includes('Nostr connection established')) {
        entry.setAttribute('data-testid', 'log-connected');
    } else if (message.includes('Joined session') || message.includes('Joined Nostr room')) {
        entry.setAttribute('data-testid', 'log-joined');
    } else if (message.includes('Peer joined') || message.includes('Peer seen')) {
        entry.setAttribute('data-testid', 'log-peer-joined');
    } else if (message.includes('Data channel open')) {
        entry.setAttribute('data-testid', 'log-data-channel');
    }
    
    logContainer.appendChild(entry);
    logContainer.scrollTop = logContainer.scrollHeight;
}

function updateStatus(connected) {
    const badge = document.getElementById('statusBadge');
    const connectBtn = document.getElementById('connectBtn');
    const disconnectBtn = document.getElementById('disconnectBtn');
    
    if (connected) {
        badge.textContent = 'Connected';
        badge.className = 'status-badge status-connected';
        connectBtn.disabled = true;
        disconnectBtn.disabled = false;
    } else {
        badge.textContent = 'Disconnected';
        badge.className = 'status-badge status-disconnected';
        connectBtn.disabled = false;
        disconnectBtn.disabled = true;
        // Keep client/session labels stable; identity and room are local state.
    }
}

function updatePeerList() {
    const peerList = document.getElementById('peerList');
    if (!peerList) return;
    
    // Enforce: close all non-preferred connections
    enforcePreferredConnections();
    
    // DEBUG: Log what's in peerPreferredSource
    console.log(`[updatePeerList] peerPreferredSource has ${peerPreferredSource.size} entries:`, 
        Array.from(peerPreferredSource.entries()).map(([id, src]) => `${id.substring(0,8)}...: ${src}`).join(', ')
    );
    
    // Build display from ONLY peerPreferredSource - one entry per peer guaranteed
    const connectedPeers = new Map(); // peerId -> source
    const activeSourceTypes = new Set();

    for (const [peerId, source] of peerPreferredSource.entries()) {
        // Check if this peer's preferred connection is actually active
        let isActive = false;
        
        if (source === 'Tracker') {
            const sp = trackerPeers.get(peerId);
            isActive = !!(sp && sp.connected);
        } else {
            // Gun or Nostr
            const pc = peerConnections.get(peerId);
            const dc = dataChannels.get(peerId);
            const hasOpenDataChannel = dc && dc.readyState === 'open';
            const connState = pc && pc.connectionState;
            
            isActive = !!(pc instanceof RTCPeerConnection && (connState === 'connected' || connState === 'connecting' || hasOpenDataChannel));
        }

        // Only display if currently active (will reappear if reconnects)
        if (isActive) {
            connectedPeers.set(peerId, source);
            activeSourceTypes.add(source);
        }
    }

    if (connectedPeers.size === 0) {
        peerList.innerHTML = '<p style="color: #94a3b8;">No peers connected</p>';
        return;
    }

    peerList.innerHTML = '';
    const displayedPeerSubstrings = new Set(); // Track peer ID substrings already displayed
    
    for (const [peerId, source] of connectedPeers) {
        const peerSubstring = peerId.substring(0, 8);
        
        // HARD BLOCK: if this peer substring already displayed, skip it
        if (displayedPeerSubstrings.has(peerSubstring)) {
            console.warn(`[Dedupe] Skipping duplicate peer display: ${peerSubstring}... (already shown as ${source})`);
            continue;
        }
        
        displayedPeerSubstrings.add(peerSubstring);
        const peerItem = document.createElement('div');
        peerItem.className = 'peer-item';
        peerItem.innerHTML = `<span style="color: #64748b; font-size: 11px;">[${source}]</span> ${peerSubstring}...`;
        peerList.appendChild(peerItem);
    }
}

window.connect = async function() {
    await connectNostr();
};

function shouldInitiateWith(peerId) {
    // Deterministic initiator to avoid offer glare
    if (!myPeerId) return false;
    return myPeerId.localeCompare(peerId) < 0;
}

function isPoliteFor(peerId) {
    // In perfect negotiation, one side is "polite" (will accept/repair collisions)
    return !shouldInitiateWith(peerId);
}

async function sendSignal(to, payload) {
    if (!nostrClient) throw new Error('Not connected to Nostr');
    const type = payload?.type;
    const isBroadcast = !to;
    const toSession = isBroadcast ? null : peerSessions.get(to);
    const needsToSession = !isBroadcast && type !== 'probe';

    if (needsToSession && !toSession) throw new Error('No peer session yet');

    let finalPayload = {
        ...payload,
        ...(to ? { to } : {}),
        ...(needsToSession ? { toSession } : {}),
        fromSession: mySessionNonce,
    };

    // Optionally encrypt the payload using unsea
    if (encryptionEnabled && to && myKeyPair) {
        try {
            const recipientPublicKey = getPeerPublicKey(to);
            if (recipientPublicKey) {
                finalPayload = await wrapEncryptedPayload(finalPayload, recipientPublicKey);
            }
            // Silently fall back to unencrypted if no peer key yet - will be available from their hello
        } catch (e) {
            console.warn('[Crypto] Encryption failed, sending unencrypted:', e?.message);
        }
    }

    return nostrClient.send(finalPayload);
}

async function sendSignalToSession(to, payload, toSession) {
    if (!nostrClient) throw new Error('Not connected to Nostr');
    if (!toSession) throw new Error('toSession is required');
    
    let finalPayload = {
        ...payload,
        to,
        toSession,
        fromSession: mySessionNonce,
    };

    // Optionally encrypt the payload using unsea
    if (encryptionEnabled && to && myKeyPair) {
        try {
            const recipientPublicKey = getPeerPublicKey(to);
            if (recipientPublicKey) {
                finalPayload = await wrapEncryptedPayload(finalPayload, recipientPublicKey);
            }
            // Silently fall back to unencrypted if no peer key yet - will be available from their hello
        } catch (e) {
            console.warn('[Crypto] Encryption failed, sending unencrypted:', e?.message);
        }
    }

    return nostrClient.send(finalPayload);
}

async function maybeProbePeer(peerId) {
    if (!nostrClient) return;
    const session = peerSessions.get(peerId);
    if (!session) return;
    if (!shouldInitiateWith(peerId)) return;

    const last = peerProbeState.get(peerId);
    if (last && last.session === session) return;

    const probeId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    peerProbeState.set(peerId, { session, ts: Date.now(), probeId });
    try {
        const probePayload = { type: 'probe', probeId };
        // Include our encryption public key so peer can encrypt responses
        if (encryptionEnabled && myKeyPair && myKeyPair.publicKey) {
            try {
                probePayload.encryptionPublicKey = JSON.stringify(myKeyPair.publicKey);
            } catch (e) {
                console.warn('[Crypto] Failed to serialize public key for probe:', e?.message);
            }
        }
        await sendSignal(peerId, probePayload);
        log(`Probing peer ${peerId.substring(0, 6)}...`, 'info');
    } catch (e) {
        log(`Probe failed: ${e?.message || e}`, 'warning');
    }
}

// Force a probe to resync sessions when we detect mismatched toSession
async function resyncPeerSession(peerId, reason = 'session mismatch') {
    if (!nostrClient) return;

    const now = Date.now();
    const last = peerResyncState.get(peerId) || 0;
    if (now - last < 3000) return; // throttle resync attempts
    peerResyncState.set(peerId, now);

    const probeId = Math.random().toString(36).slice(2, 10) + now.toString(36);
    // Track probe so probe-ack can update readiness/session
    const prevSession = peerSessions.get(peerId) || null;
    peerProbeState.set(peerId, { session: prevSession, ts: now, probeId });

    try {
        await sendSignal(peerId, { type: 'probe', probeId });
        log(`Resyncing session with ${peerId.substring(0, 6)}... (${reason})`, 'info');
    } catch (e) {
        log(`Resync probe failed: ${e?.message || e}`, 'warning');
    }
}

function logDrop(peerId, payload, reason) {
    const t = payload?.type || 'unknown';
    if (t !== 'signal-offer' && t !== 'signal-answer' && t !== 'signal-ice' && t !== 'signal-ice-batch' && t !== 'probe' && t !== 'probe-ack') return;
    log(`Dropped ${t} from ${peerId.substring(0, 6)}... (${reason})`, 'warning');
}

async function resetPeerConnection(peerId) {
    const existing = peerConnections.get(peerId);
    if (existing instanceof RTCPeerConnection) {
        try {
            existing.close();
        } catch {
            // ignore
        }
    }
    peerConnections.delete(peerId);
    pendingIce.delete(peerId);

    const dc = dataChannels.get(peerId);
    if (dc) {
        try {
            dc.close();
        } catch {
            // ignore
        }
    }
    dataChannels.delete(peerId);
    updatePeerList();

    return ensurePeerConnection(peerId);
}

async function ensurePeerConnection(peerId) {
    if (!peerId || peerId === myPeerId) return null;
    if (peerConnections.has(peerId) && peerConnections.get(peerId) instanceof RTCPeerConnection) {
        return peerConnections.get(peerId);
    }

    const initiator = shouldInitiateWith(peerId);

    // Initiator must wait until the peer proves it's live (probe-ack), otherwise we end up
    // negotiating with stale peers from relay history.
    if (initiator && !readyPeers.has(peerId)) {
        return null;
    }
    const pc = await createPeerConnection(peerId, initiator);
    return pc;
}

async function addIceCandidateSafely(peerId, candidate) {
    const pc = peerConnections.get(peerId);
    if (!(pc instanceof RTCPeerConnection)) return;

    if (!pc.remoteDescription) {
        const list = pendingIce.get(peerId) || [];
        list.push(candidate);
        pendingIce.set(peerId, list);
        return;
    }

    await pc.addIceCandidate(new RTCIceCandidate(candidate));
}

async function flushPendingIce(peerId) {
    const pc = peerConnections.get(peerId);
    if (!(pc instanceof RTCPeerConnection)) return;
    if (!pc.remoteDescription) return;

    const list = pendingIce.get(peerId);
    if (!list || list.length === 0) return;
    pendingIce.delete(peerId);

    for (const c of list) {
        try {
            await pc.addIceCandidate(new RTCIceCandidate(c));
        } catch (e) {
            log(`Failed to add queued ICE candidate: ${e?.message || e}`, 'warning');
        }
    }
}

async function connectNostr() {
    const roomIdInput = document.getElementById('roomId');
    const roomId = roomIdInput.value.trim();
    
    // Check which signaling methods are enabled
    nostrEnabled = document.getElementById('nostrToggle')?.checked ?? true;
    trackerEnabled = document.getElementById('trackerToggle')?.checked ?? true;
    gunEnabled = document.getElementById('gunToggle')?.checked ?? true;

    if (!nostrEnabled && !trackerEnabled && !gunEnabled) {
        log('Please enable at least one signaling method', 'error');
        return;
    }

    const effectiveRoom = roomId || `room-${Math.random().toString(36).substring(2, 10)}`;
    if (!roomId) roomIdInput.value = effectiveRoom;

    // Generate identity for all methods
    myPeerId = myPeerId || ensureIdentity();
    document.getElementById('clientId').textContent = myPeerId.substring(0, 16) + '...';
    document.getElementById('sessionId').textContent = effectiveRoom;

    try {
        // Only connect to Nostr if enabled
        if (nostrEnabled) {
            const relayUrlRaw = document.getElementById('relayUrl').value.trim() || DEFAULT_RELAYS.join(',');
            
            const relayCandidatesRaw = relayUrlRaw.toLowerCase() === 'auto'
                ? DEFAULT_RELAYS
                : Array.from(
                    new Set(
                        relayUrlRaw
                            .split(/[\s,]+/)
                            .map((s) => s.trim())
                            .filter((s) => s.startsWith('wss://') || s.startsWith('ws://'))
                    )
                );

            const relayCandidates = relayCandidatesRaw.length ? relayCandidatesRaw : DEFAULT_RELAYS;

            log(`Connecting to Nostr relay...`, 'info');

            if (nostrClient) {
                await nostrClient.disconnect();
                nostrClient = null;
            }

            // Preserve session across relay reconnects to avoid breaking existing signaling.
            // Only reset on true disconnect (Disconnect button), not on relay failures.
            // NOTE: Do NOT reset mySessionNonce here. Keep it stable across relay changes.
            // If no session exists yet, it will be created below.
            peerSessions.clear();
            peerProbeState.clear();
            readyPeers.clear();
            pendingIce.clear();
            peerConnections.forEach((pc) => {
                if (pc instanceof RTCPeerConnection) pc.close();
            });
            peerConnections.clear();
            dataChannels.clear();
            updatePeerList();

            const wireHandlers = (client) => {
                client.__handlers = {
                    onState: (state) => {
                        if (state === 'connected') updateStatus(true);
                        if (state === 'disconnected') updateStatus(false);
                    },
                    onNotice: (notice) => {
                        log(`Relay NOTICE: ${String(notice)}`, 'warning');
                    },
                    onOk: ({ id, ok, message }) => {
                        if (ok === false) log(`Relay rejected event ${String(id).slice(0, 8)}...: ${String(message)}`, 'error');
                    },
                };
            };

            // Try relays async (in small parallel batches) and pick the first that accepts publishes.
            const relayBatchSize = 3;
            let lastError = null;
            let selected = null;
            
            // Generate unsea key pair for encryption (once per connection, defaults to enabled)
            if (!myKeyPair) {
                try {
                    myKeyPair = await generateRandomPair();
                    console.log('[Crypto] Generated unsea key pair for peer', myPeerId.substring(0, 6));
                } catch (e) {
                    console.warn('[Crypto] Failed to generate key pair:', e?.message);
                }
            }
            
            // Generate session nonce only once per connect session (preserve across relay changes)
            if (!mySessionNonce) {
                mySessionNonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
            }

            const makeClient = (relayUrl) => createNostrClient({
                relayUrl,
                room: effectiveRoom,
                secretKeyHex: mySecretKeyHex,
                onState: (state) => {
                    if (state === 'connected') {
                    updateStatus(true);
                }
                if (state === 'disconnected') {
                    updateStatus(false);
                }
            },
            onNotice: (notice) => {
                log(`Relay NOTICE (${relayUrl}): ${String(notice)}`, 'warning');
            },
            onOk: ({ id, ok, message }) => {
                if (ok === false) log(`Relay rejected event ${String(id).slice(0, 8)}...: ${String(message)}`, 'error');
            },
            onPayload: async ({ from, payload }) => {
                const peerId = from;
                if (!peerId || peerId === myPeerId) return;

                // Discovery no longer decides source; selection happens on connect

                // Try to decrypt if encrypted (using unsea)
                let decrypted = payload;
                if (payload && payload.encrypted && payload.content && myKeyPair && myKeyPair.privateKey) {
                    try {
                        const senderPublicKey = getPeerPublicKey(peerId);
                        if (senderPublicKey) {
                            decrypted = await unwrapEncryptedPayload(payload, senderPublicKey, myKeyPair.privateKey);
                            console.log('[Crypto] Decrypted message from', peerId.substring(0, 6));
                        } else {
                            console.warn('[Crypto] No public key for sender, cannot decrypt');
                        }
                    } catch (e) {
                        console.warn('[Crypto] Failed to decrypt message from', peerId.substring(0, 6), ':', e?.message);
                        // If decryption fails, ignore the message (safety-first for encrypted content)
                        return;
                    }
                }

                // Use decrypted payload for all subsequent processing
                payload = decrypted;

                // Use the existing peer list UI as a simple "seen peers" list
                if (!peerConnections.has(peerId)) {
                    peerConnections.set(peerId, null);
                    peerSources.set(peerId, 'Nostr'); // Mark as Nostr peer
                    updatePeerList();
                    log(`Peer seen: ${peerId.substring(0, 6)}...`, 'success');
                }

                if (!payload || typeof payload !== 'object') return;

                // NOTE: Do NOT learn/update peerSessions from arbitrary relay history.
                // Only trust:
                // - `hello` (broadcast presence)
                // - messages targeted to this tab via `toSession === mySessionNonce`

                // Presence
                if (payload.type === 'hello') {
                    if (!myPeerId || !mySessionNonce) return;
                    if (typeof payload.session !== 'string' || payload.session.length < 6) return;
                    const prev = peerSessions.get(peerId);
                    peerSessions.set(peerId, payload.session);
                    if (!prev || prev !== payload.session) {
                        log(`Peer session updated: ${peerId.substring(0, 6)}...`, 'info');
                    }

                    if (prev && prev !== payload.session) {
                        readyPeers.delete(peerId);
                    }

                    // Extract peer's encryption public key if included
                    if (encryptionEnabled && payload.encryptionPublicKey) {
                        try {
                            const publicKeyObj = JSON.parse(payload.encryptionPublicKey);
                            registerPeerPublicKey(peerId, publicKeyObj);
                            console.log('[Crypto] Registered peer encryption key from hello:', peerId.substring(0, 6));
                        } catch (e) {
                            console.warn('[Crypto] Failed to parse peer public key from hello:', e?.message);
                        }
                    }

                    // We may receive peer presence while still selecting a relay.
                    // Store and probe once we have a selected/connected `nostrClient`.
                    deferredHelloPeers.add(peerId);
                    await maybeProbePeer(peerId);
                    return;
                }

                if (payload.type === 'probe') {
                    // Learn the peer's session from a live message.
                    if (typeof payload.fromSession === 'string' && payload.fromSession.length >= 6) {
                        const prev = peerSessions.get(peerId);
                        if (!prev || prev !== payload.fromSession) {
                            peerSessions.set(peerId, payload.fromSession);
                            log(`Peer session ${prev ? 'rotated' : 'learned'}: ${peerId.substring(0, 6)}...`, 'info');
                            readyPeers.delete(peerId);
                        }
                    }

                    // Reply directly to the sender's session (fromSession) so the initiator doesn't drop it.
                    try {
                        await sendSignalToSession(peerId, { type: 'probe-ack', probeId: payload.probeId }, payload.fromSession);
                        log(`Probe ack -> ${peerId.substring(0, 6)}...`, 'info');
                    } catch (e) {
                        log(`Probe-ack failed: ${e?.message || e}`, 'warning');
                    }
                    return;
                }

                // Only accept signaling intended for THIS browser session
                if (payload.toSession && payload.toSession !== mySessionNonce) {
                    logDrop(peerId, payload, 'toSession mismatch');
                    await resyncPeerSession(peerId, 'toSession mismatch');
                    return;
                }

                // Signaling messages are always targeted
                if (payload.to && payload.to !== myPeerId) {
                    logDrop(peerId, payload, 'to mismatch');
                    return;
                }

                // Now that we know it's targeted to this session, we can safely learn peer session.
                if (typeof payload.fromSession === 'string' && payload.fromSession.length >= 6) {
                    const prev = peerSessions.get(peerId);
                    if (!prev || prev !== payload.fromSession) {
                        peerSessions.set(peerId, payload.fromSession);
                        log(`Peer session ${prev ? 'rotated' : 'learned'}: ${peerId.substring(0, 6)}...`, 'info');
                        readyPeers.delete(peerId);
                    }
                }

                if (payload.type === 'probe-ack') {
                    const last = peerProbeState.get(peerId);
                    if (!last || !last.probeId || !payload.probeId || payload.probeId !== last.probeId) {
                        logDrop(peerId, payload, 'probeId mismatch');
                        return;
                    }
                    // Extract peer's encryption public key from probe-ack if included
                    if (encryptionEnabled && payload.encryptionPublicKey) {
                        try {
                            const publicKeyObj = JSON.parse(payload.encryptionPublicKey);
                            registerPeerPublicKey(peerId, publicKeyObj);
                            console.log('[Crypto] Registered peer encryption key from probe-ack:', peerId.substring(0, 6));
                        } catch (e) {
                            console.warn('[Crypto] Failed to parse peer public key from probe-ack:', e?.message);
                        }
                    }
                    // Peer session can legitimately rotate between hello/probe/ack (reloads, relay history).
                    // Since this message is already targeted to our toSession, accept it and update our view.
                    if (typeof payload.fromSession === 'string' && payload.fromSession.length >= 6) {
                        if (peerSessions.get(peerId) !== payload.fromSession) {
                            peerSessions.set(peerId, payload.fromSession);
                        }
                        if (last.session !== payload.fromSession) {
                            last.session = payload.fromSession;
                        }
                    }
                    if (Date.now() - last.ts > 30000) {
                        logDrop(peerId, payload, 'stale probe-ack');
                        return;
                    }

                    readyPeers.add(peerId);
                    if (shouldInitiateWith(peerId)) {
                        log(`Probe ack <- ${peerId.substring(0, 6)}...`, 'info');
                        await ensurePeerConnection(peerId);
                    }
                    return;
                }

                if (payload.type === 'signal-offer' && payload.sdp) {
                    log(`Received offer from ${peerId.substring(0, 6)}...`, 'info');
                    let pc = await ensurePeerConnection(peerId);
                    if (!pc) {
                        // As the receiver we should always accept an offer even if probe logic didn't run.
                        pc = await resetPeerConnection(peerId);
                    }
                    if (!(pc instanceof RTCPeerConnection)) return;

                    // Offer collision handling: if we're not stable, decide whether to ignore or reset.
                    const offerCollision = pc.signalingState !== 'stable';
                    if (offerCollision && !isPoliteFor(peerId)) {
                        log(`Ignoring offer collision from ${peerId.substring(0, 6)}...`, 'warning');
                        return;
                    }
                    if (offerCollision && isPoliteFor(peerId)) {
                        log(`Offer collision; resetting connection with ${peerId.substring(0, 6)}...`, 'warning');
                        await resetPeerConnection(peerId);
                        const next = peerConnections.get(peerId);
                        if (!(next instanceof RTCPeerConnection)) return;
                        pc = next;
                    }

                    const pc2 = peerConnections.get(peerId);
                    if (!(pc2 instanceof RTCPeerConnection)) return;

                    // Only accept offers here.
                    if (payload.sdp?.type && payload.sdp.type !== 'offer') {
                        log(`Ignoring non-offer in signal-offer from ${peerId.substring(0, 6)}...`, 'warning');
                        return;
                    }

                    await pc2.setRemoteDescription(new RTCSessionDescription(payload.sdp));
                    await flushPendingIce(peerId);
                    if (pc2.signalingState !== 'have-remote-offer') {
                        log(`Not answering; unexpected state: ${pc2.signalingState}`, 'warning');
                        return;
                    }
                    const answer = await pc2.createAnswer();
                    await pc2.setLocalDescription(answer);
                    try {
                        await sendSignal(peerId, { type: 'signal-answer', sdp: { type: pc2.localDescription.type, sdp: pc2.localDescription.sdp } });
                        log(`Sent answer to ${peerId.substring(0, 6)}...`, 'success');
                    } catch (e) {
                        log(`Failed to send answer: ${e?.message || e}`, 'error');
                    }
                    return;
                }

                if (payload.type === 'signal-answer' && payload.sdp) {
                    log(`Received answer from ${peerId.substring(0, 6)}...`, 'info');
                    const pc = peerConnections.get(peerId);
                    if (pc instanceof RTCPeerConnection) {
                        if (payload.sdp?.type && payload.sdp.type !== 'answer') {
                            log(`Ignoring non-answer in signal-answer from ${peerId.substring(0, 6)}...`, 'warning');
                            return;
                        }
                        // Perfect negotiation guard: only accept an answer when we have a local offer
                        if (pc.signalingState !== 'have-local-offer') {
                            log(`Ignoring answer; unexpected signaling state: ${pc.signalingState}`, 'warning');
                            return;
                        }
                        await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
                        await flushPendingIce(peerId);
                    }
                    return;
                }

                if (payload.type === 'signal-ice' && payload.candidate) {
                    log(`Received ICE candidate from ${peerId.substring(0, 6)}...`, 'info');
                    try {
                        await addIceCandidateSafely(peerId, payload.candidate);
                    } catch (e) {
                        log(`Failed to add ICE candidate: ${e?.message || e}`, 'warning');
                    }
                    return;
                }

                if (payload.type === 'signal-ice-batch' && Array.isArray(payload.candidates)) {
                    log(`Received ICE batch (${payload.candidates.length}) from ${peerId.substring(0, 6)}...`, 'info');
                    for (const c of payload.candidates) {
                        try {
                            await addIceCandidateSafely(peerId, c);
                        } catch (e) {
                            log(`Failed to add ICE candidate: ${e?.message || e}`, 'warning');
                        }
                    }
                }
            },
        });

            const tryOneRelay = async (relayUrl) => {
                const candidateClient = makeClient(relayUrl);
                await candidateClient.connect();
                const ok = await candidateClient.sendWithOk({ type: 'relay-check', session: mySessionNonce }, { timeoutMs: 3500 });
                if (ok.ok !== true) throw new Error(ok.message || 'Relay rejected publish');
                return { relayUrl, client: candidateClient };
            };

            for (let i = 0; i < relayCandidates.length && !selected; i += relayBatchSize) {
                const batch = relayCandidates.slice(i, i + relayBatchSize);
                batch.forEach((u) => log(`Trying relay: ${u}`, 'info'));

                const clientsInBatch = new Map();
                const attempts = batch.map((relayUrl) => (async () => {
                    const result = await tryOneRelay(relayUrl);
                    clientsInBatch.set(relayUrl, result.client);
                    return result;
                })());

                try {
                    selected = await Promise.any(attempts);
                } catch (e) {
                    lastError = e;
                } finally {
                    // Close any batch clients that were created but not selected.
                    for (const [url, c] of clientsInBatch.entries()) {
                        if (selected && selected.relayUrl === url) continue;
                        try {
                            await c.disconnect();
                        } catch {
                            // ignore
                        }
                    }
                }
            }

            if (!selected) {
                throw lastError || new Error('No relay candidates available');
            }

            nostrClient = selected.client;
            document.getElementById('relayUrl').value = selected.relayUrl;
            log(`Selected relay: ${selected.relayUrl}`, 'success');
            log(`Joined Nostr room: ${effectiveRoom}`, 'success');
            
            // Send hello via Nostr
            const helloPayload = { type: 'hello', session: mySessionNonce };
            if (encryptionEnabled && myKeyPair && myKeyPair.publicKey) {
                try {
                    helloPayload.encryptionPublicKey = JSON.stringify(myKeyPair.publicKey);
                    console.log('[Crypto] Including public key in hello message');
                } catch (e) {
                    console.warn('[Crypto] Failed to serialize public key:', e?.message);
                }
            }
            await nostrClient.send(helloPayload);

            // Kick any peers we saw while selecting relays.
            for (const peerId of deferredHelloPeers) {
                await maybeProbePeer(peerId);
            }
            deferredHelloPeers.clear();
        } // End of Nostr connection block

        // Initialize hybrid signaling (Tracker + Gun) - always runs regardless of Nostr
        if (hybridSignaling) {
            hybridSignaling.shutdown();
        }
        
        if (trackerEnabled || gunEnabled) {
            hybridSignaling = new HybridSignaling({
                roomId: effectiveRoom,
                peerId: myPeerId,
                onPeerDiscovered: ({ source, peerId: discoveredPeerId, peer, data }) => {
                    if (discoveredPeerId === myPeerId) return;
                    const sourceLabel = source === 'tracker' ? 'Tracker' : source === 'gun' ? 'Gun' : 'Nostr';
                    log(`Peer discovered via ${source}: ${discoveredPeerId.substring(0, 6)}...`, 'info');
                        // Track discovery source for labeling; FIRST discovery source wins (immutable)
                        // This ensures if Gun discovers peer first, Tracker won't overwrite it
                        if (!peerSources.has(discoveredPeerId)) {
                            peerSources.set(discoveredPeerId, sourceLabel);
                        }
                    
                    // Track discovered peer
                    if (!peerConnections.has(discoveredPeerId)) {
                        peerConnections.set(discoveredPeerId, null);
                        updatePeerList();
                    }
                    
                    // If from tracker, attach the simple-peer instance immediately
                    if (source === 'tracker' && peer) {
                        attachTrackerPeer(discoveredPeerId, peer);
                    }
                    
                    // If from Gun, initiate WebRTC if we're the initiator
                    if (source === 'gun' && shouldInitiateWith(discoveredPeerId)) {
                        // Mark Gun peers as ready immediately (no probe needed)
                        readyPeers.add(discoveredPeerId);
                        initiateGunWebRTC(discoveredPeerId);
                    }
                },
                onSignal: async ({ source, from, signal }) => {
                    const peerId = from;
                    const sourceLabel = source === 'gun' ? 'Gun' : 'Nostr';
                    lastSignalSource.set(peerId, sourceLabel);
                    log(`Signal via ${source} from ${peerId.substring(0, 6)}...`, 'info');
                    
                    // Process Gun signals - establish WebRTC connections
                    if (source === 'gun' && signal) {
                        await handleGunSignal(peerId, signal);
                    }
                }
            });
            
            // Initialize tracker for peer discovery (if enabled)
            if (trackerEnabled) {
                hybridSignaling.initTracker([
                    'wss://tracker.openwebtorrent.com',
                    'wss://tracker.webtorrent.dev',
                    'wss://tracker.btorrent.xyz'
                ]);
            }
            
            // Initialize Gun for alternative signaling (if enabled)
            if (gunEnabled) {
                try {
                    await hybridSignaling.initGun();
                } catch (err) {
                    console.error('[Gun] Initialization error:', err);
                }
            }
        }
        
        // Report which methods are active
        const enabled = [];
        if (nostrEnabled) enabled.push('Nostr');
        if (trackerEnabled) enabled.push('Tracker');
        if (gunEnabled) enabled.push('Gun');
        log(`Signaling active: ${enabled.join(' + ')}`, 'success');
        
        updateStatus(true);
        log('Connection established', 'success');
    } catch (error) {
        log(`Nostr connection error: ${error.message}`, 'error');
        updateStatus(false);
    }
}

async function connectWebRTC() {
    const serverUrl = document.getElementById('serverUrl').value.trim();
    const roomId = document.getElementById('roomId').value.trim();

    if (!serverUrl) {
        log('Please enter a server URL', 'error');
        return;
    }

    if (!roomId) {
        log('Please enter a room ID', 'error');
        return;
    }

    try {
        log(`Connecting to ${serverUrl}...`, 'info');
        
        // For Cloudflare, use /ws endpoint with room ID query param
        let finalUrl = serverUrl;
        if (serverUrl.includes('signal.peer.ooo')) {
            finalUrl = `${serverUrl.replace(/\/$/, '')}/ws?room=${roomId}`;
            log(`Using hosted endpoint with session: ${roomId}`, 'info');
        }
        
        client = new UniWRTCClient(finalUrl, { autoReconnect: false });
        
        client.on('connected', (data) => {
            log(`Connected with client ID: ${data.clientId}`, 'success');
            document.getElementById('clientId').textContent = data.clientId;
            updateStatus(true);
            
            // Auto-join the room
            log(`Joining session: ${roomId}`, 'info');
            client.joinSession(roomId);
        });

        client.on('joined', (data) => {
            log(`Joined session: ${data.sessionId}`, 'success');
            document.getElementById('sessionId').textContent = data.sessionId;
            
            if (data.clients && data.clients.length > 0) {
                log(`Found ${data.clients.length} existing peers`, 'info');
                data.clients.forEach(peerId => {
                    log(`Creating connection to existing peer: ${peerId.substring(0, 6)}...`, 'info');
                    createPeerConnection(peerId, true);
                });
            }
        });

        client.on('peer-joined', (data) => {
            // Only handle peers in our session
            if (client.sessionId && data.sessionId !== client.sessionId) {
                log(`Ignoring peer from different session: ${data.sessionId}`, 'warning');
                return;
            }
            
            log(`Peer joined: ${data.peerId.substring(0, 6)}...`, 'success');
            
            // Wait a bit to ensure both peers are ready
            setTimeout(() => {
                createPeerConnection(data.peerId, false);
            }, 100);
        });

        client.on('peer-left', (data) => {
            log(`Peer left: ${data.peerId.substring(0, 6)}...`, 'warning');
            const pc = peerConnections.get(data.peerId);
            if (pc) {
                pc.close();
                peerConnections.delete(data.peerId);
                dataChannels.delete(data.peerId);
                updatePeerList();
            }
        });

        client.on('offer', async (data) => {
            log(`Received offer from ${data.peerId.substring(0, 6)}...`, 'info');
            const pc = peerConnections.get(data.peerId) || await createPeerConnection(data.peerId, false);
            await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            client.sendAnswer(answer, data.peerId);
            log(`Sent answer to ${data.peerId.substring(0, 6)}...`, 'success');
        });

        client.on('answer', async (data) => {
            log(`Received answer from ${data.peerId.substring(0, 6)}...`, 'info');
            const pc = peerConnections.get(data.peerId);
            if (pc) {
                await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
            }
        });

        client.on('ice-candidate', async (data) => {
            log(`Received ICE candidate from ${data.peerId.substring(0, 6)}...`, 'info');
            const pc = peerConnections.get(data.peerId);
            if (pc && data.candidate) {
                await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
            }
        });

        client.on('disconnected', () => {
            log('Disconnected from server', 'error');
            updateStatus(false);
            peerConnections.forEach(pc => pc.close());
            peerConnections.clear();
            dataChannels.clear();
            updatePeerList();
        });

        client.on('error', (data) => {
            log(`Error: ${data.message}`, 'error');
        });

        await client.connect();
    } catch (error) {
        log(`Connection error: ${error.message}`, 'error');
        updateStatus(false);
    }
}

window.disconnect = function() {
    if (nostrClient) {
        nostrClient.disconnect().catch(() => {});
        nostrClient = null;
        mySessionNonce = null;
        peerSessions.clear();
        peerProbeState.clear();
        readyPeers.clear();
        pendingIce.clear();
        peerConnections.forEach((pc) => {
            if (pc instanceof RTCPeerConnection) pc.close();
        });
        peerConnections.clear();
        dataChannels.clear();
        updatePeerList();
    }
    trackerPeers.forEach((sp) => {
        try { sp.destroy?.(); } catch {}
    });
    trackerPeers.clear();
    if (hybridSignaling) {
        hybridSignaling.shutdown();
        hybridSignaling = null;
        log('Hybrid signaling disconnected', 'info');
    }
    if (client) {
        client.disconnect();
        client = null;
        peerConnections.forEach(pc => pc.close());
        peerConnections.clear();
        dataChannels.clear();
        updatePeerList();
        updateStatus(false);
        log('Disconnected', 'warning');
    }
};

window.toggleEncryption = function() {
    const checkbox = document.getElementById('encryptionToggle');
    encryptionEnabled = checkbox.checked;
    const status = encryptionEnabled ? 'enabled' : 'disabled';
    console.log('[Crypto] Encryption', status);
    log(`Signaling encryption ${status}`, 'info');
};

window.toggleSignalFabric = function() {
    const fabricToggle = document.getElementById('signalFabricToggle');
    const nostrToggle = document.getElementById('nostrToggle');
    const trackerToggle = document.getElementById('trackerToggle');
    const gunToggle = document.getElementById('gunToggle');
    
    if (fabricToggle.checked) {
        // Check all source toggles
        nostrToggle.checked = true;
        trackerToggle.checked = true;
        gunToggle.checked = true;
        
        // Grey them out (disable)
        nostrToggle.disabled = true;
        trackerToggle.disabled = true;
        gunToggle.disabled = true;
        
        // Style disabled state
        document.querySelectorAll('[id$="Toggle"][disabled]').forEach(input => {
            const label = input.closest('label');
            if (label) {
                label.style.opacity = '0.5';
                label.style.cursor = 'not-allowed';
            }
        });
    } else {
        // Uncheck and enable all source toggles
        nostrToggle.checked = false;
        trackerToggle.checked = false;
        gunToggle.checked = false;
        
        nostrToggle.disabled = false;
        trackerToggle.disabled = false;
        gunToggle.disabled = false;
        
        // Restore normal style
        document.querySelectorAll('[id$="Toggle"]:not([disabled])').forEach(input => {
            const label = input.closest('label');
            if (label) {
                label.style.opacity = '1';
                label.style.cursor = 'pointer';
            }
        });
    }
};

// REMOVED: load handler was firing before HTML existed

async function createPeerConnection(peerId, shouldInitiate) {
    if (peerConnections.has(peerId)) {
        const existing = peerConnections.get(peerId);
        if (existing instanceof RTCPeerConnection) {
            log(`Peer connection already exists for ${peerId.substring(0, 6)}...`, 'warning');
            return existing;
        }

        // Placeholder entry (e.g., peer "seen" list). Replace it with a real RTCPeerConnection.
        peerConnections.delete(peerId);
    }

    log(`Creating peer connection with ${peerId.substring(0, 6)}... (shouldInitiate: ${shouldInitiate})`, 'info');

    const pc = new RTCPeerConnection({
        iceServers: ICE_SERVERS,
    });

    // Register early to avoid races where answer/ICE arrives before this function finishes.
    peerConnections.set(peerId, pc);
    pendingIce.delete(peerId);
    updatePeerList();

    pc.onicecandidate = (event) => {
        if (!nostrClient && client && event.candidate) {
            client.sendIceCandidate(event.candidate, peerId);
            return;
        }

        // Route ICE to Gun if Nostr is disabled but Gun is enabled
        if (!nostrClient && gunEnabled && hybridSignaling && event.candidate) {
            hybridSignaling.sendGunSignal(peerId, {
                type: 'ice',
                candidate: event.candidate.toJSON?.() || event.candidate
            });
            return;
        }

        if (!nostrClient) return;

        const entry = outboundIceBatches.get(peerId) || { candidates: [], timer: null };
        outboundIceBatches.set(peerId, entry);

        if (event.candidate) {
            entry.candidates.push(event.candidate.toJSON?.() || event.candidate);
        }

        const flush = () => {
            entry.timer = null;
            if (!entry.candidates.length) return;
            const batch = entry.candidates.splice(0, entry.candidates.length);
            log(`Sending ICE batch (${batch.length}) to ${peerId.substring(0, 6)}...`, 'info');
            sendSignal(peerId, { type: 'signal-ice-batch', candidates: batch }).catch((e) => {
                log(`Failed to send ICE batch: ${e?.message || e}`, 'warning');
            });
        };

        // If end-of-candidates, flush immediately; otherwise debounce.
        if (!event.candidate) {
            flush();
            return;
        }

        if (!entry.timer) {
            entry.timer = setTimeout(flush, 250);
        }
    };

    pc.oniceconnectionstatechange = () => {
        log(`ICE state (${peerId.substring(0, 6)}...): ${pc.iceConnectionState}`, 'info');
        updatePeerList();
    };

    pc.onconnectionstatechange = () => {
        log(`Conn state (${peerId.substring(0, 6)}...): ${pc.connectionState}`, 'info');
        updatePeerList();
    };

    pc.ondatachannel = (event) => {
            log(`Received data channel from ${peerId.substring(0, 6)}`, 'info');
        const hint = lastSignalSource.get(peerId) || null;
        setupDataChannel(peerId, event.channel, hint);
    };

    if (shouldInitiate) {
        // Only create data channel if we don't have one yet
        if (!dataChannels.has(peerId)) {
            const dc = pc.createDataChannel('chat');
            const hint = lastSignalSource.get(peerId) || 'Nostr';
            setupDataChannel(peerId, dc, hint);
        } else {
            log(`Data channel already exists for ${peerId.substring(0, 6)}, reusing`, 'info');
        }
        
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        
        initiatedPeers.add(peerId); // Mark as initiated
        
        if (nostrClient) {
            try {
                await sendSignal(peerId, { type: 'signal-offer', sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
                log(`Sent offer to ${peerId.substring(0, 6)}...`, 'success');
            } catch (e) {
                log(`Failed to send offer: ${e?.message || e}`, 'warning');
            }
        } else if (client) {
            client.sendOffer(offer, peerId);
            log(`Sent offer to ${peerId.substring(0, 6)}...`, 'success');
        }
    } else {
            log(`Waiting for offer from ${peerId.substring(0, 6)}...`, 'info');
    }
    return pc;
}

function setupDataChannel(peerId, dataChannel, sourceHint) {
    // Avoid duplicate data channel setup
    if (dataChannels.has(peerId)) {
        log(`Data channel already exists for ${peerId.substring(0, 6)}, skipping duplicate`, 'warning');
        return;
    }
    
    dataChannel.onopen = () => {
        log(`Data channel open with ${peerId.substring(0, 6)}...`, 'success');
        rtcConnectedAt.set(peerId, Date.now());
        const lastSignal = lastSignalSource.get(peerId);
        const chosen = sourceHint || lastSignal || 'Nostr';
        const preferred = peerPreferredSource.get(peerId.trim());

        // If another transport already won, tear down this channel immediately
        if (preferred && preferred !== chosen) {
            log(`Ignoring data channel from ${chosen} because ${preferred} already won for ${peerId.substring(0, 6)}...`, 'warning');
            try { dataChannel.close(); } catch {}
            const pc = peerConnections.get(peerId);
            if (pc instanceof RTCPeerConnection) {
                try { pc.close(); } catch {}
            }
            dataChannels.delete(peerId);
            return;
        }

        if (!peerSources.has(peerId) && chosen) {
            peerSources.set(peerId, chosen);
        }
        setPreferredSource(peerId, chosen);
    };

    dataChannel.onmessage = (event) => {
        let message;
        try {
            message = JSON.parse(event.data);
        } catch {
            // Treat as plain text chat message
            displayChatMessage(event.data, `${peerId.substring(0, 6)}...`, false);
            return;
        }

        // Treat as chat message
        displayChatMessage(JSON.stringify(message), `${peerId.substring(0, 6)}...`, false);
    };

    dataChannel.onclose = () => {
            log(`Data channel closed with ${peerId.substring(0, 6)}...`, 'warning');
        dataChannels.delete(peerId);
        rtcConnectedAt.delete(peerId);
        // DO NOT delete peerPreferredSource - it must remain stable for the peer's lifetime
        // This ensures "first source wins" is never violated, even if connections drop
        updatePeerList();
    };

    dataChannels.set(peerId, dataChannel);
}

window.sendChatMessage = function() {
    const message = document.getElementById('chatMessage').value.trim();
    
    if (!message) {
        return;
    }

    const hasRtc = dataChannels.size > 0;
    const hasTracker = trackerPeers.size > 0;
    if (!hasRtc && !hasTracker) {
        log('No data channels yet. Open this room in another tab/browser and wait for WebRTC to connect.', 'error');
        return;
    }

    // Send to all connected peers
    let sent = 0;
    
    // Send via WebRTC data channels (Nostr signaling)
    dataChannels.forEach((dc, peerId) => {
        if (dc.readyState === 'open') {
            try {
                dc.send(message);
                sent++;
            } catch (err) {
                console.warn('[Chat] Failed to send via datachannel to', peerId.substring(0, 6), err);
            }
        }
    });
    
    // Send via tracker peers (simple-peer)
    trackerPeers.forEach((sp, peerId) => {
        if (sp && sp.connected) {
            try {
                sp.send(message);
                sent++;
            } catch (err) {
                console.warn('[Chat] Failed to send via tracker to', peerId.substring(0, 6), err);
            }
        }
    });

    if (sent > 0) {
        displayChatMessage(message, 'You', true);
        document.getElementById('chatMessage').value = '';
    } else {
        log('No open connections to send message', 'error');
    }
};

function displayChatMessage(message, sender, isLocal) {
    const chatContainer = document.getElementById('chatContainer');
    
    // Clear placeholder if needed
    if (chatContainer.querySelector('p')) {
        chatContainer.innerHTML = '';
    }

    const messageEl = document.createElement('div');
    messageEl.className = 'log-entry';
    messageEl.style.background = isLocal ? 'rgba(16, 185, 129, 0.1)' : 'rgba(100, 116, 139, 0.1)';
        messageEl.innerHTML = `
            <span style="color: ${isLocal ? '#10b981' : '#64748b'}; font-weight: bold;">${sender}:</span>
            <span style="margin-left: 8px;">${message}</span>
        `;
    chatContainer.appendChild(messageEl);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

async function initiateGunWebRTC(peerId) {
    try {
        // If a preferred source already exists and it's not Gun, skip
        const preferred = peerPreferredSource.get(peerId);
        if (preferred && preferred !== 'Gun') {
            console.log(`[Select] Skipping Gun connect; preferred is ${preferred} for ${peerId.substring(0, 8)}`);
            return;
        }
        
        // Skip if we've already initiated with this peer via any method
        if (initiatedPeers.has(peerId)) {
            log(`Already initiated connection with ${peerId.substring(0, 6)}, skipping Gun offer`, 'info');
            return;
        }
        
        log(`Initiating Gun WebRTC with ${peerId.substring(0, 6)}...`, 'info');
        
        // Create peer connection WITHOUT shouldInitiate (to avoid Nostr/tracker offer send)
        let pc = peerConnections.get(peerId);
        if (!pc || !(pc instanceof RTCPeerConnection)) {
            pc = await createPeerConnection(peerId, false); // false = don't initiate via Nostr
        }
        
        if (!pc) {
            log(`Cannot initiate Gun WebRTC - peer connection failed`, 'warning');
            return;
        }
        
        // Skip if data channel already exists
        if (dataChannels.has(peerId)) {
            log(`Data channel already exists for ${peerId.substring(0, 6)}, skipping Gun offer`, 'info');
            return;
        }
        
        // Create data channel
        const dataChannel = pc.createDataChannel('chat');
        setupDataChannel(peerId, dataChannel, 'Gun');
        
        // Create and send offer via Gun
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        
        initiatedPeers.add(peerId); // Mark as initiated
        
        if (hybridSignaling) {
            hybridSignaling.sendGunSignal(peerId, {
                type: 'offer',
                sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp }
            });
            log(`Sent Gun offer to ${peerId.substring(0, 6)}...`, 'success');
        }
    } catch (err) {
        log(`Gun WebRTC initiation error: ${err?.message || err}`, 'error');
    }
}

async function handleGunSignal(peerId, signal) {
    try {
        const preferred = peerPreferredSource.get(peerId.trim());
        if (preferred && preferred !== 'Gun') {
            console.log(`[Gun] Ignoring signal for ${peerId.substring(0, 8)} because preferred is ${preferred}`);
            return;
        }

        if (signal.type === 'offer' && signal.sdp) {
            log(`Received Gun offer from ${peerId.substring(0, 6)}...`, 'info');
            let pc = await ensurePeerConnection(peerId);
            if (!pc) {
                pc = await resetPeerConnection(peerId);
            }
            if (!(pc instanceof RTCPeerConnection)) return;

            await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
            await flushPendingIce(peerId);
            
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            
            // Send answer via Gun
            if (hybridSignaling) {
                hybridSignaling.sendGunSignal(peerId, {
                    type: 'answer',
                    sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp }
                });
                log(`Sent Gun answer to ${peerId.substring(0, 6)}...`, 'success');
            }
        } else if (signal.type === 'answer' && signal.sdp) {
            log(`Received Gun answer from ${peerId.substring(0, 6)}...`, 'info');
            const pc = peerConnections.get(peerId);
            if (pc instanceof RTCPeerConnection) {
                await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
                await flushPendingIce(peerId);
                log(`Applied remote answer for ${peerId.substring(0, 6)}...`, 'success');
            } else {
                log(`No existing peer connection for answer from ${peerId.substring(0, 6)}...`, 'warning');
            }
        } else if (signal.type === 'ice' && signal.candidate) {
            log(`Received Gun ICE from ${peerId.substring(0, 6)}...`, 'info');
            await addIceCandidateSafely(peerId, signal.candidate);
        }
    } catch (err) {
        log(`Gun signal error: ${err?.message || err}`, 'error');
    }
}

// Removed gun initiation delay: the first successful connection wins immediately

function attachTrackerPeer(peerId, peer) {
    if (!peer) return;
    
    // First source wins: if source exists and is not Tracker, ignore
    const existingSource = peerSources.get(peerId);
    if (existingSource && existingSource !== 'Tracker') {
        console.log(`[Dedupe] Skipping Tracker attach, first source is ${existingSource} for ${peerId.substring(0, 8)}`);
        peer.destroy?.();
        return;
    }
    
    // Avoid attaching same peer multiple times (memory leak)
    if (trackerPeers.has(peerId)) {
        console.log('[Tracker] Peer already attached:', peerId.substring(0, 8));
        return;
    }

    trackerPeers.set(peerId, peer);
    log(`Attaching tracker peer: ${peerId.substring(0, 6)}...`, 'info');

    peer.on('connect', () => {
        log(`Tracker peer connected: ${peerId.substring(0, 6)}...`, 'success');
        trackerConnectedAt.set(peerId, Date.now());
        const chosen = 'Tracker';
        if (!peerSources.has(peerId)) {
            peerSources.set(peerId, chosen);
        }
        setPreferredSource(peerId, chosen);
        const preferred = peerPreferredSource.get(peerId.trim());
        if (preferred && preferred !== 'Tracker') {
            try { peer.destroy?.(); } catch {}
            trackerPeers.delete(peerId);
        }
    });

    peer.on('data', (data) => {
        try {
            const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
            displayChatMessage(text, `${peerId.substring(0, 6)}...`, false);
        } catch {
            // ignore decode errors
        }
    });

    peer.on('close', () => {
        trackerPeers.delete(peerId);
        trackerConnectedAt.delete(peerId);
        // DO NOT delete peerPreferredSource - it must remain stable for the peer's lifetime
        // This ensures "first source wins" is never violated, even if connections drop
        updatePeerList();
        log(`Tracker peer closed: ${peerId.substring(0, 6)}...`, 'warning');
    });

    peer.on('error', (err) => {
        log(`Tracker peer error: ${peerId.substring(0, 6)}... ${err?.message || err}`, 'warning');
    });
}

// Initialize
updateStatus(false);
log('UniWRTC Demo ready', 'success');
