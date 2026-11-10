const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const ar = (n) => Number(n).toLocaleString('ar-EG');
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const COLORS = { ask: 'var(--c-ask)', alert: 'var(--c-alert)', lost: 'var(--c-lost)', offer: 'var(--c-offer)', chat: 'var(--c-chat)' };
const state = {
  me: null, loc: null, radius: store.get('ftt.r') || 2, cat: '', sort: 'new', posts: [],
  composeCat: 'chat', composeTtl: store.get('ftt.ttl'), image: null, thread: null, loading: false,
};

/* ---------- api ---------- */
// Inside the phone app, a hashed device id lets bans stick to the phone.
const DEVICE = (() => { try { return window.HonNative?.deviceId?.() || ''; } catch { return ''; } })();
async function api(path, opts = {}) {
  const headers = opts.body ? { 'Content-Type': 'application/json' } : {};
  if (DEVICE) headers['X-Hon-Device'] = DEVICE;
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'صار خطأ، جرّب مرة ثانية'), { status: res.status });
  return data;
}

/* ---------- small ui helpers ---------- */
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2600);
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function ago(min) {
  if (min < 1) return 'هلأ';
  if (min < 60) return `قبل ${ar(min)} د`;
  const h = Math.floor(min / 60);
  return `قبل ${ar(h)} س`;
}
function leftText(min) {
  if (min < 60) return `${ar(min)} د`;
  return `${ar(Math.round(min / 60))} س`;
}

let openSheet = null;
function showSheet(id) {
  if (openSheet) $(openSheet).hidden = true;
  openSheet = id; $(id).hidden = false; $('#scrim').hidden = false;
}
function closeSheet() {
  if (openSheet) $(openSheet).hidden = true;
  openSheet = null; $('#scrim').hidden = true;
}
$('#scrim').addEventListener('click', closeSheet);
document.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
// Android app: the back button closes an open sheet before leaving the app.
window.honBack = () => { if (!openSheet) return false; closeSheet(); return true; };

/* ---------- location ---------- */
function setLocation(loc) {
  state.loc = loc;
  $('#placeName').textContent = loc.name;
  $('#composePlace').textContent = loc.spot ? `عند «${loc.name}»` : 'بمكانك الحالي';
  if (loc.spot) store.set('ftt.spot', loc.spot); else store.set('ftt.spot', null);
  loadFeed();
}
function askGps() {
  return new Promise((resolve, reject) => {
    if (!window.isSecureContext || !navigator.geolocation) return reject(new Error('insecure'));
    // never leave the user stuck on "بنحدد موقعك…" if the phone doesn't answer
    const guard = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 3 })), 20000);
    navigator.geolocation.getCurrentPosition(
      (p) => { clearTimeout(guard); resolve({ lat: p.coords.latitude, lng: p.coords.longitude, name: 'حواليك', spot: null }); },
      (e) => { clearTimeout(guard); reject(e); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 15000 });
  });
}
// After your first message or reply, the phone app asks once whether you want reply notifications.
function askNotificationsOnce() {
  if (store.get('ftt.askedPush')) return;
  try { window.HonNative?.requestNotifications?.(); store.set('ftt.askedPush', true); setTimeout(registerPush, 4000); } catch {}
}
async function locate({ manual = false } = {}) {
  const saved = store.get('ftt.spot');
  if (!manual && saved && state.me.testMode) {
    const s = state.me.testSpots.find((x) => x.id === saved);
    if (s) return setLocation({ lat: s.lat, lng: s.lng, name: s.name, spot: s.id });
  }
  try {
    setLocation(await askGps());
  } catch (e) {
    openPlaceSheet(e);
  }
}
function openPlaceSheet(err) {
  const secure = window.isSecureContext && navigator.geolocation;
  $('#useGps').hidden = !secure;
  let note = 'التطبيق بيعرضلك اللي حواليك بس، فبنحتاج موقعك. ما بنحفظ موقعك الدقيق أبداً.';
  if (!secure) note = 'الموقع الحقيقي بيشتغل لما يكون الرابط آمن (https). لهلأ جرّب من الأماكن التجريبية.';
  else if (err && err.code === 1) note = 'رفضت مشاركة الموقع. فعّلها من إعدادات المتصفح وجرّب مرة ثانية.';
  else if (err && err.code === 3) note = 'الموقع اتأخر. تأكد إن الـ GPS شغّال وجرّب مرة ثانية.';
  $('#placeNote').textContent = note;
  const spots = state.me.testSpots;
  $('#spotsBox').hidden = !spots.length;
  $('#spots').innerHTML = spots.map((s) => `<button class="spot ${state.loc?.spot === s.id ? 'on' : ''}" data-spot="${s.id}">${esc(s.name)}</button>`).join('');
  if (!secure && !spots.length) $('#placeNote').textContent = 'لازم يكون الرابط آمن (https) عشان نقدر نعرف موقعك.';
  showSheet('#placeSheet');
}
$('#placeChip').addEventListener('click', () => openPlaceSheet());
$('#useGps').addEventListener('click', async () => {
  $('#useGps').disabled = true;
  try { setLocation(await askGps()); closeSheet(); }
  catch (e) { openPlaceSheet(e); }
  finally { $('#useGps').disabled = false; }
});
$('#spots').addEventListener('click', (e) => {
  const b = e.target.closest('[data-spot]'); if (!b) return;
  const s = state.me.testSpots.find((x) => x.id === b.dataset.spot);
  setLocation({ lat: s.lat, lng: s.lng, name: s.name, spot: s.id }); closeSheet();
});

