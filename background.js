// ============================================================
// background.js — Service Worker for TradeIt Tracker
// Handles polling, watchlist matching, and messaging to content.js
// ============================================================

const API_BASE = 'https://tradeit.gg/api/v2/inventory/data';
const GAME_ID  = 730; // CS2

// Item type codes from tradeit.gg metaMappings.type
const EXCLUDED_TYPES = new Set([15, 25, 1, 4]); // Stickers, Agents, Cases, Graffiti

// ── Default settings ──────────────────────────────────────
const DEFAULT_SETTINGS = {
  pollingInterval: 10,       // seconds
  soundNormal: true,
  soundWatchlist: true,
  popupEnabled: true,
  watchlist: [],             // [{name, patterns, floatMin, floatMax}]
  categoryMonitors: [],      // [{weapon, patterns, floatMin, floatMax}]
};

// ── State (in-memory, reset on SW restart) ────────────────
let seenIds       = new Set();
let backoffDelay  = 0;       // seconds — exponential backoff on 429
let isInitialized = false;
let recentMatches = [];      // cap at 20

// ============================================================
// Alarm setup
// ============================================================
chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get('settings');
  if (!data.settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
  await setupAlarm();
  console.log('[TradeIt Tracker] Extension installed / updated.');
});

chrome.runtime.onStartup.addListener(async () => {
  await setupAlarm();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'poll') {
    await pollMarket();
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
    const { settings } = await chrome.storage.local.get('settings');
    const cfg = settings ?? DEFAULT_SETTINGS;

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
  };
}

function checkWatchlist(item, cfg) {
  const watchlist       = cfg.watchlist       ?? [];
  const categoryMonitors = cfg.categoryMonitors ?? [];

  // Named watchlist check
  for (const entry of watchlist) {
    if (!entry.name) continue;
    const entryName = entry.name.toLowerCase().trim();
    const itemName  = item.name.toLowerCase();

    if (!itemName.includes(entryName)) continue;
    if (!floatInRange(item.floatValue, entry.floatMin, entry.floatMax)) continue;
    if (!patternMatches(item.patternIndex, entry.patterns)) continue;

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
    if (!floatInRange(item.floatValue, cat.floatMin, cat.floatMax)) continue;
    if (!patternMatches(item.patternIndex, cat.patterns)) continue;

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
  });
  if (recentMatches.length > 20) recentMatches = recentMatches.slice(0, 20);
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
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'POLL_NOW') {
    pollMarket().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'GET_STATUS') {
    sendResponse({
      isInitialized,
      seenCount: seenIds.size,
      backoffDelay,
      matchCount: recentMatches.length,
    });
    return true;
  }
});
