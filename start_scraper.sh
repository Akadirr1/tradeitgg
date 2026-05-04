#!/bin/bash
# Start the TradeIt Tracker scraper backend
# Requires Python 3.10+

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRAPER_DIR="$SCRIPT_DIR/scraper"
VENV_DIR="$SCRAPER_DIR/.venv"

echo "═══════════════════════════════════════════"
echo "  TradeIt Tracker — Scrapling Backend"
echo "═══════════════════════════════════════════"

# Create venv if it doesn't exist
if [ ! -d "$VENV_DIR" ]; then
    echo "Creating Python virtual environment..."
    python3 -m venv "$VENV_DIR"
fi

# Activate venv
source "$VENV_DIR/bin/activate"

# Install dependencies
echo "Installing dependencies..."
pip install -q -r "$SCRAPER_DIR/requirements.txt"

# Install Scrapling browser dependencies (if not already installed)
if ! python3 -c "from scrapling.cli import install" 2>/dev/null; then
    echo "Installing Scrapling browser dependencies..."
    scrapling install
fi

echo ""
echo "Starting scraper backend..."
echo ""

# Run the server
cd "$SCRIPT_DIR"
python3 -m scraper.run "$@"
