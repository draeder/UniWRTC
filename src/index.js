/**
 * UniWRTC Cloudflare Worker
 * WebRTC Signaling Service using Durable Objects
 * Serves static assets and HTTP polling signaling
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

    // WebSockets are intentionally disabled in this deployment.
    if (url.pathname === '/ws') {
      return new Response('WebSockets disabled; use /api (HTTP polling)', { status: 410 });
    }

    // HTTP signaling API (no WebSockets)
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const roomId = url.searchParams.get('room') || 'default';
      const id = env.ROOMS.idFromName(roomId);
      const roomStub = env.ROOMS.get(id);
      return roomStub.fetch(request);
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
