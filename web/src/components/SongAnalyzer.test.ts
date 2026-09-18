import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SongStats } from "../lib/pyodide";
import SongAnalyzer from "./SongAnalyzer.svelte";

vi.mock("../lib/pyodide", () => ({
  loadPyodide: vi.fn(),
  analyzeStats: vi.fn(),
  convertToMusicXML: vi.fn(),
}));

vi.mock("../lib/softDelete", () => ({
  moveToTrash: vi.fn(),
}));

vi.mock("../lib/analytics", () => ({
  trackToolAction: vi.fn(),
}));

vi.mock("../lib/channelLabels", () => ({
  getChannelLabels: vi.fn().mockReturnValue({}),
  setChannelLabel: vi.fn(),
  removeChannelLabel: vi.fn(),
  formatChannel: vi.fn((ch: number, labels?: Record<number, string>) => {
    const resolved = labels ?? {};
    return resolved[ch] || `Ch ${ch}`;
  }),
}));

vi.mock("../lib/cardStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/cardStore")>();
  return {
    ...actual,
    cardStore: {
      isLoaded: false,
      songXmls: new Map<string, string>(),
      songLastModified: new Map<string, number>(),
      rootHandle: null,
      reconnect: vi.fn().mockResolvedValue(false),
      hasPersistedHandle: vi.fn().mockResolvedValue(false),
      requestReconnect: vi.fn().mockResolvedValue(false),
      pickDirectory: vi.fn().mockResolvedValue(undefined),
      adoptHandle: vi.fn().mockResolvedValue(undefined),
      saveSongCache: vi.fn().mockResolvedValue(undefined),
    },
  };
});

import { trackToolAction } from "../lib/analytics";
import { cardStore } from "../lib/cardStore";
import { analyzeStats, convertToMusicXML, loadPyodide } from "../lib/pyodide";
import { moveToTrash } from "../lib/softDelete";

const mockLoadPyodide = loadPyodide as unknown as ReturnType<typeof vi.fn>;
const mockAnalyzeStats = analyzeStats as unknown as ReturnType<typeof vi.fn>;
const mockConvertToMusicXML = convertToMusicXML as unknown as ReturnType<
  typeof vi.fn
>;
const mockMoveToTrash = moveToTrash as unknown as ReturnType<typeof vi.fn>;
const mockTrack = trackToolAction as unknown as ReturnType<typeof vi.fn>;
const mockCardStore = cardStore as unknown as {
  isLoaded: boolean;
  songXmls: Map<string, string>;
  songLastModified: Map<string, number>;
  rootHandle: { name: string } | null;
  reconnect: ReturnType<typeof vi.fn>;
  hasPersistedHandle: ReturnType<typeof vi.fn>;
  requestReconnect: ReturnType<typeof vi.fn>;
  pickDirectory: ReturnType<typeof vi.fn>;
  adoptHandle: ReturnType<typeof vi.fn>;
  saveSongCache: ReturnType<typeof vi.fn>;
};

function stat(overrides: Partial<SongStats> = {}): SongStats {
  return {
    filename: "song.XML",
    bpm: 120,
    key: "C major",
    hasArrangement: true,
    instrumentCount: 2,
    synthCount: 1,
    kitCount: 1,
    midiCount: 0,
    cvCount: 0,
    audioCount: 0,
    clipCount: 4,
    totalNotes: 100,
    durationStr: "1:30",
    midiChannels: [],
    firmwareVersion: "4.0.0",
    ...overrides,
  };
}

function xmlFile(name: string, content = "<song></song>"): File {
  return new File([content], name, { type: "application/xml" });
}

