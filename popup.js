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
  telegram: {
    enabled: false,
    token: '',
    chatId: '',
  },
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

// ── Skin Search Autocomplete ───────────────────────────────
let skinSearchTimer   = null;
let selectedSkinName  = '';   // only set when user picks from dropdown
let highlightedIdx    = -1;

const wlNameInput  = document.getElementById('wl-name');
const wlDropdown   = document.getElementById('wl-skin-dropdown');
const wlWrapper    = document.getElementById('wl-search-wrapper');

// Clear validated name whenever user types (forces re-selection)
wlNameInput.addEventListener('input', () => {
  selectedSkinName = '';
  highlightedIdx = -1;
  const q = wlNameInput.value.trim();
  clearTimeout(skinSearchTimer);
  if (q.length < 2) { closeDropdown(); return; }
  skinSearchTimer = setTimeout(() => searchSkins(q), 350);
});

// Keyboard navigation
wlNameInput.addEventListener('keydown', (e) => {
  const options = wlDropdown.querySelectorAll('.skin-option');
  if (!options.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    highlightedIdx = Math.min(highlightedIdx + 1, options.length - 1);
    updateHighlight(options);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    highlightedIdx = Math.max(highlightedIdx - 1, 0);
    updateHighlight(options);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (highlightedIdx >= 0 && options[highlightedIdx]) {
      options[highlightedIdx].click();
    }
  } else if (e.key === 'Escape') {
    closeDropdown();
  }
});

// Close dropdown when clicking outside
document.addEventListener('mousedown', (e) => {
  if (!wlWrapper.contains(e.target)) closeDropdown();
});

