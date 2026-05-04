"""
FastAPI server that bridges the Scrapling scraper with the Chrome extension.
Provides REST API + WebSocket for real-time item updates.
"""
from __future__ import annotations
import json
import logging
import asyncio
from typing import Optional
from contextlib import asynccontextmanager

import aiosqlite
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from scraper import config
from scraper.scraper import TradeItScraper
from scraper.models import ScrapeResult, ScrapeConfig
from scraper import db as database

logger = logging.getLogger("tradeit.server")

# ── Global state ────────────────────────────────────────────
scraper = TradeItScraper()
db_conn: Optional[aiosqlite.Connection] = None
connected_clients: set[WebSocket] = set()
scrape_task: Optional[asyncio.Task] = None
current_config = ScrapeConfig()
last_result: Optional[ScrapeResult] = None


# ── Periodic scraping loop ──────────────────────────────────
async def scrape_loop():
    """Background task that periodically scrapes tradeit.gg."""
    global last_result
    logger.info(f"Scrape loop started (interval: {current_config.polling_interval}s)")

    while True:
        try:
            # Pass db_conn so scan_one_page can compare against DB and upsert
            result = await scraper.hybrid_scrape(db_conn=db_conn)
            last_result = result

            if result.new_count > 0:
                logger.info(
                    f"Alert: {result.new_count} item(s) — "
                    f"page offset={scraper.state.current_offset - config.PAGE_SIZE}, "
                    f"known={len(scraper.state.known_ids)}"
                )
                await broadcast_items(result)
            else:
                logger.debug(
                    f"Page OK, 0 alerts — "
                    f"offset={scraper.state.current_offset}, "
                    f"known={len(scraper.state.known_ids)}, "
                    f"scans={scraper.state.full_scans_completed}"
                )

            if result.errors:
                for err in result.errors:
                    logger.warning(f"Scrape error: {err}")

        except asyncio.CancelledError:
            logger.info("Scrape loop cancelled")
            break
        except Exception as e:
            logger.error(f"Scrape loop error: {e}")

        # Wait for next cycle
        await asyncio.sleep(current_config.polling_interval)


async def broadcast_items(result: ScrapeResult):
    """Push new items to all connected WebSocket clients."""
    if not connected_clients or not result.items:
        return

    # Convert items to extension-compatible format
    items_data = [item.to_extension_format() for item in result.items]

    message = json.dumps({
        "type": "NEW_ITEMS",
        "items": items_data,
        "meta": {
            "newCount": result.new_count,
            "totalScraped": result.total_scraped,
            "durationMs": round(result.duration_ms, 1),
            "source": result.source,
            "errors": result.errors,
        }
    })

    dead_clients = set()
    for ws in connected_clients:
        try:
            await ws.send_text(message)
        except Exception:
            dead_clients.add(ws)

    connected_clients.difference_update(dead_clients)
    if dead_clients:
        logger.info(f"Removed {len(dead_clients)} dead WebSocket clients")


# ── App lifecycle ───────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown logic."""
    global db_conn, scrape_task

    # Startup
    logger.info("Starting TradeIt Tracker scraper backend...")
    db_conn = await database.init_db()

    # Start the scrape loop
    scrape_task = asyncio.create_task(scrape_loop())
    logger.info(f"Server ready on {config.HOST}:{config.PORT}")

    yield

    # Shutdown
    logger.info("Shutting down...")
    if scrape_task:
        scrape_task.cancel()
        try:
            await scrape_task
        except asyncio.CancelledError:
            pass

    if db_conn:
        await db_conn.close()

    logger.info("Shutdown complete")