function dropEvent(files: File[]) {
  return { dataTransfer: { items: undefined, files } } as unknown as DragEvent;
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  mockLoadPyodide.mockResolvedValue({});
  mockAnalyzeStats.mockResolvedValue([stat()]);
  mockConvertToMusicXML.mockResolvedValue("<score></score>");
  mockCardStore.isLoaded = false;
  mockCardStore.songXmls = new Map();
  mockCardStore.songLastModified = new Map();
  mockCardStore.rootHandle = null;
  mockCardStore.reconnect.mockReset().mockResolvedValue(false);
  mockCardStore.hasPersistedHandle.mockReset().mockResolvedValue(false);
  mockCardStore.requestReconnect.mockReset().mockResolvedValue(false);
  mockCardStore.pickDirectory.mockReset().mockResolvedValue(undefined);
  mockCardStore.adoptHandle.mockReset().mockResolvedValue(undefined);
  mockCardStore.saveSongCache.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SongAnalyzer", () => {
  it("renders the dropzone in the idle state", async () => {
    render(SongAnalyzer);
    await Promise.resolve();
    expect(screen.getByText("Drop your SD card or SONGS folder")).toBeTruthy();
  });

  it("analyzes dropped XML files and renders a results table", async () => {
    render(SongAnalyzer);
    const dropzone = document.querySelector(".dropzone") as HTMLElement;

    await fireEvent.drop(dropzone, dropEvent([xmlFile("song.XML")]));
    await waitFor(() => expect(screen.getByText("song")).toBeTruthy());

    expect(mockAnalyzeStats).toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith("stats", "analyze_drop");
    expect(screen.getByText("120")).toBeTruthy();
  });

  it("shows an error when dropped files contain no XML", async () => {
    render(SongAnalyzer);
    const dropzone = document.querySelector(".dropzone") as HTMLElement;

    await fireEvent.drop(dropzone, dropEvent([new File(["x"], "readme.txt")]));
    await waitFor(() =>
      expect(screen.getByText(/No \.XML files found/)).toBeTruthy(),
    );

    await fireEvent.click(screen.getByText("Try again"));
    expect(screen.getByText("Drop your SD card or SONGS folder")).toBeTruthy();
  });

  it("auto-loads from an already-scanned card store", async () => {
    mockCardStore.isLoaded = true;
    mockCardStore.songXmls = new Map([["SONGS/song.XML", "<song></song>"]]);
    mockCardStore.rootHandle = { name: "CARD" };

    render(SongAnalyzer);

    await waitFor(() => expect(mockAnalyzeStats).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText("song")).toBeTruthy());
  });

  it("filters results by search query", async () => {
    mockAnalyzeStats.mockResolvedValue([
      stat({ filename: "kick.XML" }),
      stat({ filename: "snare.XML" }),
    ]);
    render(SongAnalyzer);
    const dropzone = document.querySelector(".dropzone") as HTMLElement;
    await fireEvent.drop(
      dropzone,
      dropEvent([xmlFile("kick.XML"), xmlFile("snare.XML")]),
    );
    await waitFor(() => expect(screen.getByText("kick")).toBeTruthy());

    const search = document.querySelector(".filter-search") as HTMLInputElement;
    await fireEvent.input(search, { target: { value: "kick" } });

    expect(screen.getByText("kick")).toBeTruthy();
    expect(screen.queryByText("snare")).toBeNull();
    expect(screen.getByText("1/2 songs")).toBeTruthy();
  });

  it("sorts the table when a sortable column header is clicked", async () => {
    mockAnalyzeStats.mockResolvedValue([
      stat({ filename: "b.XML", bpm: 200 }),
      stat({ filename: "a.XML", bpm: 100 }),
    ]);
    render(SongAnalyzer);
    const dropzone = document.querySelector(".dropzone") as HTMLElement;
    await fireEvent.drop(
      dropzone,
      dropEvent([xmlFile("b.XML"), xmlFile("a.XML")]),
    );
    await waitFor(() => expect(screen.getByText("a")).toBeTruthy());

    const bpmHeader = Array.from(document.querySelectorAll(".sort-btn")).find(
      (b) => b.textContent?.trim().startsWith("BPM"),
    ) as HTMLElement;
    await fireEvent.click(bpmHeader);

    const rows = Array.from(document.querySelectorAll(".cell-name-text")).map(
      (n) => n.textContent,
    );
    expect(rows).toEqual(["a", "b"]);
  });

  it("sorts duration numerically, not as text", async () => {
    mockAnalyzeStats.mockResolvedValue([
      stat({ filename: "short.XML", durationStr: "7s" }),
      stat({ filename: "long.XML", durationStr: "6:54" }),
    ]);
    render(SongAnalyzer);
    const dropzone = document.querySelector(".dropzone") as HTMLElement;
    await fireEvent.drop(
      dropzone,
      dropEvent([xmlFile("short.XML"), xmlFile("long.XML")]),
    );
    await waitFor(() => expect(screen.getByText("short")).toBeTruthy());

    const durationHeader = Array.from(
      document.querySelectorAll(".sort-btn"),
    ).find((b) => b.textContent?.trim().startsWith("Duration")) as HTMLElement;
    await fireEvent.click(durationHeader);

    const rows = Array.from(document.querySelectorAll(".cell-name-text")).map(
      (n) => n.textContent,
    );
    expect(rows).toEqual(["short", "long"]);
  });

  it("shows firmware version in a sortable column", async () => {
    mockAnalyzeStats.mockResolvedValue([
      stat({ filename: "old.XML", firmwareVersion: "3.1.5" }),
      stat({ filename: "new.XML", firmwareVersion: "4.3.0" }),
    ]);
    render(SongAnalyzer);
    const dropzone = document.querySelector(".dropzone") as HTMLElement;
    await fireEvent.drop(
      dropzone,
      dropEvent([xmlFile("old.XML"), xmlFile("new.XML")]),
    );
    await waitFor(() => expect(screen.getByText("old")).toBeTruthy());

    expect(screen.getByText("3.1.5")).toBeTruthy();
    expect(screen.getByText("4.3.0")).toBeTruthy();

    const firmwareHeader = Array.from(
      document.querySelectorAll(".sort-btn"),
    ).find((b) => b.textContent?.trim().startsWith("Firmware")) as HTMLElement;
    await fireEvent.click(firmwareHeader);

    const rows = Array.from(document.querySelectorAll(".cell-name-text")).map(
      (n) => n.textContent,
    );
    expect(rows).toEqual(["old", "new"]);
  });

  it("exports CSV", async () => {
    const createUrl = vi.fn().mockReturnValue("blob:mock");
    const revokeUrl = vi.fn();
    URL.createObjectURL = createUrl;
    URL.revokeObjectURL = revokeUrl;
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    render(SongAnalyzer);
    const dropzone = document.querySelector(".dropzone") as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent([xmlFile("song.XML")]));
    await waitFor(() => expect(screen.getByText("song")).toBeTruthy());

    await fireEvent.click(screen.getByText("Export CSV"));

    expect(createUrl).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith("stats", "export_csv");

    clickSpy.mockRestore();
  });

  it("deletes a song when a root handle is available", async () => {
    mockCardStore.isLoaded = true;
    mockCardStore.songXmls = new Map([["SONGS/song.XML", "<song></song>"]]);
    mockCardStore.rootHandle = { name: "CARD" };
    mockMoveToTrash.mockResolvedValue(undefined);

    render(SongAnalyzer);
    await waitFor(() => expect(screen.getByText("song")).toBeTruthy());

    await fireEvent.click(screen.getByTitle("Move to SOFT_DELETE/"));
    await waitFor(() => expect(mockMoveToTrash).toHaveBeenCalled());

    expect(mockTrack).toHaveBeenCalledWith("stats", "delete_song");
    await waitFor(() => expect(screen.queryByText("song")).toBeNull());
  });

  it("converts a song to MusicXML and downloads it", async () => {
    const createUrl = vi.fn().mockReturnValue("blob:mock");
    const revokeUrl = vi.fn();
    URL.createObjectURL = createUrl;
    URL.revokeObjectURL = revokeUrl;
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    render(SongAnalyzer);
    const dropzone = document.querySelector(".dropzone") as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent([xmlFile("song.XML")]));
    await waitFor(() => expect(screen.getByText("song")).toBeTruthy());

    await fireEvent.click(screen.getByTitle("Convert to MusicXML"));
    await waitFor(() => expect(mockConvertToMusicXML).toHaveBeenCalled());

    expect(mockTrack).toHaveBeenCalledWith("stats", "convert_score");
    expect(clickSpy).toHaveBeenCalled();

    clickSpy.mockRestore();
  });

  it("opens a song in the preview page", async () => {
    render(SongAnalyzer);
    const dropzone = document.querySelector(".dropzone") as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent([xmlFile("song.XML")]));
    await waitFor(() => expect(screen.getByText("song")).toBeTruthy());

    await fireEvent.click(screen.getByTitle("Preview song"));

    expect(mockTrack).toHaveBeenCalledWith("stats", "open_in_preview");
    expect(
      JSON.parse(sessionStorage.getItem("deluge-preview-file") ?? "{}").name,
    ).toBe("song.XML");
  });

  it("filters by clicking a key chip", async () => {
    mockAnalyzeStats.mockResolvedValue([
      stat({ filename: "a.XML", key: "C major" }),
      stat({ filename: "b.XML", key: "D minor" }),
    ]);
    render(SongAnalyzer);
    const dropzone = document.querySelector(".dropzone") as HTMLElement;
    await fireEvent.drop(
      dropzone,
      dropEvent([xmlFile("a.XML"), xmlFile("b.XML")]),
    );
    await waitFor(() => expect(screen.getByText("a")).toBeTruthy());

    await fireEvent.click(screen.getByText("C major"));

    expect(screen.getByText("a")).toBeTruthy();
    expect(screen.queryByText("b")).toBeNull();
    expect(screen.getByText("Clear filters")).toBeTruthy();

    await fireEvent.click(screen.getByText("Clear filters"));
    expect(screen.getByText("b")).toBeTruthy();
  });

  it("shows a reconnect button when a persisted handle is available but not connected", async () => {
    mockCardStore.hasPersistedHandle.mockResolvedValue(true);
    render(SongAnalyzer);
    const dropzone = document.querySelector(".dropzone") as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent([xmlFile("song.XML")]));
    await waitFor(() => expect(screen.getByText("song")).toBeTruthy());

    await waitFor(() =>
      expect(
        screen.getByText("Reconnect folder to enable delete"),
      ).toBeTruthy(),
    );

    mockCardStore.requestReconnect.mockImplementation(async () => {
      mockCardStore.rootHandle = { name: "CARD" };
      return true;
    });
    await fireEvent.click(
      screen.getByText("Reconnect folder to enable delete"),
    );
    await waitFor(() =>
      expect(
        screen.queryByText("Reconnect folder to enable delete"),
      ).toBeNull(),
    );
  });

  it("resets back to idle", async () => {
    render(SongAnalyzer);
    const dropzone = document.querySelector(".dropzone") as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent([xmlFile("song.XML")]));
    await waitFor(() => expect(screen.getByText("song")).toBeTruthy());

    await fireEvent.click(screen.getByText("Analyze more"));
    expect(screen.getByText("Drop your SD card or SONGS folder")).toBeTruthy();
  });
});

