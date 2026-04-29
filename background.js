// ============================================================
// background.js — Service Worker for TradeIt Tracker
// ============================================================
//
// TRADEİT API GRUPLAMA MANTIĞI:
//   Grup  : id === groupId (number), floatValue yok → ucuz/yaygın skinler
//   Bireysel: id = büyük string assetId, floatValue var → nadir/pahalı skinler
//
// STATE KALICILIĞI SORUNU (Manifest V3):
//   Chrome SW'ları alarm'lar arasında ölebilir. Tüm state
//   chrome.storage.session'da saklanır — SW öldüğünde korunur,
//   tarayıcı kapanınca sıfırlanır.
//
// COUNTS KARŞILAŞTIRMASI:
//   API her sorguda {groupId: adet} döndürür. Öncekiyle
//   karşılaştırarak hangi gruba yeni item eklendiğini biliriz.
// ============================================================

const API_BASE = 'https://tradeit.gg/api/v2/inventory/data';
const GAME_ID  = 730;

// Dışlanan item tipleri:
// 1=Case, 4=Graffiti, 5=Key, 15=Sticker, 21=AutographCapsule, 22=StickerCapsule, 25=Agent
// NOT: type 10 = Pistol (silah!), type 3 = Gloves, type 6 = Knife, type 11 = Rifle vb. → bunlar dahil edilmeli
const EXCLUDED_TYPES = new Set([1, 4, 5, 15, 21, 22, 25]);

const DEFAULT_SETTINGS = {
  pollingInterval: 10,
  soundNormal: true,
  soundWatchlist: true,
  popupEnabled: true,
  watchlist: [],
  categoryMonitors: [],
  stickerMonitors: [],
};

// ── In-memory state (SW öldüğünde sıfırlanır, session'dan restore edilir) ──
let seenAssetIds      = new Set(); // Asla groupId eklenmez, sadece gerçek assetId
let prevCounts        = {};         // {groupId: count} — önceki sorgunun counts'u
let prevCountsLoaded  = false;      // SW sıfırlanma tespiti için
let isInitialized     = false;
let recentMatches     = [];
let latestCheckedItems = [];
let backoffDelay      = 0;

// ── Session'dan state restore ────────────────────────────────
async function loadSessionState() {
  try {
    const s = await chrome.storage.session.get([
      'seenAssetIds', 'prevCounts', 'isInitialized', 'latestCheckedItems'
    ]);
    if (s.seenAssetIds)      seenAssetIds = new Set(s.seenAssetIds);
    if (s.prevCounts)        { prevCounts = s.prevCounts; prevCountsLoaded = true; }
    if (s.isInitialized)     isInitialized = s.isInitialized;
    if (s.latestCheckedItems) latestCheckedItems = s.latestCheckedItems;
  } catch (_) {}
}