async function searchSkins(query) {
  wlWrapper.classList.add('loading');
  wlDropdown.classList.add('open');
  wlDropdown.innerHTML = '';

  try {
    const url = `https://tradeit.gg/api/v2/inventory/data?gameId=730&offset=0&limit=20&sortType=Popularity&searchValue=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'Referer': 'https://tradeit.gg/' }
    });
    if (!res.ok) throw new Error('API error');
    const json = await res.json();
    const items = json?.items ?? json?.data ?? [];

    // Deduplicate by name
    const seen = new Set();
    const unique = [];
    for (const it of items) {
      const n = it.name ?? '';
      if (n && !seen.has(n)) { seen.add(n); unique.push(it); }
    }

    if (unique.length === 0) {
      wlDropdown.innerHTML = `<div class="skin-no-results">No skins found for "${escHtml(query)}"</div>`;
    } else {
      highlightedIdx = -1;
      unique.forEach(item => {
        const div = document.createElement('div');
        div.className = 'skin-option';
        const imgSrc = item.imgURL ?? item.iconUrl ?? '';
        div.innerHTML = `
          ${imgSrc ? `<img class="skin-option-img" src="${escHtml(imgSrc)}" alt="" loading="lazy">` : '<div style="width:28px"></div>'}
          <span class="skin-option-name">${escHtml(item.name)}</span>
        `;
        div.addEventListener('mousedown', (e) => {
          e.preventDefault(); // prevent blur
          selectSkin(item.name);
        });
        wlDropdown.appendChild(div);
      });
    }
  } catch (_) {
    wlDropdown.innerHTML = `<div class="skin-no-results">Search failed. Try again.</div>`;
  } finally {
    wlWrapper.classList.remove('loading');
  }
}

function selectSkin(name) {
  selectedSkinName = name;
  wlNameInput.value = name;
  closeDropdown();
}

function closeDropdown() {
  wlDropdown.classList.remove('open');
  wlDropdown.innerHTML = '';
  highlightedIdx = -1;
}

function updateHighlight(options) {
  options.forEach((o, i) => o.classList.toggle('highlighted', i === highlightedIdx));
  if (highlightedIdx >= 0) options[highlightedIdx].scrollIntoView({ block: 'nearest' });
}

// ── Watchlist Add Button ────────────────────────────────────
document.getElementById('wl-add-btn').addEventListener('click', () => {
  const rawInput = wlNameInput.value.trim();
  const patterns = document.getElementById('wl-patterns').value.trim();
  const floatMin = document.getElementById('wl-float-min').value.trim();
  const floatMax = document.getElementById('wl-float-max').value.trim();

  // Must have a name
  if (!rawInput) { shakeInput('wl-name'); return; }

  // Must be a confirmed skin from the dropdown
  if (!selectedSkinName || selectedSkinName !== rawInput) {
    // Flash red to signal the user must pick from dropdown
    const el = document.getElementById('wl-name');
    el.style.borderColor = 'var(--red)';
    el.placeholder = 'Please select a skin from the search list ↑';
    setTimeout(() => {
      el.style.borderColor = '';
      el.placeholder = 'e.g. "Karambit | Fade"';
    }, 1800);
    return;
  }

  if (!settings.watchlist) settings.watchlist = [];

  // Prevent duplicate entries
  const alreadyExists = settings.watchlist.some(
    e => e.name.toLowerCase() === selectedSkinName.toLowerCase()
  );
  if (alreadyExists) {
    const el = document.getElementById('wl-name');
    el.style.borderColor = 'var(--accent)';
    setTimeout(() => el.style.borderColor = '', 1200);
    return;
  }

  settings.watchlist.push({ name: selectedSkinName, patterns, floatMin, floatMax });
  selectedSkinName = '';
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

  // Telegram
  const tg = settings.telegram ?? {};
  document.getElementById('s-tg-enabled').checked = tg.enabled === true;
  document.getElementById('tg-token').value  = tg.token  ?? '';
  document.getElementById('tg-chatid').value = tg.chatId ?? '';
  updateTgStatus();
}

// Toggle listeners (sounds & popup)
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

// ══════════════════════════════════════════════════════════
// TELEGRAM SETTINGS
// ══════════════════════════════════════════════════════════
function updateTgStatus() {
  const tg     = settings.telegram ?? {};
  const active = tg.enabled && tg.token && tg.chatId;
  const badge  = document.getElementById('tg-status');
  const fields = document.getElementById('tg-fields');
  if (badge) {
    badge.textContent = active ? '✅ Active' : 'Off';
    badge.className   = `tg-status ${active ? 'connected' : 'disconnected'}`;
  }
  if (fields) fields.classList.toggle('disabled', !tg.enabled);
}

document.getElementById('s-tg-enabled').addEventListener('change', (e) => {
  if (!settings.telegram) settings.telegram = {};
  settings.telegram.enabled = e.target.checked;
  updateTgStatus();
  saveSettings();
});

document.getElementById('tg-save-btn').addEventListener('click', () => {
  const token  = document.getElementById('tg-token').value.trim();
  const chatId = document.getElementById('tg-chatid').value.trim();
  const msg    = document.getElementById('tg-test-msg');

  if (!token || !chatId) {
    msg.textContent = '⚠️ Please fill in both fields.';
    msg.className = 'tg-test-msg err';
    return;
  }

  if (!settings.telegram) settings.telegram = {};
  settings.telegram.token  = token;
  settings.telegram.chatId = chatId;
  saveSettings();
  updateTgStatus();
  msg.textContent = '✅ Saved!';
  msg.className = 'tg-test-msg ok';
  setTimeout(() => { msg.textContent = 'Saved. Click Test to verify.'; msg.className = 'tg-test-msg'; }, 2000);
});

document.getElementById('tg-test-btn').addEventListener('click', async () => {
  const msg = document.getElementById('tg-test-msg');
  const tg  = settings.telegram ?? {};
  if (!tg.token || !tg.chatId) {
    msg.textContent = '⚠️ Save token & Chat ID first.';
    msg.className = 'tg-test-msg err';
    return;
  }
  msg.textContent = '⏳ Sending...';
  msg.className = 'tg-test-msg';

  try {
    const result = await chrome.runtime.sendMessage({ type: 'TG_TEST' });
    if (result?.ok) {
      msg.textContent = '✅ Message sent!';
      msg.className = 'tg-test-msg ok';
    } else {
      msg.textContent = `❌ ${result?.error ?? 'Failed'}`;
      msg.className = 'tg-test-msg err';
    }
  } catch (e) {
    msg.textContent = '❌ Background error.';
    msg.className = 'tg-test-msg err';
  }
  setTimeout(() => { msg.textContent = 'Ready.'; msg.className = 'tg-test-msg'; }, 4000);
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