it("toggles between flat and folder view", async () => {
  mockCardStore.isLoaded = true;
  mockCardStore.songXmls = new Map([
    ["SONGS/A/one.XML", "<song></song>"],
    ["SONGS/A/two.XML", "<song></song>"],
    ["SONGS/B/three.XML", "<song></song>"],
  ]);
  mockCardStore.rootHandle = { name: "CARD" };
  mockAnalyzeStats.mockResolvedValue([
    stat({ filename: "one.XML" }),
    stat({ filename: "two.XML" }),
    stat({ filename: "three.XML" }),
  ]);

  render(SongAnalyzer);
  await waitFor(() => expect(screen.getByText("one")).toBeTruthy());

  // Default is flat — all songs in one table
  expect(document.querySelectorAll(".cell-name-text").length).toBe(3);
  expect(document.querySelector(".folder-group")).toBeNull();

  // Toggle to folder view
  await fireEvent.click(screen.getByText("Show folders"));

  // Should show folder groups
  expect(document.querySelectorAll(".folder-group").length).toBeGreaterThan(0);

  // Toggle back to flat
  await fireEvent.click(screen.getByText("Show flat"));
  expect(document.querySelector(".folder-group")).toBeNull();
});

it("shows folder headers with song counts in folder view", async () => {
  mockCardStore.isLoaded = true;
  mockCardStore.songXmls = new Map([
    ["SONGS/MyFolder/one.XML", "<song></song>"],
    ["SONGS/MyFolder/two.XML", "<song></song>"],
    ["SONGS/Other/three.XML", "<song></song>"],
  ]);
  mockCardStore.rootHandle = { name: "CARD" };
  mockAnalyzeStats.mockResolvedValue([
    stat({ filename: "one.XML" }),
    stat({ filename: "two.XML" }),
    stat({ filename: "three.XML" }),
  ]);

  render(SongAnalyzer);
  await waitFor(() => expect(screen.getByText("one")).toBeTruthy());

  await fireEvent.click(screen.getByText("Show folders"));

  // Folder headers should show
  const headers = document.querySelectorAll(".folder-header");
  expect(headers.length).toBeGreaterThanOrEqual(2);

  // Should contain folder names
  const headerTexts = Array.from(headers).map((h) => h.textContent);
  expect(headerTexts.some((t) => t?.includes("MyFolder"))).toBe(true);
  expect(headerTexts.some((t) => t?.includes("Other"))).toBe(true);
});

it("collapses and expands folders", async () => {
  mockCardStore.isLoaded = true;
  mockCardStore.songXmls = new Map([
    ["SONGS/A/one.XML", "<song></song>"],
    ["SONGS/B/two.XML", "<song></song>"],
  ]);
  mockCardStore.rootHandle = { name: "CARD" };
  mockAnalyzeStats.mockResolvedValue([
    stat({ filename: "one.XML" }),
    stat({ filename: "two.XML" }),
  ]);

  render(SongAnalyzer);
  await waitFor(() => expect(screen.getByText("one")).toBeTruthy());

  await fireEvent.click(screen.getByText("Show folders"));

  // Folders start collapsed — no song rows visible
  expect(document.querySelectorAll(".cell-name-text").length).toBe(0);

  // Click first folder header to expand
  const headers = document.querySelectorAll(".folder-header");
  await fireEvent.click(headers[0]);

  // One folder expanded — its song visible
  const visibleSongs = document.querySelectorAll(".cell-name-text");
  expect(visibleSongs.length).toBe(1);
});

it("folder view works on first toggle from card store", async () => {
  mockCardStore.isLoaded = true;
  mockCardStore.songXmls = new Map([
    ["SONGS/FolderA/one.XML", "<song></song>"],
    ["SONGS/FolderA/two.XML", "<song></song>"],
    ["SONGS/FolderB/three.XML", "<song></song>"],
  ]);
  mockCardStore.rootHandle = { name: "CARD" };
  mockAnalyzeStats.mockResolvedValue([
    stat({ filename: "one.XML" }),
    stat({ filename: "two.XML" }),
    stat({ filename: "three.XML" }),
  ]);

  render(SongAnalyzer);
  await waitFor(() => expect(screen.getByText("one")).toBeTruthy());

  // First toggle — should immediately show folder groups with real folder names
  await fireEvent.click(screen.getByText("Show folders"));

  const headers = document.querySelectorAll(".folder-header");
  const headerTexts = Array.from(headers).map((h) => h.textContent);
  // Should NOT show "(root)" — should show real folder paths
  expect(headerTexts.every((t) => !t?.includes("(root)"))).toBe(true);
  expect(headerTexts.some((t) => t?.includes("FolderA"))).toBe(true);
  expect(headerTexts.some((t) => t?.includes("FolderB"))).toBe(true);
});

it("shows an error when analysis throws", async () => {
  mockAnalyzeStats.mockRejectedValue(new Error("boom"));
  render(SongAnalyzer);
  const dropzone = document.querySelector(".dropzone") as HTMLElement;
  await fireEvent.drop(dropzone, dropEvent([xmlFile("song.XML")]));
  await waitFor(() => expect(screen.getByText("boom")).toBeTruthy());
});

