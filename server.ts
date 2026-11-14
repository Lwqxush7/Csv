import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const isProd = process.env.NODE_ENV === 'production';

const ALLOWED_PROXY_HOSTS = new Set([
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  'data-api.binance.vision',
  'api.binance.com',
  'www.okx.com',
  'api.bybit.com',
  'api.exchange.coinbase.com',
  'api.kraken.com',
  'www.bitstamp.net',
  'api.gateio.ws',
  'api.kucoin.com',
  'biquote.io',
  'api.frankfurter.dev',
  'api.tiingo.com',
  'api.twelvedata.com',
  'financialmodelingprep.com',
]);

async function startServer() {
  const app = express();

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/proxy', async (req, res) => {
    const rawUrl = typeof req.query.url === 'string' ? req.query.url : '';
    if (!rawUrl) {
      res.status(400).json({ error: 'Missing url parameter' });
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      res.status(400).json({ error: 'Invalid url parameter' });
      return;
    }

    if (parsed.protocol !== 'https:' || !ALLOWED_PROXY_HOSTS.has(parsed.hostname)) {
      res.status(403).json({ error: `Host not allowed: ${parsed.hostname}` });
      return;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);

    try {
      const upstream = await fetch(parsed.toString(), {
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Accept: 'application/json, text/plain, */*',
        },
      });

      const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
      const bodyText = await upstream.text();
      res.status(upstream.status);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'no-store');
      res.send(bodyText);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upstream fetch failed';
      res.status(502).json({ error: message });
    } finally {
      clearTimeout(timer);
    }
  });

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
