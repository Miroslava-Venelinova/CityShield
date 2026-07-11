"""
Shared pytest setup.

The backend modules import each other as top-level packages
(`from config import cfg`, `from services import common`, ...), so the
backend/ directory itself must be on sys.path regardless of where pytest
is invoked from.
"""

import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"


def load_fixture(name: str) -> str:
    return (FIXTURES_DIR / name).read_text(encoding="utf-8")
