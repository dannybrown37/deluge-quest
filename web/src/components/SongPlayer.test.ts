import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SongPlayer from "./SongPlayer.svelte";

vi.mock("../lib/homeAudio", () => ({
  homeAudio: {
    isPlaying: false,
    songLoaded: false,
    loadedSongIndex: -1,
    songs: [{ name: "Test Song" }],
    currentSongIndex: 0,
    get elapsed() {
      return 0;
    },
    get duration() {
      return 0;
    },
    subscribe: vi.fn(() => vi.fn()),
    fetchSongList: vi.fn().mockResolvedValue(undefined),
    initAudio: vi.fn().mockResolvedValue(undefined),
    loadSong: vi.fn().mockResolvedValue(true),
    togglePlay: vi.fn().mockResolvedValue(undefined),
  },
}));

import { homeAudio } from "../lib/homeAudio";

const mockHomeAudio = homeAudio as unknown as {
  isPlaying: boolean;
  songLoaded: boolean;
  loadedSongIndex: number;
  songs: { name: string }[];
  currentSongIndex: number;
  subscribe: ReturnType<typeof vi.fn>;
  fetchSongList: ReturnType<typeof vi.fn>;
  initAudio: ReturnType<typeof vi.fn>;
  loadSong: ReturnType<typeof vi.fn>;
  togglePlay: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  mockHomeAudio.isPlaying = false;
  mockHomeAudio.songLoaded = false;
  mockHomeAudio.loadedSongIndex = -1;
  mockHomeAudio.currentSongIndex = 0;
  mockHomeAudio.songs = [{ name: "Test Song" }];
  vi.clearAllMocks();
  mockHomeAudio.subscribe.mockReturnValue(vi.fn());
  mockHomeAudio.fetchSongList.mockResolvedValue(undefined);
  mockHomeAudio.initAudio.mockResolvedValue(undefined);
  mockHomeAudio.loadSong.mockResolvedValue(true);
  mockHomeAudio.togglePlay.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe("SongPlayer", () => {
  it("renders the song name", () => {
    render(SongPlayer, {
      name: "Test Song",
      pageUrl: "https://deluge.quest/songs/test",
    });
    expect(screen.getByText("Test Song")).toBeTruthy();
  });

  it("renders optional metadata tags when provided", () => {
    render(SongPlayer, {
      name: "Test Song",
      pageUrl: "https://deluge.quest/songs/test",
      genre: "Techno",
      year: "2024",
      duration: "3:00",
    });
    expect(screen.getByText("Techno")).toBeTruthy();
    expect(screen.getByText("2024")).toBeTruthy();
    expect(screen.getByText("3:00")).toBeTruthy();
  });

  it("omits metadata tags when not provided", () => {
    render(SongPlayer, {
      name: "Test Song",
      pageUrl: "https://deluge.quest/songs/test",
    });
    expect(screen.queryByText("Techno")).toBeNull();
  });

  it("fetches the song list and syncs on mount", async () => {
    render(SongPlayer, {
      name: "Test Song",
      pageUrl: "https://deluge.quest/songs/test",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(mockHomeAudio.fetchSongList).toHaveBeenCalled();
    expect(mockHomeAudio.currentSongIndex).toBe(0);
  });

  it("loads and plays the song when the play button is clicked", async () => {
    render(SongPlayer, {
      name: "Test Song",
      pageUrl: "https://deluge.quest/songs/test",
    });
    await Promise.resolve();

    const playButton = screen.getByRole("button", { name: "Play" });
    await fireEvent.click(playButton);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockHomeAudio.initAudio).toHaveBeenCalled();
    expect(mockHomeAudio.loadSong).toHaveBeenCalledWith(0);
    expect(mockHomeAudio.togglePlay).toHaveBeenCalled();
  });

  it("does not reload an already-loaded song", async () => {
    mockHomeAudio.loadedSongIndex = 0;
    render(SongPlayer, {
      name: "Test Song",
      pageUrl: "https://deluge.quest/songs/test",
    });
    await Promise.resolve();

    const playButton = screen.getByRole("button", { name: "Play" });
    await fireEvent.click(playButton);
    await Promise.resolve();

    expect(mockHomeAudio.loadSong).not.toHaveBeenCalled();
    expect(mockHomeAudio.togglePlay).toHaveBeenCalled();
  });

  it("uses the Web Share API when available", async () => {
    const shareMock = vi.fn();
    Object.defineProperty(navigator, "share", {
      value: shareMock,
      configurable: true,
    });

    render(SongPlayer, {
      name: "Test Song",
      pageUrl: "https://deluge.quest/songs/test",
    });
    await fireEvent.click(screen.getByRole("button", { name: "Share" }));

    expect(shareMock).toHaveBeenCalledWith({
      title: "Test Song — deluge.quest",
      url: "https://deluge.quest/songs/test",
    });

    delete (navigator as { share?: unknown }).share;
  });

  it("falls back to clipboard copy when Web Share API is unavailable", async () => {
    delete (navigator as { share?: unknown }).share;
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextMock },
      configurable: true,
    });

    render(SongPlayer, {
      name: "Test Song",
      pageUrl: "https://deluge.quest/songs/test",
    });
    await fireEvent.click(screen.getByRole("button", { name: "Share" }));

    expect(writeTextMock).toHaveBeenCalledWith(
      "https://deluge.quest/songs/test",
    );
    expect(screen.getByText("Link copied")).toBeTruthy();
  });

  it("swaps to the pause icon once playback starts", async () => {
    mockHomeAudio.togglePlay.mockImplementation(async () => {
      mockHomeAudio.isPlaying = true;
    });

    render(SongPlayer, {
      name: "Test Song",
      pageUrl: "https://deluge.quest/songs/test",
    });
    await fireEvent.click(screen.getByRole("button", { name: "Play" }));
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
  });

  it("runs the animation-frame tick loop while playing", async () => {
    let tickCallback: FrameRequestCallback | undefined;
    const rafSpy = vi
      .spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation((cb: FrameRequestCallback) => {
        tickCallback = cb;
        return 1;
      });
    let publish: (() => void) | undefined;
    mockHomeAudio.subscribe.mockImplementation((fn: () => void) => {
      publish = fn;
      return vi.fn();
    });

    render(SongPlayer, {
      name: "Test Song",
      pageUrl: "https://deluge.quest/songs/test",
    });
    await Promise.resolve();
    await Promise.resolve();

    mockHomeAudio.isPlaying = true;
    publish?.();
    expect(rafSpy).toHaveBeenCalled();

    tickCallback?.(0);
    expect(rafSpy).toHaveBeenCalledTimes(2);

    rafSpy.mockRestore();
  });
});
