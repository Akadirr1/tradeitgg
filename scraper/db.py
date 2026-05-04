"""
SQLite persistence layer for scraped items and price history.
Uses aiosqlite for async operations.
"""
from __future__ import annotations
import json
import logging
import aiosqlite
from datetime import datetime, timedelta
from typing import Optional

from scraper.config import DB_PATH, MAX_HISTORY_DAYS
from scraper.models import ScrapedItem, StickerInfo

logger = logging.getLogger("tradeit.db")


async def init_db(db_path: str = DB_PATH) -> aiosqlite.Connection:
    """Initialize the database and create tables if they don't exist."""
    db = await aiosqlite.connect(db_path)
    await db.execute("PRAGMA journal_mode=WAL")
    await db.execute("PRAGMA synchronous=NORMAL")

    await db.executescript("""
        CREATE TABLE IF NOT EXISTS items (
            id TEXT PRIMARY KEY,
            asset_id TEXT,
            name TEXT NOT NULL,
            price_cents INTEGER NOT NULL,
            float_value REAL,
            pattern_index INTEGER,
            paint_index INTEGER,
            condition TEXT,
            icon_url TEXT,
            stickers_json TEXT DEFAULT '[]',
            total_sticker_value_cents INTEGER DEFAULT 0,
            steam_tags_json TEXT DEFAULT '[]',
            item_type INTEGER,
            trade_url TEXT,
            discount_percent REAL,
            first_seen_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL,
            source TEXT DEFAULT 'scraper'
        );

        CREATE TABLE IF NOT EXISTS price_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_id TEXT NOT NULL,
            price_cents INTEGER NOT NULL,
            recorded_at TEXT NOT NULL,
            FOREIGN KEY (item_id) REFERENCES items(id)
        );

        CREATE INDEX IF NOT EXISTS idx_items_name ON items(name);
        CREATE INDEX IF NOT EXISTS idx_items_last_seen ON items(last_seen_at);
        CREATE INDEX IF NOT EXISTS idx_price_history_item ON price_history(item_id);
        CREATE INDEX IF NOT EXISTS idx_price_history_date ON price_history(recorded_at);
    """)

    await db.commit()
    logger.info(f"Database initialized at {db_path}")
    return db


async def upsert_item(db: aiosqlite.Connection, item: ScrapedItem) -> tuple[bool, int | None]:
    """
    Insert or update an item.
    Returns (is_new: bool, old_price_cents: int | None).
    old_price_cents is None if item is new, otherwise the previous price.
    """
    now = datetime.utcnow().isoformat()
    stickers_json = json.dumps([s.model_dump() for s in item.stickers])
    tags_json = json.dumps(item.steam_tags)

    # Check if item exists
    cursor = await db.execute("SELECT id, price_cents FROM items WHERE id = ?", (item.id,))
    existing = await cursor.fetchone()

    if existing:
        old_price = existing[1]
        await db.execute("""
            UPDATE items SET
                price_cents = ?,
                float_value = ?,
                pattern_index = ?,
                stickers_json = ?,
                total_sticker_value_cents = ?,
                discount_percent = ?,
                last_seen_at = ?,
                source = ?
            WHERE id = ?
        """, (
            item.price_cents,
            item.float_value,
            item.pattern_index,
            stickers_json,
            int(item.total_sticker_value * 100),
            item.discount_percent,
            now,
            item.source,
            item.id,
        ))

        # Record price change
        if old_price != item.price_cents:
            await db.execute(
                "INSERT INTO price_history (item_id, price_cents, recorded_at) VALUES (?, ?, ?)",
                (item.id, item.price_cents, now)
            )

        await db.commit()
        return False, old_price
    else:
        await db.execute("""
            INSERT INTO items (
                id, asset_id, name, price_cents, float_value, pattern_index,
                paint_index, condition, icon_url, stickers_json,
                total_sticker_value_cents, steam_tags_json, item_type,
                trade_url, discount_percent, first_seen_at, last_seen_at, source
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            item.id, item.asset_id, item.name, item.price_cents,
            item.float_value, item.pattern_index, item.paint_index,
            item.condition, item.icon_url, stickers_json,
            int(item.total_sticker_value * 100), tags_json,
            item.item_type, item.trade_url, item.discount_percent,
            now, now, item.source,
        ))

        await db.execute(
            "INSERT INTO price_history (item_id, price_cents, recorded_at) VALUES (?, ?, ?)",
            (item.id, item.price_cents, now)
        )

        await db.commit()
        return True, None


async def get_recent_items(
    db: aiosqlite.Connection,
    limit: int = 50,
    name_filter: Optional[str] = None,
) -> list[ScrapedItem]:
    """Get recently seen items, optionally filtered by name."""
    query = "SELECT * FROM items"
    params: list = []

    if name_filter:
        query += " WHERE name LIKE ?"
        params.append(f"%{name_filter}%")

    query += " ORDER BY last_seen_at DESC LIMIT ?"
    params.append(limit)

    cursor = await db.execute(query, params)
    rows = await cursor.fetchall()
    columns = [desc[0] for desc in cursor.description]

    items = []
    for row in rows:
        data = dict(zip(columns, row))
        stickers = [StickerInfo(**s) for s in json.loads(data.get("stickers_json", "[]"))]
        items.append(ScrapedItem(
            id=data["id"],
            asset_id=data.get("asset_id", ""),
            name=data["name"],
            price=data["price_cents"] / 100,
            price_cents=data["price_cents"],
            float_value=data.get("float_value"),
            pattern_index=data.get("pattern_index"),
            paint_index=data.get("paint_index"),
            condition=data.get("condition", ""),
            icon_url=data.get("icon_url", ""),
            stickers=stickers,
            total_sticker_value=data.get("total_sticker_value_cents", 0) / 100,
            steam_tags=json.loads(data.get("steam_tags_json", "[]")),
            item_type=data.get("item_type"),
            trade_url=data.get("trade_url", ""),
            discount_percent=data.get("discount_percent"),
            source=data.get("source", "scraper"),
        ))

    return items


async def get_all_known_ids(db: aiosqlite.Connection) -> dict[str, int]:
    """
    Return a dict of {item_id: price_cents} for all items in the DB.
    Used to diff against freshly scraped pages.
    """
    cursor = await db.execute("SELECT id, price_cents FROM items")
    rows = await cursor.fetchall()
    return {row[0]: row[1] for row in rows}


async def get_price_history(
    db: aiosqlite.Connection,
    item_id: str,
    days: int = 7,
) -> list[dict]:
    """Get price history for a specific item."""
    since = (datetime.utcnow() - timedelta(days=days)).isoformat()
    cursor = await db.execute(
        "SELECT price_cents, recorded_at FROM price_history WHERE item_id = ? AND recorded_at > ? ORDER BY recorded_at",
        (item_id, since)
    )
    rows = await cursor.fetchall()
    return [{"price_cents": r[0], "recorded_at": r[1]} for r in rows]


async def cleanup_old_data(db: aiosqlite.Connection):
    """Remove old price history entries."""
    cutoff = (datetime.utcnow() - timedelta(days=MAX_HISTORY_DAYS)).isoformat()
    await db.execute("DELETE FROM price_history WHERE recorded_at < ?", (cutoff,))
    await db.commit()
    logger.info("Cleaned up old price history data")


async def get_item_count(db: aiosqlite.Connection) -> int:
    """Get total number of tracked items."""
    cursor = await db.execute("SELECT COUNT(*) FROM items")
    row = await cursor.fetchone()
    return row[0] if row else 0
