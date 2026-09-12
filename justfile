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
  uv sync

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
  uv run pytest tests/ -v --cov=deluge_tools --cov-branch --cov-report=term-missing --cov-report=lcov:coverage/python.lcov

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

# Run the real-Pyodide integration test (real WASM runtime, real wheel, no mocks;
# needs network on first run to fetch Pyodide's package set, then ~3s cached).
# Included in `just coverage`; not part of `just check` since it's out-of-repo network I/O.
web-test-pyodide:
  cd web && npm run test:integration

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
# SD Card Backup (git-tracked)
# ============================================================================

# Drive letter where the SD card mounts (WSL path)
card-mount := env("DELUGE_CARD_MOUNT", "/mnt/d")

# Drive letter to pass to `mount -t drvfs`
card-drive := env("DELUGE_CARD_DRIVE", "D:")

# Ensure the SD card is mounted (WSL doesn't automount removable drives)
[private]
card-ensure-mount:
  #!/bin/bash
  set -e
  if mountpoint -q "{{card-mount}}" 2>/dev/null; then
    exit 0
  fi
  if [ -d "{{card-mount}}" ] && [ -n "$(ls -A '{{card-mount}}' 2>/dev/null)" ]; then
    exit 0
  fi
  echo "Mounting {{card-drive}} → {{card-mount}} ..."
  sudo mkdir -p "{{card-mount}}"
  sudo mount -t drvfs "{{card-drive}}" "{{card-mount}}"

# All card-* recipes delegate to the deluge-backup CLI (pip install deluge-tools)

card-init source="": card-ensure-mount
  deluge-backup init {{ if source != "" { source } else { "" } }}

card-sync go="": card-ensure-mount
  deluge-backup sync {{ if go != "" { "--go" } else { "" } }}

card-commit msg="Session snapshot":
  deluge-backup commit "{{msg}}"

card-save msg="Session snapshot": card-ensure-mount
  deluge-backup save "{{msg}}"

card-status:
  deluge-backup status

card-diff:
  deluge-backup diff

card-log:
  deluge-backup log

card-size:
  deluge-backup size

card-remote-init url:
  deluge-backup remote-init "{{url}}"

card-push msg="":
  deluge-backup push {{ if msg != "" { "\"" + msg + "\"" } else { "" } }}

# ============================================================================
# Development Workflow
# ============================================================================

# Full install (Python + web)
setup: install web-install

# Run full test suite
check: lint typecheck test web-lint web-typecheck web-test

# Build everything (Python + web)
build: web-rebuild-wheel web-build

