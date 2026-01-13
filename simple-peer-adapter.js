/**
 * simple-peer ↔ UniWRTC signaling adapter (SDP text only)
 *
 * UniWRTC wire format after this repo's change:
 * - offer: { type: 'offer', offer: '<sdp string>', targetId, sessionId? }
 * - answer:{ type: 'answer', answer:'<sdp string>', targetId, sessionId? }
 * - ice:   { type: 'ice-candidate', candidate: RTCIceCandidateInit, targetId, sessionId? }
 *
 * This adapter maps simple-peer "signal" objects to/from that wire format.
 */

function normalizeSdp(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value.sdp === 'string') return value.sdp;
  return null;
}

function isIceCandidateSignal(signal) {
  return !!signal && typeof signal === 'object' && typeof signal.candidate === 'string';
}

function parseIceCandidateText(candidateText) {
  if (!candidateText || typeof candidateText !== 'string') return null;
  const [candidate, sdpMidRaw, sdpMLineIndexRaw] = candidateText.split('|');
  if (!candidate) return null;
  const ice = { candidate };
  if (sdpMidRaw) ice.sdpMid = sdpMidRaw;
  if (sdpMLineIndexRaw !== undefined && sdpMLineIndexRaw !== '') {
    const idx = Number(sdpMLineIndexRaw);
    if (!Number.isNaN(idx)) ice.sdpMLineIndex = idx;
  }
  return ice;
}

/**
 * Deterministically chooses a single initiator for a given peer pair.
 * Returns true for exactly one side when both sides use the same two IDs.
 */
export function chooseDeterministicInitiator(localPeerId, remotePeerId) {
  if (!localPeerId || !remotePeerId) {
    throw new Error('localPeerId and remotePeerId are required');
  }
  return String(localPeerId) < String(remotePeerId);
}

/**
 * Sends a simple-peer signal via UniWRTCClient.
 *
 * @param {object} client UniWRTCClient instance
 * @param {object} signal simple-peer signal object
 * @param {string} targetId peer id to target
 */
export function sendSimplePeerSignal(client, signal, targetId) {
  if (!client) throw new Error('client is required');
  if (!signal) throw new Error('signal is required');
  if (!targetId) throw new Error('targetId is required');

  if (signal.type === 'offer') {
    const sdp = normalizeSdp(signal.sdp ?? signal);
    if (!sdp) throw new Error('offer SDP missing');
    client.sendOffer(sdp, targetId);
    return;
  }

  if (signal.type === 'answer') {
    const sdp = normalizeSdp(signal.sdp ?? signal);
    if (!sdp) throw new Error('answer SDP missing');
    client.sendAnswer(sdp, targetId);
    return;
  }

  // simple-peer ICE candidate signal has shape: { candidate, sdpMid, sdpMLineIndex }
  if (isIceCandidateSignal(signal) || signal.type === 'ice-candidate' || signal.type === 'candidate') {
    client.sendIceCandidate(signal, targetId);
    return;
  }

  // simple-peer can emit renegotiation / transceiver requests.
  // UniWRTC server in this repo doesn't route arbitrary signal types.
  throw new Error(`Unsupported simple-peer signal type for UniWRTC transport: ${signal.type || '(unknown)'}`);
}

/**
 * Attaches UniWRTCClient events to a simple-peer instance.
 *
 * @param {object} client UniWRTCClient instance
 * @param {object} peer simple-peer instance (must have peer.signal())
 * @returns {() => void} cleanup function
 */
export function attachUniWRTCToSimplePeer(client, peer) {
  if (!client) throw new Error('client is required');
  if (!peer || typeof peer.signal !== 'function') throw new Error('peer.signal(...) is required');

  const onOffer = (data) => {
    const sdp = normalizeSdp(data.offer);
    if (sdp) peer.signal({ type: 'offer', sdp });
  };

  const onAnswer = (data) => {
    const sdp = normalizeSdp(data.answer);
    if (sdp) peer.signal({ type: 'answer', sdp });
  };

  const onIce = (data) => {
    if (!data?.candidate) return;
    if (typeof data.candidate === 'string') {
      const ice = parseIceCandidateText(data.candidate);
      if (ice) peer.signal(ice);
      return;
    }
    peer.signal(data.candidate);
  };

  client.on('offer', onOffer);
  client.on('answer', onAnswer);
  client.on('ice-candidate', onIce);

  return () => {
    client.off('offer', onOffer);
    client.off('answer', onAnswer);
    client.off('ice-candidate', onIce);
  };
}