async function saveSessionState() {
  try {
    await chrome.storage.session.set({
      seenAssetIds:       [...seenAssetIds],
      prevCounts,
      isInitialized,
      latestCheckedItems,
    });
  } catch (_) {}
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
  const interval = settings?.pollingInterval ?? DEFAULT_SETTINGS.pollingInterval;
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

  // SW restart'larına karşı state'i restore et
  await loadSessionState();

  try {
    const stored = await chrome.storage.local.get(['settings', 'activationState', 'recentMatches']);
    const cfg = stored.settings ?? DEFAULT_SETTINGS;
    if (stored.recentMatches) recentMatches = stored.recentMatches;

    if (!stored.activationState?.isActive) {
      console.log('[TradeIt Tracker] Not activated. Skipping poll.');
      return;
    }

    // ── Ana API isteği ──────────────────────────────────────
    const res = await fetchSafe(`${API_BASE}?gameId=${GAME_ID}&offset=0&limit=500&sortType=Newest`);
    if (!res) return;

    const json = await res.json();
    const rawItems      = json?.items ?? [];
    const currentCounts = json?.counts ?? {};

    if (!Array.isArray(rawItems)) return;

    // ── İlk çalışma: seed ───────────────────────────────────
    if (!isInitialized) {
      rawItems
        .filter(i => !isExcluded(i) && !isGroupItem(i))
        .forEach(i => seenAssetIds.add(String(i.id ?? i.assetId)));

      // Watchlist'le eşleşen grupların içindeki assetId'leri sessizce seed et
      const matchedGroups = rawItems
        .filter(i => !isExcluded(i) && isGroupItem(i) && checkWatchlistByName(i.name, cfg))
        .slice(0, 8);

      for (const grp of matchedGroups) {
        const gRes = await fetchSafe(`${API_BASE}?gameId=${GAME_ID}&groupId=${grp.groupId}`);
        if (!gRes) continue;
        try {
          const gData = await gRes.json();
          (gData?.items ?? []).forEach(gi => seenAssetIds.add(String(gi.id ?? gi.assetId)));
        } catch (_) {}
      }

      prevCounts = { ...currentCounts };
      prevCountsLoaded = true;
      isInitialized = true;

      // Latest panelini hemen doldur: bireysel itemler + ilk N grubun detayı
      // Grup başına max 2 item göster (Kukri/Asiimov kaplamasını önlemek için)
      const initIndividual = rawItems
        .filter(i => !isExcluded(i) && !isGroupItem(i))
        .map(normalizeItem);

      const initGroups = rawItems
        .filter(i => !isExcluded(i) && isGroupItem(i))
        .sort((a, b) => a.score - b.score) // score küçük = en yeni
        .slice(0, 12); // Daha fazla grup aç, ama her birinden az item al

      const initGroupItems = [];
      for (const grp of initGroups) {
        const gRes = await fetchSafe(`${API_BASE}?gameId=${GAME_ID}&groupId=${grp.groupId}`);
        if (!gRes) continue;
        try {
          const gData = await gRes.json();
          const gItems = (gData?.items ?? []).map(normalizeItem).filter(i => !isExcluded(i));
          // Bu gruptan en fazla 2 item al
          initGroupItems.push(...gItems.slice(0, 2));
          gItems.forEach(i => seenAssetIds.add(i.id)); // tümünü seed et (yeni görünmesin)
        } catch (_) {}
      }

      latestCheckedItems = [...initIndividual, ...initGroupItems]
        .filter((v, i, a) => a.findIndex(x => x.id === v.id) === i)
        .slice(0, 40);

      await saveSessionState();
      console.log(`[TradeIt Tracker] Initialized. seenAssetIds: ${seenAssetIds.size}, latest: ${latestCheckedItems.length}`);
      return;
    }

    // ── SW sıfırlanma kontrolü ──────────────────────────────
    // prevCountsLoaded=false ise SW öldü ve counts boştur.
    // Bu durumda tüm gruplar "yeni" görünür → sadece bireysel itemleri işle,
    // grup fetch'i YAPMA (spam önleme).
    const swWasReset = !prevCountsLoaded;
    if (swWasReset) {
      console.warn('[TradeIt Tracker] SW restart detected. Skipping group fetch this poll.');
      prevCounts = { ...currentCounts };
      prevCountsLoaded = true;
      await saveSessionState();
    }

    const watchlistMatches = [];
    const regularItems     = [];
    const newLatestItems   = []; // Latest paneli için sadece gerçekten yeni itemler

    // ── 1. Bireysel itemler (id !== groupId, float var) ─────
    const individualRaw = rawItems.filter(i => !isExcluded(i) && !isGroupItem(i));
    for (const raw of individualRaw) {
      const assetId = String(raw.id ?? raw.assetId ?? '');
      if (!assetId || seenAssetIds.has(assetId)) continue;
      seenAssetIds.add(assetId);

      const item = normalizeItem(raw);
      newLatestItems.push(item);

      const match = checkWatchlist(item, cfg, false);
      if (match) {
        item.watchlistMatch = match;
        watchlistMatches.push(item);
        recordMatch(item);
      } else {
        regularItems.push(item);
      }
    }

    // ── 2. Gruplar: counts artışı veya watchlist eşleşmesi ──
    if (!swWasReset) {
      const groupsToFetch = new Map(); // groupId → raw

      for (const raw of rawItems) {
        if (isExcluded(raw) || !isGroupItem(raw)) continue;
        const gid      = String(raw.groupId);
        const prevCnt  = prevCounts[gid] ?? 0;
        const currCnt  = currentCounts[gid] ?? 0;

        const hasNewItems    = currCnt > prevCnt;
        const nameMatchesWL  = checkWatchlistByName(raw.name, cfg);

        // Gruba yeni item eklenmiş VE (watchlist eşleşiyorsa VEYA counts artmışsa)
        if (hasNewItems) {
          groupsToFetch.set(gid, raw);
        } else if (nameMatchesWL && prevCnt === 0) {
          // İlk kez karşılaşılan watchlist grubu
          groupsToFetch.set(gid, raw);
        }
      }

      // Grup detaylarını çek (maksimum 10 istek / poll)
      let fetchCount = 0;
      for (const [gid, groupRaw] of groupsToFetch.entries()) {
        if (fetchCount >= 10 || backoffDelay > 0) break;

        const gRes = await fetchSafe(`${API_BASE}?gameId=${GAME_ID}&groupId=${gid}`);
        if (!gRes) continue;
        fetchCount++;

        let gData;
        try { gData = await gRes.json(); } catch (_) { continue; }

        for (const gi of (gData?.items ?? [])) {
          const assetId = String(gi.id ?? gi.assetId ?? '');
          if (!assetId) continue;

          const isNew = !seenAssetIds.has(assetId);
          seenAssetIds.add(assetId);
          if (!isNew) continue;

          const item = normalizeItem(gi);
          newLatestItems.push(item);

          const match = checkWatchlist(item, cfg, false);
          if (match) {
            item.watchlistMatch = match;
            watchlistMatches.push(item);
            recordMatch(item);
          } else {
            regularItems.push(item);
          }
        }
      }
    }

    // prevCounts güncelle
    prevCounts = { ...currentCounts };

    // seenAssetIds boyutu kontrolü (son 3000 tut)
    if (seenAssetIds.size > 3000) {
      const arr = [...seenAssetIds];
      seenAssetIds = new Set(arr.slice(arr.length - 1500));
    }

    // ── Latest paneli: gerçekten yeni itemleri öne ekle ─────
    // Grup başına max 3 item (aynı skin kaplamasını önle)
    if (newLatestItems.length > 0) {
      const cappedNew = capByGroup(newLatestItems, 3);
      latestCheckedItems = [...cappedNew, ...latestCheckedItems]
        .filter((v, i, a) => a.findIndex(x => x.id === v.id) === i)
        .slice(0, 40);
    }

    // State'i session'a kaydet
    await saveSessionState();

    if (watchlistMatches.length === 0 && regularItems.length === 0) return;

    await chrome.storage.local.set({ recentMatches });

    if (watchlistMatches.length > 0) {
      for (const item of watchlistMatches) {
        await sendTelegramAlert(item, cfg);
      }
    }

    await notifyTabs({ watchlistMatches, regularItems, settings: cfg });

  } catch (err) {
    console.error('[TradeIt Tracker] Poll error:', err);
  }
}

