# 🎯 TradeIt Tracker — Chrome Extension

Real-time CS2 skin monitor for **tradeit.gg**. Get notified the instant new skins appear, with full watchlist support, pattern filtering, and float range tracking — all in-page, no browser notifications.

---

## Installation

### 1. Load as Unpacked Extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer Mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `tradeitgg/` folder
5. The extension icon will appear in your toolbar

### 2. Open tradeit.gg

Navigate to `https://tradeit.gg/csgo/store`. The live item panel will appear in the bottom-right corner of the page automatically.

---

## Features

### 📊 Live Item Panel
Injected into every tradeit.gg page — shows new skin arrivals in real time as they appear on the market. Draggable and minimizable.

- **Green rows** = regular new listings
- **Gold/highlighted rows with ★** = watchlist matches

### 🔍 Pattern Filter (injected into tradeit.gg)
Use the filter bar at the top of the live panel:
- Single values: `387`
- Comma-separated: `387, 661, 42`
- Ranges: `1-100`
- Combined: `1-100, 387, 500-600`

Filters update the live table instantly without any page reload.

### 🔔 Toast Notifications
Overlay popups appear in the top-right corner of tradeit.gg:
- **Green border** = new listing
- **Gold border + ★ WATCHLIST badge** = watchlist match
- Auto-dismiss after 5 seconds, or click ✕ to close

### 🔊 Sounds
- **Normal sound** — soft ding when any new skin appears
- **Watchlist sound** — distinct alert when a watchlist item is found

---

## Popup Settings

Click the extension icon in the Chrome toolbar to open settings.

### ⭐ Watchlist Tab
Add specific skins you're hunting:

| Field | Description |
|-------|-------------|
| Skin Name | Partial match (e.g. `Karambit | Fade`) |
| Pattern Filter | Exact + ranges (e.g. `1-100, 387`) |
| Float Min/Max | Filter by condition |

### 📂 Categories Tab
Monitor entire weapon categories (e.g. All Knives, AK-47) with optional pattern and float filters.

### ⚙️ Settings Tab
- Toggle normal / watchlist sounds independently
- Toggle on-screen popup notifications
- Set polling interval: **5s / 10s / 30s / 1m**
- **Poll Now** button for immediate check

### 📋 Log Tab
Last 20 watchlist matches, clickable to open the item on tradeit.gg.

---

## How It Works

### Polling
The extension polls the tradeit.gg API every N seconds (configurable):
```
GET https://tradeit.gg/api/v2/inventory/data?gameId=730&offset=0&limit=40&sortType=Newest
```

### First Run Seeding
On first load, the extension seeds all currently visible items as "seen" — this prevents a flood of notifications for listings that were already live before you opened the page.

### Exclusion Rules
The following item types are automatically excluded:
- Stickers (type 15)
- Agents (type 25)
- Graffiti (type 4)
- Cases (type 1)

### Rate Limiting
If the API returns HTTP 429 (Too Many Requests), the extension backs off with exponential delay (up to 5 minutes) before retrying.

---

## API Findings (tradeit.gg)

### Endpoint
```
GET https://tradeit.gg/api/v2/inventory/data
    ?gameId=730
    &offset=0
    &limit=40
    &sortType=Newest
```

No authentication required for public market listings.

### Response Shape
```json
{
  "items": [
    {
      "id": 123456789,
      "assetId": 987654321,
      "name": "AK-47 | Asiimov (Field-Tested)",
      "storePrice": 4599,
      "floatValue": 0.281234,
      "patternIndex": 387,
      "paintIndex": 279,
      "imgURL": "https://...",
      "steamTags": ["Rifle", "AK-47", "Field-Tested"],
      "metaMappings": {
        "type": 11
      }
    }
  ],
  "total": 1523
}
```

### Key Fields
| Field | Type | Notes |
|-------|------|-------|
| `id` | integer | Unique listing ID |
| `assetId` | integer | Steam asset ID |
| `name` | string | Full skin name with wear |
| `storePrice` | integer | Price in **cents** (divide by 100) |
| `floatValue` | float | 0.00–1.00 wear value |
| `patternIndex` | integer | 0–1000 paint seed / pattern ID |
| `paintIndex` | integer | Workshop paint index |
| `steamTags` | string[] | `["Rifle", "AK-47", "Field-Tested"]` |
| `metaMappings.type` | integer | Item type code |

### Item Type Codes
| Code | Category |
|------|----------|
| 6 | Knives |
| 3 | Gloves |
| 11 | Rifles / Pistols / SMGs |
| 15 | Stickers ← excluded |
| 25 | Agents ← excluded |
| 4 | Graffiti ← excluded |
| 1 | Cases ← excluded |

### Update Mechanism
tradeit.gg uses **REST polling** — no WebSocket. The page refreshes its item list via periodic XHR calls to the endpoint above. The extension mirrors this behavior via `chrome.alarms`.

---

## File Structure
```
tradeitgg/
├── manifest.json         — MV3 manifest
├── background.js         — Service worker (polling + matching)
├── content.js            — In-page panel + toast injection
├── popup.html            — Settings UI
├── popup.js              — Settings controller
├── styles.css            — Styles injected into tradeit.gg
├── sounds/
│   ├── sound_normal.mp3  — Soft ding for new listings
│   └── sound_watchlist.mp3 — Alert tone for watchlist matches
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Panel not showing | Refresh the tradeit.gg page after installing |
| No sounds | Click the page first (browsers require user gesture for audio) |
| No new items detected | Check Settings tab → Debug Info for status |
| Extension not polling | Click "Poll Now" in Settings to manually trigger |
| API errors | tradeit.gg may require you to be logged in — log in first |