# ── FastAPI app ─────────────────────────────────────────────
app = FastAPI(
    title="TradeIt Tracker Scraper",
    description="Scrapling-powered backend for tradeit.gg monitoring",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS — allow Chrome extension to connect
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ════════════════════════════════════════════════════════════
# WebSocket endpoint
# ════════════════════════════════════════════════════════════

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """
    Real-time bidirectional connection with the Chrome extension.

    Server → Client:
      - NEW_ITEMS: pushed whenever new items are scraped
      - STATUS: periodic status updates

    Client → Server:
      - CONFIG_UPDATE: extension pushes its watchlist/settings
      - SCRAPE_NOW: trigger immediate scrape
    """
    await websocket.accept()
    connected_clients.add(websocket)
    logger.info(f"WebSocket client connected ({len(connected_clients)} total)")

    # Send initial status
    await websocket.send_text(json.dumps({
        "type": "CONNECTED",
        "status": {
            "initialized": scraper.initialized,
            "seenCount": len(scraper.state.known_ids),
            "connectedClients": len(connected_clients),
            "pollingInterval": current_config.polling_interval,
            "currentOffset": scraper.state.current_offset,
            "fullScansCompleted": scraper.state.full_scans_completed,
            "lastResult": {
                "newCount": last_result.new_count if last_result else 0,
                "totalScraped": last_result.total_scraped if last_result else 0,
                "source": last_result.source if last_result else "none",
            } if last_result else None,
        }
    }))

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
                await handle_ws_message(msg, websocket)
            except json.JSONDecodeError:
                await websocket.send_text(json.dumps({
                    "type": "ERROR",
                    "error": "Invalid JSON"
                }))
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
    finally:
        connected_clients.discard(websocket)
        logger.info(f"WebSocket client disconnected ({len(connected_clients)} remaining)")


async def handle_ws_message(msg: dict, ws: WebSocket):
    """Handle messages from the Chrome extension."""
    global current_config

    msg_type = msg.get("type", "")

    if msg_type == "CONFIG_UPDATE":
        # Extension pushes its settings/watchlist
        try:
            current_config = ScrapeConfig(**msg.get("config", {}))
            logger.info(f"Config updated: interval={current_config.polling_interval}s, "
                       f"watchlist={len(current_config.watchlist)} items")
            await ws.send_text(json.dumps({"type": "CONFIG_ACK", "ok": True}))
        except Exception as e:
            await ws.send_text(json.dumps({"type": "CONFIG_ACK", "ok": False, "error": str(e)}))

    elif msg_type == "SCRAPE_NOW":
        # Trigger immediate scrape
        logger.info("Manual scrape triggered via WebSocket")
        result = await scraper.hybrid_scrape(db_conn=db_conn)

        await broadcast_items(result)
        await ws.send_text(json.dumps({
            "type": "SCRAPE_RESULT",
            "ok": True,
            "newCount": result.new_count,
            "totalScraped": result.total_scraped,
            "source": result.source,
        }))

    elif msg_type == "SEARCH_ITEM":
        # Deep search for a specific item
        query = msg.get("query", "")
        if query:
            result = await scraper.scrape_via_api(limit=20, search=query)
            items_data = [item.to_extension_format() for item in result.items]
            await ws.send_text(json.dumps({
                "type": "SEARCH_RESULT",
                "items": items_data,
                "query": query,
            }))

    elif msg_type == "GET_STATUS":
        item_count = await database.get_item_count(db_conn) if db_conn else 0
        await ws.send_text(json.dumps({
            "type": "STATUS",
            "status": {
                "initialized": scraper.initialized,
                "seenCount": len(scraper.state.known_ids),
                "dbItemCount": item_count,
                "connectedClients": len(connected_clients),
                "pollingInterval": current_config.polling_interval,
                "currentOffset": scraper.state.current_offset,
                "fullScansCompleted": scraper.state.full_scans_completed,
            }
        }))

    elif msg_type == "PING":
        await ws.send_text(json.dumps({"type": "PONG"}))


# ════════════════════════════════════════════════════════════
# REST API endpoints
# ════════════════════════════════════════════════════════════

@app.get("/api/status")
async def get_status():
    """Get current scraper status."""
    item_count = await database.get_item_count(db_conn) if db_conn else 0
    state = scraper.state
    return {
        "ok": True,
        "initialized": scraper.initialized,
        "seenCount": len(state.known_ids),
        "dbItemCount": item_count,
        "connectedClients": len(connected_clients),
        "pollingInterval": current_config.polling_interval,
        "scan": {
            "currentOffset": state.current_offset,
            "totalPagesScanned": state.total_pages_scanned,
            "fullScansCompleted": state.full_scans_completed,
            "isFirstRun": state.is_first_run,
            "pageSize": config.PAGE_SIZE,
            "maxPagesPerScan": config.MAX_PAGES_PER_SCAN,
        },
        "lastResult": {
            "newCount": last_result.new_count,
            "totalScraped": last_result.total_scraped,
            "durationMs": round(last_result.duration_ms, 1),
            "source": last_result.source,
            "errors": last_result.errors,
        } if last_result else None,
    }


@app.get("/api/items")
async def get_items(
    limit: int = Query(50, ge=1, le=200),
    search: Optional[str] = Query(None),
):
    """Get recently scraped items from the database."""
    if not db_conn:
        return {"items": [], "error": "Database not initialized"}

    items = await database.get_recent_items(db_conn, limit=limit, name_filter=search)
    return {
        "items": [item.to_extension_format() for item in items],
        "count": len(items),
    }


@app.get("/api/items/{item_id}/history")
async def get_item_history(item_id: str, days: int = Query(7, ge=1, le=90)):
    """Get price history for a specific item."""
    if not db_conn:
        return {"history": [], "error": "Database not initialized"}

    history = await database.get_price_history(db_conn, item_id, days=days)
    return {"item_id": item_id, "history": history}


class ScrapeRequest(BaseModel):
    search: str = ""
    limit: int = 40
    use_browser: bool = False


@app.post("/api/scrape")
async def trigger_scrape(req: ScrapeRequest):
    """Manually trigger a scrape."""
    if req.search:
        result = await scraper.scrape_via_api(limit=req.limit, search=req.search)
    elif req.use_browser:
        result = await scraper.scrape_store_page(limit=req.limit)
    else:
        result = await scraper.hybrid_scrape(use_browser=req.use_browser)

    # Store results
    if db_conn and result.items:
        for item in result.items:
            await database.upsert_item(db_conn, item)

    # Broadcast to connected clients
    await broadcast_items(result)

    return {
        "ok": True,
        "newCount": result.new_count,
        "totalScraped": result.total_scraped,
        "durationMs": round(result.duration_ms, 1),
        "source": result.source,
        "errors": result.errors,
        "items": [item.to_extension_format() for item in result.items[:10]],  # Preview
    }


@app.post("/api/cleanup")
async def cleanup():
    """Clean up old data from the database."""
    if db_conn:
        await database.cleanup_old_data(db_conn)
        return {"ok": True}
    return {"ok": False, "error": "Database not initialized"}
