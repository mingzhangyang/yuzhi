import { handleIcsRequest } from '../shared/icsProxy';

interface Env {
  ASSETS: Fetcher;
}

// Cloudflare Worker（带静态资源）：/api/ics 由这里处理，其余交给 dist/ 里的静态文件
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/ics') {
      if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET' } });
      return handleIcsRequest(request.url);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