it("shows an error when analysis from card store throws", async () => {
  mockCardStore.isLoaded = true;
  mockCardStore.songXmls = new Map([["SONGS/song.XML", "<song></song>"]]);
  mockCardStore.rootHandle = { name: "CARD" };
  mockAnalyzeStats.mockRejectedValue(new Error("card boom"));

  render(SongAnalyzer);
  await waitFor(() => expect(screen.getByText("card boom")).toBeTruthy());
  expect(mockTrack).toHaveBeenCalledWith("stats", "analyze_error");
});

it("does not delete when confirm is declined", async () => {
  vi.stubGlobal(
    "confirm",
    vi.fn(() => false),
  );
  mockCardStore.isLoaded = true;
  mockCardStore.songXmls = new Map([["SONGS/song.XML", "<song></song>"]]);
  mockCardStore.rootHandle = { name: "CARD" };

  render(SongAnalyzer);
  await waitFor(() => expect(screen.getByText("song")).toBeTruthy());

  await fireEvent.click(screen.getByTitle("Move to SOFT_DELETE/"));
  expect(mockMoveToTrash).not.toHaveBeenCalled();
  expect(screen.getByText("song")).toBeTruthy();
});

it("logs an error when delete fails", async () => {
  const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
  mockCardStore.isLoaded = true;
  mockCardStore.songXmls = new Map([["SONGS/song.XML", "<song></song>"]]);
  mockCardStore.rootHandle = { name: "CARD" };
  mockMoveToTrash.mockRejectedValue(new Error("delete failed"));

  render(SongAnalyzer);
  await waitFor(() => expect(screen.getByText("song")).toBeTruthy());

  await fireEvent.click(screen.getByTitle("Move to SOFT_DELETE/"));
  await waitFor(() => expect(mockMoveToTrash).toHaveBeenCalled());
  expect(consoleErr).toHaveBeenCalled();
  expect(screen.getByText("song")).toBeTruthy();

  consoleErr.mockRestore();
});

it("downloads directly on second click without re-converting", async () => {
  const createUrl = vi.fn().mockReturnValue("blob:mock");
  URL.createObjectURL = createUrl;
  URL.revokeObjectURL = vi.fn();
  const clickSpy = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});

  render(SongAnalyzer);
  const dropzone = document.querySelector(".dropzone") as HTMLElement;
  await fireEvent.drop(dropzone, dropEvent([xmlFile("song.XML")]));
  await waitFor(() => expect(screen.getByText("song")).toBeTruthy());

  await fireEvent.click(screen.getByTitle("Convert to MusicXML"));
  await waitFor(() => expect(mockConvertToMusicXML).toHaveBeenCalledTimes(1));

  await fireEvent.click(screen.getByTitle("Download MusicXML"));
  expect(mockConvertToMusicXML).toHaveBeenCalledTimes(1);
  expect(clickSpy).toHaveBeenCalledTimes(2);

  clickSpy.mockRestore();
});

it("shows a conversion error message", async () => {
  mockConvertToMusicXML.mockRejectedValue(new Error("convert failed"));
  render(SongAnalyzer);
  const dropzone = document.querySelector(".dropzone") as HTMLElement;
  await fireEvent.drop(dropzone, dropEvent([xmlFile("song.XML")]));
  await waitFor(() => expect(screen.getByText("song")).toBeTruthy());

  await fireEvent.click(screen.getByTitle("Convert to MusicXML"));
  await waitFor(() => expect(mockConvertToMusicXML).toHaveBeenCalled());
  await waitFor(() =>
    expect(screen.getByTitle("Convert to MusicXML")).toBeTruthy(),
  );
  expect(mockTrack).not.toHaveBeenCalledWith("stats", "convert_score");
});

it("filters by BPM min and max", async () => {
  mockAnalyzeStats.mockResolvedValue([
    stat({ filename: "a.XML", bpm: 100 }),
    stat({ filename: "b.XML", bpm: 200 }),
  ]);
  render(SongAnalyzer);
  const dropzone = document.querySelector(".dropzone") as HTMLElement;
  await fireEvent.drop(
    dropzone,
    dropEvent([xmlFile("a.XML"), xmlFile("b.XML")]),
  );
  await waitFor(() => expect(screen.getByText("a")).toBeTruthy());

  const [minInput, maxInput] = document.querySelectorAll(".filter-input");
  await fireEvent.input(minInput, { target: { value: "150" } });
  expect(screen.getByText("b")).toBeTruthy();
  expect(screen.queryByText("a")).toBeNull();

  await fireEvent.input(minInput, { target: { value: "" } });
  await fireEvent.input(maxInput, { target: { value: "150" } });
  expect(screen.getByText("a")).toBeTruthy();
  expect(screen.queryByText("b")).toBeNull();
});

it("filters by minimum notes", async () => {
  mockAnalyzeStats.mockResolvedValue([
    stat({ filename: "a.XML", totalNotes: 10 }),
    stat({ filename: "b.XML", totalNotes: 500 }),
  ]);
  render(SongAnalyzer);
  const dropzone = document.querySelector(".dropzone") as HTMLElement;
  await fireEvent.drop(
    dropzone,
    dropEvent([xmlFile("a.XML"), xmlFile("b.XML")]),
  );
  await waitFor(() => expect(screen.getByText("a")).toBeTruthy());

  const notesInput = Array.from(
    document.querySelectorAll(".filter-input"),
  )[2] as HTMLInputElement;
  await fireEvent.input(notesInput, { target: { value: "100" } });
  expect(screen.getByText("b")).toBeTruthy();
  expect(screen.queryByText("a")).toBeNull();
});

it.each([
  ["yes", "a"],
  ["no", "b"],
])("filters by arrangement presence (%s)", async (value, expected) => {
  mockAnalyzeStats.mockResolvedValue([
    stat({ filename: "a.XML", hasArrangement: true }),
    stat({ filename: "b.XML", hasArrangement: false }),
  ]);
  render(SongAnalyzer);
  const dropzone = document.querySelector(".dropzone") as HTMLElement;
  await fireEvent.drop(
    dropzone,
    dropEvent([xmlFile("a.XML"), xmlFile("b.XML")]),
  );
  await waitFor(() => expect(screen.getByText("a")).toBeTruthy());

  const [, arrSelect] = document.querySelectorAll(".filter-select");
  await fireEvent.change(arrSelect, { target: { value } });
  expect(screen.getByText(expected)).toBeTruthy();
});

