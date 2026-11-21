import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '16kb' }));

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

const ENV_PJ_SECRET = String(process.env.PROP_JOURNAL_SECRET || '').trim();
const SESSION_SECRET = String(process.env.SESSION_SECRET || '').trim() || crypto.randomBytes(32).toString('hex');
const ALLOWED_ORIGINS = String(process.env.PROP_JOURNAL_ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim().replace(/\/+$/, '').toLowerCase())
  .filter(Boolean);

let bootstrappedSecret = '';

const SESSION_TTL_SEC = 2 * 3600;
const LINK_MAX_SKEW_SEC = 120;
const CODE_STEP_MS = 30000;
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX_FAILS = 8;

const revokedJtis = new Map();
const usedCodes = new Map();
const usedSignatures = new Map();
const authFailures = new Map();

function getPjSecret() {
  return ENV_PJ_SECRET || bootstrappedSecret;
}

function cleanupMaps() {
  const nowMs = Date.now();
  for (const [k, exp] of revokedJtis.entries()) {
    if (exp <= nowMs) revokedJtis.delete(k);
  }
  for (const [k, exp] of usedCodes.entries()) {
    if (exp <= nowMs) usedCodes.delete(k);
  }
  for (const [k, exp] of usedSignatures.entries()) {
    if (exp <= nowMs) usedSignatures.delete(k);
  }
  for (const [ip, rec] of authFailures.entries()) {
    if (rec.resetAt <= nowMs) authFailures.delete(ip);
  }
}

setInterval(cleanupMaps, 30000).unref();

function safeTimingEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function safeTimingEqualBuf(bufA, bufB) {
  if (!Buffer.isBuffer(bufA) || !Buffer.isBuffer(bufB)) return false;
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function getClientIp(req) {
  return String(req.ip || req.socket?.remoteAddress || 'unknown');
}

function checkRateLimit(ip) {
  const nowMs = Date.now();
  const rec = authFailures.get(ip);
  if (!rec || rec.resetAt <= nowMs) return { allowed: true, retryAfterSec: 0 };
  if (rec.count >= RATE_LIMIT_MAX_FAILS) {
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((rec.resetAt - nowMs) / 1000)) };
  }
  return { allowed: true, retryAfterSec: 0 };
}

function recordAuthFailure(ip) {
  const nowMs = Date.now();
  const rec = authFailures.get(ip);
  if (!rec || rec.resetAt <= nowMs) {
    authFailures.set(ip, { count: 1, resetAt: nowMs + RATE_LIMIT_WINDOW_MS });
    return 1;
  }
  rec.count += 1;
  return rec.count;
}

function clearAuthFailures(ip) {
  authFailures.delete(ip);
}

function issueToken(uid, mode, stage = 'session', ttlSec = SESSION_TTL_SEC) {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ttlSec;
  const jti = crypto.randomBytes(16).toString('hex');
  const payload = { jti, stage, uid: String(uid || 'prop-journal-user').slice(0, 128), mode, iat, exp };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sigB64 = crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('base64url');
  return { token: `${payloadB64}.${sigB64}`, payload };
}

function verifyToken(token, expectedStage = 'session') {
  if (typeof token !== 'string' || !token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  if (!payloadB64 || !sigB64) return null;

  const expectedSigB64 = crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('base64url');
  if (!safeTimingEqualStr(sigB64, expectedSigB64)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.jti !== 'string' || typeof payload.exp !== 'number') return null;
  if (expectedStage && payload.stage !== expectedStage) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.exp <= nowSec) return null;
  if (revokedJtis.has(payload.jti)) return null;
  return payload;
}

function extractBearerToken(req) {
  const header = String(req.headers.authorization || '').trim();
  if (!header.toLowerCase().startsWith('bearer ')) return '';
  return header.slice(7).trim();
}

function requireAuth(req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  if (!getPjSecret()) {
    return res.status(401).json({ error: 'Erişim anahtarı henüz yapılandırılmamış.' });
  }
  const token = extractBearerToken(req);
  const session = verifyToken(token, 'session');
  if (!session) {
    return res.status(401).json({ error: 'Prop Journal oturum doğrulaması gerekli veya süresi dolmuş.' });
  }
  req.authSession = session;
  return next();
}

function truncateHmacTo6Digits(hash) {
  const offset = hash[hash.length - 1] & 0x0f;
  const bin =
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);
  return String(bin % 1000000).padStart(6, '0');
}

