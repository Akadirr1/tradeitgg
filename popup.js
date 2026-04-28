// ============================================================
// popup.js — TradeIt Tracker Popup Controller
// ============================================================

'use strict';

// ── Tab Navigation ─────────────────────────────────────────
const tabs = document.querySelectorAll('.tab-btn');
const contents = document.querySelectorAll('.tab-content');

tabs.forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    tabs.forEach(t => t.classList.remove('active'));
    contents.forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`content-${target}`).classList.add('active');
    if (target === 'log') loadMatchLog();
  });
});

// ── State ──────────────────────────────────────────────────
let settings = {
  pollingInterval: 10,
  soundNormal: true,
  soundWatchlist: true,
  popupEnabled: true,
  watchlist: [],
  categoryMonitors: [],
};

// ── Initialize ─────────────────────────────────────────────
async function init() {
  const data = await chrome.storage.local.get('settings');
  if (data.settings) settings = data.settings;
  renderAll();
  loadDebugInfo();
}

function renderAll() {
  renderWatchlist();
  renderCategories();
  renderSettingsForm();
}

// ── Save helper ────────────────────────────────────────────
async function saveSettings() {
  await chrome.storage.local.set({ settings });
  // Tell background to re-setup alarm
  try {
    await chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED' });
  } catch (_) {}
}

// ══════════════════════════════════════════════════════════
// WATCHLIST TAB
// ══════════════════════════════════════════════════════════
function renderWatchlist() {
  const container = document.getElementById('watchlist-items');
  if (!container) return;
  container.innerHTML = '';

  if (!settings.watchlist || settings.watchlist.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⭐</div>No skins yet. Add one below.</div>`;
    return;
  }

  settings.watchlist.forEach((entry, idx) => {
    const el = document.createElement('div');
    el.className = 'watchlist-item';

    const floatStr = buildFloatStr(entry.floatMin, entry.floatMax);
    const patStr   = entry.patterns?.trim() ? `Pattern: ${entry.patterns}` : '';

    el.innerHTML = `
      <div class="watchlist-item-info">
        <div class="watchlist-item-name">★ ${escHtml(entry.name)}</div>
        <div class="watchlist-item-meta">
          ${patStr   ? `<span><span class="meta-label">Pattern:</span><span class="meta-val">${escHtml(entry.patterns)}</span></span>` : ''}
          ${floatStr ? `<span><span class="meta-label">Float:</span><span class="meta-val">${floatStr}</span></span>` : ''}
        </div>
      </div>
      <button class="btn btn-danger btn-sm" data-idx="${idx}" data-type="wl">✕</button>
    `;
    container.appendChild(el);
  });

  container.querySelectorAll('[data-type="wl"]').forEach(btn => {
    btn.addEventListener('click', () => {
      settings.watchlist.splice(Number(btn.dataset.idx), 1);
      saveSettings();
      renderWatchlist();
    });
  });
}

document.getElementById('wl-add-btn').addEventListener('click', () => {
  const name     = document.getElementById('wl-name').value.trim();
  const patterns = document.getElementById('wl-patterns').value.trim();
  const floatMin = document.getElementById('wl-float-min').value.trim();
  const floatMax = document.getElementById('wl-float-max').value.trim();

  if (!name) { shakeInput('wl-name'); return; }

  if (!settings.watchlist) settings.watchlist = [];
  settings.watchlist.push({ name, patterns, floatMin, floatMax });
  saveSettings();
  renderWatchlist();

  // Clear inputs
  ['wl-name', 'wl-patterns', 'wl-float-min', 'wl-float-max'].forEach(id => {
    document.getElementById(id).value = '';
  });
});

// ══════════════════════════════════════════════════════════
// CATEGORIES TAB
// ══════════════════════════════════════════════════════════
function renderCategories() {
  const container = document.getElementById('category-items');
  if (!container) return;
  container.innerHTML = '';

  if (!settings.categoryMonitors || settings.categoryMonitors.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📂</div>No categories monitored yet.</div>`;
    return;
  }

  settings.categoryMonitors.forEach((entry, idx) => {
    const el = document.createElement('div');
    el.className = 'watchlist-item';
    const floatStr = buildFloatStr(entry.floatMin, entry.floatMax);

    el.innerHTML = `
      <div class="watchlist-item-info">
        <div class="watchlist-item-name">📂 ${escHtml(entry.weapon)}</div>
        <div class="watchlist-item-meta">
          ${entry.patterns?.trim() ? `<span><span class="meta-label">Pattern:</span><span class="meta-val">${escHtml(entry.patterns)}</span></span>` : ''}
          ${floatStr ? `<span><span class="meta-label">Float:</span><span class="meta-val">${floatStr}</span></span>` : ''}
        </div>
      </div>
      <button class="btn btn-danger btn-sm" data-idx="${idx}" data-type="cat">✕</button>
    `;
    container.appendChild(el);
  });

  container.querySelectorAll('[data-type="cat"]').forEach(btn => {
    btn.addEventListener('click', () => {
      settings.categoryMonitors.splice(Number(btn.dataset.idx), 1);
      saveSettings();
      renderCategories();
    });
  });
}