it.each([
  ["deluge", "a"],
  ["external", "b"],
])("filters by gear (%s)", async (value, expected) => {
  mockAnalyzeStats.mockResolvedValue([
    stat({ filename: "a.XML", midiCount: 0, cvCount: 0 }),
    stat({ filename: "b.XML", midiCount: 1, cvCount: 0 }),
  ]);
  render(SongAnalyzer);
  const dropzone = document.querySelector(".dropzone") as HTMLElement;
  await fireEvent.drop(
    dropzone,
    dropEvent([xmlFile("a.XML"), xmlFile("b.XML")]),
  );
  await waitFor(() => expect(screen.getByText("a")).toBeTruthy());

  const [, , gearSelect] = document.querySelectorAll(".filter-select");
  await fireEvent.change(gearSelect, { target: { value } });
  expect(screen.getByText(expected)).toBeTruthy();
});

it("shows empty-results message when filters match nothing", async () => {
  mockAnalyzeStats.mockResolvedValue([stat({ filename: "a.XML" })]);
  render(SongAnalyzer);
  const dropzone = document.querySelector(".dropzone") as HTMLElement;
  await fireEvent.drop(dropzone, dropEvent([xmlFile("a.XML")]));
  await waitFor(() => expect(screen.getByText("a")).toBeTruthy());

  const search = document.querySelector(".filter-search") as HTMLInputElement;
  await fireEvent.input(search, { target: { value: "nonexistent" } });
  expect(screen.getByText("No songs match filters")).toBeTruthy();
});

it("renders summary stats and key matrix, and filters by matrix cell", async () => {
  mockAnalyzeStats.mockResolvedValue([
    stat({
      filename: "a.XML",
      key: "C major",
      bpm: 100,
      totalNotes: 50,
      instrumentCount: 2,
      clipCount: 3,
    }),
    stat({
      filename: "b.XML",
      key: "C major",
      bpm: 140,
      totalNotes: 70,
      instrumentCount: 1,
      clipCount: 2,
    }),
  ]);
  render(SongAnalyzer);
  const dropzone = document.querySelector(".dropzone") as HTMLElement;
  await fireEvent.drop(
    dropzone,
    dropEvent([xmlFile("a.XML"), xmlFile("b.XML")]),
  );
  await waitFor(() => expect(screen.getByText("a")).toBeTruthy());

  expect(document.querySelector(".summary")).toBeTruthy();
  expect(document.querySelector(".key-matrix")).toBeTruthy();

  const matrixBtn = document.querySelector(".matrix-btn") as HTMLElement;
  expect(matrixBtn.textContent).toBe("2");
  await fireEvent.click(matrixBtn);
  expect(screen.getByText("a")).toBeTruthy();
  expect(screen.getByText("b")).toBeTruthy();
});

it("shows an error row style and skips key chip for error keys", async () => {
  mockAnalyzeStats.mockResolvedValue([
    stat({ filename: "bad.XML", key: "Error: parse failed" }),
  ]);
  render(SongAnalyzer);
  const dropzone = document.querySelector(".dropzone") as HTMLElement;
  await fireEvent.drop(dropzone, dropEvent([xmlFile("bad.XML")]));
  await waitFor(() => expect(screen.getByText("bad")).toBeTruthy());

  expect(document.querySelector(".row--error")).toBeTruthy();
  expect(document.querySelector(".key-error")).toBeTruthy();
});

it.each([
  ["key", ["a", "b"]],
  ["instruments", ["b", "a"]],
  ["clips", ["b", "a"]],
  ["notes", ["b", "a"]],
])("sorts by %s column", async (col, expected) => {
  mockAnalyzeStats.mockResolvedValue([
    stat({
      filename: "a.XML",
      key: "C major",
      instrumentCount: 5,
      clipCount: 5,
      totalNotes: 500,
    }),
    stat({
      filename: "b.XML",
      key: "D minor",
      instrumentCount: 1,
      clipCount: 1,
      totalNotes: 1,
    }),
  ]);
  render(SongAnalyzer);
  const dropzone = document.querySelector(".dropzone") as HTMLElement;
  await fireEvent.drop(
    dropzone,
    dropEvent([xmlFile("a.XML"), xmlFile("b.XML")]),
  );
  await waitFor(() => expect(screen.getByText("a")).toBeTruthy());

  const header = Array.from(document.querySelectorAll(".sort-btn")).find(
    (b) =>
      b.getAttribute("class")?.includes("sort-btn") &&
      b.textContent
        ?.trim()
        .toLowerCase()
        .startsWith(
          col === "notes"
            ? "notes"
            : col === "clips"
              ? "clips"
              : col === "instruments"
                ? "inst"
                : "key",
        ),
  ) as HTMLElement;
  await fireEvent.click(header);

  const rows = Array.from(document.querySelectorAll(".cell-name-text")).map(
    (n) => n.textContent,
  );
  expect(rows).toEqual(expected);
});

it("restores results from session cache on mount", async () => {
  sessionStorage.setItem(
    "deluge-stats-results",
    JSON.stringify([stat({ filename: "cached.XML" })]),
  );
  render(SongAnalyzer);
  await waitFor(() => expect(screen.getByText("cached")).toBeTruthy());
});

it("opens the SD card root via the File System Access API", async () => {
  vi.stubGlobal("showDirectoryPicker", vi.fn());
  mockCardStore.pickDirectory.mockImplementation(
    async (cb: (status: string, current: number, total: number) => void) => {
      cb("Indexing", 1, 2);
      mockCardStore.songXmls = new Map([["SONGS/song.XML", "<song></song>"]]);
    },
  );

  render(SongAnalyzer);
  await waitFor(() =>
    expect(screen.getByText(/Open SD card root/)).toBeTruthy(),
  );
  await fireEvent.click(screen.getByText(/Open SD card root/));

  await waitFor(() => expect(screen.getByText("song")).toBeTruthy());
  expect(mockCardStore.pickDirectory).toHaveBeenCalled();
});

it("shows an error when the opened folder has no SONGS directory", async () => {
  vi.stubGlobal("showDirectoryPicker", vi.fn());
  mockCardStore.pickDirectory.mockResolvedValue(undefined);

  render(SongAnalyzer);
  await waitFor(() =>
    expect(screen.getByText(/Open SD card root/)).toBeTruthy(),
  );
  await fireEvent.click(screen.getByText(/Open SD card root/));

  await waitFor(() =>
    expect(screen.getByText(/Not a Deluge SD card/)).toBeTruthy(),
  );
});

