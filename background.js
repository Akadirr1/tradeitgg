// ============================================================
// background.js — Service Worker for TradeIt Tracker
// Handles polling, watchlist matching, and messaging to content.js
// Now with Scrapling WebSocket backend support + API fallback
// ============================================================

const API_BASE = 'https://tradeit.gg/api/v2/inventory/data';
const GAME_ID  = 730; // CS2

// Item type codes from tradeit.gg metaMappings.type
const EXCLUDED_TYPES = new Set([15, 25, 1, 4]); // Stickers, Agents, Cases, Graffiti

// ── Scrapling Backend ─────────────────────────────────────
const SCRAPER_WS_URL = 'ws://127.0.0.1:8000/ws';
const SCRAPER_API_URL = 'http://127.0.0.1:8000/api';
let ws = null;
let wsConnected = false;
let wsReconnectTimer = null;
const WS_RECONNECT_DELAY = 5000;   // 5s between reconnect attempts

// ── Default settings ──────────────────────────────────────
const DEFAULT_SETTINGS = {
  pollingInterval: 10,       // seconds
  soundNormal: true,
  soundWatchlist: true,
  popupEnabled: true,
  watchlist: [],             // [{name, patterns, floatMin, floatMax, minStickerValue}]
  categoryMonitors: [],      // [{weapon, patterns, floatMin, floatMax, minStickerValue}]
  stickerMonitors: [],       // [{name, minStickerValue}]
};

// ── State (in-memory, reset on SW restart) ────────────────
let seenIds       = new Set();
let backoffDelay  = 0;       // seconds — exponential backoff on 429
let isInitialized = false;
let recentMatches = [];      // cap at 20

// ============================================================
// Scrapling WebSocket connection
// ============================================================
function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    ws = new WebSocket(SCRAPER_WS_URL);

    ws.onopen = () => {
      wsConnected = true;
      console.log('[TradeIt Tracker] 🔗 Connected to Scrapling backend');
      // Sync config to backend
      syncConfigToBackend();
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleScraperMessage(msg);
      } catch (e) {
        console.warn('[TradeIt Tracker] Bad WS message:', e);
      }
    };

    ws.onclose = () => {
      wsConnected = false;
      ws = null;
      console.log('[TradeIt Tracker] WebSocket disconnected — falling back to API');
      // Schedule reconnect
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = setTimeout(connectWebSocket, WS_RECONNECT_DELAY);
    };

    ws.onerror = (err) => {
      console.warn('[TradeIt Tracker] WebSocket error:', err.message || 'connection failed');
    };
  } catch (e) {
    console.warn('[TradeIt Tracker] WebSocket creation failed:', e);
    wsConnected = false;
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(connectWebSocket, WS_RECONNECT_DELAY);
  }
}

async function syncConfigToBackend() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    const { settings } = await chrome.storage.local.get('settings');
    const cfg = settings ?? DEFAULT_SETTINGS;
    ws.send(JSON.stringify({
      type: 'CONFIG_UPDATE',
      config: {
        polling_interval: cfg.pollingInterval ?? 15,
        watchlist: (cfg.watchlist ?? []).map(w => ({
          name: w.name,
          patterns: w.patterns || '',
          float_min: w.floatMin ? parseFloat(w.floatMin) : null,
          float_max: w.floatMax ? parseFloat(w.floatMax) : null,
          filter_mode: w.filterMode || 'float',
          min_sticker_value: w.minStickerValue ? parseFloat(w.minStickerValue) : null,
        })),
        category_monitors: cfg.categoryMonitors ?? [],
        sticker_monitors: cfg.stickerMonitors ?? [],
      }
    }));
  } catch (e) {
    console.warn('[TradeIt Tracker] Failed to sync config:', e);
  }
}

