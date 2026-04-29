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
    if (target === 'latest') loadLatestLog();
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
  stickerMonitors: [],
  telegram: {
    enabled: false,
    token: '',
    chatId: '',
  },
};

// ── Activation State ─────────────────────────────────────────
let activationState = { isActive: false, apiKey: '', deviceId: '' };
const BACKEND_URL = 'http://localhost:3000'; // Default to localhost

function generateUUID() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

async function checkActivation() {
  const data = await chrome.storage.local.get('activationState');
  if (data.activationState) {
    activationState = data.activationState;
  }
  
  if (!activationState.deviceId) {
    activationState.deviceId = generateUUID();
    await chrome.storage.local.set({ activationState });
  }

  const screen = document.getElementById('activation-screen');
  if (activationState.isActive) {
    screen.style.display = 'none';
  } else {
    screen.style.display = 'flex';
  }
}

document.getElementById('activate-btn').addEventListener('click', async () => {
  const apiKey = document.getElementById('api-key-input').value.trim();
  const errorEl = document.getElementById('activation-error');
  const btn = document.getElementById('activate-btn');
  
  if (!apiKey) {
    errorEl.textContent = 'API Anahtarı boş olamaz.';
    errorEl.style.display = 'block';
    return;
  }

  btn.textContent = 'Doğrulanıyor...';
  btn.disabled = true;
  errorEl.style.display = 'none';

  try {
    const res = await fetch(`${BACKEND_URL}/api/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey, deviceId: activationState.deviceId })
    });
    
    const data = await res.json();
    
    if (res.ok && data.success) {
      activationState.isActive = true;
      activationState.apiKey = apiKey;
      await chrome.storage.local.set({ activationState });
      document.getElementById('activation-screen').style.display = 'none';
      // Signal background to start polling if it was waiting
      chrome.runtime.sendMessage({ type: 'ACTIVATION_SUCCESS' });
    } else {
      errorEl.textContent = data.error || 'Doğrulama başarısız.';
      errorEl.style.display = 'block';
    }
  } catch (err) {
    errorEl.textContent = 'Sunucuya bağlanılamadı. Lütfen internetinizi kontrol edin.';
    errorEl.style.display = 'block';
  } finally {
    btn.textContent = 'Aktifleştir';
    btn.disabled = false;
  }
});

// ── Initialize ─────────────────────────────────────────────
async function init() {
  await checkActivation();
  const data = await chrome.storage.local.get('settings');
  if (data.settings) settings = data.settings;
  initModeToggleHandlers();
  renderAll();
  loadDebugInfo();
}

function renderAll() {
  renderWatchlist();
  renderCategories();
  renderStickers();
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

    const isPatMode = entry.filterMode === 'pattern';
    const floatStr  = isPatMode ? '' : buildFloatStr(entry.floatMin, entry.floatMax);
    const patStr    = entry.patterns?.trim() ? entry.patterns : '';
    const stickerStr = entry.minStickerValue ? `$${entry.minStickerValue}+` : '';
    const modeBadge = isPatMode
      ? `<span style="background:rgba(232,184,75,0.15);color:var(--accent);border-radius:4px;padding:1px 5px;font-size:9px;font-weight:700">PATTERN</span>`
      : `<span style="background:rgba(63,185,80,0.12);color:var(--green);border-radius:4px;padding:1px 5px;font-size:9px;font-weight:700">FLOAT</span>`;

    el.innerHTML = `
      <div class="watchlist-item-info">
        <div class="watchlist-item-name">★ ${escHtml(entry.name)} ${modeBadge}</div>
        <div class="watchlist-item-meta">
          ${patStr   ? `<span><span class="meta-label">Pattern:</span><span class="meta-val">${escHtml(patStr)}</span></span>` : ''}
          ${floatStr ? `<span><span class="meta-label">Float:</span><span class="meta-val">${floatStr}</span></span>` : ''}
          ${stickerStr ? `<span><span class="meta-label">Stickers:</span><span class="meta-val">${stickerStr}</span></span>` : ''}
          ${isPatMode && !patStr ? `<span style="color:var(--red);font-size:9px">⚠️ Pattern girilmemiş</span>` : ''}
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

// ── Filter Mode State ──────────────────────────────────────
let wlFilterMode  = 'float';   // 'float' | 'pattern'
let catFilterMode = 'float';

const WL_MODE_HINTS = {
  float:   'Float Range: Takip etmek istediğin aşınma aralığını gir. Pattern boş kalırsa tüm pattern\'lar kabul edilir.',
  pattern: 'Pattern Only: Girdiğin pattern numaralarına sahip skin, hangi aşınma durumunda olursa olsun takip edilir. Aramadan herhangi bir aşınmayı seçebilirsin — aşınma suffix\'i otomatik silinir.',
};

function applyWlMode(mode) {
  wlFilterMode = mode;
  const floatBtn    = document.getElementById('wl-mode-float');
  const patBtn      = document.getElementById('wl-mode-pattern');
  const floatFields = document.getElementById('wl-float-fields');
  const patFields   = document.getElementById('wl-pattern-fields');
  const hint        = document.getElementById('wl-mode-hint');
  floatBtn.className = 'filter-mode-btn' + (mode === 'float' ? ' active-float' : '');
  patBtn.className   = 'filter-mode-btn' + (mode === 'pattern' ? ' active-pattern' : '');
  floatFields.style.display = mode === 'float'   ? '' : 'none';
  patFields.style.display   = mode === 'pattern' ? '' : 'none';
  if (hint) hint.textContent = WL_MODE_HINTS[mode];
}

function applyCatMode(mode) {
  catFilterMode = mode;
  const floatBtn    = document.getElementById('cat-mode-float');
  const patBtn      = document.getElementById('cat-mode-pattern');
  const floatFields = document.getElementById('cat-float-fields');
  const patFields   = document.getElementById('cat-pattern-fields');
  const hint        = document.getElementById('cat-mode-hint');
  floatBtn.className = 'filter-mode-btn' + (mode === 'float' ? ' active-float' : '');
  patBtn.className   = 'filter-mode-btn' + (mode === 'pattern' ? ' active-pattern' : '');
  floatFields.style.display = mode === 'float'   ? '' : 'none';
  patFields.style.display   = mode === 'pattern' ? '' : 'none';
  if (hint) hint.textContent = WL_MODE_HINTS[mode];
}

function initModeToggleHandlers() {
  document.getElementById('wl-mode-float').addEventListener('click',    () => applyWlMode('float'));
  document.getElementById('wl-mode-pattern').addEventListener('click',  () => applyWlMode('pattern'));
  document.getElementById('cat-mode-float').addEventListener('click',   () => applyCatMode('float'));
  document.getElementById('cat-mode-pattern').addEventListener('click', () => applyCatMode('pattern'));
}

// ── Skin Search Autocomplete ───────────────────────────────
let skinSearchTimer   = null;
let selectedSkinName  = '';   // only set when user picks from dropdown
let highlightedIdx    = -1;

function setupAutocomplete(inputId, wrapperId, dropdownId) {
  const nameInput  = document.getElementById(inputId);
  const dropdown   = document.getElementById(dropdownId);
  const wrapper    = document.getElementById(wrapperId);

  nameInput.addEventListener('input', () => {
    selectedSkinName = '';
    highlightedIdx = -1;
    const q = nameInput.value.trim();
    clearTimeout(skinSearchTimer);
    if (q.length < 2) { closeDropdown(dropdown); return; }
    skinSearchTimer = setTimeout(() => searchSkins(q, wrapper, dropdown, nameInput), 350);
  });

  nameInput.addEventListener('keydown', (e) => {
    const options = dropdown.querySelectorAll('.skin-option');
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
      closeDropdown(dropdown);
    }
  });

  document.addEventListener('mousedown', (e) => {
    if (!wrapper.contains(e.target)) closeDropdown(dropdown);
  });
}

setupAutocomplete('wl-name', 'wl-search-wrapper', 'wl-skin-dropdown');
setupAutocomplete('st-name', 'st-search-wrapper', 'st-skin-dropdown');

async function searchSkins(query, wrapper, dropdown, inputEl) {
  wrapper.classList.add('loading');
  dropdown.classList.add('open');
  dropdown.innerHTML = '';

  try {
    const url = `https://tradeit.gg/api/v2/inventory/data?gameId=730&offset=0&limit=20&sortType=Popularity&searchValue=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'Referer': 'https://tradeit.gg/' }
    });
    if (!res.ok) throw new Error('API error');
    const json = await res.json();
    const items = json?.items ?? json?.data ?? [];

    const seen = new Set();
    const unique = [];
    for (const it of items) {
      const originalName = it.name ?? '';
      if (!originalName) continue;

      const baseName = stripWear(originalName);
      
      // Eğer item bir silah skiniyse (aşınma durumu varsa), 5 varyasyonunu da üret
      if (baseName !== originalName) {
        const WEARS = ['(Factory New)', '(Minimal Wear)', '(Field-Tested)', '(Well-Worn)', '(Battle-Scarred)'];
        for (const w of WEARS) {
          const generatedName = `${baseName} ${w}`;
          if (!seen.has(generatedName)) {
            seen.add(generatedName);
            // Sadece ismini değiştirerek listeye ekliyoruz, ikon vs. aynı kalacak
            unique.push({ ...it, name: generatedName });
          }
        }
      } else {
        // Silah değilse (Sticker, Ajan vs.) veya suffix'i yoksa direkt ekle
        if (!seen.has(originalName)) {
          seen.add(originalName);
          unique.push(it);
        }
      }
    }

    if (unique.length === 0) {
      dropdown.innerHTML = `<div class="skin-no-results">No skins found for "${escHtml(query)}"</div>`;
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
          e.preventDefault();
          selectSkin(item.name, inputEl, dropdown);
        });
        dropdown.appendChild(div);
      });
    }
  } catch (_) {
    dropdown.innerHTML = `<div class="skin-no-results">Search failed. Try again.</div>`;
  } finally {
    wrapper.classList.remove('loading');
  }
}

function selectSkin(name, inputEl, dropdown) {
  selectedSkinName = name;
  inputEl.value = name;
  closeDropdown(dropdown);
}

function closeDropdown(dropdown) {
  dropdown.classList.remove('open');
  dropdown.innerHTML = '';
  highlightedIdx = -1;
}

function updateHighlight(options) {
  options.forEach((o, i) => o.classList.toggle('highlighted', i === highlightedIdx));
  if (highlightedIdx >= 0) options[highlightedIdx].scrollIntoView({ block: 'nearest' });
}

// ── Watchlist Add Button ────────────────────────────────────
document.getElementById('wl-add-btn').addEventListener('click', () => {
  const rawInput = document.getElementById('wl-name').value.trim();

  // Must have a name
  if (!rawInput) { shakeInput('wl-name'); return; }



  // Collect fields based on active mode
  let patterns = '', floatMin = '', floatMax = '';
  if (wlFilterMode === 'pattern') {
    patterns = document.getElementById('wl-patterns-only').value.trim();
    if (!patterns) { shakeInput('wl-patterns-only'); return; } // Pattern zorunlu
  } else {
    floatMin = document.getElementById('wl-float-min').value.trim();
    floatMax = document.getElementById('wl-float-max').value.trim();
    patterns = document.getElementById('wl-patterns').value.trim();
  }
  
  const minStickerValue = document.getElementById('wl-sticker-val').value.trim();

  // Pattern modunda aşınma suffix'ini temizle → tüm wear'ları kapsar
  const nameToSave = wlFilterMode === 'pattern'
    ? stripWear(rawInput)
    : rawInput;

  if (!settings.watchlist) settings.watchlist = [];

  // Prevent duplicate entries (compare stripped names)
  const alreadyExists = settings.watchlist.some(
    e => stripWear(e.name).toLowerCase() === nameToSave.toLowerCase()
  );
  if (alreadyExists) {
    const el = document.getElementById('wl-name');
    el.style.borderColor = 'var(--accent)';
    setTimeout(() => el.style.borderColor = '', 1200);
    return;
  }

  settings.watchlist.push({ name: nameToSave, patterns, floatMin, floatMax, filterMode: wlFilterMode, minStickerValue });
  selectedSkinName = '';
  saveSettings();
  renderWatchlist();

  // Clear inputs
  ['wl-name', 'wl-patterns', 'wl-patterns-only', 'wl-float-min', 'wl-float-max', 'wl-sticker-val'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
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
    const isPatMode = entry.filterMode === 'pattern';
    const floatStr  = isPatMode ? '' : buildFloatStr(entry.floatMin, entry.floatMax);
    const patStr    = entry.patterns?.trim() ? entry.patterns : '';
    const stickerStr = entry.minStickerValue ? `$${entry.minStickerValue}+` : '';
    const modeBadge = isPatMode
      ? `<span style="background:rgba(232,184,75,0.15);color:var(--accent);border-radius:4px;padding:1px 5px;font-size:9px;font-weight:700">PATTERN</span>`
      : `<span style="background:rgba(63,185,80,0.12);color:var(--green);border-radius:4px;padding:1px 5px;font-size:9px;font-weight:700">FLOAT</span>`;

    el.innerHTML = `
      <div class="watchlist-item-info">
        <div class="watchlist-item-name">📂 ${escHtml(entry.weapon)} ${modeBadge}</div>
        <div class="watchlist-item-meta">
          ${patStr   ? `<span><span class="meta-label">Pattern:</span><span class="meta-val">${escHtml(patStr)}</span></span>` : ''}
          ${floatStr ? `<span><span class="meta-label">Float:</span><span class="meta-val">${floatStr}</span></span>` : ''}
          ${stickerStr ? `<span><span class="meta-label">Stickers:</span><span class="meta-val">${stickerStr}</span></span>` : ''}
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
  const weapon = document.getElementById('cat-weapon').value;
  if (!weapon) { shakeInput('cat-weapon'); return; }

  let patterns = '', floatMin = '', floatMax = '';
  if (catFilterMode === 'pattern') {
    patterns = document.getElementById('cat-patterns-only').value.trim();
    if (!patterns) { shakeInput('cat-patterns-only'); return; }
  } else {
    floatMin = document.getElementById('cat-float-min').value.trim();
    floatMax = document.getElementById('cat-float-max').value.trim();
    patterns = document.getElementById('cat-patterns').value.trim();
  }

  const minStickerValue = document.getElementById('cat-sticker-val').value.trim();

  if (!settings.categoryMonitors) settings.categoryMonitors = [];
  settings.categoryMonitors.push({ weapon, patterns, floatMin, floatMax, filterMode: catFilterMode, minStickerValue });
  saveSettings();
  renderCategories();

  document.getElementById('cat-weapon').value = '';
  ['cat-patterns', 'cat-patterns-only', 'cat-float-min', 'cat-float-max', 'cat-sticker-val'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
});

// ══════════════════════════════════════════════════════════
// STICKERS TAB
// ══════════════════════════════════════════════════════════
function renderStickers() {
  const container = document.getElementById('sticker-items');
  if (!container) return;
  container.innerHTML = '';

  if (!settings.stickerMonitors || settings.stickerMonitors.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🏷️</div>No sticker monitors yet.</div>`;
    return;
  }

  settings.stickerMonitors.forEach((entry, idx) => {
    const el = document.createElement('div');
    el.className = 'watchlist-item';
    el.innerHTML = `
      <div class="watchlist-item-info">
        <div class="watchlist-item-name">🏷️ ${escHtml(entry.name)}</div>
        <div class="watchlist-item-meta">
          <span><span class="meta-label">Min Sticker Value:</span><span class="meta-val">$${escHtml(entry.minStickerValue)}</span></span>
        </div>
      </div>
      <button class="btn btn-danger btn-sm" data-idx="${idx}" data-type="st">✕</button>
    `;
    container.appendChild(el);
  });

  container.querySelectorAll('[data-type="st"]').forEach(btn => {
    btn.addEventListener('click', () => {
      settings.stickerMonitors.splice(Number(btn.dataset.idx), 1);
      saveSettings();
      renderStickers();
    });
  });
}

document.getElementById('st-add-btn').addEventListener('click', () => {
  const rawInput = document.getElementById('st-name').value.trim();
  const minStickerValue = document.getElementById('st-sticker-val').value.trim();

  if (!rawInput) { shakeInput('st-name'); return; }
  if (!minStickerValue) { shakeInput('st-sticker-val'); return; }



  const nameToSave = stripWear(rawInput);

  if (!settings.stickerMonitors) settings.stickerMonitors = [];
  
  const alreadyExists = settings.stickerMonitors.some(
    e => stripWear(e.name).toLowerCase() === nameToSave.toLowerCase()
  );
  if (alreadyExists) {
    const el = document.getElementById('st-name');
    el.style.borderColor = 'var(--accent)';
    setTimeout(() => el.style.borderColor = '', 1200);
    return;
  }

  settings.stickerMonitors.push({ name: nameToSave, minStickerValue });
  selectedSkinName = '';
  saveSettings();
  renderStickers();

  ['st-name', 'st-sticker-val'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
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
  const tg = settings.telegram ?? { enabled: false, bots: [] };
  document.getElementById('s-tg-enabled').checked = tg.enabled === true;
  updateTgStatus();
  renderTgBots();
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
  const tg     = settings.telegram ?? { enabled: false, bots: [] };
  const bots   = tg.bots || [];
  const active = tg.enabled && bots.length > 0;
  const badge  = document.getElementById('tg-status');
  const fields = document.getElementById('tg-fields');
  if (badge) {
    badge.textContent = active ? '✅ Active' : 'Off';
    badge.className   = `tg-status ${active ? 'connected' : 'disconnected'}`;
  }
  if (fields) fields.classList.toggle('disabled', !tg.enabled);
}

document.getElementById('s-tg-enabled').addEventListener('change', (e) => {
  if (!settings.telegram) settings.telegram = { enabled: false, bots: [] };
  settings.telegram.enabled = e.target.checked;
  updateTgStatus();
  saveSettings();
});

function renderTgBots() {
  const container = document.getElementById('tg-bot-list');
  if (!container) return;
  container.innerHTML = '';
  
  const tg = settings.telegram ?? { enabled: false, bots: [] };
  const bots = tg.bots || [];

  if (bots.length === 0) {
    container.innerHTML = `<div style="font-size:11px;color:var(--muted);text-align:center;padding:10px;">No bots added. Add one below.</div>`;
    return;
  }

  bots.forEach((bot, idx) => {
    const el = document.createElement('div');
    el.className = 'watchlist-item';
    el.style.alignItems = 'center';
    el.innerHTML = `
      <div class="watchlist-item-info">
        <div class="watchlist-item-name">🤖 ${escHtml(bot.name)}</div>
        <div class="watchlist-item-meta">
          <span><span class="meta-label">Chat ID:</span><span class="meta-val">${escHtml(bot.chatId)}</span></span>
        </div>
      </div>
      <button class="btn btn-ghost btn-sm tg-test-item-btn" data-idx="${idx}" title="Test">&#9992;</button>
      <button class="btn btn-danger btn-sm tg-del-item-btn" data-idx="${idx}" title="Delete">✕</button>
    `;
    container.appendChild(el);
  });

  container.querySelectorAll('.tg-del-item-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      settings.telegram.bots.splice(Number(btn.dataset.idx), 1);
      saveSettings();
      updateTgStatus();
      renderTgBots();
    });
  });

  container.querySelectorAll('.tg-test-item-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = Number(btn.dataset.idx);
      const bot = settings.telegram.bots[idx];
      const origText = btn.innerHTML;
      btn.innerHTML = '⏳';
      try {
        const result = await chrome.runtime.sendMessage({ type: 'TG_TEST', token: bot.token, chatId: bot.chatId });
        if (result?.ok) {
          btn.innerHTML = '✅';
        } else {
          btn.innerHTML = '❌';
          alert('Test failed: ' + (result?.error || 'Unknown error'));
        }
      } catch (err) {
        btn.innerHTML = '❌';
      }
      setTimeout(() => { btn.innerHTML = origText; }, 3000);
    });
  });
}

document.getElementById('tg-add-btn').addEventListener('click', () => {
  const name   = document.getElementById('tg-new-name').value.trim();
  const token  = document.getElementById('tg-new-token').value.trim();
  const chatId = document.getElementById('tg-new-chatid').value.trim();
  const msg    = document.getElementById('tg-form-msg');

  if (!name || !token || !chatId) {
    msg.textContent = '⚠️ Fill all fields.';
    msg.className = 'tg-test-msg err';
    return;
  }

  if (!settings.telegram) settings.telegram = { enabled: false, bots: [] };
  if (!settings.telegram.bots) settings.telegram.bots = [];
  
  settings.telegram.bots.push({ name, token, chatId });
  saveSettings();
  updateTgStatus();
  renderTgBots();

  document.getElementById('tg-new-name').value = '';
  document.getElementById('tg-new-token').value = '';
  document.getElementById('tg-new-chatid').value = '';

  msg.textContent = '✅ Added!';
  msg.className = 'tg-test-msg ok';
  setTimeout(() => { msg.textContent = ''; }, 2000);
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
    const logTs   = m.timestamp;
    const when    = timeAgo(logTs);
    const clockTime = logTs ? new Date(logTs).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';

    a.innerHTML = `
      <div class="match-star">★</div>
      <div class="match-info">
        <div class="match-name">${escHtml(m.name)}</div>
        <div class="match-meta">
          <span class="match-price">${price}</span>
          <span>Float: ${float}</span>
          <span>Pat: ${pattern}</span>
          ${m.totalStickerValue > 0 ? `<span style="color:var(--accent)">Stickers: $${(m.totalStickerValue / 100).toFixed(2)}</span>` : ''}
        </div>
        <div class="match-meta" style="margin-top:2px;opacity:0.65;font-size:10px">
          <span>🕐 ${clockTime ? clockTime + ' · ' : ''}${when}</span>
        </div>
      </div>
    `;
    log.appendChild(a);
  }
}

// ══════════════════════════════════════════════════════════
// LATEST LOG TAB
// ══════════════════════════════════════════════════════════
async function loadLatestLog() {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'GET_LATEST_ITEMS' });
    const items = result?.items ?? [];
    const log = document.getElementById('latest-log');
    if (!log) return;

    if (items.length === 0) {
      log.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🔍</div>No items checked yet. Keep the bot running.</div>`;
      return;
    }

    log.innerHTML = '';
    for (const m of items) {
      const a = document.createElement('a');
      a.className = 'match-item';
      a.href = m.tradeUrl;
      a.target = '_blank';

      const price   = m.price ? `$${(m.price / 100).toFixed(2)}` : 'N/A';
      const float   = m.floatValue !== null && m.floatValue !== undefined ? m.floatValue.toFixed(4) : 'N/A';
      const pattern = m.patternIndex !== null && m.patternIndex !== undefined ? m.patternIndex : 'N/A';
      // m.timestamp = botun algilama ani (her zaman guncel)
      // m.listingTime = API'nin createdAt (9 gun once gibi eski olabilir)
      const detectedTs = m.timestamp;
      const when       = timeAgo(detectedTs);
      const clockTime  = detectedTs
        ? new Date(detectedTs).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        : '';
      
      let totalStickerValue = 0;
      if (m.stickers && m.stickers.length > 0) {
        for (const s of m.stickers) totalStickerValue += s.price ?? 0;
      }

      a.innerHTML = `
        <div class="match-star" style="color:var(--muted)">👁️</div>
        <div class="match-info">
          <div class="match-name">${escHtml(m.name)}</div>
          <div class="match-meta">
            <span class="match-price">${price}</span>
            <span>Float: ${float}</span>
            <span>Pat: ${pattern}</span>
            ${totalStickerValue > 0 ? `<span style="color:var(--accent)">Stickers: $${(totalStickerValue / 100).toFixed(2)}</span>` : ''}
          </div>
          <div class="match-meta" style="margin-top:2px;opacity:0.65;font-size:10px">
            <span title="Listeleme saati: ${clockTime}">🕐 ${clockTime ? clockTime + ' · ' : ''}${when}</span>
          </div>
        </div>
      `;
      log.appendChild(a);
    }
  } catch (err) {
    console.error('Failed to load latest log', err);
  }
}

// ── Helpers ────────────────────────────────────────────────

/**
 * CS2 aşınma suffix'lerini skin adından siler.
 * "AK-47 | Redline (Minimal Wear)" → "AK-47 | Redline"
 * Pattern modunda kaydederken kullanılır: tüm aşınma durumları kapsanır.
 */
const WEAR_SUFFIXES = [
  '(Factory New)', '(Minimal Wear)', '(Field-Tested)', '(Well-Worn)', '(Battle-Scarred)',
];
function stripWear(name) {
  let result = name;
  for (const suffix of WEAR_SUFFIXES) {
    if (result.endsWith(suffix)) {
      result = result.slice(0, -suffix.length).trimEnd();
      break;
    }
  }
  return result;
}

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
  // Unix ms veya ISO string kabul et
  const t = typeof ts === 'string' ? new Date(ts).getTime() : ts;
  const diff = Math.floor((Date.now() - t) / 1000);
  if (diff < 0)    return 'henuz';
  if (diff < 60)   return `${diff}s once`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m once`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h once`;
  return `${Math.floor(diff / 86400)}g once`;
}

// ── Boot ───────────────────────────────────────────────────
init();
