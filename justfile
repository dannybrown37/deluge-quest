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
  pytest tests/ -v

# Run tests with coverage
test-cov:
  pytest tests/ -v --cov=deluge_tools --cov-report=term-missing

# Lint with ruff
lint:
  ruff check deluge_tools/ tests/

# Format code with ruff
fmt:
  ruff format deluge_tools/ tests/

# Type-check with pyright (if installed)
typecheck:
  pyright deluge_tools/ tests/ || echo "pyright not installed"

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

  count=0
  for wav in *.wav; do
    if [ -f "$wav" ]; then
      mp3="${wav%.*}.mp3"
      echo "Converting '$wav' → '$mp3'"
      ffmpeg -i "$wav" -q:a 0 -map a "$mp3" -y -loglevel error
      rm "$wav"
      ((count++))
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
check: lint test

# Build everything (Python + web)
build: web-rebuild-wheel web-build

# Full dev setup + start web server
dev: setup web-dev

# Clean all build artifacts
clean: clean-py
  cd web && rm -rf dist/ node_modules/ .astro/

# One-time setup for fresh clone
init:
  git config core.hooksPath .git/hooks 2>/dev/null || true
  just setup
