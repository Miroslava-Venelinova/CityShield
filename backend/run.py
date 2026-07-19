"""
Entry point for the backend.
Runs all services concurrently using asyncio. Each service runs in an
independent loop inside a dedicated thread (via asyncio.to_thread) so
services never block each other.

Per-service intervals are read from config (which reads from .env).
Leave a service's interval blank in .env to use DEFAULT_INTERVAL.
"""

import asyncio
import logging
import sys
from datetime import datetime

from config import cfg
from services import (
    epro_service,
    heating_service,
    roads_service,
    varnatraffic_service,
    vik_service,
)

# ---------------------------------------------------------------------------
# Logging setup
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=cfg.log_level,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("backend.log", encoding="utf-8"),
    ],
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Service registry
# Each entry: (display_name, callable, interval_seconds | None)
# None → falls back to cfg.DEFAULT_INTERVAL
# ---------------------------------------------------------------------------
SERVICES: list[tuple[str, object, int | None]] = [
    ("VarnaTraffic", varnatraffic_service.main, cfg.VT_INTERVAL),
    ("VIK",          vik_service.main,          cfg.VIK_INTERVAL),
    ("ePro",         epro_service.main,         cfg.EPRO_INTERVAL),
    ("Heating",      heating_service.main,      cfg.HEATING_INTERVAL),
    ("Roads",        roads_service.main,        cfg.ROADS_INTERVAL),
]

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
async def run_service(name: str, fn) -> None:
    """
    Run a synchronous service function in a thread so it doesn't block
    the event loop. Any unhandled exception is caught and logged here
    so one crashing service never kills the others.
    """
    start = datetime.now()
    try:
        await asyncio.to_thread(fn)
        elapsed = (datetime.now() - start).total_seconds()
        log.info("[%s] Finished in %.1fs", name, elapsed)
    except Exception as exc:
        log.exception("[%s] Unhandled exception: %s", name, exc)


async def service_loop(name: str, fn, interval: int) -> None:
    """
    Continuously run a single service on its own cadence.
    The interval clock starts AFTER the service finishes, so a slow
    run never causes two overlapping executions of the same service.
    """
    while True:
        await run_service(name, fn)
        log.info("[%s] Next run in %d minute(s).\n", name, interval // 60)
        await asyncio.sleep(interval)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
async def main() -> None:
    tasks = []
    for name, fn, interval in SERVICES:
        resolved = interval if interval is not None else cfg.DEFAULT_INTERVAL
        log.info("Scheduling  %-16s  every %d min", name, resolved // 60)
        tasks.append(asyncio.create_task(service_loop(name, fn, resolved)))

    await asyncio.gather(*tasks)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("Stopped by user.")