async function handleScraperMessage(msg) {
  const type = msg.type;

  if (type === 'CONNECTED') {
    console.log('[TradeIt Tracker] Backend status:', msg.status);
    return;
  }

  if (type === 'NEW_ITEMS') {
    // Items from the Scrapling backend — richer data than API
    const items = msg.items ?? [];
    if (items.length === 0) return;

    const { settings } = await chrome.storage.local.get('settings');
    const cfg = settings ?? DEFAULT_SETTINGS;

    const newItems = [];
    for (const raw of items) {
      const id = String(raw.id ?? raw.assetId ?? '');
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      const item = normalizeItem(raw);
      item._source = msg.meta?.source ?? 'scraper';
      newItems.push(item);
    }

    if (newItems.length === 0) return;

    // Classify
    const watchlistMatches = [];
    const regularItems = [];
    for (const item of newItems) {
      const match = checkWatchlist(item, cfg);
      if (match) {
        item.watchlistMatch = match;
        watchlistMatches.push(item);
        recordMatch(item);
      } else {
        regularItems.push(item);
      }
    }

    await chrome.storage.local.set({ recentMatches });

    if (watchlistMatches.length > 0) {
      for (const item of watchlistMatches) {
        await sendTelegramAlert(item, cfg);
      }
    }

    await notifyTabs({ watchlistMatches, regularItems, settings: cfg });
    console.log(`[TradeIt Tracker] Scraper: ${newItems.length} new (${watchlistMatches.length} matches) via ${msg.meta?.source ?? 'scraper'}`);
    return;
  }

  if (type === 'PONG' || type === 'CONFIG_ACK' || type === 'STATUS') {
    // Acknowledged — no action needed
    return;
  }
}

// ============================================================
// Alarm setup
// ============================================================
chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get('settings');
  if (!data.settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
  await setupAlarm();
  connectWebSocket();
  console.log('[TradeIt Tracker] Extension installed / updated.');
});

chrome.runtime.onStartup.addListener(async () => {
  await setupAlarm();
  connectWebSocket();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'poll') {
    // Only poll API if scraper backend is NOT connected
    if (!wsConnected) {
      await pollMarket();
    } else {
      // Ping the backend to keep connection alive
      try {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'PING' }));
        }
      } catch (_) {}
    }
  }
});

async function setupAlarm() {
  const { settings } = await chrome.storage.local.get('settings');
  const interval = (settings?.pollingInterval ?? DEFAULT_SETTINGS.pollingInterval);
  await chrome.alarms.clear('poll');
  chrome.alarms.create('poll', {
    delayInMinutes: interval / 60,
    periodInMinutes: interval / 60,
  });
}

