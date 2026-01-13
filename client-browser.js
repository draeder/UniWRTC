/**
 * UniWRTC Client - WebRTC Signaling Client Library
 * Browser version (HTTP polling; no WebSockets)
 */

import UniWRTCClient from './src/client-cloudflare.js';

// Attach to window for non-module script usage
if (typeof window !== 'undefined') {
  window.UniWRTCClient = UniWRTCClient;
}

export default UniWRTCClient;