it("silently ignores an AbortError from the folder picker", async () => {
  vi.stubGlobal("showDirectoryPicker", vi.fn());
  const abortErr = new Error("aborted");
  abortErr.name = "AbortError";
  mockCardStore.pickDirectory.mockRejectedValue(abortErr);

  render(SongAnalyzer);
  await waitFor(() =>
    expect(screen.getByText(/Open SD card root/)).toBeTruthy(),
  );
  await fireEvent.click(screen.getByText(/Open SD card root/));

  await waitFor(() => expect(mockCardStore.pickDirectory).toHaveBeenCalled());
  expect(screen.queryByText(/Not a Deluge SD card/)).toBeNull();
  expect(document.querySelector(".error-card")).toBeNull();
});

it("shows an error for non-abort folder picker failures", async () => {
  vi.stubGlobal("showDirectoryPicker", vi.fn());
  mockCardStore.pickDirectory.mockRejectedValue(new Error("picker failed"));

  render(SongAnalyzer);
  await waitFor(() =>
    expect(screen.getByText(/Open SD card root/)).toBeTruthy(),
  );
  await fireEvent.click(screen.getByText(/Open SD card root/));

  await waitFor(() => expect(screen.getByText("picker failed")).toBeTruthy());
});

it("handles a folder input change (webkitdirectory)", async () => {
  mockAnalyzeStats.mockResolvedValue([stat({ filename: "folder-song.XML" })]);
  render(SongAnalyzer);
  const input = document.getElementById(
    "stats-folder-input",
  ) as HTMLInputElement;
  Object.defineProperty(input, "files", {
    value: [xmlFile("folder-song.XML")],
    configurable: true,
  });
  await fireEvent.change(input);
  await waitFor(() => expect(screen.getByText("folder-song")).toBeTruthy());
});

it("adopts a dropped directory handle when available", async () => {
  mockCardStore.adoptHandle.mockImplementation(async () => {
    mockCardStore.songXmls = new Map([["SONGS/song.XML", "<song></song>"]]);
  });
  const item = {
    kind: "file",
    getAsFileSystemHandle: vi.fn().mockResolvedValue({
      kind: "directory",
      requestPermission: vi.fn().mockResolvedValue("granted"),
    }),
  };

  render(SongAnalyzer);
  const dropzone = document.querySelector(".dropzone") as HTMLElement;
  await fireEvent.drop(dropzone, {
    dataTransfer: { items: [item] },
  } as unknown as DragEvent);

  await waitFor(() => expect(screen.getByText("song")).toBeTruthy());
  expect(mockCardStore.adoptHandle).toHaveBeenCalled();
});

it("shows an error when the adopted directory handle has no songs", async () => {
  const item = {
    kind: "file",
    getAsFileSystemHandle: vi.fn().mockResolvedValue({
      kind: "directory",
      requestPermission: vi.fn().mockResolvedValue("granted"),
    }),
  };

  render(SongAnalyzer);
  const dropzone = document.querySelector(".dropzone") as HTMLElement;
  await fireEvent.drop(dropzone, {
    dataTransfer: { items: [item] },
  } as unknown as DragEvent);

  await waitFor(() =>
    expect(screen.getByText(/Not a Deluge SD card/)).toBeTruthy(),
  );
});

it("walks a dropped FileSystemEntry tree recursively via webkitGetAsEntry", async () => {
  mockAnalyzeStats.mockResolvedValue([stat({ filename: "nested.XML" })]);
  const fileEntry = {
    isFile: true,
    isDirectory: false,
    fullPath: "/SONGS/nested.XML",
    name: "nested.XML",
    file: (resolve: (f: File) => void) => resolve(xmlFile("nested.XML")),
  };
  const dirReader = {
    readEntries: (() => {
      let called = false;
      return (
        cb: (
          entries: {
            isFile: boolean;
            isDirectory: boolean;
            fullPath: string;
            name: string;
            file?: (f: (file: File) => void) => void;
            createReader?: () => unknown;
          }[],
        ) => void,
      ) => {
        if (!called) {
          called = true;
          cb([fileEntry]);
        } else {
          cb([]);
        }
      };
    })(),
  };
  const dirEntry = {
    isFile: false,
    isDirectory: true,
    name: "SONGS",
    createReader: () => dirReader,
  };
  const item = {
    kind: "file",
    webkitGetAsEntry: () => dirEntry,
  };

  render(SongAnalyzer);
  const dropzone = document.querySelector(".dropzone") as HTMLElement;
  await fireEvent.drop(dropzone, {
    dataTransfer: { items: [item] },
  } as unknown as DragEvent);

  await waitFor(() => expect(screen.getByText("nested")).toBeTruthy());
});

it("reconnects from session cache when a card was previously connected", async () => {
  sessionStorage.setItem(
    "deluge-stats-results",
    JSON.stringify([stat({ filename: "cached.XML" })]),
  );
  mockCardStore.reconnect.mockImplementation(async () => {
    mockCardStore.songXmls = new Map([["SONGS/cached.XML", "<song></song>"]]);
    mockCardStore.rootHandle = { name: "CARD" };
    return true;
  });

  render(SongAnalyzer);
  await waitFor(() => expect(screen.getByText("cached")).toBeTruthy());
  await waitFor(() =>
    expect(screen.getByTitle("Move to SOFT_DELETE/")).toBeTruthy(),
  );
});

it("sorts by modified date when the column header is clicked", async () => {
  mockAnalyzeStats.mockResolvedValue([
    stat({ filename: "old.XML", bpm: 100, lastModified: 1000 }),
    stat({ filename: "new.XML", bpm: 200, lastModified: 9999 }),
  ]);
  mockCardStore.isLoaded = true;
  mockCardStore.songXmls = new Map([
    ["SONGS/old.XML", "<song></song>"],
    ["SONGS/new.XML", "<song></song>"],
  ]);
  mockCardStore.songLastModified = new Map([
    ["SONGS/old.XML", 1000],
    ["SONGS/new.XML", 9999],
  ]);
  mockCardStore.rootHandle = { name: "CARD" };

  render(SongAnalyzer);
  await waitFor(() => expect(screen.getByText("old")).toBeTruthy());

  const modifiedHeader = screen.getByText("Modified");
  await fireEvent.click(modifiedHeader);

  const rows = document.querySelectorAll("tr");
  expect(rows.length).toBeGreaterThan(1);
});

it("handles dragover and dragleave events on the dropzone", async () => {
  render(SongAnalyzer);
  await Promise.resolve();
  const dropzone = document.querySelector(".dropzone") as HTMLElement;

  await fireEvent.dragOver(dropzone);
  expect(dropzone.classList.contains("dropzone--over")).toBe(true);

  await fireEvent.dragLeave(dropzone);
  expect(dropzone.classList.contains("dropzone--over")).toBe(false);
});

