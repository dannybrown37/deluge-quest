// Self-hosts Pyodide under public/pyodide/ so no Python runtime code is fetched from a
// third-party CDN at page load. Core files come from the pinned `pyodide` npm package
// (integrity-checked by package-lock); the wheels npm doesn't ship are committed in
// vendor/pyodide/ and verified here against pinned hashes.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CORE_FILES = [
  "pyodide.mjs",
  "pyodide.asm.js",
  "pyodide.asm.wasm",
  "python_stdlib.zip",
  "pyodide-lock.json",
];

// micropip/packaging hashes match pyodide-lock.json; mido matches PyPI.
export const WHEEL_HASHES = {
  "micropip-0.9.0-py3-none-any.whl":
    "034f22763607744f982d2911170c50b496a38b8ba0535e5a09618475b1d7b051",
  "packaging-24.2-py3-none-any.whl":
    "fbf6a5ace596eb8e28fe0089ecfc0bca2eb3930563e9ca06acb98ea5302b99f7",
  "mido-1.3.3-py3-none-any.whl":
    "01033c9b10b049e4436fca2762194ca839b09a4334091dd3c34e7f4ae674fd8a",
};

/**
 * @param {{ runtimeDir: string; wheelDir: string; outDir: string; wheelHashes: Record<string, string> }} opts
 */
export function vendorPyodide({ runtimeDir, wheelDir, outDir, wheelHashes }) {
  for (const f of CORE_FILES) {
    if (!fs.existsSync(path.join(runtimeDir, f))) {
      throw new Error(`Pyodide runtime file missing: ${f} (run npm install)`);
    }
  }
  for (const f of fs.readdirSync(wheelDir).filter((f) => f.endsWith(".whl"))) {
    if (!(f in wheelHashes)) throw new Error(`${f} has no pinned sha256`);
  }
  for (const [f, expected] of Object.entries(wheelHashes)) {
    const file = path.join(wheelDir, f);
    if (!fs.existsSync(file)) throw new Error(`Pinned wheel missing: ${f}`);
    const actual = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    if (actual !== expected) {
      throw new Error(`${f} sha256 mismatch: expected ${expected}, got ${actual}`);
    }
  }

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of CORE_FILES) fs.copyFileSync(path.join(runtimeDir, f), path.join(outDir, f));
  for (const f of Object.keys(wheelHashes)) {
    fs.copyFileSync(path.join(wheelDir, f), path.join(outDir, f));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const web = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  vendorPyodide({
    runtimeDir: path.join(web, "node_modules", "pyodide"),
    wheelDir: path.join(web, "vendor", "pyodide"),
    outDir: path.join(web, "public", "pyodide"),
    wheelHashes: WHEEL_HASHES,
  });
}
