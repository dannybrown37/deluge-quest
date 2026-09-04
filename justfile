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

# Download the Synthstrom factory SD card contents as a test fixture (gitignored, not committed)
fetch-fixtures:
  #!/bin/bash
  set -e
  dest="tests/fixtures/factory-card"
  if [ -d "$dest" ] && [ -n "$(ls -A "$dest" 2>/dev/null)" ]; then
    echo "Factory card fixtures already present at $dest"
    exit 0
  fi
  mkdir -p "$dest"
  tmpzip=$(mktemp --suffix=.zip)
  trap 'rm -f "$tmpzip"' EXIT
  echo "Downloading factory card contents..."
  curl -fL -o "$tmpzip" "https://s3.us-east-2.amazonaws.com/synthstrom-audible-deluge/Deluge+V2p1p0+factory+card+contents.zip"
  unzip -q "$tmpzip" -d "$dest"
  echo "Factory card fixtures extracted to $dest"

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

# Run all tests with coverage, merge into one local HTML report. Pass --open to open it in the browser.
coverage open="":
  #!/bin/bash
  set -e
  command -v lcov >/dev/null || { echo "Missing 'lcov'. Install with: sudo apt-get install -y lcov"; exit 1; }
  mkdir -p coverage

  # coverage.py's term-missing report has no ANSI color of its own, unlike vitest's
  # v8 reporter (which colors by threshold automatically under FORCE_COLOR) — so we
  # add the same red/yellow/green threshold coloring by hand for the pytest table.
  colorize_pct() {
    awk '{
      line = $0
      out = ""
      while (match(line, /[0-9]+(\.[0-9]+)?%/)) {
        pct = substr(line, RSTART, RLENGTH - 1) + 0
        color = (pct >= 90) ? "32" : (pct >= 70) ? "33" : "31"
        out = out substr(line, 1, RSTART - 1) "\033[" color "m" substr(line, RSTART, RLENGTH) "\033[0m"
        line = substr(line, RSTART + RLENGTH)
      }
      print out line
    }'
  }

  just test-cov > coverage/python.log 2>&1 &
  py_pid=$!
  FORCE_COLOR=1 just web-test-cov > coverage/web.log 2>&1 &
  web_pid=$!

  py_status=0
  web_status=0
  wait "$py_pid" || py_status=$?
  wait "$web_pid" || web_status=$?

  printf "\n\033[1m=== Python coverage (pytest) ===\033[0m\n"
  sed -n '/^Name /,/^TOTAL/p' coverage/python.log | colorize_pct
  grep -E "passed|failed|error" coverage/python.log | tail -1

  printf "\n\033[1m=== Web coverage (vitest) ===\033[0m\n"
  sed -n '/^File /,$p' coverage/web.log
  grep -E "Test Files|Tests " coverage/web.log

  if [ "$py_status" -ne 0 ] || [ "$web_status" -ne 0 ]; then
    printf "\nTests failed — full logs: coverage/python.log, coverage/web.log\n" >&2
    exit 1
  fi

  sed 's|^SF:|SF:web/|' web/coverage/lcov.info > coverage/web.lcov
  lcov --add-tracefile coverage/python.lcov --add-tracefile coverage/web.lcov --output-file coverage/merged.lcov > coverage/lcov-merge.log 2>&1
  genhtml coverage/merged.lcov --output-directory coverage/html > coverage/genhtml.log 2>&1

  printf "\n\033[1m=== Combined coverage ===\033[0m\n"
  grep -A3 "^Summary coverage rate" coverage/lcov-merge.log | colorize_pct

  printf "\nFull report: coverage/html/index.html\n"

  if [ -n "{{open}}" ]; then
    if command -v wslview >/dev/null 2>&1; then
      wslview coverage/html/index.html
    elif grep -qi microsoft /proc/version 2>/dev/null && command -v explorer.exe >/dev/null 2>&1; then
      explorer.exe "$(wslpath -w coverage/html/index.html)" || true
    elif command -v xdg-open >/dev/null 2>&1; then
      xdg-open coverage/html/index.html >/dev/null 2>&1 &
    elif command -v open >/dev/null 2>&1; then
      open coverage/html/index.html
    else
      echo "Could not detect a way to open a browser; open coverage/html/index.html manually" >&2
    fi
  fi

# Full dev setup + start web server
dev: setup web-dev

# Clean all build artifacts
clean: clean-py
  cd web && rm -rf dist/ node_modules/ .astro/

# One-time setup for fresh clone
init:
  git config core.hooksPath .git/hooks 2>/dev/null || true
  just setup
