"""
Centralized configuration for the TradeIt Tracker scraper backend.
Override any setting via environment variables prefixed with TT_.
"""
import os

# ── Server ──────────────────────────────────────────────────
HOST = os.getenv("TT_HOST", "127.0.0.1")
PORT = int(os.getenv("TT_PORT", "8000"))

# ── Scraping ────────────────────────────────────────────────
TRADEIT_BASE_URL = "https://tradeit.gg"
TRADEIT_STORE_URL = f"{TRADEIT_BASE_URL}/csgo/store"
TRADEIT_API_URL = f"{TRADEIT_BASE_URL}/api/v2/inventory/data"
GAME_ID = 730  # CS2

# Polling intervals (seconds)
SCRAPE_INTERVAL = int(os.getenv("TT_SCRAPE_INTERVAL", "15"))
DETAIL_SCRAPE_INTERVAL = int(os.getenv("TT_DETAIL_INTERVAL", "30"))

# ── Pagination scan settings ──────────────────────────────
# Items per API page
PAGE_SIZE = int(os.getenv("TT_PAGE_SIZE", "60"))
ITEMS_PER_SCRAPE = PAGE_SIZE  # backward compat alias

# Max pages to walk per full scan cycle (60 items × 50 pages = 3000 items)
# Set to 0 for unlimited (will stop at end of inventory)
MAX_PAGES_PER_SCAN = int(os.getenv("TT_MAX_PAGES", "50"))

# Notify when price drops by at least this fraction (0.05 = 5%)
PRICE_DROP_THRESHOLD = float(os.getenv("TT_PRICE_DROP_THRESHOLD", "0.05"))

# Seconds to wait between page fetches to avoid rate limiting
PAGE_DELAY = float(os.getenv("TT_PAGE_DELAY", "1.0"))

# ── StealthyFetcher settings ───────────────────────────────
HEADLESS = os.getenv("TT_HEADLESS", "true").lower() == "true"
SOLVE_CLOUDFLARE = True
NETWORK_IDLE = True
TIMEOUT_MS = 30000

# ── Database ────────────────────────────────────────────────
DB_PATH = os.getenv("TT_DB_PATH", os.path.join(os.path.dirname(__file__), "tradeit.db"))

# ── Item filtering ──────────────────────────────────────────
# Excluded type codes (same as extension)
EXCLUDED_TYPES = {15, 25, 1, 4}  # Stickers, Agents, Cases, Graffiti
EXCLUDED_TAGS = {"Sticker", "Agent", "Graffiti"}

# Max items to keep in memory before pruning
MAX_SEEN_ITEMS = 3000
MAX_HISTORY_DAYS = 30  # days to keep price history

# ── Logging ─────────────────────────────────────────────────
LOG_LEVEL = os.getenv("TT_LOG_LEVEL", "INFO")
