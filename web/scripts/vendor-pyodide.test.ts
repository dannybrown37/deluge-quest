// @vitest-environment node
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CORE_FILES, vendorPyodide } from "./vendor-pyodide.mjs";

const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");

let tmp: string;
let runtimeDir: string;
let wheelDir: string;
let outDir: string;

function writeWheel(name: string, body: string): void {
  fs.writeFileSync(path.join(wheelDir, name), body);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-pyodide-"));
  runtimeDir = path.join(tmp, "runtime");
  wheelDir = path.join(tmp, "wheels");
  outDir = path.join(tmp, "out");
  fs.mkdirSync(runtimeDir);
  fs.mkdirSync(wheelDir);
  for (const f of CORE_FILES) fs.writeFileSync(path.join(runtimeDir, f), `core:${f}`);
  writeWheel("a-1.0-py3-none-any.whl", "wheel-a");
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("vendorPyodide", () => {
  it("copies every core runtime file and each verified wheel", () => {
    vendorPyodide({
      runtimeDir,
      wheelDir,
      outDir,
      wheelHashes: { "a-1.0-py3-none-any.whl": sha256("wheel-a") },
    });

    expect(fs.readdirSync(outDir).sort()).toEqual(
      [...CORE_FILES, "a-1.0-py3-none-any.whl"].sort(),
    );
    expect(fs.readFileSync(path.join(outDir, "pyodide.mjs"), "utf8")).toBe("core:pyodide.mjs");
  });

  it.each([
    ["hash mismatch", { "a-1.0-py3-none-any.whl": sha256("tampered") }, /sha256 mismatch/],
    ["wheel without a pinned hash", {}, /no pinned sha256/],
  ])("refuses a %s", (_label, wheelHashes, error) => {
    expect(() => vendorPyodide({ runtimeDir, wheelDir, outDir, wheelHashes })).toThrow(error);
  });

  it("refuses a pinned wheel that is missing on disk", () => {
    expect(() =>
      vendorPyodide({
        runtimeDir,
        wheelDir,
        outDir,
        wheelHashes: {
          "a-1.0-py3-none-any.whl": sha256("wheel-a"),
          "gone-1.0-py3-none-any.whl": sha256("x"),
        },
      }),
    ).toThrow(/gone-1.0-py3-none-any.whl/);
  });

  it("fails when a core runtime file is missing", () => {
    fs.rmSync(path.join(runtimeDir, "pyodide.asm.wasm"));
    expect(() =>
      vendorPyodide({
        runtimeDir,
        wheelDir,
        outDir,
        wheelHashes: { "a-1.0-py3-none-any.whl": sha256("wheel-a") },
      }),
    ).toThrow(/pyodide.asm.wasm/);
  });

  it("removes stale files left from a previous version", () => {
    fs.mkdirSync(outDir);
    fs.writeFileSync(path.join(outDir, "old-0.1-py3-none-any.whl"), "stale");
    vendorPyodide({
      runtimeDir,
      wheelDir,
      outDir,
      wheelHashes: { "a-1.0-py3-none-any.whl": sha256("wheel-a") },
    });
    expect(fs.existsSync(path.join(outDir, "old-0.1-py3-none-any.whl"))).toBe(false);
  });
});