/* ---------- filters ---------- */
// One fixed row of icon tabs — everything visible at once, no sideways scrolling.
const CAT_ICONS = {
  '': '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/>',
  ask: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .9-1 1.6"/><circle cx="12" cy="16.8" r=".7" fill="currentColor"/>',
  alert: '<path d="M12 3.5 2.5 20h19L12 3.5Z"/><path d="M12 10v4"/><circle cx="12" cy="16.8" r=".7" fill="currentColor"/>',
  lost: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  offer: '<path d="M3.5 12.5V4h8.5l9 9-8.5 8.5-9-9Z"/><circle cx="8" cy="8.5" r="1.4"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.6A8 8 0 1 1 21 12Z"/>',
  locked: '<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3"/>',
};
function renderFilters() {
  const cats = state.me.categories;
  const tabs = [['', 'الكل', 'var(--ink)'], ...Object.entries(cats).map(([k, v]) => [k, v, COLORS[k]]), ['locked', 'مقفولة', 'var(--accent)']];
  $('#filters').innerHTML = tabs.map(([k, label, color]) =>
    `<button class="ftab ${state.cat === k ? 'on' : ''}" data-cat="${k}" style="--c:${color}" aria-pressed="${state.cat === k}">
      <span class="ficon"><svg viewBox="0 0 24 24">${CAT_ICONS[k] || CAT_ICONS.chat}</svg></span><span class="flabel">${label}</span></button>`).join('');
  $('#composeCats').innerHTML = Object.entries(cats).map(([k, v]) =>
    `<button class="chip ${state.composeCat === k ? 'on' : ''}" data-ccat="${k}" style="--c:${COLORS[k]}"><i></i>${v}</button>`).join('');
}
$('#filters').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cat]'); if (!b) return;
  state.cat = b.dataset.cat; renderFilters(); loadFeed();
});
$('#composeCats').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ccat]'); if (!b) return;
  state.composeCat = b.dataset.ccat; renderFilters();
});
$$('.radius button').forEach((b) => {
  b.classList.toggle('on', Number(b.dataset.r) === state.radius);
  b.addEventListener('click', () => {
    state.radius = Number(b.dataset.r); store.set('ftt.r', state.radius);
    $$('.radius button').forEach((x) => x.classList.toggle('on', x === b)); loadFeed();
  });
});
$$('.sort button').forEach((b) => b.addEventListener('click', () => {
  state.sort = b.dataset.sort; $$('.sort button').forEach((x) => x.classList.toggle('on', x === b)); loadFeed();
}));
$('#refreshBtn').addEventListener('click', () => refreshHere());
// While you walk, keep your position fresh so locked messages open when you reach them.
async function refreshHere({ silent = false } = {}) {
  if (state.loc && !state.loc.spot) {
    try { const l = await askGps(); state.loc = { ...state.loc, lat: l.lat, lng: l.lng }; } catch {}
  }
  return loadFeed({ silent });
}

