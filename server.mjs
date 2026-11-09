import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, UPLOAD_DIR, db, get, all, run, tx, getSettings, setSetting } from './lib/db.mjs';
import {
  now, int, num, sha256, randomToken, MIME, SEC_HEADERS, roundCoord, distanceM, boundingBox, validCoords, approxDistance,
  findBannedWord, cleanText, rateLimit, sendJson, parseCookies, cookie, readJson, clientIp,
} from './lib/util.mjs';

const PORT = int(process.env.PORT, 3000);
const PUBLIC_DIR = path.join(ROOT, 'public');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const HOUR = 3600_000, DAY = 24 * HOUR;
const KEEP_EXPIRED_DAYS = 30;          // hidden copy kept for serious reports, then purged
const MAX_POST = 280, MAX_REPLY = 200;

export const CATEGORIES = {
  ask: 'سؤال', alert: 'تنبيه', lost: 'مفقودات', offer: 'عرض', chat: 'دردشة',
};
export const TEST_SPOTS = [
  { id: 'ppu', name: 'جامعة البوليتكنك', lat: 31.5336, lng: 35.0972 },
  { id: 'center', name: 'وسط الخليل', lat: 31.5297, lng: 35.0998 },
  { id: 'old', name: 'البلدة القديمة', lat: 31.5247, lng: 35.1107 },
];

/* ---------- identity: an anonymous device cookie, no name, no phone ---------- */
const COOKIE = 'ftt';
function currentUser(req, res) {
  const token = parseCookies(req)[COOKIE];
  const t = now();
  if (token && token.length >= 30) {
    const u = get('SELECT * FROM users WHERE token_hash = ?', sha256(token));
    if (u) {
      if (t - u.last_seen > HOUR) run('UPDATE users SET last_seen = ? WHERE id = ?', t, u.id);
      return u;
    }
  }
  const fresh = randomToken();
  const r = run('INSERT INTO users(token_hash, created_at, last_seen) VALUES (?, ?, ?)', sha256(fresh), t, t);
  res.setHeader('Set-Cookie', cookie(COOKIE, fresh, { maxAge: 400 * 86400, secure: isHttps(req) }));
  return get('SELECT * FROM users WHERE id = ?', Number(r.lastInsertRowid));
}
const isHttps = (req) => String(req.headers['x-forwarded-proto'] || '').startsWith('https');

/* ---------- admin session ---------- */
const adminSessions = new Map();   // token → expiry
function isAdmin(req) {
  const tok = parseCookies(req).ftt_admin;
  const exp = tok && adminSessions.get(tok);
  return !!exp && exp > now();
}

/* ---------- helpers ---------- */
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === (req.headers['x-forwarded-host'] || req.headers.host); } catch { return false; }
}
const fail = (res, status, error) => sendJson(res, status, { error });
const minutesAgo = (ts) => Math.max(0, Math.round((now() - ts) / 60000));