document.getElementById('cat-add-btn').addEventListener('click', () => {
  const weapon   = document.getElementById('cat-weapon').value;
  const patterns = document.getElementById('cat-patterns').value.trim();
  const floatMin = document.getElementById('cat-float-min').value.trim();
  const floatMax = document.getElementById('cat-float-max').value.trim();

  if (!weapon) { shakeInput('cat-weapon'); return; }

  if (!settings.categoryMonitors) settings.categoryMonitors = [];
  settings.categoryMonitors.push({ weapon, patterns, floatMin, floatMax });
  saveSettings();
  renderCategories();

  document.getElementById('cat-weapon').value = '';
  ['cat-patterns', 'cat-float-min', 'cat-float-max'].forEach(id => {
    document.getElementById(id).value = '';
  });
});

// ══════════════════════════════════════════════════════════
// SETTINGS TAB
// ══════════════════════════════════════════════════════════
function renderSettingsForm() {
  document.getElementById('s-sound-normal').checked    = settings.soundNormal !== false;
  document.getElementById('s-sound-watchlist').checked = settings.soundWatchlist !== false;
  document.getElementById('s-popup').checked           = settings.popupEnabled !== false;

  // Interval buttons
  document.querySelectorAll('.interval-btn').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.val) === settings.pollingInterval);
  });
}

// Toggle listeners
['s-sound-normal', 's-sound-watchlist', 's-popup'].forEach(id => {
  document.getElementById(id).addEventListener('change', (e) => {
    const map = {
      's-sound-normal':    'soundNormal',
      's-sound-watchlist': 'soundWatchlist',
      's-popup':           'popupEnabled',
    };
    settings[map[id]] = e.target.checked;
    saveSettings();
  });
});

// Interval buttons
document.getElementById('interval-group').addEventListener('click', (e) => {
  const btn = e.target.closest('.interval-btn');
  if (!btn) return;
  settings.pollingInterval = Number(btn.dataset.val);
  saveSettings();
  document.querySelectorAll('.interval-btn').forEach(b =>
    b.classList.toggle('active', b === btn)
  );
});

// Poll now
document.getElementById('poll-now-btn').addEventListener('click', async () => {
  const btn = document.getElementById('poll-now-btn');
  btn.textContent = '⏳ Polling...';
  btn.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: 'POLL_NOW' });
    btn.textContent = '✅ Done!';
  } catch (_) {
    btn.textContent = '❌ Error';
  }
  setTimeout(() => {
    btn.textContent = '▶ Poll Now';
    btn.disabled = false;
    loadDebugInfo();
  }, 1500);
});

// Status pill
document.getElementById('status-pill').addEventListener('click', () => {
  document.getElementById('poll-now-btn')?.click();
});

async function loadDebugInfo() {
  try {
    const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    document.getElementById('debug-info').innerHTML = `
      Initialized: ${status.isInitialized ? '✅ Yes' : '⏳ No'}<br>
      Items seen: ${status.seenCount}<br>
      Backoff delay: ${status.backoffDelay}s<br>
      Recent matches: ${status.matchCount}<br>
      Polling every: ${settings.pollingInterval}s
    `;
    document.getElementById('footer-stat').textContent =
      `${status.seenCount} items tracked`;
  } catch (_) {
    document.getElementById('debug-info').textContent = 'Background service not responding.';
  }
}

// ══════════════════════════════════════════════════════════
// MATCH LOG TAB
// ══════════════════════════════════════════════════════════
async function loadMatchLog() {
  const { recentMatches } = await chrome.storage.local.get('recentMatches');
  const log = document.getElementById('match-log');
  if (!log) return;

  const matches = recentMatches ?? [];
  if (matches.length === 0) {
    log.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📭</div>No matches yet.</div>`;
    return;
  }

  log.innerHTML = '';
  for (const m of matches) {
    const a = document.createElement('a');
    a.className = 'match-item';
    a.href = m.tradeUrl;
    a.target = '_blank';

    const price   = m.price ? `$${(m.price / 100).toFixed(2)}` : 'N/A';
    const float   = m.floatValue !== null && m.floatValue !== undefined ? m.floatValue.toFixed(4) : 'N/A';
    const pattern = m.patternIndex !== null && m.patternIndex !== undefined ? m.patternIndex : 'N/A';
    const when    = timeAgo(m.timestamp);

    a.innerHTML = `
      <div class="match-star">★</div>
      <div class="match-info">
        <div class="match-name">${escHtml(m.name)}</div>
        <div class="match-meta">
          <span class="match-price">${price}</span>
          <span>Float: ${float}</span>
          <span>Pat: ${pattern}</span>
          <span class="match-time">${when}</span>
        </div>
      </div>
    `;
    log.appendChild(a);
  }
}

// ── Helpers ────────────────────────────────────────────────
function buildFloatStr(min, max) {
  if ((!min || min === '') && (!max || max === '')) return '';
  const lo = min || '0';
  const hi = max || '1';
  return `${lo}–${hi}`;
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shakeInput(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.borderColor = 'var(--red)';
  el.style.animation = 'none';
  setTimeout(() => el.style.borderColor = '', 800);
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60)   return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ── Boot ───────────────────────────────────────────────────
init();