function computeDynamicCandidates(secret, step) {
  const out = [];
  // Primary formula: HMAC-SHA256(secret, String(step))
  const hStr = crypto.createHmac('sha256', secret).update(String(step), 'utf8').digest();
  out.push(truncateHmacTo6Digits(hStr));

  // RFC 6238 8-byte big-endian counter compatibility (SHA-256 & SHA-1)
  const buf8 = Buffer.alloc(8);
  buf8.writeBigUInt64BE(BigInt(step), 0);
  const hBin256 = crypto.createHmac('sha256', secret).update(buf8).digest();
  out.push(truncateHmacTo6Digits(hBin256));
  const hBin1 = crypto.createHmac('sha1', secret).update(buf8).digest();
  out.push(truncateHmacTo6Digits(hBin1));
  return out;
}

function verifyDynamicCode(secret, rawCode) {
  const code = String(rawCode || '').trim();
  if (!/^\d{6}$/.test(code)) {
    return { ok: false, reason: 'Doğrulama kodu 6 haneli rakam olmalıdır.' };
  }
  const currentStep = Math.floor(Date.now() / CODE_STEP_MS);
  const windows = [currentStep, currentStep - 1, currentStep + 1];
  let matchedWindow = null;

  for (const w of windows) {
    if (w < 0) continue;
    const candidates = computeDynamicCandidates(secret, w);
    for (const cand of candidates) {
      if (safeTimingEqualStr(cand, code)) {
        matchedWindow = w;
        break;
      }
    }
    if (matchedWindow !== null) break;
  }

  if (matchedWindow === null) {
    return { ok: false, reason: 'Kod geçersiz veya 30 saniyelik süresi dolmuş.' };
  }

  const replayKey = `${matchedWindow}:${code}`;
  if (usedCodes.has(replayKey)) {
    return { ok: false, reason: 'Bu 30 saniyelik kod zaten kullanıldı. Yeni kodu bekleyin.' };
  }
  usedCodes.set(replayKey, Date.now() + 120000);
  return { ok: true, uid: 'pj-code-user' };
}

function verifySignedLink(secret, rawTs, rawUid, rawSig, referrer) {
  const tsStr = String(rawTs || '').trim();
  const uid = String(rawUid || '').trim();
  const sig = String(rawSig || '').trim().toLowerCase();

  if (!/^\d{9,13}$/.test(tsStr) || !/^[a-f0-9]{64}$/.test(sig)) {
    return { ok: false, reason: 'İmzalı bağlantı parametreleri geçersiz.' };
  }
  if (uid.length > 128 || !/^[A-Za-z0-9._:@-]*$/.test(uid)) {
    return { ok: false, reason: 'Kullanıcı kimliği formatı geçersiz.' };
  }

  if (ALLOWED_ORIGINS.length > 0 && referrer) {
    try {
      const refOrigin = new URL(String(referrer)).origin.toLowerCase();
      if (!ALLOWED_ORIGINS.includes(refOrigin)) {
        return { ok: false, reason: 'Yönlendiren site kökeni izinli listede değil.' };
      }
    } catch {
      return { ok: false, reason: 'Yönlendiren adres doğrulanamadı.' };
    }
  }

  const tsNum = Number(tsStr);
  const nowSec = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(tsNum) || Math.abs(nowSec - tsNum) > LINK_MAX_SKEW_SEC) {
    return { ok: false, reason: 'İmzalı bağlantının süresi dolmuş. Prop Journal üzerinden yeni bağlantı açın.' };
  }

  const providedBuf = Buffer.from(sig, 'hex');
  const expectedPrimary = crypto.createHmac('sha256', secret).update(`${tsStr}:${uid}`, 'utf8').digest();
  let matched = safeTimingEqualBuf(providedBuf, expectedPrimary);

  if (!matched && !uid) {
    const expectedNoUid = crypto.createHmac('sha256', secret).update(tsStr, 'utf8').digest();
    matched = safeTimingEqualBuf(providedBuf, expectedNoUid);
  }

  if (!matched) {
    return { ok: false, reason: 'Bağlantı imzası doğrulanamadı.' };
  }

  if (usedSignatures.has(sig)) {
    return { ok: false, reason: 'Bu tek kullanımlık bağlantı zaten kullanılmış.' };
  }
  usedSignatures.set(sig, Date.now() + 150000);

  return { ok: true, uid: uid || 'pj-link-user' };
}

function isBlockedHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h === '0.0.0.0' || h === '::1' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  const m172 = h.match(/^172\.(\d+)\./);
  if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return true;
  if (/^(fc|fd|fe80):/i.test(h)) return true;
  return false;
}