/* ---------- feed ---------- */
const SHARE_ICON = '<svg viewBox="0 0 24 24"><path d="M12 15V3M7 8l5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';
const opensText = (n) => n ? `انفتحت لـ ${ar(n)} ${n === 1 ? 'شخص' : n <= 10 ? 'أشخاص' : 'شخص'}` : 'لسا ما حدا فتحها';
function lifeHtml(p) {
  const ttl = p.life || state.me.ttlHours * 60;
  const frac = Math.max(0, Math.min(1, p.left / ttl));
  const C = 2 * Math.PI * 9;
  return `<span class="life" title="الوقت المتبقي قبل ما تختفي">
        <svg viewBox="0 0 22 22"><circle class="track" cx="11" cy="11" r="9"/><circle class="left" cx="11" cy="11" r="9" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - frac)}"/></svg>
        ${leftText(p.left)}
      </span>`;
}
const MORE_BTN = '<button class="more" data-act="menu" aria-label="خيارات"><svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="12" cy="19" r="1.2"/></svg></button>';
function sealedHtml(p) {
  const cat = state.me.categories[p.cat] || '';
  const maps = `https://www.google.com/maps/dir/?api=1&destination=${p.spot.lat},${p.spot.lng}&travelmode=walking`;
  return `
  <article class="card sealed" data-id="${p.id}" style="--c:${COLORS[p.cat] || COLORS.chat}">
    <div class="card-head">
      <span class="badge"><i></i>${cat}</span><span class="dot">•</span><span>${ago(p.ago)}</span>${MORE_BTN}
    </div>
    <div class="seal">
      <div class="seal-ico">🔒</div>
      <div><b>رسالة مقفولة</b><p>${esc(p.distText)}، امشي لهناك لتنفتحلك</p></div>
    </div>
    <div class="card-foot">
      <a class="go-btn" href="${maps}" target="_blank" rel="noopener"><svg viewBox="0 0 24 24"><path d="M3 11 21 3l-8 18-2-8-8-2Z"/></svg>خذني لهناك</a>
      <span class="opens">&nbsp; ${opensText(p.opens)}</span>
      <button class="share-btn" data-act="share" aria-label="شارك كصورة">${SHARE_ICON}</button>
      ${lifeHtml(p)}
    </div>
  </article>`;
}
function cardHtml(p, { inThread = false } = {}) {
  if (p.sealed) return sealedHtml(p);
  const cat = state.me.categories[p.cat] || '';
  return `
  <article class="card ${p.justOpened ? 'just-opened' : ''}" data-id="${p.id}" style="--c:${COLORS[p.cat] || COLORS.chat}">
    <div class="card-head">
      <span class="badge"><i></i>${cat}</span><span class="dot">•</span>
      <span>${esc(p.distText)}</span><span class="dot">•</span><span>${ago(p.ago)}</span>
      ${p.mine ? '<span class="mine-tag">رسالتك</span>' : ''}
      ${p.locked ? `<span class="unlocked-tag" title="${opensText(p.opens)}">🔓 ${p.mine ? ar(p.opens) : 'انفتحتلك'}</span>` : ''}
      ${MORE_BTN}
    </div>
    <p class="card-text">${esc(p.text)}</p>
    ${p.image ? `<img class="card-img" src="${p.image}" alt="صورة مرفقة بالرسالة" loading="lazy">` : ''}
    <div class="card-foot">
      <div class="vote">
        <button class="up ${p.myVote === 1 ? 'on' : ''}" data-act="up" aria-label="مفيدة" ${p.mine ? 'disabled' : ''}><svg viewBox="0 0 24 24"><path d="m6 14 6-6 6 6"/></svg></button>
        <b>${ar(p.score)}</b>
        <button class="down ${p.myVote === -1 ? 'on' : ''}" data-act="down" aria-label="مش مفيدة" ${p.mine ? 'disabled' : ''}><svg viewBox="0 0 24 24"><path d="m6 10 6 6 6-6"/></svg></button>
      </div>
      ${inThread ? '' : `<button class="reply-btn" data-act="thread"><svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.6A8 8 0 1 1 21 12Z"/></svg>${p.replies ? ar(p.replies) : 'رد'}</button>`}
      <button class="share-btn" data-act="share" aria-label="شارك كصورة">${SHARE_ICON}</button>
      ${lifeHtml(p)}
    </div>
  </article>`;
}

const EMPTY_ART = `<svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="50" stroke-dasharray="4 6"/><circle cx="60" cy="60" r="30" stroke-dasharray="3 5"/><path d="M60 72s-12-9.6-12-19a12 12 0 0 1 24 0c0 9.4-12 19-12 19Z" fill="var(--accent)" stroke="none"/><circle cx="60" cy="53" r="4" fill="var(--card)" stroke="none"/></svg>`;

async function loadFeed({ silent = false } = {}) {
  if (!state.loc || state.loading) return;
  state.loading = true;
  $('#refreshBtn').classList.add('spin');
  if (!silent && !state.posts.length) $('#feed').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  try {
    const q = new URLSearchParams({ lat: state.loc.lat, lng: state.loc.lng, r: state.radius, sort: state.sort });
    if (state.cat) q.set('cat', state.cat);
    const d = await api(`/api/feed?${q}`);
    state.posts = d.posts;
    renderFeed(d);
    renderPulse(d.pulse);
    const opened = d.posts.filter((p) => p.justOpened);
    if (opened.length) {
      toast(opened.length === 1 ? '🔓 وصلت! انفتحتلك رسالة مقفولة' : `🔓 وصلت! انفتحتلك ${ar(opened.length)} رسائل مقفولة`);
      try { navigator.vibrate?.([60, 40, 120]); } catch {}
      $(`#feed .card[data-id="${opened[0].id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  } catch (e) {
    if (!silent) $('#feed').innerHTML = `<div class="empty"><h3>ما قدرنا نحمّل الرسائل</h3><p>${esc(e.message)}</p><button class="ghost" id="retry">جرّب مرة ثانية</button></div>`;
  } finally {
    state.loading = false; $('#refreshBtn').classList.remove('spin');
  }
}
function renderPulse(n) {
  const bar = $('#pulseBar');
  if (!n) { bar.hidden = true; return; }
  bar.innerHTML = `<span class="beat"></span><span><b>${ar(n)} ${n <= 10 ? 'أشخاص' : 'شخص'}</b> فاتحين هون حواليك هلأ</span>`;
  bar.hidden = false;
}
function renderFeed(d) {
  if (!state.posts.length) {
    const cat = state.cat === 'locked' ? 'مقفولة ' : state.cat ? `«${state.me.categories[state.cat]}» ` : '';
    const hint = d.widerCount ? `في ${ar(d.widerCount)} رسالة أبعد شوي، كبّر النطاق لتشوفها.` : 'كن أول واحد بيكتب هون، واللي بيمرق من جنبك بيشوفها.';
    $('#feed').innerHTML = `<div class="empty"><div class="art">${EMPTY_ART}</div><h3>ما في رسائل ${cat}حواليك هلأ</h3><p>${hint}</p><button class="primary small" data-act="compose">ازرع أول رسالة</button></div>`;
    return;
  }
  $('#feed').innerHTML = state.posts.map((p) => cardHtml(p)).join('');
}

