import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEMO_SONG,
  DEMO_SONGS,
  fetchAllDemoXmls,
  fetchDemoXml,
} from "./demoSong";

describe("DEMO_SONG", () => {
  it("has the expected shape", () => {
    expect(DEMO_SONG.name).toBe("Brahms Cello Sonata");
    expect(DEMO_SONG.xmlPath).toMatch(/\.XML$/);
    expect(DEMO_SONG.fileName).toMatch(/\.XML$/);
    expect(DEMO_SONG.songPagePath).toMatch(/^\/songs\//);
  });
});

describe("DEMO_SONGS", () => {
  it("contains the single DEMO_SONG as the first entry", () => {
    expect(DEMO_SONGS[0]).toBe(DEMO_SONG);
  });

  it("has at least 3 songs for a meaningful stats table", () => {
    expect(DEMO_SONGS.length).toBeGreaterThanOrEqual(3);
  });

  it("every entry has the required fields", () => {
    for (const song of DEMO_SONGS) {
      expect(song.name).toBeTruthy();
      expect(song.xmlPath).toMatch(/^\/demo\/.*\.XML$/);
      expect(song.fileName).toMatch(/\.XML$/);
      expect(song.songPagePath).toMatch(/^\/songs/);
    }
  });

  it("has unique file names", () => {
    const names = DEMO_SONGS.map((s) => s.fileName);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("fetchDemoXml", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("fetches from DEMO_SONG.xmlPath", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("<song/>"),
    } as Response);

    const result = await fetchDemoXml();
    expect(result).toBe("<song/>");
    expect(mockFetch).toHaveBeenCalledWith(DEMO_SONG.xmlPath);
  });

  it("throws on HTTP error", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 404 } as Response);
    await expect(fetchDemoXml()).rejects.toThrow("404");
  });
});

describe("fetchAllDemoXmls", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("fetches all demo songs and returns name/content pairs", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockImplementation((url) =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve(`<song>${url}</song>`),
      } as Response),
    );

    const results = await fetchAllDemoXmls();
    expect(results).toHaveLength(DEMO_SONGS.length);
    for (const [i, result] of results.entries()) {
      expect(result.name).toBe(DEMO_SONGS[i].fileName);
      expect(result.content).toContain(DEMO_SONGS[i].xmlPath);
    }
  });

  it("throws if any fetch fails", async () => {
    const mockFetch = vi.mocked(fetch);
    let callIdx = 0;
    mockFetch.mockImplementation(() => {
      callIdx++;
      if (callIdx === 2) {
        return Promise.resolve({ ok: false, status: 500 } as Response);
      }
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve("<song/>"),
      } as Response);
    });

    await expect(fetchAllDemoXmls()).rejects.toThrow("500");
  });
});
