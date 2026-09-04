# web/

The [deluge.quest](https://deluge.quest) site — Astro + Svelte, static, deployed to Vercel. See
the [repo root README](../README.md) for what this project is, and
[`CLAUDE.md`](../CLAUDE.md) for the full architecture (page-by-page component map, the
Python↔JS bridge, design decisions).

## Commands

Run from this directory:

| Command          | Action                                              |
| :---------------- | :--------------------------------------------------- |
| `npm install`     | Install dependencies                                  |
| `npm run dev`      | Start dev server at `localhost:4321`                  |
| `npm run build`    | Build the static site to `./dist/` (zero errors/warnings is the bar) |
| `npm run preview`  | Preview a production build locally                    |
| `npm run lint`     | ESLint over `.ts`/`.svelte`/`.astro`                   |
| `npm test`         | Run the Vitest suite                                   |
| `npx tsc --noEmit` | Type-check                                             |

Prefer `just` from the repo root (`just web-dev`, `just web-build`, `just check`) — it wires
these up alongside the Python side.

## The Python↔JS seam

`src/lib/pyodide.ts` loads `public/py/deluge_tools-*.whl` (a wheel built from the sibling
`deluge_tools/` Python package) into Pyodide and calls into it for parsing/analysis/conversion.
**That wheel is not rebuilt automatically** — if you change anything under `../deluge_tools/`,
run `bash build-wheel.sh` before your browser will see the change, `npm run dev` included.