// ============================================================
// Item helpers
// ============================================================

/**
 * Aynı grubun Latest panelinde fazla yer kaplamasını önler.
 * Her groupId için maksimum maxPerGroup adet item döner.
 * GroupId'si olmayan (bireysel nadir) itemler sınırsızdır.
 */
function capByGroup(items, maxPerGroup = 2) {
  const groupCounts = new Map();
  return items.filter(item => {
    if (!item.groupId) return true; // Bireysel item → sınır yok
    const cnt = groupCounts.get(item.groupId) ?? 0;
    if (cnt >= maxPerGroup) return false;
    groupCounts.set(item.groupId, cnt + 1);
    return true;
  });
}

/**
 * Grup tespiti: id (number) === groupId → grup özeti (float yok)
 * Bireysel: id büyük string assetId, groupId küçük sayı
 */
function isGroupItem(raw) {
  if (raw.id == null || raw.groupId == null) return false;
  return String(raw.id) === String(raw.groupId);
}

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
  // floatValue: TradeIt vanilla knife'lar için -1 döndürüyor → null kabul et
  const rawFloat = raw.floatValue;
  const floatValue = (rawFloat != null && rawFloat >= 0) ? rawFloat : null;

  const assetId = String(raw.id ?? raw.assetId ?? '');
  return {
    id:           assetId,
    assetId:      assetId,
    groupId:      raw.groupId ? String(raw.groupId) : null,
    isGroup:      isGroupItem(raw),
    name:         raw.name ?? 'Unknown',
    price:        raw.storePrice ?? raw.price ?? 0,  // cents
    floatValue,
    patternIndex: raw.patternIndex ?? raw.paintSeed ?? null,
    paintIndex:   raw.paintIndex ?? null,
    iconUrl:      raw.imgURL ?? raw.iconUrl ?? raw.icon ?? '',
    type:         raw?.metaMappings?.type ?? raw.type ?? null,
    steamTags:    raw.steamTags ?? [],
    tradeUrl:     `https://tradeit.gg/csgo/store?search=${encodeURIComponent(raw.name ?? '')}`,
    timestamp:    Date.now(),
    listingTime:  raw.createdAt ?? raw.tradedAt ?? null, // API'nin gercek listeleme zamani
    stickers:     raw.stickers ?? [],
  };
}