// ============================================================
// Core polling logic
// ============================================================
async function pollMarket() {
  if (backoffDelay > 0) {
    backoffDelay = Math.max(0, backoffDelay - 10);
    console.log(`[TradeIt Tracker] Backing off, ${backoffDelay}s remaining.`);
    return;
  }

  try {
    const data = await chrome.storage.local.get(['settings', 'activationState']);
    const cfg = data.settings ?? DEFAULT_SETTINGS;
    const activationState = data.activationState;

    if (!activationState || !activationState.isActive) {
      console.log('[TradeIt Tracker] Not activated. Skipping poll.');
      return;
    }

    const url = `${API_BASE}?gameId=${GAME_ID}&offset=0&limit=40&sortType=Newest`;
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Referer': 'https://tradeit.gg/',
      }
    });

    if (response.status === 429) {
      backoffDelay = Math.min(backoffDelay + 30, 300);
      console.warn(`[TradeIt Tracker] Rate limited. Backing off ${backoffDelay}s.`);
      return;
    }

    if (!response.ok) {
      console.error(`[TradeIt Tracker] API error ${response.status}`);
      return;
    }

    const json = await response.json();
    const items = json?.items ?? json?.data ?? [];

    if (!Array.isArray(items)) {
      console.warn('[TradeIt Tracker] Unexpected API response shape:', json);
      return;
    }

    // First run — seed seen IDs without alerting
    if (!isInitialized) {
      items.forEach(item => seenIds.add(String(item.id ?? item.assetId)));
      isInitialized = true;
      console.log(`[TradeIt Tracker] Initialized with ${seenIds.size} items.`);
      return;
    }

    const newItems = [];
    for (const item of items) {
      const id = String(item.id ?? item.assetId ?? '');
      if (!id || seenIds.has(id)) continue;
      if (isExcluded(item)) continue;
      seenIds.add(id);
      newItems.push(normalizeItem(item));
    }

    // Keep seenIds from growing unbounded (cap at 2000)
    if (seenIds.size > 2000) {
      const arr = [...seenIds];
      seenIds = new Set(arr.slice(arr.length - 1000));
    }

    if (newItems.length === 0) return;

    // Classify items
    const watchlistMatches = [];
    const regularItems     = [];

    for (const item of newItems) {
      const match = checkWatchlist(item, cfg);
      if (match) {
        item.watchlistMatch = match;
        watchlistMatches.push(item);
        recordMatch(item);
      } else {
        regularItems.push(item);
      }
    }

    // Persist recent matches
    await chrome.storage.local.set({ recentMatches });

    // Send Telegram alerts for watchlist matches
    if (watchlistMatches.length > 0) {
      for (const item of watchlistMatches) {
        await sendTelegramAlert(item, cfg);
      }
    }

    // Notify active tradeit.gg tabs
    await notifyTabs({ watchlistMatches, regularItems, settings: cfg });

  } catch (err) {
    console.error('[TradeIt Tracker] Poll error:', err);
  }
}

// ============================================================
// Item helpers
// ============================================================
function isExcluded(item) {
  const type = item?.metaMappings?.type ?? item?.type;
  if (type !== undefined && EXCLUDED_TYPES.has(Number(type))) return true;

  const tags = item?.steamTags ?? [];
  if (tags.some(t => ['Sticker', 'Agent', 'Graffiti'].includes(t))) return true;

  const name = (item?.name ?? '').toLowerCase();
  if (name.includes('sticker |') || name.startsWith('agent |')) return true;

  return false;
}

function normalizeItem(raw) {
  return {
    id:           String(raw.id ?? raw.assetId ?? ''),
    assetId:      String(raw.assetId ?? raw.id ?? ''),
    name:         raw.name ?? 'Unknown',
    price:        raw.storePrice ?? raw.price ?? 0,      // cents
    floatValue:   raw.floatValue ?? null,
    patternIndex: raw.patternIndex ?? raw.paintSeed ?? null,
    paintIndex:   raw.paintIndex ?? null,
    iconUrl:      raw.imgURL ?? raw.iconUrl ?? raw.icon ?? '',
    type:         raw?.metaMappings?.type ?? raw.type ?? null,
    steamTags:    raw.steamTags ?? [],
    tradeUrl:     `https://tradeit.gg/csgo/store?search=${encodeURIComponent(raw.name ?? '')}`,
    timestamp:    Date.now(),
    stickers:     raw.stickers ?? [],
  };
}

function calculateStickerValue(stickers) {
  if (!stickers || stickers.length === 0) return 0;
  let total = 0;
  for (const s of stickers) {
    total += s.price ?? 0;
  }
  return total;
}

