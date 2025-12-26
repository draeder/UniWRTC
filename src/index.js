/**
 * UniWRTC Cloudflare Worker
 * WebRTC Signaling Service using Durable Objects
 * Serves both static assets and WebSocket signaling
 */

import { Room } from './room.js';

export { Room };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    console.log(`[Worker] ${request.method} ${url.pathname}${url.search}`);

    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Handle WebSocket upgrade on /ws endpoint
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') === 'websocket') {
        console.log(`[Worker] WebSocket upgrade detected for room: ${url.searchParams.get('room')}`);
        const roomId = url.searchParams.get('room') || 'default';
        const id = env.ROOMS.idFromName(roomId);
        const roomStub = env.ROOMS.get(id);
        console.log(`[Worker] Routing to Durable Object: ${roomId}`);
        return roomStub.fetch(request);
      }
      return new Response('WebSocket upgrade required', { status: 400 });
    }

    // Serve root as index.html
    if (url.pathname === '/') {
      try {
        const asset = await env.ASSETS.get('index.html');
        if (asset) {
          return new Response(asset, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
        }
      } catch (e) {
        // ASSETS binding may not exist in local dev
      }
    }

    // Serve static assets (CSS, JS, images, etc.)
    if (request.method === 'GET') {
      try {
        const pathname = url.pathname.replace(/^\//, '');
        const asset = await env.ASSETS.get(pathname);
        if (asset) {
          let contentType = 'application/octet-stream';
          if (pathname.endsWith('.html')) contentType = 'text/html; charset=utf-8';
          else if (pathname.endsWith('.js')) contentType = 'application/javascript';
          else if (pathname.endsWith('.css')) contentType = 'text/css';
          else if (pathname.endsWith('.json')) contentType = 'application/json';
          else if (pathname.endsWith('.svg')) contentType = 'image/svg+xml';
          else if (pathname.endsWith('.png')) contentType = 'image/png';
          else if (pathname.endsWith('.jpg')) contentType = 'image/jpeg';
          else if (pathname.endsWith('.ico')) contentType = 'image/x-icon';

          return new Response(asset, {
            headers: { 'Content-Type': contentType }
          });
        }
      } catch (e) {
        // ASSETS binding may not exist in local dev
      }
    }

    return new Response('Not Found', { status: 404 });
  }
};
