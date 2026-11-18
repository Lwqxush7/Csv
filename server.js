import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

function isBlockedHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h === '0.0.0.0' || h === '::1' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  const m172 = h.match(/^172\.(\d+)\./);
  if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return true;
  if (/^(fc|fd|fe80):/i.test(h)) return true;
  return false;
}

app.get('/api/proxy', async (req, res) => {
  const target = String(req.query.url || '').trim();
  if (!target) {
    return res.status(400).json({ error: 'Missing ?url= query parameter' });
  }
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return res.status(400).json({ error: 'Invalid target URL' });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return res.status(400).json({ error: 'Unsupported protocol' });
  }
  if (isBlockedHost(parsed.hostname)) {
    return res.status(403).json({ error: 'Target host is not allowed' });
  }
  try {
    const upstream = await fetch(parsed.toString(), {
      signal: AbortSignal.timeout(10000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*'
      }
    });
    const body = await upstream.text();
    const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
    res.status(upstream.status);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(body);
  } catch (err) {
    return res.status(502).json({ error: err?.message || 'Upstream proxy error' });
  }
});

app.use(express.static(__dirname));

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
});
