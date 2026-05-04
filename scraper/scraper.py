"""
Core scraping engine using Scrapling's Fetcher and StealthyFetcher.
Uses paginated scanning to walk the full tradeit.gg inventory instead of
only checking the first 60 items which never change.

Approach:
  - Each scrape cycle fetches ONE page (configurable offset) from the API.
  - The offset advances every cycle, walking the full inventory over time.
  - Items are compared against the SQLite DB: NEW item → alert, PRICE DROP → alert.
  - After reaching the end, the scan wraps back to offset=0.
"""
from __future__ import annotations
import re
import json
import time
import logging
import asyncio
from dataclasses import dataclass, field
from typing import Optional
from urllib.parse import urlencode, quote
from datetime import datetime

from scraper import config
from scraper.models import ScrapedItem, StickerInfo, ScrapeResult

logger = logging.getLogger("tradeit.scraper")


@dataclass
class ScanState:
    """
    Tracks where the paginated scan is up to across cycles.
    Persisted in-memory (resets on server restart — that's fine,
    DB keeps the real state).
    """
    current_offset: int = 0
    total_pages_scanned: int = 0
    full_scans_completed: int = 0
    is_first_run: bool = True          # seed DB silently on very first scan
    known_ids: dict[str, int] = field(default_factory=dict)   # {id: price_cents}
    known_ids_loaded: bool = False


