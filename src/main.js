import './style.css';
import UniWRTCClient from '../client-browser.js';

// Make UniWRTCClient available globally for backwards compatibility
window.UniWRTCClient = UniWRTCClient;

let client = null;
const peerConnections = new Map();
const dataChannels = new Map();

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
                    <label style="display: block; margin-bottom: 5px; color: #64748b; font-size: 13px;">Server URL</label>
                    <input type="text" id="serverUrl" data-testid="serverUrl" placeholder="https://signal.peer.ooo or http://localhost:8080" value="https://signal.peer.ooo">
                </div>
                <div>
                    <label style="display: block; margin-bottom: 5px; color: #64748b; font-size: 13px;">Room / Session ID</label>
                    <input type="text" id="roomId" data-testid="roomId" placeholder="my-room">
                </div>
            </div>
            <div style="display: flex; gap: 10px; align-items: center;">
                <button onclick="window.connect()" class="btn-primary" id="connectBtn" data-testid="connectBtn">Connect</button>
                <button onclick="window.disconnect()" class="btn-danger" id="disconnectBtn" data-testid="disconnectBtn" disabled>Disconnect</button>
                <span id="statusBadge" data-testid="statusBadge" class="status-badge status-disconnected">Disconnected</span>
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

function log(message, type = 'info') {
    const logContainer = document.getElementById('logContainer');
    const entry = document.createElement('div');
        entry.className = `log-entry ${type}`;
    const timestamp = new Date().toLocaleTimeString();
        entry.textContent = `[${timestamp}] ${message}`;
    
    // Add testid for specific log messages
    if (message.includes('Connected with client ID')) {
        entry.setAttribute('data-testid', 'log-connected');
    } else if (message.includes('Joined session')) {
        entry.setAttribute('data-testid', 'log-joined');
    } else if (message.includes('Peer joined')) {
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
        document.getElementById('clientId').textContent = 'Not connected';
        document.getElementById('sessionId').textContent = 'Not joined';
    }
}

function updatePeerList() {
    const peerList = document.getElementById('peerList');
    if (peerConnections.size === 0) {
        peerList.innerHTML = '<p style="color: #94a3b8;">No peers connected</p>';
    } else {
        peerList.innerHTML = '';
        peerConnections.forEach((pc, peerId) => {
            const peerItem = document.createElement('div');
            peerItem.className = 'peer-item';
            peerItem.textContent = peerId.substring(0, 8) + '...';
            peerList.appendChild(peerItem);
        });
    }
}

function normalizeSessionDescription(descOrSdp, fallbackType) {
    if (!descOrSdp) {
        throw new Error(`Missing ${fallbackType} SDP`);
    }

    if (typeof descOrSdp === 'string') {
        return { type: fallbackType, sdp: descOrSdp };
    }

    if (typeof descOrSdp === 'object') {
        if (typeof descOrSdp.sdp === 'string') {
            return {
                type: descOrSdp.type || fallbackType,
                sdp: descOrSdp.sdp
            };
        }
    }

    return descOrSdp;
}

function normalizeIceCandidate(candidateOrText) {
    if (!candidateOrText) return null;
    if (typeof candidateOrText === 'string') {
        const [candidate, sdpMidRaw, sdpMLineIndexRaw] = candidateOrText.split('|');
        if (!candidate) return null;
        const ice = { candidate };
        if (sdpMidRaw) ice.sdpMid = sdpMidRaw;
        if (sdpMLineIndexRaw !== undefined && sdpMLineIndexRaw !== '') {
            const idx = Number(sdpMLineIndexRaw);
            if (!Number.isNaN(idx)) ice.sdpMLineIndex = idx;
        }
        return ice;
    }
    return candidateOrText;
}

window.connect = async function() {
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

        const isHttpUrl = /^https?:\/\//i.test(serverUrl);
        if (!isHttpUrl) {
            throw new Error('Server URL must start with http(s):// (WebSockets are disabled)');
        }

        // HTTP polling signaling (no WebSockets)
        client = new UniWRTCClient(serverUrl, { autoReconnect: false, roomId });
        log(`Using HTTP polling (no WebSockets) for room: ${roomId}`, 'info');
        
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
            await pc.setRemoteDescription(normalizeSessionDescription(data.offer, 'offer'));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            client.sendAnswer(answer, data.peerId);
                log(`Sent answer to ${data.peerId.substring(0, 6)}...`, 'success');
        });

        client.on('answer', async (data) => {
                log(`Received answer from ${data.peerId.substring(0, 6)}...`, 'info');
            const pc = peerConnections.get(data.peerId);
            if (pc) {
                await pc.setRemoteDescription(normalizeSessionDescription(data.answer, 'answer'));
            }
        });

        client.on('ice-candidate', async (data) => {
                log(`Received ICE candidate from ${data.peerId.substring(0, 6)}...`, 'info');
            const pc = peerConnections.get(data.peerId);
            if (pc && data.candidate) {
                const iceInit = normalizeIceCandidate(data.candidate);
                if (iceInit) {
                    await pc.addIceCandidate(new RTCIceCandidate(iceInit));
                }
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
};

window.disconnect = function() {
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

async function createPeerConnection(peerId, shouldInitiate) {
    if (peerConnections.has(peerId)) {
            log(`Peer connection already exists for ${peerId.substring(0, 6)}...`, 'warning');
        return peerConnections.get(peerId);
    }

        log(`Creating peer connection with ${peerId.substring(0, 6)}... (shouldInitiate: ${shouldInitiate})`, 'info');

    const pc = new RTCPeerConnection({
        // Avoid external STUN for reliability in restricted environments.
        // Host candidates are sufficient for same-device/browser-tab testing.
        iceServers: []
    });

    pc.onicecandidate = (event) => {
        if (event.candidate) {
                log(`Sending ICE candidate to ${peerId.substring(0, 6)}...`, 'info');
            client.sendIceCandidate(event.candidate, peerId);
        }
    };

    pc.ondatachannel = (event) => {
            log(`Received data channel from ${peerId.substring(0, 6)}`, 'info');
        setupDataChannel(peerId, event.channel);
    };

    if (shouldInitiate) {
        const dc = pc.createDataChannel('chat');
        setupDataChannel(peerId, dc);
        
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        client.sendOffer(offer, peerId);
            log(`Sent offer to ${peerId.substring(0, 6)}...`, 'success');
    } else {
            log(`Waiting for offer from ${peerId.substring(0, 6)}...`, 'info');
    }

    peerConnections.set(peerId, pc);
    updatePeerList();
    return pc;
}

function setupDataChannel(peerId, dataChannel) {
    dataChannel.onopen = () => {
            log(`Data channel open with ${peerId.substring(0, 6)}...`, 'success');
    };

    dataChannel.onmessage = (event) => {
        displayChatMessage(event.data, `${peerId.substring(0, 6)}...`, false);
    };

    dataChannel.onclose = () => {
            log(`Data channel closed with ${peerId.substring(0, 6)}...`, 'warning');
        dataChannels.delete(peerId);
    };

    dataChannels.set(peerId, dataChannel);
}

window.sendChatMessage = function() {
    const message = document.getElementById('chatMessage').value.trim();
    
    if (!message) {
        return;
    }

    if (dataChannels.size === 0) {
        log('No peer connections available. Wait for data channels to open.', 'error');
        return;
    }

    // Send to all connected peers
    let sent = 0;
    dataChannels.forEach((dc, peerId) => {
        if (dc.readyState === 'open') {
            dc.send(message);
            sent++;
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

// Initialize
updateStatus(false);
log('UniWRTC Demo ready', 'success');
