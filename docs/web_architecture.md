# Web Architecture

How [deluge.quest](https://deluge.quest) works — a static Astro + Svelte site that runs Python
in the browser via Pyodide, processing Deluge SD card files entirely client-side.

## Stack

```
Astro 5           Static site generator — one .astro shell per page
Svelte 5          UI framework — one island component per tool page
Pyodide 0.27      Python-in-WASM — runs deluge_tools in the browser
Vercel             Hosting (free tier, static deploy)
```

No server. No uploads. No accounts. Everything runs in the browser.

## High-Level Data Flow

```diagram
                   ┌─────────────────────────────────────┐
                   │           Browser (client)           │
                   │                                      │
  SD card ────────►│  File System Access API               │
  (Chromium)       │  (showDirectoryPicker)                │
                   │         │                             │
                   │         ▼                             │
                   │  ┌─────────────┐   ┌──────────────┐  │
                   │  │  cardStore  │◄─►│  IndexedDB   │  │
                   │  │  (singleton)│   │  v2 cache    │  │
                   │  └──────┬──────┘   └──────────────┘  │
                   │         │                             │
                   │         ▼                             │
                   │  ┌─────────────┐                      │
                   │  │  Svelte     │   ┌──────────────┐  │
                   │  │  Component  │──►│  pyodide.ts  │  │
                   │  │  (island)   │   │  (bridge)    │  │
                   │  └─────────────┘   └──────┬───────┘  │
                   │                           │          │
                   │                           ▼          │
                   │                    ┌──────────────┐  │
                   │                    │  Pyodide     │  │
                   │                    │  (WASM)      │  │
                   │                    │              │  │
                   │                    │ deluge_tools │  │
                   │                    │  .whl        │  │
                   │                    └──────────────┘  │
                   │                                      │
                   │         Web Audio API                 │
                   │  ┌─────────────┐  ┌──────────────┐  │
                   │  │ homeAudio   │  │ patchAudio   │  │
                   │  │ (playback)  │  │ (synth)      │  │
                   │  └─────────────┘  └──────────────┘  │
                   └─────────────────────────────────────┘
```

## Page Architecture

Every tool page follows the same pattern: a thin `.astro` shell wraps `BaseLayout` and mounts
a single Svelte island component with `client:load`.

```diagram
src/pages/manage.astro          →  <CardScanner client:load />
src/pages/stats.astro           →  <SongAnalyzer client:load />
src/pages/preview.astro         →  <SongPreview client:load />
...
```

Prose-only pages (`/backup`, `/faq`) are Markdown files with `layout: ProseLayout.astro`.

### Page Map

| Route | Type | Component | Purpose |
| ---|---| --- | --- |
| `/` | Astro + Svelte | `DelugeUI.svelte` | Interactive pad grid, demo player |
| `/manage` | Astro + Svelte | `CardScanner.svelte` | SD card browser, sample management |
| `/stats` | Astro + Svelte | `SongAnalyzer.svelte` | Batch song analysis table |
| `/preview` | Astro + Svelte | `SongPreview.svelte` | Web Audio song playback |
| `/kits` | Astro + Svelte | `KitBuilder.svelte` | Kit XML builder (vim keys) |
| `/patch` | Astro + Svelte | `PatchGenerator.svelte` | Synth preset generator |
| `/score` | Astro + Svelte | `ScoreConverter.svelte` | Song XML to MusicXML |
| `/import` | Astro + Svelte | `MidiImporter.svelte` | MIDI to Deluge XML |
| `/backup` | Markdown | — | CLI tutorial for `deluge-backup` |
| `/faq` | Markdown | — | Hand-written FAQ |
| `/songs` | Astro | — | Song index with links to per-song pages |
| `/songs/[slug]` | Astro + Svelte | `SongPlayer.svelte` | Shareable per-song player page |

## The Pyodide Bridge (`pyodide.ts`)

Python runs in the browser via Pyodide (CPython compiled to WebAssembly). The bridge is an
untyped string seam — Python and TypeScript share no type system.

### Loading

```diagram
loadPyodide()
  → import pyodide.mjs from CDN
  → pyodide.loadPackage("micropip")
  → micropip.install.callKwargs(wheel_path, {deps: false})
```

The wheel is checked into `web/public/py/`. `deps=false` is critical — without it, micropip
resolves the wheel's declared dependencies (music21, mido) and pulls ~50MB of packages on
every page load. The browser-loaded modules are pure stdlib and don't need them.

**Gotcha**: `micropip.install(path, {deps: false})` silently fails — the JS object becomes a
positional Python arg, not kwargs. Must use `callKwargs`.

### Bridge Functions

| Function | Python module | Used by |
| --- | --- | --- |
| `analyzeStats(xml)` | `analyzer.py` | `/stats`, `/manage` |
| `convertToMusicXML(xml)` | `converter.py` → `musicxml_writer.py` | `/score` |
| `inspectSong(xml)` | `parser.py` | `/preview` |
| `convertMidiToDelugeXml(midi)` | `midi_to_deluge.py` | `/import` |

Each bridge: sets globals via `pyodide.globals.set()`, runs embedded Python via
`pyodide.runPythonAsync()`, and returns JSON-parsed results.

### Wheel Rebuild Requirement

Changes to `deluge_tools/*.py` are **invisible in the browser** until you rebuild the wheel:

```bash
bash web/build-wheel.sh
```

The dev server, `pytest`, and `ruff` all see the source directly — only the browser loads the
`.whl`. This is the #1 source of "it works in tests but not in the browser" confusion.

## Shared State (`cardStore.ts`)

`cardStore` is a singleton that holds the SD card directory handle, sample index, and song
cache. It's shared across `/manage`, `/stats`, `/kits`, and `/preview`.

```diagram
cardStore
  ├── rootHandle: FileSystemDirectoryHandle  (the SD card)
  ├── samples: Map<string, SampleInfo>       (indexed on scan)
  ├── songCache: Map<string, string>         (XML text, persisted to IDB)
  └── IndexedDB ("deluge-card-store", v2)
       ├── meta store    → rootHandle (persisted across sessions)
       └── songCache store → arrangement songs
```

The handle persists in IndexedDB but requires a user gesture to re-grant permission each
session (`cardStore.reconnect()` / `requestReconnect()`).

**App-managed directories** (`SOFT_DELETE/`, `REPAIR_BACKUP/`, `MOVE_BACKUP/`,
`HISTORY_BACKUP/`) are excluded from all scans. Card operations never destroy files — they
move to these directories, with backup-on-restore to prevent overwrites.

## Audio System

Three layers, each building on the last:

```diagram
┌────────────────────────────────────────────────┐
│  homeAudio.ts — site-wide singleton player     │
│  HTML <audio> + Web Audio FX chain             │
│  (filter, reverb, delay, analyser)             │
│  MediaSession for hardware controls            │
│  Used by: /, /songs/[slug], mini-player        │
├────────────────────────────────────────────────┤
│  songAudio.ts — song-level playback scheduler  │
│  Drives patchAudio voices + card samples       │
│  Used by: /preview                             │
├────────────────────────────────────────────────┤
│  patchAudio.ts — Web Audio synth engine        │
│  Subtractive + FM voices, ADSR envelopes       │
│  Used by: /patch (live preview), /preview      │
├────────────────────────────────────────────────┤
│  padSounds.ts — 8 percussion synth voices      │
│  Used by: DelugeUI pad grid                    │
├────────────────────────────────────────────────┤
│  audioVisualizer.ts — canvas frequency bars    │
│  Gold/teal when playing, ambient wave on idle  │
│  Used by: / (below pad grid)                   │
└────────────────────────────────────────────────┘
```

`homeAudio` has a dual-element design for iOS: a `MediaElementAudioSourceNode` captures the
main `<audio>` into the Web Audio graph (for FX), while a muted backup `<audio>` element takes
over on `visibilitychange` so lock-screen playback stays audible (iOS suspends AudioContext
on screen lock).

## Browser API Dependencies

| API | Used for | Fallback |
|---|---|---|
| File System Access API | SD card read/write | Drag-and-drop (read-only) |
| IndexedDB | Handle + song cache persistence | Re-scan on every visit |
| Web Audio API | Synth, FX, visualization | No audio features |
| MediaSession API | Hardware play/pause/next/prev | Software controls only |
| Pyodide (WASM) | Python analysis/conversion | None (core functionality) |

File System Access API is **Chromium-only**. Firefox/Safari get read-only drag-and-drop — card
mutation features (rename, move, delete, backup) are unavailable.

## Build and Deploy

```
just build
  → bash web/build-wheel.sh        # deluge_tools → .whl in web/public/py/
  → cd web && npm run build         # Astro static build → web/dist/

Vercel
  → picks up web/vercel.json
  → static deploy from web/dist/
  → security headers (X-Content-Type-Options, Referrer-Policy, X-Frame-Options, CSP)
```

### Astro Config

- **Integrations**: `@astrojs/svelte` (Svelte islands), `@astrojs/sitemap`
- **Markdown**: custom rehype plugin opens external links in new tabs (`target="_blank"`)
- **Site**: `https://deluge.quest` (used by sitemap and OG tags)

## Analytics

Vercel Web Analytics (cookieless, no consent banner). Custom events track tool usage, song
playback, and listen duration — see CLAUDE.md for the full event table.

## Design System

- **Fonts**: DM Mono (headers, code, labels) + DM Sans (body, UI)
- **Palette**: Gold `#D4A847` / Charcoal `#131316` / Teal `#5AABAC` (dark mode primaries)
- **Theme**: Full light/dark via CSS custom properties in `src/styles/`

## Testing

```
just web-test              # vitest unit tests (lib + components)
just web-test-pyodide      # real-Pyodide integration test (slow, network)
just coverage              # merged Python + JS coverage report
```

- Every file in `web/src/lib/` has 100% line coverage
- All 9 Svelte components have test files using `@testing-library/svelte`
- Pyodide bridge functions covered by real-WASM integration test
- Component tests require `plugins: [svelte()]` and `resolve: { conditions: ['browser'] }`
  in vitest config (server build throws on `onMount`/`onDestroy`)
