import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ScoreConverter from "./ScoreConverter.svelte";

vi.mock("../lib/pyodide", () => ({
  loadPyodide: vi.fn(),
  convertToMusicXML: vi.fn(),
}));

vi.mock("../lib/analytics", () => ({
  trackToolAction: vi.fn(),
}));

vi.mock("../lib/cardStore", () => ({
  cardStore: {
    isLoaded: false,
    songXmls: new Map(),
    rootHandle: null,
    eligibleSongs: vi.fn(() => []),
    loadCachedSongs: vi.fn().mockResolvedValue(null),
  },
  songHasArrangement: vi.fn(() => true),
}));

import { trackToolAction } from "../lib/analytics";
import { cardStore } from "../lib/cardStore";
import { convertToMusicXML, loadPyodide } from "../lib/pyodide";

const mockLoadPyodide = loadPyodide as unknown as ReturnType<typeof vi.fn>;
const mockConvert = convertToMusicXML as unknown as ReturnType<typeof vi.fn>;
const mockTrack = trackToolAction as unknown as ReturnType<typeof vi.fn>;
const mockCardStore = cardStore as unknown as {
  isLoaded: boolean;
  songXmls: Map<string, string>;
  rootHandle: { name: string } | null;
  eligibleSongs: ReturnType<typeof vi.fn>;
  loadCachedSongs: ReturnType<typeof vi.fn>;
};

function xmlFile(name: string, content = "<song></song>"): File {
  return new File([content], name, { type: "application/xml" });
}

