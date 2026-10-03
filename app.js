'use strict';

const SAVED = 'saved'; // pseudo day id of the "Saved" tab
const $ = (sel) => document.querySelector(sel);
const main = $('#main');
const daysNav = $('#days');
const sheet = $('#sheet');
const info = $('#info');
const searchInput = $('#search');

let data = null;
let sessions = new Map(); // id -> session, extended with date/day/roomName
let current = null; // selected day date, or SAVED
let query = '';
let favs = new Set(load('goatmire.favs', []));
let notes = load('goatmire.notes', {});

function load(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private mode / quota: favourites just won't persist
  }
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const linkify = (s) =>
  esc(s).replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)]/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);

const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const startMin = (s) => toMin(s.start);
const endMin = (s) => (toMin(s.end) <= toMin(s.start) ? toMin(s.end) + 1440 : toMin(s.end));

function fmtDate(date, opts) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { timeZone: 'UTC', ...opts });
}

function fmtDuration(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return [h && `${h} h`, m && `${m} min`].filter(Boolean).join(' ');
}

// Current date and minute of day in conference time, whatever the device timezone is.
// ?now=2026-09-30T10:20 overrides it for testing.
const debugNow = new URLSearchParams(location.search).get('now');
function now() {
  const s =
    debugNow ||
    new Intl.DateTimeFormat('sv-SE', {
      timeZone: data.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date());
  return { date: s.slice(0, 10), min: toMin(s.slice(11, 16)) };
}

function phase(s, t = now()) {
  if (s.date < t.date || (s.date === t.date && endMin(s) <= t.min)) return 'past';
  if (s.date === t.date && startMin(s) <= t.min) return 'live';
  return '';
}

const speakerNames = (s) => s.speakers.map((id) => data.speakers[id]?.name).filter(Boolean).join(', ');
const isSaved = (s) => favs.has(s.id) || Boolean(notes[s.id]);

function setData(next) {
  data = next;
  sessions = new Map();
  for (const day of data.days) {
    const rooms = Object.fromEntries(day.rooms.map((r) => [r.id, r.name]));
    for (const s of day.sessions) {
      sessions.set(s.id, { ...s, date: day.date, roomName: rooms[s.room] || '' });
    }
  }
}

/* ---------- day tabs ---------- */

function renderTabs() {
  const today = now().date;
  const tabs = data.days.map(
    (d) => `
    <button role="tab" data-day="${d.date}" aria-selected="${!query && current === d.date}" class="${d.date === today ? 'today' : ''}">
      <span class="dow">${fmtDate(d.date, { weekday: 'short' })} ${fmtDate(d.date, { day: 'numeric' })}</span>
      <span class="label">${esc(d.label || '')}</span>
    </button>`,
  );
  const count = [...sessions.values()].filter(isSaved).length;
  tabs.push(`
    <button role="tab" data-day="${SAVED}" aria-selected="${!query && current === SAVED}">
      <span class="dow">★ Saved</span>
      <span class="label">${count || ''}</span>
    </button>`);
  daysNav.innerHTML = tabs.join('');
  daysNav.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
}

/* ---------- timetable ---------- */

function renderGrid(day) {
  const list = day.sessions.map((s) => sessions.get(s.id));
  const from = Math.floor(Math.min(...list.map(startMin)) / 60) * 60;
  const to = Math.ceil(Math.max(...list.map(endMin)) / 60) * 60;
  // scale the day so that its shortest session still fits one line of text
  const shortest = Math.min(...list.map((s) => endMin(s) - startMin(s)));
  const ppm = Math.min(3, Math.max(1.2, 30 / shortest));
  const t = now();

  const hours = [];
  for (let m = from; m <= to; m += 60) {
    hours.push(`<span style="top:${(m - from) * ppm}px">${String((m / 60) % 24).padStart(2, '0')}:00</span>`);
  }

  const cols = day.rooms.map((room) => {
    const blocks = list
      .filter((s) => s.room === room.id)
      .map((s) => {
        const height = (endMin(s) - startMin(s)) * ppm;
        const cls = ['s', s.service && 'service', favs.has(s.id) && 'fav', notes[s.id] && 'noted', phase(s, t), height < 50 && 'compact']
          .filter(Boolean)
          .join(' ');
        return `
        <button class="${cls}" data-id="${s.id}" style="top:${(startMin(s) - from) * ppm}px;height:${height}px">
          <span class="time">${s.start}–${s.end}</span>
          <span class="title">${esc(s.title)}</span>
          <span class="who">${esc(speakerNames(s))}</span>
        </button>`;
      });
    return `<div class="col">${blocks.join('')}</div>`;
  });

  main.innerHTML = `
    <div class="tt" style="--cols:${day.rooms.length};--hour:${60 * ppm}px" data-from="${from}" data-to="${to}" data-ppm="${ppm}">
      <div class="tt-head">
        <div class="corner"></div>
        ${day.rooms.map((r) => `<div class="room">${esc(r.name)}</div>`).join('')}
      </div>
      <div class="tt-body" style="height:${(to - from) * ppm}px">
        <div class="hours">${hours.join('')}</div>
        ${cols.join('')}
        <div class="nowline" hidden></div>
      </div>
    </div>`;
}

// Position of the current time inside the visible grid, or null if it is another day / outside
function nowOffset() {
  const tt = main.querySelector('.tt');
  if (!tt) return null;
  const t = now();
  const { from, to, ppm } = tt.dataset;
  if (t.date !== current || t.min < from || t.min > to) return null;
  return (t.min - from) * ppm;
}

function updateNow() {
  const offset = nowOffset();
  const line = main.querySelector('.nowline');
  if (line) {
    line.hidden = offset === null;
    line.style.top = `${offset}px`;
    line.dataset.time = `${String(Math.floor(now().min / 60)).padStart(2, '0')}:${String(now().min % 60).padStart(2, '0')}`;
  }
  $('#now-btn').hidden = offset === null;
  const t = now();
  main.querySelectorAll('[data-id]').forEach((el) => {
    const p = phase(sessions.get(el.dataset.id), t);
    el.classList.toggle('past', p === 'past');
    el.classList.toggle('live', p === 'live');
  });
}

function scrollToNow(smooth) {
  const offset = nowOffset();
  if (offset === null) return;
  main.scrollTo({ top: Math.max(0, offset - main.clientHeight / 3), behavior: smooth ? 'smooth' : 'auto' });
}

/* ---------- lists (saved, search) ---------- */

function renderList(list, emptyText) {
  if (!list.length) {
    main.innerHTML = `<p class="empty">${emptyText}</p>`;
    return;
  }
  const t = now();
  const html = [];
  for (const day of data.days) {
    const items = list.filter((s) => s.date === day.date).sort((a, b) => startMin(a) - startMin(b));
    if (!items.length) continue;
    const label = day.label ? ` · ${esc(day.label)}` : '';
    html.push(`<h2 class="list-day">${fmtDate(day.date, { weekday: 'long', day: 'numeric', month: 'long' })}${label}</h2>`);
    for (const s of items) {
      const cls = ['item', s.service && 'service', favs.has(s.id) && 'fav', phase(s, t)].filter(Boolean).join(' ');
      html.push(`
        <button class="${cls}" data-id="${s.id}">
          <span class="time">${s.start}<br>${s.end}</span>
          <span class="body">
            <span class="title">${esc(s.title)}</span>
            <span class="who">${esc([speakerNames(s), s.roomName].filter(Boolean).join(' · '))}</span>
            ${notes[s.id] ? `<span class="note">${esc(notes[s.id])}</span>` : ''}
          </span>
          <span class="star" aria-hidden="true">★</span>
        </button>`);
    }
  }
  main.innerHTML = `<div class="list">${html.join('')}</div>`;
}

function matches(s, q) {
  const haystack = [s.title, s.description, s.roomName, ...s.tags, ...s.speakers.map((id) => `${data.speakers[id]?.name} ${data.speakers[id]?.tagline}`)]
    .join(' ')
    .toLowerCase();
  return q.split(/\s+/).every((word) => haystack.includes(word));
}

function render() {
  renderTabs();
  if (query) {
    renderList([...sessions.values()].filter((s) => matches(s, query)), 'No matches.');
  } else if (current === SAVED) {
    renderList([...sessions.values()].filter(isSaved), 'Nothing saved yet.<br>Open a session and tap ☆ Save, or add a note.');
  } else {
    renderGrid(data.days.find((d) => d.date === current) || data.days[0]);
  }
  updateNow();
}

function selectDay(day) {
  current = day;
  query = searchInput.value = '';
  $('#search-bar').hidden = true;
  $('#search-btn').setAttribute('aria-expanded', false);
  render();
  main.scrollTo(0, 0);
  scrollToNow(false);
}

/* ---------- session details ---------- */

function openSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  const speakers = s.speakers
    .map((sid) => data.speakers[sid])
    .filter(Boolean)
    .map(
      (sp) => `
      <article class="speaker">
        ${sp.photo ? `<img src="${esc(sp.photo)}" alt="" loading="lazy" width="72" height="72">` : ''}
        <div>
          <h3>${esc(sp.name)}</h3>
          ${sp.tagline ? `<p class="tagline">${esc(sp.tagline)}</p>` : ''}
        </div>
        ${sp.bio ? `<p class="bio">${linkify(sp.bio)}</p>` : ''}
      </article>`,
    )
    .join('');
  const day = data.days.find((d) => d.date === s.date);
  const kind = s.service ? [] : [day.label, ...s.tags].filter(Boolean);

  sheet.dataset.id = id;
  sheet.innerHTML = `
    <div class="sheet-bar">
      <div class="chips">${kind.map((k) => `<span>${esc(k)}</span>`).join('')}</div>
      <button class="icon-btn" data-close aria-label="Close">✕</button>
    </div>
    <h2 tabindex="-1" autofocus>${esc(s.title)}</h2>
    <p class="meta">
      ${fmtDate(s.date, { weekday: 'long', day: 'numeric', month: 'long' })}<br>
      ${s.start}–${s.end} <span class="dim">(${fmtDuration(endMin(s) - startMin(s))})</span>${s.roomName ? ` · ${esc(s.roomName)}` : ''}
    </p>
    <button class="fav-btn" data-fav aria-pressed="${favs.has(id)}"></button>
    ${s.description ? `<p class="desc">${linkify(s.description)}</p>` : ''}
    ${speakers ? `<section class="speakers">${speakers}</section>` : ''}
    <label class="notes">My notes
      <textarea rows="3" placeholder="Only stored on this device">${esc(notes[id] || '')}</textarea>
    </label>
    ${s.url ? `<p class="more"><a href="${esc(s.url)}" target="_blank" rel="noopener">Open on goatmire.com ↗</a></p>` : ''}`;
  showSheet(sheet);
  sheet.scrollTop = 0;
}