it('shows "No songs match filters" when all results are filtered out in folder view', async () => {
  mockAnalyzeStats.mockResolvedValue([stat({ filename: "song.XML" })]);
  render(SongAnalyzer);
  const dropzone = document.querySelector(".dropzone") as HTMLElement;
  await fireEvent.drop(dropzone, dropEvent([xmlFile("song.XML")]));
  await waitFor(() => expect(screen.getByText("song")).toBeTruthy());

  const folderBtn = screen.getByText("Show folders");
  await fireEvent.click(folderBtn);

  const search = document.querySelector(".filter-search") as HTMLInputElement;
  await fireEvent.input(search, { target: { value: "nonexistent-xyz" } });

  expect(screen.getByText("No songs match filters")).toBeTruthy();
});

it("triggers file input click on dropzone Enter key", async () => {
  render(SongAnalyzer);
  await Promise.resolve();
  const dropzone = document.querySelector(".dropzone") as HTMLElement;
  const clickSpy = vi.fn();
  const fileInput = document.getElementById(
    "stats-file-input",
  ) as HTMLInputElement;
  fileInput.click = clickSpy;

  await fireEvent.keyDown(dropzone, { key: "Enter" });
  expect(clickSpy).toHaveBeenCalled();
});

it("saves results to sessionStorage after analysis", async () => {
  render(SongAnalyzer);
  const dropzone = document.querySelector(".dropzone") as HTMLElement;
  await fireEvent.drop(dropzone, dropEvent([xmlFile("song.XML")]));
  await waitFor(() => expect(screen.getByText("song")).toBeTruthy());

  const cached = sessionStorage.getItem("deluge-stats-results");
  expect(cached).toBeTruthy();
  expect(JSON.parse(cached!)).toHaveLength(1);
});

it("shows dash placeholders and no type badges when a song has zero counts", async () => {
  mockAnalyzeStats.mockResolvedValue([
    stat({
      filename: "empty.XML",
      bpm: 0,
      synthCount: 0,
      kitCount: 0,
      midiCount: 0,
      cvCount: 0,
      audioCount: 0,
      instrumentCount: 0,
      clipCount: 0,
      totalNotes: 0,
      hasArrangement: false,
    }),
  ]);
  render(SongAnalyzer);
  const dropzone = document.querySelector(".dropzone") as HTMLElement;
  await fireEvent.drop(dropzone, dropEvent([xmlFile("empty.XML")]));
  await waitFor(() => expect(screen.getByText("empty")).toBeTruthy());

  const row = document.querySelector("tbody tr") as HTMLElement;
  expect(row.querySelector(".type-badge")).toBeNull();
  const numCells = row.querySelectorAll(".cell-num");
  expect(Array.from(numCells).map((c) => c.textContent)).toEqual([
    "-",
    "1:30",
    "-",
    "-",
    "-",
  ]);
});

it("shows MIDI, CV, and audio type badges", async () => {
  mockAnalyzeStats.mockResolvedValue([
    stat({
      filename: "gear.XML",
      synthCount: 0,
      kitCount: 0,
      midiCount: 1,
      cvCount: 1,
      audioCount: 1,
    }),
  ]);
  render(SongAnalyzer);
  const dropzone = document.querySelector(".dropzone") as HTMLElement;
  await fireEvent.drop(dropzone, dropEvent([xmlFile("gear.XML")]));
  await waitFor(() => expect(screen.getByText("gear")).toBeTruthy());

  const badges = document.querySelectorAll(".type-badge");
  expect(badges.length).toBe(3);
});

it("exports CSV with every gear type, no arrangement, zero BPM, and a comma in the name", async () => {
  const createUrl = vi.fn().mockReturnValue("blob:mock");
  URL.createObjectURL = createUrl;
  URL.revokeObjectURL = vi.fn();
  const clickSpy = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});

  mockAnalyzeStats.mockResolvedValue([
    stat({
      filename: "a,b.XML",
      bpm: 0,
      synthCount: 1,
      kitCount: 1,
      midiCount: 1,
      cvCount: 1,
      audioCount: 1,
      hasArrangement: false,
      lastModified: undefined,
    }),
  ]);
  render(SongAnalyzer);
  const dropzone = document.querySelector(".dropzone") as HTMLElement;
  await fireEvent.drop(dropzone, dropEvent([xmlFile("a,b.XML")]));
  await waitFor(() => expect(screen.getByText("a,b")).toBeTruthy());

  await fireEvent.click(screen.getByText("Export CSV"));
  expect(createUrl).toHaveBeenCalled();

  clickSpy.mockRestore();
});

it("toggles sort direction to descending on a second header click", async () => {
  mockAnalyzeStats.mockResolvedValue([
    stat({ filename: "a.XML", bpm: 100 }),
    stat({ filename: "b.XML", bpm: 200 }),
  ]);
  render(SongAnalyzer);
  const dropzone = document.querySelector(".dropzone") as HTMLElement;
  await fireEvent.drop(
    dropzone,
    dropEvent([xmlFile("a.XML"), xmlFile("b.XML")]),
  );
  await waitFor(() => expect(screen.getByText("a")).toBeTruthy());

  const bpmHeader = Array.from(document.querySelectorAll(".sort-btn")).find(
    (b) => b.textContent?.trim().startsWith("BPM"),
  ) as HTMLElement;
  await fireEvent.click(bpmHeader);
  await fireEvent.click(bpmHeader);

  expect(document.querySelector(".sort-arrow")?.textContent).toBe("▼");
  const rows = Array.from(document.querySelectorAll(".cell-name-text")).map(
    (n) => n.textContent,
  );
  expect(rows).toEqual(["b", "a"]);
});

it("deselects a key filter by clicking the active chip again", async () => {
  mockAnalyzeStats.mockResolvedValue([
    stat({ filename: "a.XML", key: "C major" }),
    stat({ filename: "b.XML", key: "D minor" }),
  ]);
  render(SongAnalyzer);
  const dropzone = document.querySelector(".dropzone") as HTMLElement;
  await fireEvent.drop(
    dropzone,
    dropEvent([xmlFile("a.XML"), xmlFile("b.XML")]),
  );
  await waitFor(() => expect(screen.getByText("a")).toBeTruthy());

  await fireEvent.click(screen.getByText("C major"));
  expect(screen.queryByText("b")).toBeNull();

  await fireEvent.click(screen.getByText("C major"));
  expect(screen.getByText("b")).toBeTruthy();
});

