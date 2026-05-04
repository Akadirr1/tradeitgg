#!/usr/bin/env python3
"""
Entry point for the TradeIt Tracker scraper backend.

Usage:
    python run.py
    python run.py --port 8000 --host 127.0.0.1
    python run.py --headless --interval 10
"""
import sys
import logging
import argparse

import uvicorn

from scraper import config


def setup_logging():
    """Configure logging for the entire application."""
    log_format = "[%(asctime)s] %(name)-20s %(levelname)-7s %(message)s"
    date_format = "%Y-%m-%d %H:%M:%S"

    logging.basicConfig(
        level=getattr(logging, config.LOG_LEVEL),
        format=log_format,
        datefmt=date_format,
        handlers=[
            logging.StreamHandler(sys.stdout),
        ],
    )

    # Quiet down noisy loggers
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)


def main():
    parser = argparse.ArgumentParser(
        description="TradeIt Tracker — Scrapling-powered scraper backend"
    )
    parser.add_argument("--host", default=config.HOST, help=f"Server host (default: {config.HOST})")
    parser.add_argument("--port", type=int, default=config.PORT, help=f"Server port (default: {config.PORT})")
    parser.add_argument("--interval", type=int, default=config.SCRAPE_INTERVAL,
                        help=f"Scrape interval in seconds (default: {config.SCRAPE_INTERVAL})")
    parser.add_argument("--headless", action="store_true", default=config.HEADLESS,
                        help="Run browser in headless mode (default: True)")
    parser.add_argument("--no-headless", action="store_true",
                        help="Run browser in visible mode (for debugging)")
    parser.add_argument("--log-level", default=config.LOG_LEVEL,
                        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
                        help=f"Log level (default: {config.LOG_LEVEL})")

    args = parser.parse_args()

    # Apply CLI overrides
    config.HOST = args.host
    config.PORT = args.port
    config.SCRAPE_INTERVAL = args.interval
    config.LOG_LEVEL = args.log_level

    if args.no_headless:
        config.HEADLESS = False
    elif args.headless:
        config.HEADLESS = True

    setup_logging()
    logger = logging.getLogger("tradeit.main")

    logger.info("=" * 60)
    logger.info("  TradeIt Tracker — Scrapling Backend")
    logger.info("=" * 60)
    logger.info(f"  Host:          {config.HOST}:{config.PORT}")
    logger.info(f"  Scrape every:  {config.SCRAPE_INTERVAL}s")
    logger.info(f"  Headless:      {config.HEADLESS}")
    logger.info(f"  Database:      {config.DB_PATH}")
    logger.info(f"  Log level:     {config.LOG_LEVEL}")
    logger.info("=" * 60)

    uvicorn.run(
        "scraper.server:app",
        host=config.HOST,
        port=config.PORT,
        log_level=config.LOG_LEVEL.lower(),
        reload=False,
    )


if __name__ == "__main__":
    main()