function saveImage(dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return { error: 'صيغة الصورة غير مدعومة' };
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 1_600_000) return { error: 'الصورة كبيرة، جرّب صورة أصغر' };
  const sig = buf.subarray(0, 12).toString('hex');
  const ok = (m[1] === 'jpeg' && sig.startsWith('ffd8ff')) || (m[1] === 'png' && sig.startsWith('89504e47'))
    || (m[1] === 'webp' && buf.subarray(8, 12).toString() === 'WEBP');
  if (!ok) return { error: 'الملف ليس صورة' };
  const name = `${crypto.randomBytes(12).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return { name };
}
function deleteImage(name) {
  if (name && /^[a-f0-9]{24}\.(jpg|png|webp)$/.test(name)) fs.rm(path.join(UPLOAD_DIR, name), { force: true }, () => {});
}

function recomputeKarma(userId) {
  const r = get(`SELECT COALESCE(SUM(up - down), 0) AS k FROM posts WHERE user_id = ? AND status != 'removed'`, userId);
  run('UPDATE users SET karma = ? WHERE id = ?', r.k, userId);
}

function postView(p, me, lat, lng) {
  const dist = validCoords(lat, lng) ? distanceM(lat, lng, p.lat, p.lng) : null;
  return {
    id: p.id, cat: p.cat, text: p.text,
    image: p.image ? `/u/${p.image}` : null,
    score: p.up - p.down,
    myVote: p.my_vote || 0,
    replies: p.reply_count || 0,
    mine: p.user_id === me.id,
    ago: minutesAgo(p.created_at),
    left: Math.max(0, Math.round((p.expires_at - now()) / 60000)),
    dist: dist == null ? null : Math.round(dist),
    distText: dist == null ? '' : approxDistance(dist),
  };
}

/* ---------- API ---------- */
async function api(req, res, url, me) {
  const p = url.pathname;
  const S = getSettings();
  const method = req.method;

  if (method === 'GET' && p === '/api/me') {
    const posts = get(`SELECT COUNT(*) AS n FROM posts WHERE user_id = ? AND expires_at > ? AND status = 'live'`, me.id, now()).n;
    return sendJson(res, 200, {
      karma: me.karma, livePosts: posts, banned: !!me.banned,
      categories: CATEGORIES, testMode: S.testMode === '1', testSpots: S.testMode === '1' ? TEST_SPOTS : [],
      ttlHours: int(S.postTtlHours, 24), maxPost: MAX_POST, maxReply: MAX_REPLY,
    });
  }

  if (method === 'GET' && p === '/api/feed') {
    const lat = num(url.searchParams.get('lat')), lng = num(url.searchParams.get('lng'));
    if (!validCoords(lat, lng)) return fail(res, 400, 'الموقع غير معروف');
    const km = Math.min(10, Math.max(0.5, num(url.searchParams.get('r'), 2)));
    const cat = url.searchParams.get('cat');
    const sort = url.searchParams.get('sort');
    const b = boundingBox(lat, lng, km);
    const rows = all(`
      SELECT p.*, v.v AS my_vote,
        (SELECT COUNT(*) FROM replies r WHERE r.post_id = p.id AND r.status = 'live'
           AND r.user_id NOT IN (SELECT blocked FROM blocks WHERE blocker = ?)) AS reply_count
      FROM posts p
      LEFT JOIN votes v ON v.post_id = p.id AND v.user_id = ?
      WHERE p.status = 'live' AND p.expires_at > ?
        AND p.lat BETWEEN ? AND ? AND p.lng BETWEEN ? AND ?
        AND p.user_id NOT IN (SELECT blocked FROM blocks WHERE blocker = ?)
        ${cat && CATEGORIES[cat] ? 'AND p.cat = ?' : ''}
      ORDER BY p.created_at DESC LIMIT 300`,
      me.id, me.id, now(), b.minLat, b.maxLat, b.minLng, b.maxLng, me.id, ...(cat && CATEGORIES[cat] ? [cat] : []));
    let posts = rows.map((r) => postView(r, me, lat, lng)).filter((x) => x.dist <= km * 1000 + 100);
    if (sort === 'near') posts.sort((a, b2) => a.dist - b2.dist);
    else if (sort === 'top') posts.sort((a, b2) => (b2.score + b2.replies) - (a.score + a.replies));
    posts = posts.slice(0, 150);
    // a gentle "is anyone around?" hint without revealing anyone's position
    const wider = posts.length ? 0 : (() => {
      const w = boundingBox(lat, lng, 10);
      return get(`SELECT COUNT(*) AS n FROM posts WHERE status='live' AND expires_at > ? AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`,
        now(), w.minLat, w.maxLat, w.minLng, w.maxLng).n;
    })();
    return sendJson(res, 200, { posts, radiusKm: km, widerCount: wider });
  }

  if (method === 'POST' && p === '/api/posts') {
    if (me.banned) return fail(res, 403, 'حسابك موقوف من النشر');
    const body = await readJson(req, 2_500_000);
    const text = cleanText(body.text, MAX_POST);
    const cat = CATEGORIES[body.cat] ? body.cat : 'chat';
    const lat = num(body.lat), lng = num(body.lng);
    if (text.length < 2) return fail(res, 400, 'اكتب شي قبل ما تبث');
    if (!validCoords(lat, lng)) return fail(res, 400, 'ما قدرنا نعرف موقعك');
    const bad = findBannedWord(text, S.bannedWords);
    if (bad) return fail(res, 422, 'الرسالة فيها كلام ممنوع. عدّلها وجرّب مرة ثانية');
    const perHour = me.karma <= -10 ? 1 : int(S.postsPerHour, 5);
    const window = me.karma <= -10 ? DAY : HOUR;
    if (!rateLimit(`post:${me.id}`, perHour, window) || !rateLimit(`postip:${clientIp(req)}`, perHour * 4, window))
      return fail(res, 429, me.karma <= -10 ? 'بسبب التقييمات السلبية، مسموح رسالة وحدة باليوم' : 'وصلت الحد المسموح، استنّى شوي وجرّب');
    let image = null;
    if (body.image) {
      const r = saveImage(body.image);
      if (r.error) return fail(res, 400, r.error);
      image = r.name;
    }
    const t = now();
    const ttl = Math.min(72, Math.max(1, int(S.postTtlHours, 24))) * HOUR;
    const r = run(`INSERT INTO posts(user_id, cat, text, image, lat, lng, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      me.id, cat, text, image, roundCoord(lat), roundCoord(lng), t, t + ttl);
    const row = get('SELECT * FROM posts WHERE id = ?', Number(r.lastInsertRowid));
    return sendJson(res, 201, { post: postView(row, me, lat, lng) });
  }

  let m;
  if ((m = /^\/api\/posts\/(\d+)(\/[a-z]+)?$/.exec(p))) {
    const id = int(m[1]); const action = m[2] || '';
    const post = get('SELECT * FROM posts WHERE id = ?', id);
    const visible = post && post.status === 'live' && post.expires_at > now();
    if (!visible) return fail(res, 404, 'الرسالة اختفت');

    if (method === 'DELETE' && !action) {
      if (post.user_id !== me.id) return fail(res, 403, 'مش رسالتك');
      run(`UPDATE posts SET status = 'removed' WHERE id = ?`, id);
      deleteImage(post.image); run('UPDATE posts SET image = NULL WHERE id = ?', id);
      recomputeKarma(me.id);
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'GET' && action === '/replies') {
      const rows = all(`SELECT * FROM replies WHERE post_id = ? AND status = 'live'
          AND user_id NOT IN (SELECT blocked FROM blocks WHERE blocker = ?) ORDER BY created_at ASC LIMIT 200`, id, me.id);
      // Inside a thread people get a stable nickname (صاحب الرسالة / مجهول ١ / مجهول ٢ …) — never across threads.
      const order = new Map(); let n = 0;
      const nick = (uid) => {
        if (uid === post.user_id) return 'صاحب الرسالة';
        if (!order.has(uid)) order.set(uid, ++n);
        return `مجهول ${order.get(uid).toLocaleString('ar-EG')}`;
      };
      return sendJson(res, 200, {
        replies: rows.map((r) => ({ id: r.id, text: r.text, ago: minutesAgo(r.created_at), mine: r.user_id === me.id, who: nick(r.user_id), op: r.user_id === post.user_id })),
      });
    }

    if (method === 'POST' && action === '/replies') {
      if (me.banned) return fail(res, 403, 'حسابك موقوف من النشر');
      const body = await readJson(req, 10_000);
      const text = cleanText(body.text, MAX_REPLY);
      if (text.length < 1) return fail(res, 400, 'اكتب ردّك');
      if (findBannedWord(text, S.bannedWords)) return fail(res, 422, 'الرد فيه كلام ممنوع');
      if (!rateLimit(`reply:${me.id}`, int(S.repliesPerHour, 30), HOUR)) return fail(res, 429, 'ردود كثيرة، استنّى شوي');
      run('INSERT INTO replies(post_id, user_id, text, created_at) VALUES (?, ?, ?, ?)', id, me.id, text, now());
      return sendJson(res, 201, { ok: true });
    }

    if (method === 'POST' && action === '/vote') {
      const body = await readJson(req, 1000);
      const v = [1, -1, 0].includes(body.v) ? body.v : 0;
      if (post.user_id === me.id) return fail(res, 400, 'ما بتقدر تقيّم رسالتك');
      tx(() => {
        if (v === 0) run('DELETE FROM votes WHERE post_id = ? AND user_id = ?', id, me.id);
        else run('INSERT INTO votes(post_id, user_id, v) VALUES (?, ?, ?) ON CONFLICT(post_id, user_id) DO UPDATE SET v = excluded.v', id, me.id, v);
        const c = get('SELECT COALESCE(SUM(v = 1), 0) AS up, COALESCE(SUM(v = -1), 0) AS down FROM votes WHERE post_id = ?', id);
        run('UPDATE posts SET up = ?, down = ? WHERE id = ?', c.up, c.down, id);
        if (c.down - c.up >= int(S.downvotesToHide, 5)) run(`UPDATE posts SET status = 'hidden' WHERE id = ?`, id);
      });
      recomputeKarma(post.user_id);
      const fresh = get('SELECT up, down, status FROM posts WHERE id = ?', id);
      return sendJson(res, 200, { score: fresh.up - fresh.down, myVote: v, hidden: fresh.status !== 'live' });
    }

    if (method === 'POST' && action === '/report') {
      const body = await readJson(req, 2000);
      return report(res, 'post', id, me, body.reason, S);
    }

    if (method === 'POST' && action === '/block') {
      if (post.user_id === me.id) return fail(res, 400, 'هاي رسالتك');
      run('INSERT OR IGNORE INTO blocks(blocker, blocked, created_at) VALUES (?, ?, ?)', me.id, post.user_id, now());
      return sendJson(res, 200, { ok: true });
    }
  }

  if (method === 'POST' && (m = /^\/api\/replies\/(\d+)\/report$/.exec(p))) {
    const body = await readJson(req, 2000);
    const r = get(`SELECT * FROM replies WHERE id = ? AND status = 'live'`, int(m[1]));
    if (!r) return fail(res, 404, 'الرد اختفى');
    return report(res, 'reply', r.id, me, body.reason, S);
  }

  if (method === 'POST' && p === '/api/blocks/clear') {
    run('DELETE FROM blocks WHERE blocker = ?', me.id);
    return sendJson(res, 200, { ok: true });
  }

  return fail(res, 404, 'غير موجود');
}