# Run all tests with coverage, merge into one local HTML report.
# Pass --open to open it in the browser, --verbose for the full per-suite tables.
coverage open="" verbose="":
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
  just web-test-pyodide > coverage/pyodide.log 2>&1 &
  pyodide_pid=$!

  py_status=0
  web_status=0
  pyodide_status=0
  wait "$py_pid" || py_status=$?
  wait "$web_pid" || web_status=$?
  wait "$pyodide_pid" || pyodide_status=$?

  if [ -n "{{verbose}}" ]; then
    printf "\n\033[1m=== Python coverage (pytest) ===\033[0m\n"
    sed -n '/^Name /,/^TOTAL/p' coverage/python.log | colorize_pct
    grep -E "passed|failed|error" coverage/python.log | tail -1

    printf "\n\033[1m=== Web coverage (vitest) ===\033[0m\n"
    sed -n '/^File /,$p' coverage/web.log
    grep -E "Test Files|Tests " coverage/web.log

    printf "\n\033[1m=== Pyodide integration (real Pyodide/WASM) ===\033[0m\n"
    sed -n '/^File /,$p' coverage/pyodide.log
    grep -E "Test Files|Tests " coverage/pyodide.log
  else
    printf "\n\033[1m=== Test suites ===\033[0m\n"
    printf "Python:  "; grep -E "passed|failed|error" coverage/python.log | tail -1
    printf "Web:     "; grep -E "Tests " coverage/web.log
    printf "Pyodide: "; grep -E "Tests " coverage/pyodide.log
    printf "(pass --verbose for full per-suite coverage tables)\n"
  fi

  if [ "$py_status" -ne 0 ] || [ "$web_status" -ne 0 ] || [ "$pyodide_status" -ne 0 ]; then
    printf "\nTests failed — full logs: coverage/python.log, coverage/web.log, coverage/pyodide.log\n" >&2
    exit 1
  fi

  sed 's|^SF:|SF:web/|' web/coverage/lcov.info > coverage/web.lcov
  sed 's|^SF:|SF:web/|' web/coverage-integration/lcov.info > coverage/pyodide.lcov

  # coverage.py writes BRDA branch-IDs as text ("jump to line 29") instead of lcov's
  # expected small integers. lcov's tracefile merge keys branches by (line, block, branch-id)
  # and silently miscounts when that key isn't numeric — renumber per (line, block) first.
  awk '
    BEGIN { FS = OFS = "," }
    /^BRDA:/ {
      line = $1; sub(/^BRDA:/, "", line)
      block = $2
      key = line SUBSEP block
      idx = (key in seen) ? ++seen[key] : (seen[key] = 0)
      print "BRDA:" line "," block "," idx "," $NF
      next
    }
    # coverage.py writes "FN:<start>,<end>,<name>"; lcov 1.x reads only "FN:<line>,<name>"
    # and takes the end-line as the function name, inventing a never-hit twin per function
    # (every file lands on exactly 50% functions). Drop the end-line field.
    /^FN:/ && NF == 3 {
      line = $1; sub(/^FN:/, "", line)
      print "FN:" line "," $3
      next
    }
    { print }
  ' coverage/python.lcov > coverage/python_fixed.lcov

  # lcov/genhtml don't report branches at all unless explicitly told to.
  lcov --rc lcov_branch_coverage=1 --add-tracefile coverage/python_fixed.lcov --add-tracefile coverage/web.lcov --add-tracefile coverage/pyodide.lcov --output-file coverage/merged.lcov > coverage/lcov-merge.log 2>&1
  genhtml --rc genhtml_branch_coverage=1 coverage/merged.lcov --output-directory coverage/html > coverage/genhtml.log 2>&1

  # Per-suite tables above are single-suite — a file exercised only by the pyodide
  # integration suite (like pyodide.ts) reads as 0% in the web-vitest table even
  # though it's covered overall. This merged-per-file table is the real number.
  printf "\n\033[1m=== Combined coverage by file ===\033[0m\n"
  lcov --rc lcov_branch_coverage=1 --list coverage/merged.lcov 2>/dev/null | colorize_pct

  subtotal_line() {
    label="$1"; pattern="$2"; subset="$3"
    lcov --rc lcov_branch_coverage=1 --extract coverage/merged.lcov "$pattern" -o "$subset" > /dev/null 2>&1
    pct=$(lcov --rc lcov_branch_coverage=1 --summary "$subset" 2>/dev/null | awk -F'[:%]' '
      /lines/ {l=$2} /functions/ {f=$2} /branches/ {b=$2}
      END {printf "lines %s%%  functions %s%%  branches %s%%", l, f, b}
    ')
    printf "%-14s %s\n" "$label" "$pct" | colorize_pct
  }
  printf "\n"
  subtotal_line "deluge_tools/" "deluge_tools/*" "coverage/py_subset.lcov"
  subtotal_line "web/src/" "web/src/*" "coverage/web_subset.lcov"

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

# Bump version, review changelog in nvim, commit, tag, and push to trigger PyPI publish
release increment="":
  #!/bin/bash
  set -e
  if [ -n "$(git status --porcelain)" ]; then
    echo "Working tree is dirty — commit or stash first."
    exit 1
  fi
  uv run cz bump {{ if increment != "" { "--increment " + increment } else { "" } }} --yes
  nvim CHANGELOG.md
  git add CHANGELOG.md
  git commit --amend --no-edit
  tag=$(git describe --tags --abbrev=0)
  git tag -f "$tag"
  echo ""
  echo "Ready to publish. Run:"
  echo "  git push && git push origin $tag"

# Full dev setup + start web server
dev: setup web-dev

# Clean all build artifacts
clean: clean-py
  cd web && rm -rf dist/ node_modules/ .astro/

# One-time setup for fresh clone
init:
  git config core.hooksPath .git/hooks 2>/dev/null || true
  just setup
