from __future__ import annotations

from pathlib import Path

import pytest

FACTORY_CARD_DIR = Path(__file__).parent / "fixtures" / "factory-card"


@pytest.fixture
def factory_card() -> Path:
    if not any(FACTORY_CARD_DIR.glob("*")):
        pytest.skip("factory card fixture not present — run `just fetch-fixtures`")
    return FACTORY_CARD_DIR