const REASONS = { abuse: 'إساءة أو شتائم', personal: 'كشف معلومات شخصية', spam: 'إزعاج أو سبام', danger: 'تهديد أو خطر', other: 'غير ذلك' };
function report(res, kind, id, me, reason, S) {
  const why = REASONS[reason] ? reason : 'other';
  const table = kind === 'post' ? 'posts' : 'replies';
  const r = run('INSERT OR IGNORE INTO reports(kind, target_id, user_id, reason, created_at) VALUES (?, ?, ?, ?, ?)', kind, id, me.id, why, now());
  if (r.changes) {
    run(`UPDATE ${table} SET reports = reports + 1 WHERE id = ?`, id);
    const n = get(`SELECT reports FROM ${table} WHERE id = ?`, id).reports;
    // "تهديد أو خطر" hides at once; anything else after N different people report it.
    if (why === 'danger' || n >= int(S.reportsToHide, 3)) run(`UPDATE ${table} SET status = 'hidden' WHERE id = ? AND status = 'live'`, id);
  }
  return sendJson(res, 200, { ok: true });
}

/* ---------- admin API ---------- */
async function adminApi(req, res, url) {
  const p = url.pathname, method = req.method;
  if (method === 'POST' && p === '/api/admin/login') {
    const body = await readJson(req, 2000);
    if (!rateLimit(`login:${clientIp(req)}`, 8, 15 * 60_000)) return fail(res, 429, 'محاولات كثيرة، جرّب بعد ربع ساعة');
    const a = Buffer.from(String(body.password || '')), b = Buffer.from(ADMIN_PASSWORD);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return fail(res, 401, 'كلمة السر غلط');
    const tok = randomToken();
    adminSessions.set(tok, now() + 7 * DAY);
    res.setHeader('Set-Cookie', `ftt_admin=${tok}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${7 * 86400}${isHttps(req) ? '; Secure' : ''}`);
    return sendJson(res, 200, { ok: true });
  }
  if (!isAdmin(req)) return fail(res, 401, 'سجّل دخول');

  if (method === 'GET' && p === '/api/admin/overview') {
    const t = now();
    const stats = {
      livePosts: get(`SELECT COUNT(*) n FROM posts WHERE status='live' AND expires_at > ?`, t).n,
      postsToday: get(`SELECT COUNT(*) n FROM posts WHERE created_at > ?`, t - DAY).n,
      repliesToday: get(`SELECT COUNT(*) n FROM replies WHERE created_at > ?`, t - DAY).n,
      activeUsers: get(`SELECT COUNT(*) n FROM users WHERE last_seen > ?`, t - DAY).n,
      users: get(`SELECT COUNT(*) n FROM users`).n,
      pending: get(`SELECT COUNT(*) n FROM posts WHERE status='hidden'`).n + get(`SELECT COUNT(*) n FROM replies WHERE status='hidden'`).n,
    };
    const queue = all(`
      SELECT 'post' AS kind, p.id, p.text, p.image, p.cat, p.user_id, p.up, p.down, p.reports, p.status, p.created_at, p.expires_at, NULL AS post_id,
             (SELECT GROUP_CONCAT(reason) FROM reports WHERE kind='post' AND target_id=p.id) AS reasons
      FROM posts p WHERE p.status = 'hidden' OR (p.reports > 0 AND p.status = 'live')
      UNION ALL
      SELECT 'reply', r.id, r.text, NULL, NULL, r.user_id, 0, 0, r.reports, r.status, r.created_at, NULL, r.post_id,
             (SELECT GROUP_CONCAT(reason) FROM reports WHERE kind='reply' AND target_id=r.id)
      FROM replies r WHERE r.status = 'hidden' OR (r.reports > 0 AND r.status = 'live')
      ORDER BY created_at DESC LIMIT 200`).map((x) => ({
        ...x, image: x.image ? `/u/${x.image}` : null,
        author: get('SELECT karma, banned FROM users WHERE id = ?', x.user_id),
        reasons: (x.reasons || '').split(',').filter(Boolean).map((r) => REASONS[r] || r),
      }));
    const recent = all(`SELECT id, text, cat, image, up, down, reports, status, user_id, created_at, expires_at FROM posts ORDER BY id DESC LIMIT 60`)
      .map((x) => ({ ...x, image: x.image ? `/u/${x.image}` : null }));
    return sendJson(res, 200, { stats, queue, recent, settings: getSettings(), reasons: REASONS, categories: CATEGORIES });
  }

  let m;
  if (method === 'POST' && (m = /^\/api\/admin\/(post|reply)\/(\d+)\/(restore|hide|remove|ban|unban)$/.exec(p))) {
    const [, kind, idS, act] = m; const id = int(idS);
    const table = kind === 'post' ? 'posts' : 'replies';
    const row = get(`SELECT * FROM ${table} WHERE id = ?`, id);
    if (!row) return fail(res, 404, 'غير موجود');
    if (act === 'restore') { run(`UPDATE ${table} SET status = 'live', reports = 0 WHERE id = ?`, id); run('DELETE FROM reports WHERE kind = ? AND target_id = ?', kind, id); }
    if (act === 'hide') run(`UPDATE ${table} SET status = 'hidden' WHERE id = ?`, id);
    if (act === 'remove') { run(`UPDATE ${table} SET status = 'removed' WHERE id = ?`, id); if (kind === 'post') { deleteImage(row.image); run('UPDATE posts SET image = NULL WHERE id = ?', id); } }
    if (act === 'ban') { run('UPDATE users SET banned = 1 WHERE id = ?', row.user_id); run(`UPDATE posts SET status='removed' WHERE user_id = ? AND status != 'removed'`, row.user_id); run(`UPDATE replies SET status='removed' WHERE user_id = ?`, row.user_id); }
    if (act === 'unban') run('UPDATE users SET banned = 0 WHERE id = ?', row.user_id);
    if (kind === 'post') recomputeKarma(row.user_id);
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'POST' && p === '/api/admin/settings') {
    const body = await readJson(req, 200_000);
    const allowed = { testMode: (v) => (v ? '1' : '0'), postTtlHours: (v) => String(Math.min(72, Math.max(1, int(v, 24)))),
      reportsToHide: (v) => String(Math.max(1, int(v, 3))), downvotesToHide: (v) => String(Math.max(2, int(v, 5))),
      postsPerHour: (v) => String(Math.max(1, int(v, 5))), repliesPerHour: (v) => String(Math.max(1, int(v, 30))),
      bannedWords: (v) => String(v || '').slice(0, 100_000) };
    for (const [k, f] of Object.entries(allowed)) if (k in body) setSetting(k, f(body[k]));
    return sendJson(res, 200, { ok: true, settings: getSettings() });
  }
  if (method === 'POST' && p === '/api/admin/logout') {
    adminSessions.delete(parseCookies(req).ftt_admin);
    res.setHeader('Set-Cookie', 'ftt_admin=; Path=/; Max-Age=0');
    return sendJson(res, 200, { ok: true });
  }
  return fail(res, 404, 'غير موجود');
}

