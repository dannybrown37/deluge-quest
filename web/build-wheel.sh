#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
uv pip install build --quiet
uv run python -m build --wheel --outdir web/public/py/
echo "Wheel built → web/public/py/"