app.get('/api/auth/status', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const token = extractBearerToken(req);
  const session = getPjSecret() ? verifyToken(token, 'session') : null;
  return res.json({
    configured: Boolean(getPjSecret()),
    source: ENV_PJ_SECRET ? 'env' : (bootstrappedSecret ? 'memory' : 'none'),
    authenticated: Boolean(session),
    uid: session?.uid || null,
    mode: session?.mode || null,
    expiresAt: session ? session.exp * 1000 : null,
    stepSeconds: Math.round(CODE_STEP_MS / 1000),
    serverNow: Date.now()
  });
});

app.post('/api/auth/bootstrap', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const ip = getClientIp(req);
  const rl = checkRateLimit(ip);
  if (!rl.allowed) {
    return res.status(429).json({ error: `Çok fazla deneme. ${rl.retryAfterSec} saniye sonra tekrar deneyin.` });
  }
  if (getPjSecret()) {
    return res.status(409).json({ error: 'Ortak gizli anahtar zaten tanımlı.' });
  }
  const secret = String(req.body?.secret || '').trim();
  if (secret.length < 12 || secret.length > 256) {
    recordAuthFailure(ip);
    return res.status(400).json({ error: 'Gizli anahtar en az 12, en fazla 256 karakter olmalıdır.' });
  }
  bootstrappedSecret = secret;
  clearAuthFailures(ip);
  return res.json({ ok: true, configured: true, source: 'memory' });
});

app.post('/api/auth/verify', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const ip = getClientIp(req);
  const rl = checkRateLimit(ip);
  if (!rl.allowed) {
    return res.status(429).json({ error: `Çok fazla başarısız deneme. ${rl.retryAfterSec} saniye bekleyin.` });
  }

  const secret = getPjSecret();
  if (!secret) {
    return res.status(503).json({ error: 'Sunucuda PROP_JOURNAL_SECRET henüz tanımlanmamış.' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};

  // Adım 1: İmzalı Prop Journal bağlantısı doğrulaması (tek başına tam oturum açmaz)
  if (body.sig !== undefined && body.ts !== undefined) {
    const linkRes = verifySignedLink(secret, body.ts, body.uid, body.sig, body.referrer);
    if (!linkRes.ok) {
      const fails = recordAuthFailure(ip);
      return res.status(401).json({
        error: linkRes.reason,
        remainingAttempts: Math.max(0, RATE_LIMIT_MAX_FAILS - fails)
      });
    }
    clearAuthFailures(ip);
    const { token: linkProof, payload } = issueToken(linkRes.uid, 'signed-link', 'step1', 300);
    return res.json({
      ok: true,
      step: 'link_verified',
      linkProof,
      uid: payload.uid,
      linkExpiresAt: payload.exp * 1000
    });
  }

  // Adım 2: İmzalı link onayı (linkProof) + 30 saniyelik 6 haneli kod zorunlu
  if (body.code !== undefined) {
    const step1 = verifyToken(String(body.linkProof || ''), 'step1');
    if (!step1) {
      const fails = recordAuthFailure(ip);
      return res.status(401).json({
        error: 'Önce Prop Journal üzerinden "Veri Merkezini Aç" bağlantısı ile gelmelisiniz.',
        remainingAttempts: Math.max(0, RATE_LIMIT_MAX_FAILS - fails)
      });
    }
    const codeRes = verifyDynamicCode(secret, body.code);
    if (!codeRes.ok) {
      const fails = recordAuthFailure(ip);
      return res.status(401).json({
        error: codeRes.reason,
        remainingAttempts: Math.max(0, RATE_LIMIT_MAX_FAILS - fails)
      });
    }
    revokedJtis.set(step1.jti, step1.exp * 1000);
    clearAuthFailures(ip);
    const { token, payload } = issueToken(step1.uid, 'link+code', 'session', SESSION_TTL_SEC);
    return res.json({
      ok: true,
      step: 'verified',
      token,
      uid: payload.uid,
      mode: payload.mode,
      expiresAt: payload.exp * 1000
    });
  }

  recordAuthFailure(ip);
  return res.status(400).json({ error: 'Doğrulama için önce Prop Journal imzalı bağlantısı, ardından 6 haneli kod gereklidir.' });
});

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const token = extractBearerToken(req);
  const session = verifyToken(token, 'session');
  if (session) {
    revokedJtis.set(session.jti, session.exp * 1000);
  }
  return res.json({ ok: true });
});

app.post('/api/auth/authorize-action', requireAuth, (req, res) => {
  return res.json({
    ok: true,
    uid: req.authSession.uid,
    mode: req.authSession.mode,
    expiresAt: req.authSession.exp * 1000
  });
});

app.get('/api/proxy', requireAuth, async (req, res) => {
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

