import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { handleIcsRequest } from './shared/icsProxy.ts';

/** 开发时在本地提供 /api/ics，行为与 Cloudflare Pages Function 一致 */
function icsProxyDev(): Plugin {
  return {
    name: 'yuzhi-ics-proxy-dev',
    configureServer(server) {
      server.middlewares.use('/api/ics', async (req, res) => {
        const path = (req as { originalUrl?: string }).originalUrl ?? '';
        const r = await handleIcsRequest(`http://localhost${path}`);
        res.statusCode = r.status;
        r.headers.forEach((v, k) => res.setHeader(k, v));
        res.end(await r.text());
      });
    },
  };
}

export default defineConfig({
  plugins: [icsProxyDev()],
  test: { environment: 'node' },
});
