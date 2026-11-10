const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLORS = { ask: 'var(--c-ask)', alert: 'var(--c-alert)', lost: 'var(--c-lost)', offer: 'var(--c-offer)', chat: 'var(--c-chat)' };
const STATUS = { live: 'ظاهرة', hidden: 'مخفية — بانتظارك', removed: 'محذوفة' };
let data;

async function api(path, body) {
  const res = await fetch(path, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(d.error || 'خطأ'), { status: res.status });
  return d;
}
function toast(m) { const t = $('#toast'); t.textContent = m; t.hidden = false; setTimeout(() => (t.hidden = true), 2200); }
const when = (ts) => new Date(ts).toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' });

async function load() {
  try { data = await api('/api/admin/overview'); }
  catch (e) { if (e.status === 401) { $('#login').hidden = false; $('#panel').hidden = true; return; } toast(e.message); return; }
  $('#login').hidden = true; $('#panel').hidden = false;
  const s = data.stats;
  $('#stats').innerHTML = [
    ['رسائل ظاهرة هلأ', s.livePosts], ['رسائل آخر 24 ساعة', s.postsToday], ['ردود آخر 24 ساعة', s.repliesToday],
    ['ناس فتحوا اليوم', s.activeUsers], ['كل الأجهزة', s.users], ['بانتظار مراجعتك', s.pending, s.pending ? 'warn' : ''],
  ].map(([l, n, c]) => `<div class="${c || ''}"><b>${n.toLocaleString('ar-EG')}</b><span>${l}</span></div>`).join('');
  $('#qCount').textContent = data.queue.length || '';
  $('#qCount').hidden = !data.queue.length;
  $('#queue').innerHTML = data.queue.length ? data.queue.map(itemHtml).join('') : '<p class="muted">ما في بلاغات. كل شي تمام 👌</p>';
  $('#recent').innerHTML = data.recent.map((r) => itemHtml({ ...r, kind: 'post', reasons: [] })).join('') || '<p class="muted">ما في رسائل لسا.</p>';
  const f = $('#settings');
  for (const el of f.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') el.checked = data.settings[el.name] === '1'; else el.value = data.settings[el.name] ?? '';
  }
}
function itemHtml(x) {
  const expired = x.expires_at && x.expires_at < Date.now();
  return `<div class="item ${x.status === 'hidden' ? 'hidden-item' : ''}" style="--c:${COLORS[x.cat] || 'var(--line)'}" data-kind="${x.kind}" data-id="${x.id}">
    <div class="meta">
      <span class="pill">${x.kind === 'post' ? (data.categories[x.cat] || 'رسالة') : `رد على رسالة #${x.post_id}`}</span>
      ${x.locked ? `<span class="pill">🔒 مقفولة${x.opens != null ? ` · انفتحت لـ ${x.opens}` : ''}</span>` : ''}
      <span class="pill ${x.status === 'hidden' ? 'red' : ''}">${STATUS[x.status] || x.status}${expired ? ' · انتهت مدتها' : ''}</span>
      ${x.reports ? `<span class="pill red">${x.reports} بلاغ: ${esc(x.reasons.join('، '))}</span>` : ''}
      ${x.kind === 'post' ? `<span>👍 ${x.up} · 👎 ${x.down}</span>` : ''}
      ${x.author ? `<span>سمعة الكاتب: ${x.author.karma}${x.author.banned ? ' · موقوف' : ''}</span>` : ''}
      <span>#${x.id} · ${when(x.created_at)}</span>
    </div>
    <p>${esc(x.text)}</p>
    ${x.image ? `<img src="${x.image}" alt="">` : ''}
    <div class="acts">
      ${x.status !== 'live' ? '<button data-a="restore">إرجاعها</button>' : '<button data-a="hide">إخفاء</button>'}
      ${x.status !== 'removed' ? '<button data-a="remove" class="bad">حذف نهائي</button>' : ''}
      ${x.author?.banned ? '<button data-a="unban">إلغاء الإيقاف</button>' : '<button data-a="ban" class="bad">إيقاف الكاتب ومسح كل رسائله</button>'}
    </div>
  </div>`;
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-a]'); if (!b) return;
  const it = b.closest('.item');
  if (['ban', 'remove'].includes(b.dataset.a) && !confirm(b.dataset.a === 'ban' ? 'متأكد؟ رح ينوقف الجهاز وتنمسح كل رسائله.' : 'متأكد من الحذف؟')) return;
  try { await api(`/api/admin/${it.dataset.kind}/${it.dataset.id}/${b.dataset.a}`, {}); toast('تم'); load(); } catch (er) { toast(er.message); }
});
$$('.tabs button').forEach((b) => b.addEventListener('click', () => {
  $$('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  $$('[data-pane]').forEach((p) => (p.hidden = p.dataset.pane !== b.dataset.tab));
}));
$('#settings').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {};
  for (const el of e.target.elements) if (el.name) body[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  try { await api('/api/admin/settings', body); toast('انحفظت'); load(); } catch (er) { toast(er.message); }
});
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api('/api/admin/login', { password: $('#pw').value }); $('#pw').value = ''; load(); }
  catch (er) { $('#loginErr').textContent = er.message; $('#loginErr').hidden = false; }
});
$('#logout').addEventListener('click', async () => { await api('/api/admin/logout', {}); location.reload(); });
load();
setInterval(() => { if (!$('#panel').hidden && document.visibilityState === 'visible' && $('#settings').hidden) load(); }, 30000);