function calculateStickerValue(stickers) {
  if (!stickers || stickers.length === 0) return 0;
  return stickers.reduce((sum, s) => sum + (s.price ?? 0), 0);
}

/**
 * Hızlı isim bazlı watchlist kontrolü (grup ön eleme için)
 */
function checkWatchlistByName(name, cfg) {
  const lower = (name ?? '').toLowerCase();
  for (const e of (cfg.watchlist ?? []))
    if (e.name && lower.includes(e.name.toLowerCase().trim())) return true;
  for (const c of (cfg.categoryMonitors ?? [])) {
    if (!c.weapon) continue;
    const w = c.weapon.toLowerCase().trim();
    if (w === 'all knives' || lower.includes(w)) return true;
  }
  for (const s of (cfg.stickerMonitors ?? []))
    if (s.name && lower.includes(s.name.toLowerCase().trim())) return true;
  return false;
}

/**
 * Tam filtre kontrolü: float, pattern, sticker değeri
 * nameOnly=true → sadece isim karşılaştırması (grup ön eleme)
 */
function checkWatchlist(item, cfg, nameOnly = false) {
  const watchlist        = cfg.watchlist        ?? [];
  const categoryMonitors = cfg.categoryMonitors ?? [];
  const stickerMonitors  = cfg.stickerMonitors  ?? [];
  const totalStickerVal  = calculateStickerValue(item.stickers);

  for (const entry of stickerMonitors) {
    if (!entry.name) continue;
    if (!item.name.toLowerCase().includes(entry.name.toLowerCase().trim())) continue;
    if (!nameOnly) {
      const minCents = (parseFloat(entry.minStickerValue) || 0) * 100;
      if (totalStickerVal < minCents) continue;
    }
    return { type: 'sticker', entry };
  }

  for (const entry of watchlist) {
    if (!entry.name) continue;
    if (!item.name.toLowerCase().includes(entry.name.toLowerCase().trim())) continue;
    if (!nameOnly) {
      if (entry.filterMode === 'pattern') {
        if (!patternMatches(item.patternIndex, entry.patterns)) continue;
      } else {
        if (!floatInRange(item.floatValue, entry.floatMin, entry.floatMax)) continue;
        if (!patternMatches(item.patternIndex, entry.patterns)) continue;
      }
      if (entry.minStickerValue) {
        const minCents = (parseFloat(entry.minStickerValue) || 0) * 100;
        if (totalStickerVal < minCents) continue;
      }
    }
    return { type: 'named', entry };
  }

  for (const cat of categoryMonitors) {
    if (!cat.weapon) continue;
    const weapon   = cat.weapon.toLowerCase().trim();
    const itemName = item.name.toLowerCase();
    const tags     = (item.steamTags ?? []).map(t => t.toLowerCase());

    const weaponMatch =
      itemName.includes(weapon) ||
      tags.includes(weapon) ||
      (weapon === 'all knives' && (tags.includes('knife') || itemName.includes('★')));

    if (!weaponMatch) continue;

    if (!nameOnly) {
      if (cat.filterMode === 'pattern') {
        if (!patternMatches(item.patternIndex, cat.patterns)) continue;
      } else {
        if (!floatInRange(item.floatValue, cat.floatMin, cat.floatMax)) continue;
        if (!patternMatches(item.patternIndex, cat.patterns)) continue;
      }
      if (cat.minStickerValue) {
        const minCents = (parseFloat(cat.minStickerValue) || 0) * 100;
        if (totalStickerVal < minCents) continue;
      }
    }
    return { type: 'category', entry: cat };
  }

  return null;
}

/**
 * Float filtresi:
 *  - filtre yoksa → geç (her zaman true)
 *  - filtre var ama float null → FAIL (vanilla knife vb.)
 *  - filtre var ve float geçerliyse → aralık kontrolü
 */
function floatInRange(value, min, max) {
  const hasMin = min !== undefined && min !== '';
  const hasMax = max !== undefined && max !== '';
  if (!hasMin && !hasMax) return true;
  if (value === null || value === undefined) return false;
  if (hasMin && parseFloat(min) > value) return false;
  if (hasMax && parseFloat(max) < value) return false;
  return true;
}

