import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { handleIcsRequest } from './shared/icsProxy.ts';

/** 开发时在本地提供 /api/ics，复用与生产 Worker 相同的代理逻辑 */
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
  build: {
    // 字体分片一律作为独立文件：内联进 CSS 会让每个页面都背上用不到的字形。
    assetsInlineLimit: (file) => (file.endsWith('.woff2') ? false : undefined),
  },
  test: { environment: 'node' },
});