function checkWatchlist(item, cfg) {
  const watchlist        = cfg.watchlist        ?? [];
  const categoryMonitors = cfg.categoryMonitors ?? [];
  const stickerMonitors  = cfg.stickerMonitors  ?? [];

  const totalStickerValue = calculateStickerValue(item.stickers);

  // Sticker monitors check
  for (const entry of stickerMonitors) {
    if (!entry.name) continue;
    const entryName = entry.name.toLowerCase().trim();
    const itemName  = item.name.toLowerCase();

    if (!itemName.includes(entryName)) continue;
    
    // Convert USD to cents for comparison
    const minCents = (parseFloat(entry.minStickerValue) || 0) * 100;
    if (totalStickerValue >= minCents) {
      return { type: 'sticker', entry };
    }
  }

  // Named watchlist check
  for (const entry of watchlist) {
    if (!entry.name) continue;
    const entryName = entry.name.toLowerCase().trim();
    const itemName  = item.name.toLowerCase();

    if (!itemName.includes(entryName)) continue;

    if (entry.filterMode === 'pattern') {
      // Pattern Only mode: pattern is required, float is ignored
      if (!patternMatches(item.patternIndex, entry.patterns)) continue;
    } else {
      // Float Range mode: float check required, pattern is optional
      if (!floatInRange(item.floatValue, entry.floatMin, entry.floatMax)) continue;
      if (!patternMatches(item.patternIndex, entry.patterns)) continue;
    }

    if (entry.minStickerValue) {
      const minCents = (parseFloat(entry.minStickerValue) || 0) * 100;
      if (totalStickerValue < minCents) continue;
    }

    return { type: 'named', entry };
  }

  // Category monitor check
  for (const cat of categoryMonitors) {
    if (!cat.weapon) continue;
    const weapon   = cat.weapon.toLowerCase().trim();
    const itemName = item.name.toLowerCase();
    const tags     = item.steamTags.map(t => t.toLowerCase());

    const weaponMatch =
      itemName.includes(weapon) ||
      tags.includes(weapon) ||
      (weapon === 'all knives' && (tags.includes('knife') || itemName.includes('★')));

    if (!weaponMatch) continue;

    if (cat.filterMode === 'pattern') {
      // Pattern Only mode: pattern is required, float is ignored
      if (!patternMatches(item.patternIndex, cat.patterns)) continue;
    } else {
      // Float Range mode
      if (!floatInRange(item.floatValue, cat.floatMin, cat.floatMax)) continue;
      if (!patternMatches(item.patternIndex, cat.patterns)) continue;
    }

    if (cat.minStickerValue) {
      const minCents = (parseFloat(cat.minStickerValue) || 0) * 100;
      if (totalStickerValue < minCents) continue;
    }

    return { type: 'category', entry: cat };
  }

  return null;
}

function floatInRange(value, min, max) {
  if (value === null || value === undefined) return true; // no filter = pass
  if (min !== undefined && min !== '' && parseFloat(min) > value) return false;
  if (max !== undefined && max !== '' && parseFloat(max) < value) return false;
  return true;
}

/**
 * Parse pattern string like "1-100, 387, 500-600" and test value.
 * Returns true if patterns is empty/undefined or value matches any token.
 */
function patternMatches(patternIndex, patterns) {
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

function recordMatch(item) {
  recentMatches.unshift({
    id:           item.id,
    name:         item.name,
    price:        item.price,
    floatValue:   item.floatValue,
    patternIndex: item.patternIndex,
    tradeUrl:     item.tradeUrl,
    timestamp:    item.timestamp,
    matchType:    item.watchlistMatch?.type ?? 'named',
    matchedEntry: item.watchlistMatch?.entry?.name ?? item.watchlistMatch?.entry?.weapon ?? '',
    totalStickerValue: calculateStickerValue(item.stickers),
  });
  if (recentMatches.length > 20) recentMatches = recentMatches.slice(0, 20);
}

// ============================================================
// Telegram integration
// ============================================================
async function sendTelegram(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.description ?? 'Telegram API error');
  return json;
}