/**
 * Pattern kontrolü: "1-100, 387, 500-600" formatı
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
    id:                item.id,
    name:              item.name,
    price:             item.price,
    floatValue:        item.floatValue,
    patternIndex:      item.patternIndex,
    tradeUrl:          item.tradeUrl,
    timestamp:         item.timestamp,
    matchType:         item.watchlistMatch?.type ?? 'named',
    matchedEntry:      item.watchlistMatch?.entry?.name ?? item.watchlistMatch?.entry?.weapon ?? '',
    totalStickerValue: calculateStickerValue(item.stickers),
  });
  if (recentMatches.length > 20) recentMatches = recentMatches.slice(0, 20);
}

// ── Rate-limit korumalı fetch ────────────────────────────────
async function fetchSafe(url) {
  if (backoffDelay > 0) return null;
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'Referer': 'https://tradeit.gg/' }
    });
    if (res.status === 429) {
      backoffDelay = Math.min(backoffDelay + 30, 300);
      console.warn(`[TradeIt Tracker] Rate limited. Backoff ${backoffDelay}s`);
      return null;
    }
    return res.ok ? res : null;
  } catch (_) {
    return null;
  }
}

// ============================================================
// Tab messaging
// ============================================================
async function notifyTabs(payload) {
  const tabs = await chrome.tabs.query({ url: '*://tradeit.gg/*' });
  for (const tab of tabs) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'NEW_ITEMS', ...payload });
    } catch (_) {}
  }
}

// ============================================================
// Telegram integration
// ============================================================
async function sendTelegram(token, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
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
    const tg = cfg.telegram ?? { enabled: false, bots: [] };
    if (!tg.enabled || !tg.bots?.length) return;

    const price      = item.price ? `$${(item.price / 100).toFixed(2)}` : 'N/A';
    const floatStr   = item.floatValue != null ? item.floatValue.toFixed(6) : 'N/A';
    const patternStr = item.patternIndex != null ? item.patternIndex : 'N/A';
    const matchedBy  = item.watchlistMatch?.entry?.name ?? item.watchlistMatch?.entry?.weapon ?? 'Watchlist';
    const totalSV    = calculateStickerValue(item.stickers);
    const stickerStr = totalSV > 0 ? `$${(totalSV / 100).toFixed(2)}` : 'None';

    const message = [
      '\u2605 <b>Watchlist Match!</b>',
      '',
      `\ud83d\udd2b <b>${item.name}</b>`,
      '',
      `\ud83d\udcb0 Price:    <code>${price}</code>`,
      `\ud83c\udf0a Float:    <code>${floatStr}</code>`,
      `\ud83c\udfa8 Pattern:  <code>${patternStr}</code>`,
      `\ud83c\udff7\ufe0f Stickers: <code>${stickerStr}</code>`,
      `\ud83d\udcc2 Match:    <code>${matchedBy}</code>`,
      '',
      `\ud83d\udd17 <a href="${item.tradeUrl}">View on tradeit.gg</a>`,
    ].join('\n');

    for (const bot of tg.bots) {
      if (!bot.token || !bot.chatId) continue;
      try {
        await sendTelegram(bot.token, bot.chatId, message);
        console.log(`[TradeIt Tracker] Telegram → ${bot.name || '?'}: ${item.name}`);
      } catch (err) {
        console.warn(`[TradeIt Tracker] Telegram failed (${bot.name || '?'}):`, err.message);
      }
    }
  } catch (err) {
    console.warn('[TradeIt Tracker] sendTelegramAlert error:', err.message);
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

  if (msg.type === 'GET_LATEST_ITEMS') {
    sendResponse({ items: latestCheckedItems });
    return true;
  }

  if (msg.type === 'SETTINGS_UPDATED') {
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
      seenCount:    seenAssetIds.size,
      backoffDelay,
      matchCount:   recentMatches.length,
    });
    return true;
  }

  if (msg.type === 'TG_TEST') {
    if (!msg.token || !msg.chatId) {
      sendResponse({ ok: false, error: 'No token or Chat ID provided.' });
      return true;
    }
    sendTelegram(
      msg.token,
      msg.chatId,
      '\u2705 <b>TradeIt Tracker</b> bağlantı testi başarılı!\n\nWatchlist eşleşmeleri bu şekilde görünecek.'
    ).then(() => sendResponse({ ok: true }))
     .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'ACTIVATION_SUCCESS') {
    pollMarket().catch(() => {});
    sendResponse({ ok: true });
    return true;
  }
});