document.addEventListener('click', async (e) => {
  if (e.target.id === 'retry') return loadFeed();
  const actEl = e.target.closest('[data-act]'); if (!actEl) return;
  const act = actEl.dataset.act;
  if (act === 'compose') return openCompose();
  const card = actEl.closest('.card'); if (!card) return;
  const id = Number(card.dataset.id);
  const post = state.posts.find((x) => x.id === id) || (state.thread?.id === id ? state.thread : null);
  if (!post) return;
  if (act === 'share') return openShare(post);
  if (act === 'menu') return openMenu(post);
  if (post.sealed) return toast('🔒 هاي رسالة مقفولة. امشي لمكانها لتنفتح');
  if (act === 'up' || act === 'down') return vote(post, act === 'up' ? 1 : -1);
  if (act === 'thread') return openThread(post);
  if (act === 'menu') return openMenu(post);
});

async function vote(post, v) {
  const next = post.myVote === v ? 0 : v;
  try {
    const r = await api(`/api/posts/${post.id}/vote`, { method: 'POST', body: { v: next } });
    post.myVote = r.myVote; post.score = r.score;
    if (r.hidden) { state.posts = state.posts.filter((x) => x.id !== post.id); toast('الرسالة انخفت بسبب التقييمات'); }
    rerenderPost(post);
  } catch (e) { toast(e.message); }
}
function rerenderPost(post) {
  for (const el of $$(`.card[data-id="${post.id}"]`)) {
    if (!state.posts.includes(post) && !el.closest('#threadPost')) { el.remove(); continue; }
    const inThread = !!el.closest('#threadPost');
    el.outerHTML = cardHtml(post, { inThread });
  }
  if (!state.posts.length && !$('#feed .empty')) renderFeed({ widerCount: 0 });
}