async function sendTelegramAlert(item, cfg) {
  try {
    const tg = cfg.telegram ?? {};
    if (!tg.enabled || !tg.token || !tg.chatId) return;

    const price   = item.price ? `$${(item.price / 100).toFixed(2)}` : 'N/A';
    const float_  = item.floatValue !== null && item.floatValue !== undefined
                    ? item.floatValue.toFixed(6) : 'N/A';
    const pattern = item.patternIndex !== null && item.patternIndex !== undefined
                    ? item.patternIndex : 'N/A';
    const matchedBy = item.watchlistMatch?.entry?.name
                    ?? item.watchlistMatch?.entry?.weapon
                    ?? 'Watchlist';
    
    const totalStickerValue = calculateStickerValue(item.stickers);
    const stickerStr = totalStickerValue > 0 ? `$${(totalStickerValue / 100).toFixed(2)}` : 'None';

    const lines = [
      '\u2605 <b>Watchlist Match!</b>',
      '',
      `\ud83d\udd2b <b>${item.name}</b>`,
      '',
      `\ud83d\udcb0 Price:    <code>${price}</code>`,
      `\ud83c\udf0a Float:    <code>${float_}</code>`,
      `\ud83c\udfa8 Pattern:  <code>${pattern}</code>`,
      `\ud83c\udff7\ufe0f Stickers: <code>${stickerStr}</code>`,
      `\ud83d\udcc2 Match:    <code>${matchedBy}</code>`,
      '',
      `\ud83d\udd17 <a href="${item.tradeUrl}">View on tradeit.gg</a>`,
    ];

    await sendTelegram(tg.token, tg.chatId, lines.join('\n'));
    console.log(`[TradeIt Tracker] Telegram alert sent for: ${item.name}`);
  } catch (err) {
    console.warn('[TradeIt Tracker] Telegram alert failed:', err.message);
  }
}

// ============================================================
// Tab messaging
// ============================================================
async function notifyTabs(payload) {
  const tabs = await chrome.tabs.query({ url: '*://tradeit.gg/*' });
  for (const tab of tabs) {
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'NEW_ITEMS',
        ...payload,
      });
    } catch (_) {
      // Tab may not have content script loaded yet
    }
  }
}

// ============================================================
// Message handler (from popup / content)
// ============================================================
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GET_RECENT_MATCHES') {
    chrome.storage.local.get('recentMatches').then(data => {
      sendResponse({ matches: data.recentMatches ?? [] });
    });
    return true;
  }

  if (msg.type === 'SETTINGS_UPDATED') {
    // Re-setup alarm with new interval
    setupAlarm();
    // Sync updated config to Scrapling backend
    syncConfigToBackend();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'POLL_NOW') {
    if (wsConnected && ws && ws.readyState === WebSocket.OPEN) {
      // Ask Scrapling backend to scrape now
      ws.send(JSON.stringify({ type: 'SCRAPE_NOW', useBrowser: false }));
      sendResponse({ ok: true, source: 'scraper' });
    } else {
      pollMarket().then(() => sendResponse({ ok: true, source: 'api' }));
    }
    return true;
  }

  if (msg.type === 'GET_STATUS') {
    sendResponse({
      isInitialized,
      seenCount: seenIds.size,
      backoffDelay,
      matchCount: recentMatches.length,
      scraperConnected: wsConnected,
      source: wsConnected ? 'scraper' : 'api',
    });
    return true;
  }

  if (msg.type === 'TG_TEST') {
    chrome.storage.local.get('settings').then(async (data) => {
      const tg = data.settings?.telegram ?? {};
      if (!tg.token || !tg.chatId) {
        sendResponse({ ok: false, error: 'No token or Chat ID saved.' });
        return;
      }
      try {
        await sendTelegram(
          tg.token,
          tg.chatId,
          '\u2705 <b>TradeIt Tracker</b> bağlantı testi başarılı!\n\nWatchlist eşleşmeleri bu şekilde görünecek.'
        );
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    });
    return true;
  }

  if (msg.type === 'ACTIVATION_SUCCESS') {
    connectWebSocket();
    pollMarket().catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'SCRAPER_SCRAPE_NOW') {
    // Force browser-based scrape via Scrapling backend
    if (wsConnected && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'SCRAPE_NOW', useBrowser: true }));
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: 'Scraper not connected' });
    }
    return true;
  }
});