/* ---------- static ---------- */
function serveFile(req, res, file, cache) {
  let st; try { st = fs.statSync(file); } catch { return false; }
  if (!st.isFile()) return false;
  const type = MIME[path.extname(file).toLowerCase()];
  if (!type) return false;
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = { 'Content-Type': type, 'Cache-Control': cache, ETag: etag, ...SEC_HEADERS };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(), true; }
  headers['Content-Length'] = st.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end(), true;
  fs.createReadStream(file).pipe(res);
  return true;
}
function safeJoin(base, rel) {
  if (rel.includes('\0')) return null;
  const p = path.normalize(path.join(base, rel));
  return p.startsWith(base + path.sep) ? p : null;
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (p === '/healthz') return sendJson(res, 200, { ok: true });
    // Short link for testers: always the newest Android build from GitHub.
    if (p === '/android' || p === '/android/') {
      res.writeHead(302, { Location: 'https://github.com/alshaheedlib-beep/free-to-talk/releases/latest/download/hon.apk', 'Cache-Control': 'no-store' });
      return res.end();
    }

    if (p.startsWith('/api/')) {
      if (req.method !== 'GET' && !sameOrigin(req)) return fail(res, 403, 'طلب مرفوض');
      if (p.startsWith('/api/admin/')) return await adminApi(req, res, url);
      const me = currentUser(req, res);
      return await api(req, res, url, me);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'غير مسموح');

    if (p.startsWith('/u/')) {
      const name = p.slice(3);
      // only images of posts that are still visible
      const post = /^[a-f0-9]{24}\.(jpg|png|webp)$/.test(name) && get(`SELECT id FROM posts WHERE image = ? AND status = 'live' AND expires_at > ?`, name, now());
      if (!post && !isAdmin(req)) return fail(res, 404, 'الصورة اختفت');
      if (serveFile(req, res, path.join(UPLOAD_DIR, name), 'private, max-age=3600')) return;
      return fail(res, 404, 'الصورة اختفت');
    }

    if (p === '/admin' || p === '/admin/') return serveFile(req, res, path.join(PUBLIC_DIR, 'admin.html'), 'no-cache');
    if (p === '/sw.js') return serveFile(req, res, path.join(PUBLIC_DIR, 'sw.js'), 'no-cache');
    const file = p === '/' ? path.join(PUBLIC_DIR, 'index.html') : safeJoin(PUBLIC_DIR, p);
    if (file && serveFile(req, res, file, p === '/' || p.endsWith('.html') ? 'no-cache' : 'public, max-age=300')) return;
    // the app is a single page — unknown paths open it
    return serveFile(req, res, path.join(PUBLIC_DIR, 'index.html'), 'no-cache');
  } catch (e) {
    if (!res.headersSent) fail(res, e.status || 500, e.status === 413 ? 'الملف كبير' : e.status === 400 ? 'طلب غير صالح' : 'صار خطأ، جرّب مرة ثانية');
    if (!e.status) console.error(e);
  }
});

/* ---------- expiry: hide after 24h, purge the hidden copy after 30 days ---------- */
function sweep() {
  const t = now();
  for (const r of all('SELECT id, image FROM posts WHERE expires_at <= ? AND image IS NOT NULL', t)) {
    deleteImage(r.image); run('UPDATE posts SET image = NULL WHERE id = ?', r.id);
  }
  const old = t - KEEP_EXPIRED_DAYS * DAY;
  tx(() => {
    run(`DELETE FROM reports WHERE (kind='post' AND target_id IN (SELECT id FROM posts WHERE expires_at <= ?))
         OR (kind='reply' AND target_id IN (SELECT r.id FROM replies r JOIN posts p ON p.id = r.post_id WHERE p.expires_at <= ?))`, old, old);
    run('DELETE FROM posts WHERE expires_at <= ?', old);   // replies + votes cascade
  });
  for (const [k, exp] of adminSessions) if (exp < t) adminSessions.delete(k);
}
sweep();
setInterval(sweep, 5 * 60_000).unref();

server.listen(PORT, process.env.HOST || '0.0.0.0', () => console.log(`هون (Hon) on http://localhost:${PORT}  (admin: /admin)`));
process.on('SIGTERM', () => { server.close(); db.close(); process.exit(0); });