/* ---------- menu: report / block / delete ---------- */
function openMenu(post) {
  const m = $('#menu');
  if (post.mine) {
    m.innerHTML = `<button class="danger" data-m="delete">🗑️ احذف رسالتي هلأ</button><button data-close>إلغاء</button>`;
  } else {
    m.innerHTML = `<button data-m="report">🚩 إبلاغ عن الرسالة</button><button data-m="block">🚫 ما بدي أشوف رسائل هالشخص</button><button data-close>إلغاء</button>`;
  }
  m.onclick = async (e) => {
    const b = e.target.closest('[data-m]'); if (!b) return;
    if (b.dataset.m === 'delete') {
      try { await api(`/api/posts/${post.id}`, { method: 'DELETE' }); removePost(post.id); toast('انحذفت'); } catch (er) { toast(er.message); }
    }
    if (b.dataset.m === 'block') {
      try { await api(`/api/posts/${post.id}/block`, { method: 'POST' }); closeSheet(); toast('ما رح تشوف رسائله بعد هيك'); loadFeed({ silent: true }); } catch (er) { toast(er.message); }
    }
    if (b.dataset.m === 'report') openReport(`/api/posts/${post.id}/report`, () => removePost(post.id));
  };
  showSheet('#menuSheet');
}
function openReport(url, onDone) {
  const m = $('#menu');
  m.innerHTML = `<h3>ليش بدك تبلّغ؟</h3>
    <button data-r="abuse">إساءة أو شتائم</button>
    <button data-r="personal">كشف معلومات شخصية عن حدا</button>
    <button data-r="spam">إزعاج أو سبام</button>
    <button data-r="danger" class="danger">تهديد أو خطر</button>
    <button data-r="other">غير ذلك</button>`;
  m.onclick = async (e) => {
    const b = e.target.closest('[data-r]'); if (!b) return;
    try { await api(url, { method: 'POST', body: { reason: b.dataset.r } }); closeSheet(); toast('شكراً، وصل البلاغ وانخفت عندك'); onDone?.(); }
    catch (er) { toast(er.message); }
  };
  showSheet('#menuSheet');
}
function removePost(id) {
  state.posts = state.posts.filter((x) => x.id !== id);
  closeSheet();
  $(`#feed .card[data-id="${id}"]`)?.remove();
  if (!state.posts.length) renderFeed({ widerCount: 0 });
}

/* ---------- compose ---------- */
function openCompose() {
  if (!state.loc) return openPlaceSheet();
  if (state.me.banned) return toast('حسابك موقوف من النشر');
  $('#composeError').hidden = true;
  renderTtl();
  renderFilters();
  showSheet('#composeSheet');
  setTimeout(() => $('#composeText').focus(), 250);
}
$('#composeBtn').addEventListener('click', openCompose);
const hoursText = (h) => h === 1 ? 'ساعة' : h === 2 ? 'ساعتين' : `${ar(h)} ${h <= 10 ? 'ساعات' : 'ساعة'}`;
function renderTtl() {
  const choices = state.me.ttlChoices || [state.me.ttlHours];
  if (!choices.includes(state.composeTtl)) state.composeTtl = choices[choices.length - 1];
  $('#ttlOpts').innerHTML = choices.map((h) => `<button type="button" data-ttl="${h}" class="${h === state.composeTtl ? 'on' : ''}">${h === 1 ? 'ساعة' : ar(h) + ' س'}</button>`).join('');
  $('#composeTtl').textContent = hoursText(state.composeTtl);
}
$('#ttlOpts').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ttl]'); if (!b) return;
  state.composeTtl = Number(b.dataset.ttl); store.set('ftt.ttl', state.composeTtl); renderTtl();
});
$('#composeText').addEventListener('input', () => {
  const n = $('#composeText').value.length;
  const c = $('#composeCount'); c.textContent = `${ar(n)} / ${ar(state.me.maxPost)}`; c.classList.toggle('near', n > state.me.maxPost - 30);
});
$('#photoBtn').addEventListener('click', () => $('#photoInput').click());
$('#photoInput').addEventListener('change', async () => {
  const f = $('#photoInput').files[0]; $('#photoInput').value = '';
  if (!f) return;
  try {
    state.image = await shrinkImage(f);
    $('#photoPreview img').src = state.image; $('#photoPreview').hidden = false; $('#photoBtn').hidden = true;
  } catch { toast('ما قدرنا نقرأ الصورة'); }
});
$('#photoRemove').addEventListener('click', () => { state.image = null; $('#photoPreview').hidden = true; $('#photoBtn').hidden = false; });

