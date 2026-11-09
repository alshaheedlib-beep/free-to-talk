import crypto from 'node:crypto';

export const now = () => Date.now();
export const int = (v, d = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
export const num = (v, d = NaN) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

export const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

/* ---------- geo ---------- */
// ~111 m north–south, ~95 m east–west in Palestine. Posts are stored on this grid only.
export const roundCoord = (v) => Math.round(v * 1000) / 1000;
export function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
export function boundingBox(lat, lng, km) {
  const dLat = km / 111.32;
  const dLng = km / (111.32 * Math.cos(lat * Math.PI / 180));
  return { minLat: lat - dLat, maxLat: lat + dLat, minLng: lng - dLng, maxLng: lng + dLng };
}
export const validCoords = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
// Shown to people instead of the real distance (posts sit on a ~100 m grid anyway).
export function approxDistance(m) {
  if (m < 150) return 'قريب جداً منك';
  if (m < 1000) return `على بُعد ${(Math.round(m / 50) * 50).toLocaleString('ar-EG')} م تقريباً`;
  return `على بُعد ${Number((m / 1000).toFixed(1)).toLocaleString('ar-EG')} كم تقريباً`;
}

/* ---------- text moderation ---------- */
export function normalizeArabic(s) {
  return String(s)
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')   // harakat + tatweel
    .replace(/[إأآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/(.)\1{2,}/gu, '$1$1')                 // "هههههه" → "هه"
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}
export function findBannedWord(text, list) {
  const words = String(list || '').split(/\r?\n/).map((w) => normalizeArabic(w)).filter(Boolean);
  if (!words.length) return null;
  const t = ` ${normalizeArabic(text)} `;
  return words.find((w) => t.includes(` ${w} `) || (w.length >= 5 && t.includes(w))) || null;
}
export const cleanText = (v, max) =>
  String(v ?? '').replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);

/* ---------- simple in-memory rate limiter ---------- */
const buckets = new Map();
export function rateLimit(key, limit, windowMs) {
  const t = now();
  const arr = (buckets.get(key) || []).filter((x) => t - x < windowMs);
  if (arr.length >= limit) { buckets.set(key, arr); return false; }
  arr.push(t); buckets.set(key, arr); return true;
}
setInterval(() => { const t = now(); for (const [k, a] of buckets) if (!a.some((x) => t - x < 3600_000)) buckets.delete(k); }, 600_000).unref();

/* ---------- http helpers ---------- */
export function sendJson(res, status, data, extra = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC_HEADERS, ...extra });
  res.end(body);
}
export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
export function cookie(name, value, { maxAge, secure } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
  if (maxAge != null) c += `; Max-Age=${maxAge}`;
  if (secure) c += '; Secure';
  return c;
}
export function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('bad json'), { status: 400 })); } });
    req.on('error', reject);
  });
}
export const clientIp = (req) =>
  (process.env.TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress || '';