function toggleFav(id) {
  favs.has(id) ? favs.delete(id) : favs.add(id);
  store('goatmire.favs', [...favs]);
  sheet.querySelector('[data-fav]')?.setAttribute('aria-pressed', favs.has(id));
}

function openInfo() {
  const updated = new Date(data.updated).toLocaleString('en-GB', { timeZone: data.timezone, dateStyle: 'medium', timeStyle: 'short' });
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  info.innerHTML = `
    <div class="sheet-bar">
      <div class="chips"></div>
      <button class="icon-btn" data-close aria-label="Close">✕</button>
    </div>
    <h2 tabindex="-1" autofocus>${esc(data.event)}</h2>
    <p class="desc">All times are local to Varberg, Sweden (${esc(data.timezone)}), whatever your device is set to.

Tap a session for its description and speakers. ☆ Save puts it on your Saved list; notes and saved sessions never leave this device.</p>
    ${
      standalone
        ? ''
        : `<p class="desc"><strong>Install:</strong> on iPhone/iPad open this page in Safari, tap Share, then “Add to Home Screen”. In Chrome or Edge use “Install app” / “Add to Home screen” from the browser menu.</p>`
    }
    <p class="meta">
      Schedule as of ${updated}<br>
      <span id="offline-state">${navigator.onLine ? 'Checking offline copy…' : 'You are offline.'}</span>
    </p>
    <p class="more"><a href="${esc(data.site)}/schedule" target="_blank" rel="noopener">Official schedule on goatmire.com ↗</a></p>`;
  showSheet(info);
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.ready.then(() => {
      const el = $('#offline-state');
      if (el) el.textContent = '✓ Stored on this device, works offline.';
    });
  } else {
    $('#offline-state').textContent = 'This browser does not support offline use.';
  }
}