// Resize + re-encode on the phone: smaller upload, and it drops the photo's hidden GPS/EXIF data.
function shrinkImage(file, max = 1280) {
  return new Promise((resolve, reject) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      let q = 0.8, out = c.toDataURL('image/jpeg', q);
      while (out.length > 1_900_000 && q > 0.4) { q -= 0.1; out = c.toDataURL('image/jpeg', q); }
      resolve(out);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
    img.src = url;
  });
}

$('#composeSend').addEventListener('click', async () => {
  const text = $('#composeText').value.trim();
  const err = $('#composeError');
  if (text.length < 2) { err.textContent = 'اكتب شي قبل ما تبث'; err.hidden = false; return; }
  const btn = $('#composeSend'); btn.disabled = true; btn.textContent = 'عم نزرعها…';
  try {
    // a fresh GPS reading at the moment of sending, so the message lands exactly where you are
    let loc = state.loc;
    if (!loc.spot) { try { loc = await askGps(); state.loc = loc; } catch {} }
    const r = await api('/api/posts', { method: 'POST', body: { text, cat: state.composeCat, ttlHours: state.composeTtl, locked: $('#composeLock').checked, lat: loc.lat, lng: loc.lng, image: state.image } });
    $('#composeText').value = ''; $('#composeText').dispatchEvent(new Event('input'));
    $('#photoRemove').click();
    closeSheet();
    toast(($('#composeLock').checked ? 'انقفلت 🔒 وما بيقرأها إلا اللي بيوصل هون. ' : 'انزرعت 📍 ') + 'بتختفي بعد ' + hoursText(state.composeTtl));
    $('#composeLock').checked = false;
    askNotificationsOnce();
    state.posts.unshift(r.post);
    if (state.sort !== 'new' || (state.cat && state.cat !== r.post.cat)) loadFeed({ silent: true }); else renderFeed({ widerCount: 0 });
    state.me.livePosts++;
  } catch (e) {
    err.textContent = e.message; err.hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = 'بُث الرسالة';
  }
});

/* ---------- thread ---------- */
async function openThread(post) {
  if (post.sealed) return toast('🔒 هاي رسالة مقفولة. امشي لمكانها لتنفتح');
  state.thread = post;
  $('#threadPost').innerHTML = cardHtml(post, { inThread: true });
  $('#replies').innerHTML = '<div class="skeleton" style="height:60px"></div>';
  showSheet('#threadSheet');
  await loadReplies();
}
async function loadReplies() {
  const post = state.thread; if (!post) return;
  try {
    const d = await api(`/api/posts/${post.id}/replies`);
    post.replies = d.replies.length;
    $('#replies').innerHTML = d.replies.length ? d.replies.map((r) => `
      <div class="reply ${r.op ? 'op' : ''} ${r.mine ? 'mine' : ''}" data-rid="${r.id}">
        <div class="reply-head"><b>${r.mine ? 'إنت' : esc(r.who)}</b><span>${ago(r.ago)}</span>${r.mine ? '' : '<button data-rreport>إبلاغ</button>'}</div>
        <p>${esc(r.text)}</p>
      </div>`).join('') : '<p class="muted" style="text-align:center;margin-top:24px">ما في ردود لسا. كون أول واحد بيرد.</p>';
    $('#replies').scrollTop = $('#replies').scrollHeight;
    rerenderFeedCard(post);
  } catch (e) {
    if (e.status === 404) { closeSheet(); removePost(post.id); toast('الرسالة اختفت'); }
    else $('#replies').innerHTML = `<p class="muted">${esc(e.message)}</p>`;
  }
}
function rerenderFeedCard(post) {
  const el = $(`#feed .card[data-id="${post.id}"]`); if (el) el.outerHTML = cardHtml(post);
}
$('#replies').addEventListener('click', (e) => {
  const b = e.target.closest('[data-rreport]'); if (!b) return;
  const rid = b.closest('[data-rid]').dataset.rid;
  const back = state.thread;
  openReport(`/api/replies/${rid}/report`, () => openThread(back));
});
$('#replyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#replyText'); const text = input.value.trim(); if (!text) return;
  input.disabled = true;
  try { await api(`/api/posts/${state.thread.id}/replies`, { method: 'POST', body: { text } }); input.value = ''; await loadReplies(); askNotificationsOnce(); }
  catch (er) { toast(er.message); }
  finally { input.disabled = false; input.focus(); }
});

