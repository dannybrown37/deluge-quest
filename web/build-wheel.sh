#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
uv pip install build --quiet
rm -f web/public/py/*.whl
uv run python -m build --wheel --outdir web/public/py/

wheel_name=$(basename web/public/py/*.whl)
printf '{"wheel": "%s"}\n' "$wheel_name" >web/public/py/manifest.json

echo "Wheel built → web/public/py/$wheel_name"