function dropEvent(file: File | undefined) {
  return {
    dataTransfer: { files: file ? [file] : [] },
  } as unknown as DragEvent;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadPyodide.mockResolvedValue({});
  mockConvert.mockResolvedValue("<score></score>");
  mockCardStore.isLoaded = false;
  mockCardStore.songXmls = new Map();
  mockCardStore.rootHandle = null;
  mockCardStore.eligibleSongs.mockReturnValue([]);
  mockCardStore.loadCachedSongs.mockResolvedValue(null);
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("ScoreConverter", () => {
  it("renders the dropzone with no cached songs", async () => {
    render(ScoreConverter);
    await Promise.resolve();
    expect(screen.getByText("Drop a Deluge song file")).toBeTruthy();
    expect(screen.getByText(/No songs cached yet/)).toBeTruthy();
  });

  it("rejects a non-XML file with an error", async () => {
    render(ScoreConverter);
    const dropzone = document.querySelector(".dropzone") as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(new File(["x"], "song.mid")));
    expect(
      screen.getByText("Please drop a Deluge .XML song file"),
    ).toBeTruthy();
    expect(mockConvert).not.toHaveBeenCalled();
  });

  it("converts a dropped XML file and shows the result", async () => {
    render(ScoreConverter);
    const dropzone = document.querySelector(".dropzone") as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile("song.XML")));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockConvert).toHaveBeenCalledWith("<song></song>", {});
    expect(screen.getByText("Conversion complete")).toBeTruthy();
    expect(mockTrack).toHaveBeenCalledWith("score", "convert");
  });

  it("shows an error card when conversion fails", async () => {
    mockConvert.mockRejectedValue(new Error("bad xml"));
    render(ScoreConverter);
    const dropzone = document.querySelector(".dropzone") as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile("song.XML")));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.getByText("bad xml")).toBeTruthy();
    expect(mockTrack).toHaveBeenCalledWith("score", "convert_error");
  });

  it("resets from error and done states", async () => {
    render(ScoreConverter);
    const dropzone = document.querySelector(".dropzone") as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile("song.XML")));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    await fireEvent.click(
      screen.getByRole("button", { name: "Convert another" }),
    );
    expect(screen.getByText("Drop a Deluge song file")).toBeTruthy();
  });

  it("toggles drag-over state", async () => {
    render(ScoreConverter);
    const dropzone = document.querySelector(".dropzone") as HTMLElement;
    await fireEvent.dragOver(dropzone);
    expect(dropzone.className).toContain("dropzone--over");
    await fireEvent.dragLeave(dropzone);
    expect(dropzone.className).not.toContain("dropzone--over");
  });

  it("converts a file chosen via the file input", async () => {
    render(ScoreConverter);
    const input = document.getElementById("file-input") as HTMLInputElement;
    const file = xmlFile("picked.XML");
    Object.defineProperty(input, "files", { value: [file] });

    await fireEvent.change(input);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockConvert).toHaveBeenCalled();
    expect(screen.getByText("Conversion complete")).toBeTruthy();
  });

  it("downloads the result MusicXML", async () => {
    render(ScoreConverter);
    const dropzone = document.querySelector(".dropzone") as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile("song.XML")));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const createUrl = vi.fn().mockReturnValue("blob:mock");
    const revokeUrl = vi.fn();
    URL.createObjectURL = createUrl;
    URL.revokeObjectURL = revokeUrl;
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    await fireEvent.click(
      screen.getByRole("button", { name: "Download MusicXML" }),
    );

    expect(createUrl).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(revokeUrl).toHaveBeenCalledWith("blob:mock");
    expect(mockTrack).toHaveBeenCalledWith("score", "download");

    clickSpy.mockRestore();
  });

  it("activates the file picker on Enter/Space keydown", async () => {
    render(ScoreConverter);
    const dropzone = document.querySelector(".dropzone") as HTMLElement;
    const input = document.getElementById("file-input") as HTMLInputElement;
    const clickSpy = vi.spyOn(input, "click").mockImplementation(() => {});

    await fireEvent.keyDown(dropzone, { key: "Enter" });
    expect(clickSpy).toHaveBeenCalledTimes(1);
    await fireEvent.keyDown(dropzone, { key: " " });
    expect(clickSpy).toHaveBeenCalledTimes(2);
    await fireEvent.keyDown(dropzone, { key: "a" });
    expect(clickSpy).toHaveBeenCalledTimes(2);

    clickSpy.mockRestore();
  });

  it("loads songs already indexed on cardStore", async () => {
    mockCardStore.isLoaded = true;
    mockCardStore.songXmls = new Map([["song1.XML", "<song></song>"]]);
    mockCardStore.rootHandle = { name: "MY_CARD" };
    mockCardStore.eligibleSongs.mockReturnValue([
      { path: "song1.XML", xml: "<song></song>" },
    ]);

    render(ScoreConverter);
    await Promise.resolve();
    await Promise.resolve();

    expect(
      screen.getByText(/song with arrangement data on MY_CARD/),
    ).toBeTruthy();
    expect(screen.getByText("song1.XML")).toBeTruthy();
  });

  it("converts a song picked from the cached card list", async () => {
    mockCardStore.loadCachedSongs.mockResolvedValue({
      songs: [{ path: "cached.XML", xml: "<song></song>" }],
      cardName: "CACHED_CARD",
      savedAt: 1000,
    });

    render(ScoreConverter);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    await fireEvent.click(screen.getByText("cached.XML"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockConvert).toHaveBeenCalledWith("<song></song>", {});
    expect(screen.getByText("Conversion complete")).toBeTruthy();
  });

  it("resumes a stats-page song stashed in sessionStorage", async () => {
    sessionStorage.setItem(
      "deluge-score-file",
      JSON.stringify({ name: "stashed.XML", content: "<song></song>" }),
    );

    render(ScoreConverter);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockConvert).toHaveBeenCalledWith("<song></song>", {});
    expect(sessionStorage.getItem("deluge-score-file")).toBeNull();
  });

  it("shows a resume banner when stats results are cached", async () => {
    sessionStorage.setItem(
      "deluge-stats-results",
      JSON.stringify([{ a: 1 }, { b: 2 }]),
    );

    render(ScoreConverter);
    await Promise.resolve();

    expect(screen.getByText("2 songs loaded in Song Stats")).toBeTruthy();
  });

  it("ignores malformed JSON in deluge-score-file", async () => {
    sessionStorage.setItem("deluge-score-file", "{not valid json");

    render(ScoreConverter);
    await Promise.resolve();

    expect(mockConvert).not.toHaveBeenCalled();
  });

  it("ignores a stashed file missing name or content", async () => {
    sessionStorage.setItem(
      "deluge-score-file",
      JSON.stringify({ name: "", content: "" }),
    );

    render(ScoreConverter);
    await Promise.resolve();

    expect(mockConvert).not.toHaveBeenCalled();
  });

  it("treats malformed deluge-stats-results as no cached stats", async () => {
    sessionStorage.setItem("deluge-stats-results", "{broken");

    render(ScoreConverter);
    await Promise.resolve();

    expect(screen.queryByText(/loaded in Song Stats/)).toBeNull();
  });

  it("treats a non-array deluge-stats-results as zero count", async () => {
    sessionStorage.setItem(
      "deluge-stats-results",
      JSON.stringify({ notAnArray: true }),
    );

    render(ScoreConverter);
    await Promise.resolve();

    expect(screen.queryByText(/loaded in Song Stats/)).toBeNull();
  });

  it("invokes the loadPyodide progress callback", async () => {
    mockLoadPyodide.mockImplementation(
      async (cb?: (stage: string, pct: number) => void) => {
        cb?.("Loading runtime", 20);
        return {};
      },
    );

    render(ScoreConverter);
    const dropzone = document.querySelector(".dropzone") as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile("song.XML")));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockLoadPyodide).toHaveBeenCalledWith(expect.any(Function));
    expect(screen.getByText("Conversion complete")).toBeTruthy();
  });

  it("shows the cache timestamp for songs loaded from cache", async () => {
    mockCardStore.loadCachedSongs.mockResolvedValue({
      songs: [{ path: "cached.XML", xml: "<song></song>" }],
      cardName: "CACHED_CARD",
      savedAt: 1700000000000,
    });

    render(ScoreConverter);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.getByText(/From your last card scan/)).toBeTruthy();
  });

  it("filters out cached songs without arrangement data", async () => {
    const { songHasArrangement } = await import("../lib/cardStore");
    const mockHasArrangement = songHasArrangement as unknown as ReturnType<
      typeof vi.fn
    >;
    mockHasArrangement.mockImplementation((xml: string) =>
      xml.includes("keep"),
    );

    mockCardStore.loadCachedSongs.mockResolvedValue({
      songs: [
        { path: "keep.XML", xml: "<song>keep</song>" },
        { path: "drop.XML", xml: "<song>drop</song>" },
      ],
      cardName: "CACHED_CARD",
      savedAt: 1000,
    });

    render(ScoreConverter);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.getByText("keep.XML")).toBeTruthy();
    expect(screen.queryByText("drop.XML")).toBeNull();

    mockHasArrangement.mockImplementation(() => true);
  });

  describe("folder view", () => {
    beforeEach(() => {
      mockCardStore.isLoaded = true;
      mockCardStore.songXmls = new Map([
        ["folderA/song1.XML", "<song></song>"],
        ["folderA/song2.XML", "<song></song>"],
        ["folderB/song3.XML", "<song></song>"],
      ]);
      mockCardStore.rootHandle = { name: "MY_CARD" };
      mockCardStore.eligibleSongs.mockReturnValue([
        { path: "folderA/song1.XML", xml: "<song></song>" },
        { path: "folderA/song2.XML", xml: "<song></song>" },
        { path: "folderB/song3.XML", xml: "<song></song>" },
      ]);
    });

    it("toggles into folder view and shows folder groups", async () => {
      render(ScoreConverter);
      await Promise.resolve();
      await Promise.resolve();

      await fireEvent.click(
        screen.getByRole("button", { name: "Show folders" }),
      );

      expect(screen.getByText("folderA")).toBeTruthy();
      expect(screen.getByText("folderB")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Show flat" })).toBeTruthy();
    });

    it("collapses and expands a folder group", async () => {
      render(ScoreConverter);
      await Promise.resolve();
      await Promise.resolve();

      await fireEvent.click(
        screen.getByRole("button", { name: "Show folders" }),
      );
      // folders start collapsed when entering folder view
      expect(screen.queryByText("song1.XML")).toBeNull();

      const folderAHeader = screen
        .getByText("folderA")
        .closest("button") as HTMLElement;
      await fireEvent.click(folderAHeader);
      expect(screen.getByText("song1.XML")).toBeTruthy();
      expect(screen.getByText("song2.XML")).toBeTruthy();

      await fireEvent.click(folderAHeader);
      expect(screen.queryByText("song1.XML")).toBeNull();
    });

    it("converts a song from within a folder group", async () => {
      render(ScoreConverter);
      await Promise.resolve();
      await Promise.resolve();

      await fireEvent.click(
        screen.getByRole("button", { name: "Show folders" }),
      );
      const folderAHeader = screen
        .getByText("folderA")
        .closest("button") as HTMLElement;
      await fireEvent.click(folderAHeader);

      await fireEvent.click(screen.getByText("song1.XML"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(mockConvert).toHaveBeenCalledWith("<song></song>", {});
      expect(screen.getByText("Conversion complete")).toBeTruthy();
    });

    it("switches back to flat view", async () => {
      render(ScoreConverter);
      await Promise.resolve();
      await Promise.resolve();

      await fireEvent.click(
        screen.getByRole("button", { name: "Show folders" }),
      );
      expect(screen.getByText("folderA")).toBeTruthy();

      await fireEvent.click(screen.getByRole("button", { name: "Show flat" }));
      expect(screen.queryByText("folderA")).toBeNull();
      expect(screen.getByText("folderA/song1.XML")).toBeTruthy();
    });
  });
});