class TradeItScraper:
    """
    Paginated inventory scraper for tradeit.gg.

    Each call to scan_one_page() fetches one page of the inventory,
    compares against the DB, and returns:
      - New items     (never seen before)
      - Price drops   (price fell by >= PRICE_DROP_THRESHOLD)
    """

    def __init__(self):
        self.state = ScanState()
        self.initialized = False  # kept for WS status reporting

    # ════════════════════════════════════════════════════════════
    # BROWSER-BASED SCRAPING (StealthyFetcher)
    # ════════════════════════════════════════════════════════════

    async def scrape_store_page(self, sort: str = "Newest", limit: int = 60) -> ScrapeResult:
        """
        Scrape the tradeit.gg store page using a stealth browser.

        Opens the store in headless Chrome with anti-bot bypass,
        waits for items to render, then extracts data from the DOM.
        """
        from scrapling.fetchers import StealthyFetcher

        start = time.time()
        errors: list[str] = []
        items: list[ScrapedItem] = []

        try:
            url = f"{config.TRADEIT_STORE_URL}?sort={sort}&gameId={config.GAME_ID}"
            logger.info(f"Scraping store page: {url}")

            # page_action scrolls down to trigger lazy loading of more items
            async def scroll_and_wait(page):
                """Scroll down multiple times to load more items via infinite scroll."""
                for i in range(3):
                    await page.evaluate("window.scrollBy(0, window.innerHeight)")
                    await page.wait_for_timeout(1500)
                # Scroll back to top
                await page.evaluate("window.scrollTo(0, 0)")
                await page.wait_for_timeout(500)

            response = await StealthyFetcher.async_fetch(
                url,
                headless=config.HEADLESS,
                network_idle=config.NETWORK_IDLE,
                solve_cloudflare=config.SOLVE_CLOUDFLARE,
                timeout=config.TIMEOUT_MS,
                page_action=scroll_and_wait,
                disable_resources=False,  # Need images for sticker detection
            )

            if response.status != 200:
                errors.append(f"Page returned status {response.status}")
                logger.warning(f"Store page returned status {response.status}")
            else:
                items = self._parse_store_page(response)
                logger.info(f"Parsed {len(items)} items from store page")

        except Exception as e:
            error_msg = f"Browser scrape failed: {str(e)}"
            errors.append(error_msg)
            logger.error(error_msg)

        duration = (time.time() - start) * 1000

        # Filter new items
        new_items = []
        for item in items:
            if item.id and item.id not in self.seen_ids:
                if not self.initialized:
                    self.seen_ids.add(item.id)
                else:
                    self.seen_ids.add(item.id)
                    new_items.append(item)

        if not self.initialized:
            self.initialized = True
            logger.info(f"Initialized with {len(self.seen_ids)} seen items")

        # Prune seen_ids
        if len(self.seen_ids) > config.MAX_SEEN_ITEMS:
            excess = len(self.seen_ids) - (config.MAX_SEEN_ITEMS // 2)
            self.seen_ids = set(list(self.seen_ids)[excess:])

        return ScrapeResult(
            items=new_items if self.initialized else [],
            new_count=len(new_items),
            total_scraped=len(items),
            duration_ms=duration,
            errors=errors,
            source="scraper",
        )

    def _parse_store_page(self, response) -> list[ScrapedItem]:
        """Parse items from the rendered store page DOM."""
        items: list[ScrapedItem] = []

        # tradeit.gg renders items in cards inside the store grid
        # The main container typically uses a grid/flex layout
        # Each item card contains: image, name, price, condition, discount badge
        cards = response.css('.item-card, .store-item, [class*="ItemCard"], [class*="item-card"]')

        if not cards:
            # Fallback: try broader selectors for the Vue/Nuxt rendered cards
            cards = response.css('.v-card, [data-item-id], .inventory-item')

        if not cards:
            # Last resort: look for any card-like containers with price elements
            logger.warning("No item cards found with known selectors, trying generic parsing")
            return self._parse_store_page_generic(response)

        for card in cards:
            try:
                item = self._extract_item_from_card(card)
                if item and item.name != "Unknown":
                    items.append(item)
            except Exception as e:
                logger.debug(f"Failed to parse card: {e}")

        return items

    def _extract_item_from_card(self, card) -> Optional[ScrapedItem]:
        """Extract item data from a single card element."""
        # --- Name ---
        name = ""
        # Try img alt first (tradeit sets skin name as alt text)
        img = card.css('img')
        if img:
            name = img[0].attrib.get('alt', '') if hasattr(img[0], 'attrib') else ''
            icon_url = img[0].attrib.get('src', '') if hasattr(img[0], 'attrib') else ''
        else:
            icon_url = ""

        if not name or len(name) < 3:
            # Try title attributes
            titled = card.css('[title]')
            for el in titled:
                t = el.attrib.get('title', '') if hasattr(el, 'attrib') else ''
                if len(t) > 4 and ('|' in t or t.startswith('★')):
                    name = t
                    break

        if not name or len(name) < 3:
            # Try text content
            for sel in ['h2::text', 'h3::text', '.item-name::text', '.skin-name::text',
                        'p::text', 'span::text', 'a::text']:
                texts = card.css(sel).getall()
                for t in texts:
                    t = t.strip()
                    if len(t) > 4 and ('|' in t or t.startswith('★')):
                        name = t
                        break
                if name:
                    break

        if not name:
            return None

        # --- Price ---
        price_text = ""
        for sel in ['.price::text', '[class*="price"]::text', '[class*="Price"]::text']:
            prices = card.css(sel).getall()
            for p in prices:
                p = p.strip()
                if '$' in p or p.replace('.', '').replace(',', '').isdigit():
                    price_text = p
                    break
            if price_text:
                break

        if not price_text:
            all_text = card.css('::text').getall()
            for t in all_text:
                t = t.strip()
                match = re.match(r'\$[\d,]+\.?\d*', t)
                if match:
                    price_text = match.group()
                    break

        price_usd = 0.0
        if price_text:
            clean = re.sub(r'[^\d.]', '', price_text.replace(',', ''))
            try:
                price_usd = float(clean)
            except ValueError:
                pass

        # --- Condition ---
        condition = ""
        condition_abbrevs = {'FN': 'Factory New', 'MW': 'Minimal Wear',
                            'FT': 'Field-Tested', 'WW': 'Well-Worn', 'BS': 'Battle-Scarred'}
        all_text = card.css('::text').getall()
        for t in all_text:
            t = t.strip()
            if t in condition_abbrevs:
                condition = condition_abbrevs[t]
                break
            if t in condition_abbrevs.values():
                condition = t
                break

        # --- Discount ---
        discount = None
        for t in all_text:
            t = t.strip()
            match = re.match(r'-(\d+)%', t)
            if match:
                discount = float(match.group(1))
                break

        # --- Float (if visible on card) ---
        float_value = None
        for t in all_text:
            t = t.strip()
            match = re.match(r'^0\.\d{4,}$', t)
            if match:
                float_value = float(t)
                break

        # --- Pattern (if visible) ---
        pattern_index = None
        pattern_el = card.css('[class*="pattern"]::text, [class*="seed"]::text').getall()
        for t in pattern_el:
            t = t.strip()
            if t.isdigit():
                pattern_index = int(t)
                break

        # --- Item ID ---
        item_id = ""
        if hasattr(card, 'attrib'):
            item_id = card.attrib.get('data-item-id', '') or card.attrib.get('data-id', '')
        if not item_id:
            # Generate from name + price as fallback
            item_id = f"{name}_{price_usd}_{condition}"

        # --- Stickers ---
        stickers = self._extract_stickers_from_card(card)
        total_sticker_value = sum(s.price for s in stickers)

        # --- Trade URL ---
        trade_url = f"https://tradeit.gg/csgo/store?search={quote(name)}"

        return ScrapedItem(
            id=item_id,
            asset_id=item_id,
            name=name,
            price=price_usd,
            price_cents=int(price_usd * 100),
            float_value=float_value,
            pattern_index=pattern_index,
            condition=condition,
            icon_url=icon_url,
            stickers=stickers,
            total_sticker_value=total_sticker_value,
            trade_url=trade_url,
            discount_percent=discount,
            source="scraper",
        )

    def _extract_stickers_from_card(self, card) -> list[StickerInfo]:
        """Extract sticker information from a card element."""
        stickers = []
        # Stickers are typically shown as small images in a row
        sticker_imgs = card.css('[class*="sticker"] img, [class*="Sticker"] img')
        for img in sticker_imgs:
            sticker_name = img.attrib.get('alt', '') if hasattr(img, 'attrib') else ''
            sticker_img = img.attrib.get('src', '') if hasattr(img, 'attrib') else ''
            if sticker_name:
                stickers.append(StickerInfo(
                    name=sticker_name,
                    img_url=sticker_img,
                    price=0.0,  # Price requires detail view or API lookup
                ))
        return stickers

    def _parse_store_page_generic(self, response) -> list[ScrapedItem]:
        """
        Generic fallback parser when specific selectors don't match.
        Looks for price patterns and nearby text to identify items.
        """
        items = []
        # Try to find all elements with price-like text
        all_elements = response.css('[class*="card"], [class*="item"], [class*="Card"], [class*="Item"]')
        for el in all_elements:
            text = el.css('::text').getall()
            text_joined = ' '.join(t.strip() for t in text)

            # Must have a price
            if '$' not in text_joined:
                continue

            # Must look like a skin name
            if '|' not in text_joined and '★' not in text_joined:
                continue

            item = self._extract_item_from_card(el)
            if item and item.name != "Unknown":
                items.append(item)

        return items

    # ════════════════════════════════════════════════════════════
    # PAGINATED SCAN (main entry point)
    # ════════════════════════════════════════════════════════════

    async def scan_one_page(
        self,
        db_conn=None,
        sort: str = "Newest",
    ) -> ScrapeResult:
        """
        Fetch one page of the inventory at the current offset,
        compare against the DB, and return new/changed items.

        Advances offset by PAGE_SIZE each call.
        When we reach the end of inventory the scan wraps to offset=0
        and increments full_scans_completed.
        """
        start = time.time()
        errors: list[str] = []
        state = self.state

        # On very first start, load known IDs from DB into memory
        if db_conn and not state.known_ids_loaded:
            state.known_ids = await _load_known_ids_from_db(db_conn)
            state.known_ids_loaded = True
            logger.info(f"Loaded {len(state.known_ids)} known items from DB")

        # Fetch one page
        raw_items, fetch_errors, fetch_ms = await self._fetch_page(
            offset=state.current_offset,
            limit=config.PAGE_SIZE,
            sort=sort,
        )
        errors.extend(fetch_errors)

        if not raw_items and fetch_errors:
            # Fetch failed entirely — don't advance offset
            return ScrapeResult(
                items=[], new_count=0, total_scraped=0,
                duration_ms=(time.time() - start) * 1000,
                errors=errors, source="api",
            )

        # Determine if we reached end of inventory
        reached_end = len(raw_items) < config.PAGE_SIZE

        logger.info(
            f"Page offset={state.current_offset}: {len(raw_items)} items fetched"
            + (" [end of inventory]" if reached_end else "")
        )

        # Normalize all fetched items
        parsed: list[ScrapedItem] = []
        for raw in raw_items:
            item = self._normalize_api_item(raw)
            if item and not self._is_excluded(item):
                parsed.append(item)

        # Compare against known items → classify as new or price drop
        new_items: list[ScrapedItem] = []
        price_drop_items: list[ScrapedItem] = []

        for item in parsed:
            if state.is_first_run:
                # First run: silently seed the DB, don't alert
                state.known_ids[item.id] = item.price_cents
                if db_conn:
                    await _upsert_silent(db_conn, item)
            else:
                old_price = state.known_ids.get(item.id)
                if old_price is None:
                    # Brand new item
                    item.is_new = True
                    new_items.append(item)
                    state.known_ids[item.id] = item.price_cents
                    if db_conn:
                        await _upsert_silent(db_conn, item)
                else:
                    # Known item — check for price drop
                    if _is_price_drop(old_price, item.price_cents):
                        drop_pct = (old_price - item.price_cents) / old_price * 100
                        item.price_drop_from = old_price
                        item.price_drop_pct = round(drop_pct, 1)
                        price_drop_items.append(item)
                        state.known_ids[item.id] = item.price_cents
                        if db_conn:
                            await _upsert_silent(db_conn, item)

        # Advance offset
        state.current_offset += config.PAGE_SIZE
        state.total_pages_scanned += 1

        if reached_end or (config.MAX_PAGES_PER_SCAN > 0
                           and state.total_pages_scanned % config.MAX_PAGES_PER_SCAN == 0):
            state.current_offset = 0
            state.full_scans_completed += 1
            logger.info(
                f"Full scan #{state.full_scans_completed} complete "
                f"({state.total_pages_scanned} pages total, "
                f"{len(state.known_ids)} known items)"
            )

        if state.is_first_run and reached_end:
            state.is_first_run = False
            logger.info(
                f"Initial seeding complete: {len(state.known_ids)} items in DB. "
                f"Now watching for new listings and price drops."
            )
            self.initialized = True
        elif not state.is_first_run:
            self.initialized = True

        all_alerted = new_items + price_drop_items
        duration = (time.time() - start) * 1000

        if new_items:
            logger.info(f"  → {len(new_items)} NEW items")
        if price_drop_items:
            logger.info(f"  → {len(price_drop_items)} PRICE DROPS")

        return ScrapeResult(
            items=all_alerted if not state.is_first_run else [],
            new_count=len(all_alerted),
            total_scraped=len(parsed),
            duration_ms=duration,
            errors=errors,
            source="api",
        )

    # ════════════════════════════════════════════════════════════
    # RAW PAGE FETCHER
    # ════════════════════════════════════════════════════════════

    async def _fetch_page(
        self,
        offset: int,
        limit: int,
        sort: str = "Newest",
        search: str = "",
    ) -> tuple[list[dict], list[str], float]:
        """Fetch one raw API page. Returns (raw_items, errors, ms)."""
        from scrapling.fetchers import Fetcher

        start = time.time()
        errors: list[str] = []
        raw_items: list[dict] = []

        params = {
            "gameId": config.GAME_ID,
            "offset": offset,
            "limit": limit,
            "sortType": sort,
        }
        if search:
            params["searchValue"] = search

        url = f"{config.TRADEIT_API_URL}?{urlencode(params)}"

        try:
            response = Fetcher.get(
                url,
                stealthy_headers=True,
                follow_redirects=True,
            )

            if response.status == 429:
                errors.append("Rate limited (429) — backing off")
                logger.warning("API rate limited (429)")
            elif response.status != 200:
                errors.append(f"API status {response.status}")
                logger.warning(f"API returned {response.status} for offset={offset}")
            else:
                try:
                    data = json.loads(response.body)
                    raw_items = data.get("items", data.get("data", []))
                    if not isinstance(raw_items, list):
                        raw_items = []
                        errors.append("Unexpected API response shape")
                except (json.JSONDecodeError, Exception) as e:
                    errors.append(f"JSON parse error: {e}")

        except Exception as e:
            errors.append(f"Fetch error: {e}")
            logger.error(f"Fetch failed at offset={offset}: {e}")

        ms = (time.time() - start) * 1000
        return raw_items, errors, ms

    def _normalize_api_item(self, raw: dict) -> Optional[ScrapedItem]:
        """Normalize a raw API response item into our ScrapedItem model."""
        item_id = str(raw.get("id", raw.get("assetId", "")))
        if not item_id:
            return None

        name = raw.get("name", "Unknown")
        price_cents = raw.get("storePrice", raw.get("price", 0))

        # Extract stickers
        stickers = []
        raw_stickers = raw.get("stickers", [])
        for s in raw_stickers:
            stickers.append(StickerInfo(
                name=s.get("name", ""),
                price=s.get("price", 0) / 100,  # API sends cents
                img_url=s.get("imgURL", s.get("img", "")),
            ))

        total_sticker_value = sum(s.price for s in stickers)

        # Determine condition from name
        condition = ""
        for cond in ["Factory New", "Minimal Wear", "Field-Tested", "Well-Worn", "Battle-Scarred"]:
            if f"({cond})" in name:
                condition = cond
                break

        return ScrapedItem(
            id=item_id,
            asset_id=str(raw.get("assetId", item_id)),
            name=name,
            price=price_cents / 100,
            price_cents=price_cents,
            float_value=raw.get("floatValue"),
            pattern_index=raw.get("patternIndex", raw.get("paintSeed")),
            paint_index=raw.get("paintIndex"),
            condition=condition,
            icon_url=raw.get("imgURL", raw.get("iconUrl", raw.get("icon", ""))),
            stickers=stickers,
            total_sticker_value=total_sticker_value,
            steam_tags=raw.get("steamTags", []),
            item_type=raw.get("metaMappings", {}).get("type") if isinstance(raw.get("metaMappings"), dict) else raw.get("type"),
            trade_url=f"https://tradeit.gg/csgo/store?search={quote(name)}",
            discount_percent=None,
            source="api",
        )

    # ════════════════════════════════════════════════════════════
    # DETAIL SCRAPING (for watchlist matches)
    # ════════════════════════════════════════════════════════════

    async def scrape_item_details(self, item_name: str) -> Optional[ScrapedItem]:
        """
        Search for a specific item and scrape its full details.
        Uses the browser to click into the detail modal.
        """
        from scrapling.fetchers import StealthyFetcher

        try:
            search_url = f"{config.TRADEIT_STORE_URL}?search={quote(item_name)}&gameId={config.GAME_ID}"

            async def click_first_item(page):
                """Click the first item's 'more details' button."""
                await page.wait_for_timeout(2000)
                # Try clicking the expand/detail button
                more_btn = await page.query_selector('.more-btn, [class*="detail"], [class*="expand"]')
                if more_btn:
                    await more_btn.click()
                    await page.wait_for_timeout(2000)

            response = await StealthyFetcher.async_fetch(
                search_url,
                headless=config.HEADLESS,
                network_idle=True,
                solve_cloudflare=config.SOLVE_CLOUDFLARE,
                timeout=config.TIMEOUT_MS,
                page_action=click_first_item,
            )

            if response.status == 200:
                # Try to parse the detail modal
                detail = self._parse_detail_modal(response)
                if detail:
                    return detail

                # Fallback: parse from card view
                items = self._parse_store_page(response)
                if items:
                    return items[0]

        except Exception as e:
            logger.error(f"Detail scrape failed for '{item_name}': {e}")

        return None

    def _parse_detail_modal(self, response) -> Optional[ScrapedItem]:
        """Parse item details from an opened detail modal."""
        # Look for modal/dialog/overlay elements
        modal = response.css('.item-detail, .modal-content, [class*="Detail"], [class*="dialog"]')
        if not modal:
            return None

        modal_el = modal[0]

        # Extract detailed float value
        float_value = None
        float_texts = modal_el.css('[class*="float"]::text, [class*="Float"]::text').getall()
        for t in float_texts:
            t = t.strip()
            match = re.match(r'0\.\d+', t)
            if match:
                float_value = float(match.group())
                break

        # Extract pattern/paint seed
        pattern_index = None
        pattern_texts = modal_el.css('[class*="pattern"]::text, [class*="Pattern"]::text, [class*="seed"]::text').getall()
        for t in pattern_texts:
            t = t.strip()
            if t.isdigit():
                pattern_index = int(t)
                break

        # Extract detailed sticker info with prices
        stickers = []
        sticker_els = modal_el.css('[class*="sticker"], [class*="Sticker"]')
        for sel in sticker_els:
            name = ""
            price = 0.0
            img_url = ""

            name_el = sel.css('::text').getall()
            for t in name_el:
                t = t.strip()
                if len(t) > 2 and '$' not in t:
                    name = t
                    break

            price_el = sel.css('::text').getall()
            for t in price_el:
                match = re.search(r'\$[\d,.]+', t.strip())
                if match:
                    price = float(re.sub(r'[^\d.]', '', match.group()))
                    break

            img = sel.css('img')
            if img and hasattr(img[0], 'attrib'):
                img_url = img[0].attrib.get('src', '')

            if name:
                stickers.append(StickerInfo(name=name, price=price, img_url=img_url))

        # Build the item from modal data + parent card data
        item = self._extract_item_from_card(modal_el)
        if item:
            if float_value is not None:
                item.float_value = float_value
            if pattern_index is not None:
                item.pattern_index = pattern_index
            if stickers:
                item.stickers = stickers
                item.total_sticker_value = sum(s.price for s in stickers)

        return item

    # ════════════════════════════════════════════════════════════
    # HYBRID SCRAPING (combines API + browser)
    # ════════════════════════════════════════════════════════════

    async def hybrid_scrape(self, db_conn=None, use_browser: bool = False) -> ScrapeResult:
        """Delegates to scan_one_page (paginated, DB-aware)."""
        return await self.scan_one_page(db_conn=db_conn)

    # ════════════════════════════════════════════════════════════
    # HELPERS
    # ════════════════════════════════════════════════════════════

    def _is_excluded(self, item: ScrapedItem) -> bool:
        """Check if item should be excluded (stickers, agents, cases, etc)."""
        if item.item_type is not None and item.item_type in config.EXCLUDED_TYPES:
            return True

        name_lower = item.name.lower()
        if 'sticker |' in name_lower or name_lower.startswith('agent |'):
            return True

        for tag in item.steam_tags:
            if tag in config.EXCLUDED_TAGS:
                return True

        return False


# ════════════════════════════════════════════════════════════════
# Module-level helpers used by scan_one_page
# ════════════════════════════════════════════════════════════════

async def _load_known_ids_from_db(db_conn) -> dict[str, int]:
    """Load all known item IDs and their prices from the database."""
    try:
        from scraper import db as database
        return await database.get_all_known_ids(db_conn)
    except Exception as e:
        logger.error(f"Failed to load known IDs from DB: {e}")
        return {}


async def _upsert_silent(db_conn, item: ScrapedItem) -> None:
    """Upsert item to DB, swallow errors so they don't break the scan."""
    try:
        from scraper import db as database
        await database.upsert_item(db_conn, item)
    except Exception as e:
        logger.debug(f"DB upsert error for {item.id}: {e}")


def _is_price_drop(old_price_cents: int, new_price_cents: int) -> bool:
    """Return True if price dropped by at least PRICE_DROP_THRESHOLD."""
    if old_price_cents <= 0 or new_price_cents >= old_price_cents:
        return False
    drop_fraction = (old_price_cents - new_price_cents) / old_price_cents
    return drop_fraction >= config.PRICE_DROP_THRESHOLD
