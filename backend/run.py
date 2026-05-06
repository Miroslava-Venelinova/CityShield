"""
Entry point for the backend.
Runs all services concurrently every 10 minutes using asyncio.
Each service runs in its own thread (via asyncio.to_thread) so they
don't block each other while still using the existing synchronous code.
"""

import asyncio
import logging
import sys
from datetime import datetime

from services import varnatraffic_service, vik_service, epro_service

# ---------------------------------------------------------------------------
# Logging setup
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("backend.log", encoding="utf-8"),
    ],
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
INTERVAL_SECONDS = 600  # 10 minutes

SERVICES = [
    ("VarnaTraffic", varnatraffic_service.main),
    ("VIK",          vik_service.main),
    ("ePro",         epro_service.main),
]

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
async def run_service(name: str, fn) -> None:
    """
    Run a synchronous service function in a thread so it doesn't block
    the event loop.  Any unhandled exception is caught and logged here
    so one crashing service never kills the others.
    """
    log.info("[%s] Starting...", name)
    start = datetime.now()
    try:
        await asyncio.to_thread(fn)
        elapsed = (datetime.now() - start).total_seconds()
        log.info("[%s] Finished in %.1fs", name, elapsed)
    except Exception as exc:
        log.exception("[%s] Unhandled exception: %s", name, exc)


async def run_all() -> None:
    """Run every service concurrently and wait for all to finish."""
    log.info("=" * 50)
    log.info("Running all services at %s", datetime.now().strftime("%H:%M:%S"))
    log.info("=" * 50)
    await asyncio.gather(*(run_service(name, fn) for name, fn in SERVICES))
    log.info("All services done.")


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
async def main() -> None:
    while True:
        await run_all()
        log.info("Sleeping for %d minutes...\n", INTERVAL_SECONDS // 60)
        await asyncio.sleep(INTERVAL_SECONDS)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("Stopped by user.")