/* ---------- share as an image (story size) ---------- */
const HEX = { ask: '#2f6fdb', alert: '#e2531d', lost: '#8e44ad', offer: '#1e9e63', chat: '#7a8094' };
const loadImg = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
function wrapLines(ctx, text, width, maxLines) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const w of para.split(/\s+/).filter(Boolean)) {
      const t = line ? `${line} ${w}` : w;
      if (ctx.measureText(t).width <= width || !line) line = t; else { lines.push(line); line = w; }
    }
    lines.push(line);
  }
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…'; }
  return lines;
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) return ctx.roundRect(x, y, w, h, r);
  r = Math.min(r, w / 2, h / 2);   // older iPhones
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
async function makeCard(p) {
  const W = 1080, H = 1920, F = '"Readex Pro", system-ui, sans-serif';
  await Promise.all([document.fonts.load(`600 60px ${F}`), document.fonts.load(`400 40px ${F}`)]).catch(() => {});
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.direction = 'rtl';
  // background
  const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#14213d'); g.addColorStop(1, '#0b1428');
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  x.strokeStyle = 'rgba(245,242,234,.06)'; x.lineWidth = 3;
  for (let r = 140; r < 1500; r += 140) { x.beginPath(); x.arc(W / 2, 1020, r, 0, Math.PI * 2); x.stroke(); }
  // logo
  try { const logo = await loadImg('/wordmark-light.svg'); x.drawImage(logo, W / 2 - 170, 150, 340, 174); } catch {}
  x.fillStyle = 'rgba(245,242,234,.7)'; x.font = `400 40px ${F}`; x.textAlign = 'center';
  x.fillText('المكان بيحكي', W / 2, 380);
  // card
  const cx = 90, cw = W - 180, cy = 500;
  const color = HEX[p.cat] || HEX.chat;
  x.font = `600 62px ${F}`;
  const lines = p.sealed ? [] : wrapLines(x, p.text, cw - 140, 9);
  const ch = p.sealed ? 640 : Math.max(520, 300 + lines.length * 92);
  x.fillStyle = '#f5f2ea'; roundRect(x, cx, cy, cw, ch, 48); x.fill();
  x.fillStyle = p.sealed ? '#fca311' : color; roundRect(x, cx + cw - 14, cy + 40, 14, ch - 80, 7); x.fill();
  // category pill
  const cat = p.sealed ? '🔒 رسالة مقفولة' : (state.me.categories[p.cat] || '');
  x.font = `600 38px ${F}`; x.textAlign = 'right';
  const pw = x.measureText(cat).width + 70;
  x.fillStyle = p.sealed ? 'rgba(252,163,17,.18)' : color + '22'; roundRect(x, cx + cw - 70 - pw, cy + 60, pw, 74, 37); x.fill();
  x.fillStyle = p.sealed ? '#b36b00' : color; x.fillText(cat, cx + cw - 105, cy + 111);
  x.fillStyle = '#14213d';
  if (p.sealed) {
    x.textAlign = 'center'; x.font = `400 150px ${F}`; x.fillText('🔒', W / 2, cy + 340);
    x.font = `600 56px ${F}`; x.fillText('في رسالة مقفولة هون…', W / 2, cy + 470);
    x.font = `400 42px ${F}`; x.fillStyle = '#6b7489'; x.fillText('ما بيقرأها إلا اللي بيوصل لمكانها', W / 2, cy + 550);
  } else {
    x.font = `600 62px ${F}`;
    lines.forEach((l, i) => x.fillText(l, cx + cw - 70, cy + 250 + i * 92));
  }
  // where / when
  x.textAlign = 'center'; x.fillStyle = 'rgba(245,242,234,.85)'; x.font = `400 40px ${F}`;
  const where = state.loc?.spot ? `📍 ${state.loc.name}` : '📍 مزروعة بمكانها';
  x.fillText(`${where}  ·  ⏳ بتختفي بعد ${leftText(p.left)}`, W / 2, cy + ch + 110);
  // call to action
  x.font = `600 54px ${F}`; x.fillStyle = '#f5f2ea';
  x.fillText('شو بيحكوا حواليك إنت؟', W / 2, H - 330);
  const bw = 560, bx = W / 2 - bw / 2, by = H - 270;
  x.fillStyle = '#fca311'; roundRect(x, bx, by, bw, 120, 60); x.fill();
  x.fillStyle = '#3d2600'; x.font = `700 52px ${F}`; x.fillText('حمّل هون', W / 2, by + 78);
  x.direction = 'ltr'; x.fillStyle = 'rgba(245,242,234,.6)'; x.font = `400 36px ${F}`; x.fillText('talk.alshaheed.ps', W / 2, H - 70);
  return c;
}
const SHARE_TEXT = 'شو بيحكوا حواليك؟ حمّل «هون» 📍 https://talk.alshaheed.ps';
let shareFile = null, shareData = '';
async function openShare(post) {
  $('#shareImg').removeAttribute('src');
  $('#shareNote').textContent = 'عم نجهّز الصورة…';
  showSheet('#shareSheet');
  try {
    const c = await makeCard(post);
    shareData = c.toDataURL('image/png');
    $('#shareImg').src = shareData; $('#shareSave').href = shareData;
    const blob = await new Promise((ok) => c.toBlob(ok, 'image/png'));
    shareFile = new File([blob], 'hon.png', { type: 'image/png' });
    const canShare = window.HonNative?.shareImage || navigator.canShare?.({ files: [shareFile] });
    $('#shareGo').hidden = !canShare;
    $('#shareNote').textContent = canShare ? 'جاهزة لستوري إنستغرام أو واتساب.' : 'احفظ الصورة وانشرها بستوري إنستغرام أو واتساب.';
  } catch { $('#shareNote').textContent = 'ما قدرنا نجهّز الصورة، جرّب مرة ثانية.'; }
}
$('#shareGo').addEventListener('click', async () => {
  try {
    if (window.HonNative?.shareImage) return window.HonNative.shareImage(shareData.split(',')[1], SHARE_TEXT);
    await navigator.share({ files: [shareFile], text: SHARE_TEXT });
  } catch (e) { if (e?.name !== 'AbortError') toast('ما زبطت المشاركة، احفظ الصورة بدلها'); }
});

