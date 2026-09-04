#!/usr/bin/env just --justfile

set shell := ["bash", "-cu"]

# Default to listing recipes
default:
  @just --list

# ============================================================================
# Python Package
# ============================================================================

# Install the package and dev dependencies
install:
  uv venv
  uv pip install -e ".[dev]"

# Run tests
test:
  uv run pytest tests/ -v

# Run tests with coverage (terminal + lcov for unified report)
test-cov:
  uv run pytest tests/ -v --cov=deluge_tools --cov-report=term-missing --cov-report=lcov:coverage/python.lcov

# Lint with ruff
lint:
  uv run ruff check deluge_tools/ tests/

# Format code with ruff
fmt:
  uv run ruff format deluge_tools/ tests/

# Type-check with pyright
typecheck:
  uv run pyright

# Install pre-commit hooks
pre-commit-install:
  prek install || pre-commit install

# Run pre-commit hooks against all files
pre-commit:
  prek run --all-files || pre-commit run --all-files

# Clean Python build artifacts
clean-py:
  rm -rf build/ dist/ *.egg-info deluge_tools.egg-info .pytest_cache __pycache__

# ============================================================================
# Web Frontend
# ============================================================================

# Install web dependencies
web-install:
  cd web && npm install

# Start dev server (localhost:4321)
web-dev:
  cd web && npm run dev

# Build static site
web-build:
  cd web && npm run build

# Lint the web frontend
web-lint:
  cd web && npm run lint

# Type-check the web frontend
web-typecheck:
  cd web && npx tsc --noEmit

# Run web frontend tests
web-test:
  cd web && npm test

# Run web frontend tests with coverage (lcov for unified report)
web-test-cov:
  cd web && npx vitest run --coverage

# Rebuild Python wheel for Pyodide
web-rebuild-wheel:
  cd web && bash build-wheel.sh

# ============================================================================
# Audio Processing
# ============================================================================

# Convert all .wav files in web/public/audio/ to .mp3 and delete originals
wav-to-mp3:
  #!/bin/bash
  set -e
  cd web/public/audio
  shopt -s nullglob

  count=0
  for wav in *.wav; do
    if [ -f "$wav" ]; then
      mp3="${wav%.*}.mp3"
      echo "Converting '$wav' → '$mp3'"
      ffmpeg -i "$wav" -q:a 0 -map a "$mp3" -y -loglevel error
      rm "$wav"
      count=$((count + 1))
    fi
  done

  if [ $count -eq 0 ]; then
    echo "No .wav files found in web/public/audio/"
  else
    echo "✓ Converted $count file(s)"
  fi

# List audio files currently in web/public/audio/
audio-list:
  @ls -lh web/public/audio/ || echo "Directory does not exist"

# ============================================================================
# Development Workflow
# ============================================================================

# Full install (Python + web)
setup: install web-install

# Run full test suite
check: lint typecheck test web-lint web-typecheck web-test

# Build everything (Python + web)
build: web-rebuild-wheel web-build

# Run all tests with coverage, merge into one local HTML report
coverage: test-cov web-test-cov
  #!/bin/bash
  set -e
  command -v lcov >/dev/null || { echo "Missing 'lcov'. Install with: sudo apt-get install -y lcov"; exit 1; }
  mkdir -p coverage
  sed 's|^SF:|SF:web/|' web/coverage/lcov.info > coverage/web.lcov
  lcov --add-tracefile coverage/python.lcov --add-tracefile coverage/web.lcov --output-file coverage/merged.lcov
  genhtml coverage/merged.lcov --output-directory coverage/html
  echo "Combined coverage report: coverage/html/index.html"

# Full dev setup + start web server
dev: setup web-dev

# Clean all build artifacts
clean: clean-py
  cd web && rm -rf dist/ node_modules/ .astro/

# One-time setup for fresh clone
init:
  git config core.hooksPath .git/hooks 2>/dev/null || true
  just setup