it("toggles the same sortable column twice via setSort", async () => {
  mockAnalyzeStats.mockResolvedValue([
    stat({ filename: "a.XML", clipCount: 1 }),
    stat({ filename: "b.XML", clipCount: 5 }),
  ]);
  render(SongAnalyzer);
  const dropzone = document.querySelector(".dropzone") as HTMLElement;
  await fireEvent.drop(
    dropzone,
    dropEvent([xmlFile("a.XML"), xmlFile("b.XML")]),
  );
  await waitFor(() => expect(screen.getByText("a")).toBeTruthy());

  const clipsHeader = Array.from(document.querySelectorAll(".sort-btn")).find(
    (b) => b.textContent?.trim().startsWith("Clips"),
  ) as HTMLElement;
  await fireEvent.click(clipsHeader);
  let rows = Array.from(document.querySelectorAll(".cell-name-text")).map(
    (n) => n.textContent,
  );
  expect(rows).toEqual(["a", "b"]);

  await fireEvent.click(clipsHeader);
  rows = Array.from(document.querySelectorAll(".cell-name-text")).map(
    (n) => n.textContent,
  );
  expect(rows).toEqual(["b", "a"]);
});

it("collapses a folder that was already expanded", async () => {
  mockCardStore.isLoaded = true;
  mockCardStore.songXmls = new Map([
    ["SONGS/A/one.XML", "<song></song>"],
    ["SONGS/B/two.XML", "<song></song>"],
  ]);
  mockCardStore.rootHandle = { name: "CARD" };
  mockAnalyzeStats.mockResolvedValue([
    stat({ filename: "one.XML" }),
    stat({ filename: "two.XML" }),
  ]);

  render(SongAnalyzer);
  await waitFor(() => expect(screen.getByText("one")).toBeTruthy());
  await fireEvent.click(screen.getByText("Show folders"));

  const headers = document.querySelectorAll(".folder-header");
  await fireEvent.click(headers[0]);
  expect(document.querySelectorAll(".cell-name-text").length).toBe(1);

  await fireEvent.click(headers[0]);
  expect(document.querySelectorAll(".cell-name-text").length).toBe(0);
});

it('falls back to "?" scale label for a root-only key', async () => {
  mockAnalyzeStats.mockResolvedValue([
    stat({ filename: "a.XML", key: "C" }),
    stat({ filename: "b.XML", key: "C minor" }),
  ]);
  render(SongAnalyzer);
  const dropzone = document.querySelector(".dropzone") as HTMLElement;
  await fireEvent.drop(
    dropzone,
    dropEvent([xmlFile("a.XML"), xmlFile("b.XML")]),
  );
  await waitFor(() => expect(screen.getByText("a")).toBeTruthy());

  expect(document.querySelector(".matrix-table")).toBeTruthy();
  const scaleHeaders = Array.from(
    document.querySelectorAll(".matrix-table thead th"),
  ).map((t) => t.textContent);
  expect(scaleHeaders).toContain("?");
});

it("groups two different scales under the same root in the key matrix", async () => {
  mockAnalyzeStats.mockResolvedValue([
    stat({ filename: "a.XML", key: "C major" }),
    stat({ filename: "b.XML", key: "C minor" }),
  ]);
  render(SongAnalyzer);
  const dropzone = document.querySelector(".dropzone") as HTMLElement;
  await fireEvent.drop(
    dropzone,
    dropEvent([xmlFile("a.XML"), xmlFile("b.XML")]),
  );
  await waitFor(() => expect(screen.getByText("a")).toBeTruthy());

  const matrixCells = document.querySelectorAll(".matrix-cell--filled");
  expect(matrixCells.length).toBe(2);
});

it("omits the BPM stat when every song has zero BPM", async () => {
  mockAnalyzeStats.mockResolvedValue([stat({ filename: "a.XML", bpm: 0 })]);
  render(SongAnalyzer);
  const dropzone = document.querySelector(".dropzone") as HTMLElement;
  await fireEvent.drop(dropzone, dropEvent([xmlFile("a.XML")]));
  await waitFor(() => expect(screen.getByText("a")).toBeTruthy());

  expect(document.querySelector(".summary")).toBeTruthy();
  expect(screen.queryByText(/BPM range/)).toBeNull();
});

it("treats a cached empty results array as no cache and falls through to auto-load", async () => {
  sessionStorage.setItem("deluge-stats-results", JSON.stringify([]));
  render(SongAnalyzer);
  await Promise.resolve();
  expect(screen.getByText("Drop your SD card or SONGS folder")).toBeTruthy();
});

it("auto-loads by reconnecting when no card is loaded and no session cache exists", async () => {
  mockCardStore.isLoaded = false;
  mockCardStore.reconnect.mockImplementation(async () => {
    mockCardStore.songXmls = new Map([["SONGS/auto.XML", "<song></song>"]]);
    mockCardStore.rootHandle = { name: "CARD" };
    return true;
  });
  mockAnalyzeStats.mockResolvedValue([stat({ filename: "auto.XML" })]);

  render(SongAnalyzer);
  await waitFor(() => expect(screen.getByText("auto")).toBeTruthy());
});

it("does nothing when a dropped item hands back a non-directory handle", async () => {
  const item = {
    kind: "file",
    getAsFileSystemHandle: vi.fn().mockResolvedValue({ kind: "file" }),
  };
  render(SongAnalyzer);
  const dropzone = document.querySelector(".dropzone") as HTMLElement;
  await fireEvent.drop(dropzone, {
    dataTransfer: { items: [item], files: [] },
  } as unknown as DragEvent);

  await Promise.resolve();
  expect(screen.getByText("Drop your SD card or SONGS folder")).toBeTruthy();
  expect(mockCardStore.adoptHandle).not.toHaveBeenCalled();
});

it("skips app-managed directories like SOFT_DELETE when walking a dropped tree", async () => {
  const dirEntry = {
    isFile: false,
    isDirectory: true,
    name: "SOFT_DELETE",
    createReader: () => ({
      readEntries: (cb: (e: unknown[]) => void) => cb([]),
    }),
  };
  const item = {
    kind: "file",
    webkitGetAsEntry: () => dirEntry,
  };
  render(SongAnalyzer);
  const dropzone = document.querySelector(".dropzone") as HTMLElement;
  await fireEvent.drop(dropzone, {
    dataTransfer: { items: [item] },
  } as unknown as DragEvent);

  await waitFor(() =>
    expect(screen.getByText(/No \.XML files found/)).toBeTruthy(),
  );
});

it("shows a generic error message when the folder picker fails without a message", async () => {
  vi.stubGlobal("showDirectoryPicker", vi.fn());
  mockCardStore.pickDirectory.mockRejectedValue({});

  render(SongAnalyzer);
  await waitFor(() =>
    expect(screen.getByText(/Open SD card root/)).toBeTruthy(),
  );
  await fireEvent.click(screen.getByText(/Open SD card root/));

  await waitFor(() =>
    expect(screen.getByText("Failed to open folder")).toBeTruthy(),
  );
});
