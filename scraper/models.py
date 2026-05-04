"""
Pydantic data models for scraped items, stickers, and filters.
"""
from __future__ import annotations
from typing import Optional
from pydantic import BaseModel, Field
from datetime import datetime


class StickerInfo(BaseModel):
    """Individual sticker on a skin."""
    name: str = ""
    price: float = 0.0          # USD (not cents)
    wear: Optional[float] = None
    img_url: str = ""


class ScrapedItem(BaseModel):
    """A single CS2 item scraped from tradeit.gg."""
    id: str = ""
    asset_id: str = ""
    name: str = "Unknown"
    price: float = 0.0          # USD (not cents)
    price_cents: int = 0        # cents (for extension compat)
    float_value: Optional[float] = None
    pattern_index: Optional[int] = None
    paint_index: Optional[int] = None
    condition: str = ""         # e.g. "Factory New", "Minimal Wear"
    icon_url: str = ""
    stickers: list[StickerInfo] = Field(default_factory=list)
    total_sticker_value: float = 0.0   # USD
    steam_tags: list[str] = Field(default_factory=list)
    item_type: Optional[int] = None
    trade_url: str = ""
    discount_percent: Optional[float] = None
    scraped_at: datetime = Field(default_factory=datetime.utcnow)
    source: str = "scraper"     # "scraper" or "api"
    # Change-detection fields (set by scan_one_page)
    is_new: bool = False
    price_drop_from: Optional[int] = None   # old price in cents
    price_drop_pct: Optional[float] = None  # e.g. 12.5 for 12.5% drop

    def to_extension_format(self) -> dict:
        """Convert to the format the Chrome extension expects."""
        return {
            "id": self.id,
            "assetId": self.asset_id,
            "name": self.name,
            "price": self.price_cents,
            "floatValue": self.float_value,
            "patternIndex": self.pattern_index,
            "paintIndex": self.paint_index,
            "iconUrl": self.icon_url,
            "type": self.item_type,
            "steamTags": self.steam_tags,
            "tradeUrl": self.trade_url,
            "timestamp": int(self.scraped_at.timestamp() * 1000),
            "stickers": [
                {"name": s.name, "price": int(s.price * 100), "imgURL": s.img_url}
                for s in self.stickers
            ],
            "source": self.source,
            "totalStickerValue": int(self.total_sticker_value * 100),
            "discountPercent": self.discount_percent,
            # Change-detection
            "isNew": self.is_new,
            "priceDropFrom": self.price_drop_from,
            "priceDropPct": self.price_drop_pct,
        }


class ScrapeResult(BaseModel):
    """Result of a single scrape cycle."""
    items: list[ScrapedItem] = Field(default_factory=list)
    new_count: int = 0
    total_scraped: int = 0
    duration_ms: float = 0.0
    errors: list[str] = Field(default_factory=list)
    source: str = "scraper"


class WatchlistEntry(BaseModel):
    """A watchlist filter received from the extension."""
    name: str
    patterns: str = ""
    float_min: Optional[float] = None
    float_max: Optional[float] = None
    filter_mode: str = "float"   # "float" | "pattern"
    min_sticker_value: Optional[float] = None


class ScrapeConfig(BaseModel):
    """Configuration pushed from the extension."""
    polling_interval: int = 15
    watchlist: list[WatchlistEntry] = Field(default_factory=list)
    category_monitors: list[dict] = Field(default_factory=list)
    sticker_monitors: list[dict] = Field(default_factory=list)