// Sheets push a history entry so the back button / back swipe closes them
function showSheet(dialog) {
  if (dialog.open) return;
  dialog.showModal();
  history.pushState({ sheet: true }, '');
}

for (const dialog of [sheet, info]) {
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog || e.target.closest('[data-close]')) dialog.close();
    else if (e.target.closest('[data-fav]')) toggleFav(dialog.dataset.id);
  });
  dialog.addEventListener('close', () => {
    if (history.state?.sheet) history.back();
    if (dialog === sheet) {
      const top = main.scrollTop;
      render();
      main.scrollTop = top;
    }
  });
}

sheet.addEventListener('input', (e) => {
  if (e.target.tagName !== 'TEXTAREA') return;
  const text = e.target.value.trim();
  if (text) notes[sheet.dataset.id] = text;
  else delete notes[sheet.dataset.id];
  store('goatmire.notes', notes);
});

window.addEventListener('popstate', () => {
  for (const dialog of [sheet, info]) if (dialog.open) dialog.close();
});

/* ---------- wiring ---------- */

main.addEventListener('click', (e) => {
  const el = e.target.closest('[data-id]');
  if (el) openSession(el.dataset.id);
});

daysNav.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-day]');
  if (tab) selectDay(tab.dataset.day);
});

$('#search-btn').addEventListener('click', () => {
  const bar = $('#search-bar');
  bar.hidden = !bar.hidden;
  $('#search-btn').setAttribute('aria-expanded', !bar.hidden);
  if (bar.hidden) {
    if (query) selectDay(current);
  } else {
    searchInput.focus();
  }
});

searchInput.addEventListener('input', () => {
  query = searchInput.value.trim().toLowerCase();
  render();
  main.scrollTo(0, 0);
});

$('#now-btn').addEventListener('click', () => scrollToNow(true));
$('#info-btn').addEventListener('click', openInfo);

async function fetchData() {
  const res = await fetch('data/schedule.json');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function start() {
  try {
    setData(await fetchData());
  } catch (err) {
    main.innerHTML = `<p class="empty">Could not load the schedule.<br>${esc(err.message)}</p>`;
    return;
  }
  const today = now().date;
  const dates = data.days.map((d) => d.date);
  selectDay(dates.includes(today) ? today : today > dates.at(-1) ? dates.at(-1) : dates[0]);

  setInterval(updateNow, 30_000);
  // iOS resumes installed apps without reloading, so ask the worker to check for a new schedule
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    updateNow();
    fetchData().catch(() => {});
  });
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js');
  // the worker refreshes the schedule in the background and tells us when it changed
  navigator.serviceWorker.addEventListener('message', async (e) => {
    if (e.data !== 'schedule-updated' || !data) return;
    setData(await fetchData());
    if (!sheet.open) render();
  });
}

start();
