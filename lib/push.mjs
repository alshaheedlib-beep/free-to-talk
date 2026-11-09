// Push notifications through Firebase Cloud Messaging (HTTP v1), with no extra packages.
// The server key lives only on the server: /opt/freetotalk-data/firebase-key.json (mounted as /data).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, get, all, run } from './db.mjs';

const KEY_PATHS = [process.env.FIREBASE_KEY, path.join(DATA_DIR, '..', 'firebase-key.json'), path.join(DATA_DIR, 'firebase-key.json')].filter(Boolean);

run(`CREATE TABLE IF NOT EXISTS push_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`);
run('CREATE INDEX IF NOT EXISTS push_user ON push_tokens(user_id)');

let key = null, keyMtime = 0;
function loadKey() {
  for (const p of KEY_PATHS) {
    try {
      const st = fs.statSync(p);
      if (key && st.mtimeMs === keyMtime) return key;
      const k = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (k.private_key && k.client_email && k.project_id) { key = k; keyMtime = st.mtimeMs; access = null; return key; }
    } catch { /* try next */ }
  }
  return null;
}
export const pushEnabled = () => !!loadKey();

let access = null; // { token, exp }
async function accessToken() {
  const k = loadKey();
  if (!k) return null;
  if (access && access.exp > Date.now() + 60_000) return access.token;
  const nowS = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: k.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat: nowS, exp: nowS + 3600,
  })}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(unsigned), k.private_key).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
  });
  const d = await res.json();
  if (!res.ok || !d.access_token) throw new Error(`firebase auth: ${res.status} ${JSON.stringify(d).slice(0, 200)}`);
  access = { token: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 };
  return access.token;
}

export function registerToken(userId, token, platform) {
  if (!/^[\w:\-]{20,4096}$/.test(token)) return false;
  run(`INSERT INTO push_tokens(token, user_id, platform, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, platform = excluded.platform, updated_at = excluded.updated_at`,
    token, userId, platform === 'ios' ? 'ios' : 'android', Date.now());
  return true;
}

async function sendOne(token, { title, body, url }) {
  const k = loadKey(); const at = await accessToken();
  if (!k || !at) return;
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${k.project_id}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: {
      token,
      notification: { title, body },
      data: { url },
      android: { priority: 'high', notification: { channel_id: 'replies', color: '#FCA311', icon: 'ic_notification', click_action: 'HON_OPEN' } },
      apns: { payload: { aps: { sound: 'default' } } },
    } }),
  });
  if (res.status === 404 || res.status === 400) {
    const d = await res.json().catch(() => ({}));
    const code = JSON.stringify(d);
    if (code.includes('UNREGISTERED') || code.includes('registration-token-not-registered') || code.includes('INVALID_ARGUMENT'))
      run('DELETE FROM push_tokens WHERE token = ?', token);
  } else if (!res.ok) console.error('push failed', res.status, (await res.text()).slice(0, 200));
}

const lastPing = new Map(); // `${user}:${post}` → time — at most one notification per thread every 2 minutes
/** Tell everyone in a thread (the writer and earlier repliers) that someone replied — never the replier. */
export function notifyReply(post, replierId, replyText) {
  if (!pushEnabled()) return;
  const people = new Set([post.user_id, ...all('SELECT DISTINCT user_id FROM replies WHERE post_id = ? AND status = ?', post.id, 'live').map((r) => r.user_id)]);
  people.delete(replierId);
  const t = Date.now();
  for (const uid of people) {
    if (get('SELECT banned FROM users WHERE id = ?', uid)?.banned) continue;
    const k = `${uid}:${post.id}`;
    if (t - (lastPing.get(k) || 0) < 120_000) continue;
    lastPing.set(k, t);
    const title = uid === post.user_id ? 'ردّ جديد على رسالتك 💬' : 'ردّ جديد بنقاش شاركت فيه 💬';
    const body = replyText.length > 90 ? `${replyText.slice(0, 90)}…` : replyText;
    for (const { token } of all('SELECT token FROM push_tokens WHERE user_id = ?', uid))
      sendOne(token, { title, body, url: `/?post=${post.id}` }).catch((e) => console.error('push', e.message));
  }
  if (lastPing.size > 5000) for (const [k2, v] of lastPing) if (t - v > 600_000) lastPing.delete(k2);
}
