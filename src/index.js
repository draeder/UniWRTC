/**
 * UniWRTC Cloudflare Worker
 * WebRTC Signaling Service using Durable Objects
 */

import { Room } from './room.js';

export { Room };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // WebSocket signaling
    if (url.pathname === '/signaling' || url.pathname === '/') {
      const roomId = url.searchParams.get('room') || 'default';

      // Get Durable Object stub for this room
      const id = env.ROOMS.idFromName(roomId);
      const roomStub = env.ROOMS.get(id);

      // Forward request to Durable Object
      return roomStub.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  }
};
