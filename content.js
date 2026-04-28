// ============================================================
// content.js — Injected into tradeit.gg pages
// Handles: in-page overlay, live item table, pattern filter panel
// ============================================================

(function () {
  'use strict';

  // Avoid double-injection
  if (window.__TRADEIT_TRACKER_LOADED__) return;
  window.__TRADEIT_TRACKER_LOADED__ = true;

  // ── Sound player ──────────────────────────────────────────
  let audioNormal    = null;
  let audioWatchlist = null;

  function ensureAudio() {
    if (!audioNormal) {
      audioNormal = new Audio(chrome.runtime.getURL('sounds/sound_normal.mp3'));
      audioNormal.volume = 0.4;
    }
    if (!audioWatchlist) {
      audioWatchlist = new Audio(chrome.runtime.getURL('sounds/sound_watchlist.mp3'));
      audioWatchlist.volume = 0.8;
    }
  }

  async function playSound(type) {
    try {
      const { settings } = await chrome.storage.local.get('settings');
      if (!settings) return;
      ensureAudio();
      if (type === 'watchlist' && settings.soundWatchlist) {
        audioWatchlist.currentTime = 0;
        audioWatchlist.play();
      } else if (type === 'normal' && settings.soundNormal) {
        audioNormal.currentTime = 0;
        audioNormal.play();
      }
    } catch (_) {}
  }

  // ── Toast / Overlay ───────────────────────────────────────
  let toastContainer = null;

  function ensureToastContainer() {
    if (toastContainer && document.body.contains(toastContainer)) return;
    toastContainer = document.createElement('div');
    toastContainer.id = 'tt-toast-container';
    document.body.appendChild(toastContainer);
  }

  function showToast(item, isWatchlist) {
    ensureToastContainer();

    const price = formatPrice(item.price);
    const float = item.floatValue !== null ? item.floatValue.toFixed(6) : 'N/A';
    const pattern = item.patternIndex !== null ? item.patternIndex : 'N/A';

    const toast = document.createElement('div');
    toast.className = `tt-toast ${isWatchlist ? 'tt-toast--watchlist' : 'tt-toast--normal'}`;

    toast.innerHTML = `
      <div class="tt-toast-header">
        ${isWatchlist ? '<span class="tt-badge">★ WATCHLIST</span>' : '<span class="tt-badge tt-badge--new">NEW</span>'}
        <button class="tt-toast-close">✕</button>
      </div>
      <div class="tt-toast-name">${escapeHtml(item.name)}</div>
      <div class="tt-toast-details">
        <span class="tt-detail"><span class="tt-label">Price</span><span class="tt-value">${price}</span></span>
        <span class="tt-detail"><span class="tt-label">Float</span><span class="tt-value">${float}</span></span>
        <span class="tt-detail"><span class="tt-label">Pattern</span><span class="tt-value">${pattern}</span></span>
      </div>
      <a class="tt-toast-link" href="${item.tradeUrl}" target="_blank">View on tradeit.gg →</a>
    `;

    toastContainer.appendChild(toast);

    // Animate in
    requestAnimationFrame(() => {
      toast.classList.add('tt-toast--visible');
    });

    // Close button
    toast.querySelector('.tt-toast-close').addEventListener('click', () => {
      dismissToast(toast);
    });

    // Auto-dismiss after 5s
    const timer = setTimeout(() => dismissToast(toast), 5000);
    toast._dismissTimer = timer;
  }

  function dismissToast(toast) {
    clearTimeout(toast._dismissTimer);
    toast.classList.remove('tt-toast--visible');
    toast.classList.add('tt-toast--exit');
    setTimeout(() => toast.remove(), 350);
  }

  // ── Live Item Table ───────────────────────────────────────
  let liveTable    = null;
  let livePanel    = null;
  let liveRows     = [];   // {id, item, isWatchlist}

  function ensureLivePanel() {
    if (livePanel && document.body.contains(livePanel)) return;

    livePanel = document.createElement('div');
    livePanel.id = 'tt-live-panel';
    livePanel.innerHTML = `
      <div class="tt-panel-header">
        <div class="tt-panel-title">
          <span class="tt-live-dot"></span>
          TradeIt Tracker
        </div>
        <div class="tt-panel-controls">
          <span class="tt-panel-count" id="tt-item-count">0 items</span>
          <button class="tt-panel-btn" id="tt-clear-btn" title="Clear list">🗑</button>
          <button class="tt-panel-btn" id="tt-minimize-btn" title="Minimize">─</button>
        </div>
      </div>
      <div class="tt-panel-body" id="tt-panel-body">
        <div class="tt-filter-bar">
          <input type="text" id="tt-pattern-filter" placeholder='Pattern filter: "1-100, 387, 500-600"' class="tt-input">
          <input type="text" id="tt-name-filter" placeholder='Name filter...' class="tt-input">
        </div>
        <div class="tt-table-wrap">
          <table class="tt-table">
            <thead>
              <tr>
                <th>Skin</th>
                <th>Price</th>
                <th>Float</th>
                <th>Pattern</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="tt-table-body"></tbody>
          </table>
          <div class="tt-empty" id="tt-empty">Waiting for new listings...</div>
        </div>
      </div>
    `;

    document.body.appendChild(livePanel);

    // Make draggable
    makeDraggable(livePanel, livePanel.querySelector('.tt-panel-header'));

    // Controls
    document.getElementById('tt-clear-btn').addEventListener('click', () => {
      liveRows = [];
      renderTable();
    });

    document.getElementById('tt-minimize-btn').addEventListener('click', () => {
      const body = document.getElementById('tt-panel-body');
      const btn  = document.getElementById('tt-minimize-btn');
      const minimized = livePanel.classList.toggle('tt-panel--minimized');
      btn.textContent = minimized ? '□' : '─';
    });

    // Live pattern filter
    document.getElementById('tt-pattern-filter').addEventListener('input', renderTable);
    document.getElementById('tt-name-filter').addEventListener('input', renderTable);

    liveTable = document.getElementById('tt-table-body');
  }

  function addItemsToTable(items, isWatchlist) {
    ensureLivePanel();
    for (const item of items) {
      // Dedup
      if (liveRows.find(r => r.id === item.id)) continue;
      liveRows.unshift({ id: item.id, item, isWatchlist });
    }
    // Cap at 100 rows
    if (liveRows.length > 100) liveRows = liveRows.slice(0, 100);
    renderTable();
  }

  function renderTable() {
    if (!liveTable) return;

    const patternFilter = (document.getElementById('tt-pattern-filter')?.value ?? '').trim();
    const nameFilter    = (document.getElementById('tt-name-filter')?.value ?? '').toLowerCase().trim();

    const filtered = liveRows.filter(({ item }) => {
      if (nameFilter && !item.name.toLowerCase().includes(nameFilter)) return false;
      if (patternFilter && !patternMatchesString(item.patternIndex, patternFilter)) return false;
      return true;
    });

    liveTable.innerHTML = '';
    const empty = document.getElementById('tt-empty');

    if (filtered.length === 0) {
      if (empty) empty.style.display = 'block';
    } else {
      if (empty) empty.style.display = 'none';
      for (const { item, isWatchlist } of filtered) {
        const tr = document.createElement('tr');
        tr.className = isWatchlist ? 'tt-row--watchlist' : 'tt-row--normal';
        const price   = formatPrice(item.price);
        const float   = item.floatValue !== null ? item.floatValue.toFixed(4) : 'N/A';
        const pattern = item.patternIndex !== null ? item.patternIndex : 'N/A';
        tr.innerHTML = `
          <td class="tt-cell-name">
            ${isWatchlist ? '<span class="tt-star">★</span>' : ''}
            ${escapeHtml(item.name)}
          </td>
          <td class="tt-cell-price">${price}</td>
          <td class="tt-cell-float">${float}</td>
          <td class="tt-cell-pattern">${pattern}</td>
          <td><a href="${item.tradeUrl}" target="_blank" class="tt-link-btn">View</a></td>
        `;
        liveTable.appendChild(tr);
      }
    }

    // Update count
    const countEl = document.getElementById('tt-item-count');
    if (countEl) countEl.textContent = `${liveRows.length} item${liveRows.length !== 1 ? 's' : ''}`;
  }

  // ── Pattern helpers ───────────────────────────────────────
  function patternMatchesString(patternIndex, patterns) {
    if (!patterns || patterns.trim() === '') return true;
    if (patternIndex === null || patternIndex === undefined) return false;
    const tokens = patterns.split(',').map(t => t.trim()).filter(Boolean);
    for (const token of tokens) {
      if (token.includes('-')) {
        const [lo, hi] = token.split('-').map(Number);
        if (patternIndex >= lo && patternIndex <= hi) return true;
      } else {
        if (Number(token) === patternIndex) return true;
      }
    }
    return false;
  }

  // ── Drag helper ───────────────────────────────────────────
  function makeDraggable(el, handle) {
    let ox = 0, oy = 0, startX = 0, startY = 0;
    handle.style.cursor = 'grab';

    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      startX = e.clientX;
      startY = e.clientY;
      const rect = el.getBoundingClientRect();
      ox = rect.left;
      oy = rect.top;

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    function onMove(e) {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      el.style.left   = `${ox + dx}px`;
      el.style.top    = `${oy + dy}px`;
      el.style.right  = 'auto';
      el.style.bottom = 'auto';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
  }

  // ── Utility ───────────────────────────────────────────────
  function formatPrice(cents) {
    if (!cents && cents !== 0) return 'N/A';
    return `$${(cents / 100).toFixed(2)}`;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Message listener from background.js ──────────────────
  chrome.runtime.onMessage.addListener(async (msg, _sender) => {
    if (msg.type !== 'NEW_ITEMS') return;

    const { watchlistMatches, regularItems, settings } = msg;

    // Add to live table
    addItemsToTable(watchlistMatches, true);
    addItemsToTable(regularItems, false);

    if (!settings) return;

    // Watchlist alerts
    if (watchlistMatches.length > 0) {
      playSound('watchlist');
      if (settings.popupEnabled) {
        for (const item of watchlistMatches.slice(0, 3)) {
          showToast(item, true);
        }
      }
    }

    // Normal alerts
    if (regularItems.length > 0) {
      playSound('normal');
      if (settings.popupEnabled && regularItems.length <= 5) {
        for (const item of regularItems.slice(0, 2)) {
          showToast(item, false);
        }
      }
    }
  });

  // ── Initialize on load ────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureLivePanel);
  } else {
    ensureLivePanel();
  }

  console.log('[TradeIt Tracker] Content script loaded.');
})();