/* ---------- me ---------- */
$('#meBtn').addEventListener('click', async () => {
  try { state.me = { ...state.me, ...(await api('/api/me')) }; } catch {}
  $('#meKarma').textContent = ar(state.me.karma);
  $('#mePosts').textContent = ar(state.me.livePosts);
  showSheet('#meSheet');
});
$('#clearBlocks').addEventListener('click', async () => {
  try { await api('/api/blocks/clear', { method: 'POST' }); closeSheet(); toast('ألغينا الحظر'); loadFeed({ silent: true }); } catch (e) { toast(e.message); }
});

/* ---------- start ---------- */
async function start() {
  try {
    state.me = await api('/api/me');
  } catch {
    $('#feed').innerHTML = '<div class="empty"><h3>ما في اتصال</h3><p>تأكد من الإنترنت وافتح التطبيق مرة ثانية.</p><button class="ghost" id="reloadBtn">إعادة المحاولة</button></div>';
    $('#reloadBtn').addEventListener('click', () => location.reload());
    return;
  }
  renderFilters();
  locate();
  registerPush();
  openFromLink();
  // keep the board fresh while the app is open
  setInterval(() => { if (document.visibilityState === 'visible' && !openSheet) refreshHere({ silent: true }); }, 30000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshHere({ silent: true }); });
}
start();

/* ---------- notifications (phone app only) ---------- */
// The app hands the page its Firebase token; the server uses it to tell you when someone replies.
function registerPush(tries = 0) {
  let token = '';
  try { token = window.HonNative?.pushToken?.() || ''; } catch {}
  if (!token) { if (window.HonNative && tries < 10) setTimeout(() => registerPush(tries + 1), 1500); return; }
  if (store.get('ftt.push') === token) return;
  api('/api/push/register', { method: 'POST', body: { token, platform: window.HonNative.platform?.() || 'android' } })
    .then(() => store.set('ftt.push', token)).catch(() => {});
}
// Tapping a notification opens /?post=123 → show that thread.
async function openFromLink() {
  const id = Number(new URLSearchParams(location.search).get('post'));
  if (!id) return;
  history.replaceState(null, '', '/');
  try {
    const q = state.loc ? `?lat=${state.loc.lat}&lng=${state.loc.lng}` : '';
    const d = await api(`/api/posts/${id}${q}`);
    openThread(d.post);
  } catch { toast('الرسالة اختفت'); }
}

if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
