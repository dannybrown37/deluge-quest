import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MidiImporter from "./MidiImporter.svelte";

vi.mock("../lib/pyodide", () => ({
  loadPyodide: vi.fn(),
  convertMidiToDelugeXml: vi.fn(),
}));

vi.mock("../lib/analytics", () => ({
  trackToolAction: vi.fn(),
}));

import { trackToolAction } from "../lib/analytics";
import { convertMidiToDelugeXml, loadPyodide } from "../lib/pyodide";

const mockLoadPyodide = loadPyodide as unknown as ReturnType<typeof vi.fn>;
const mockConvert = convertMidiToDelugeXml as unknown as ReturnType<
  typeof vi.fn
>;
const mockTrack = trackToolAction as unknown as ReturnType<typeof vi.fn>;

function midiFile(name: string): File {
  return new File([new Uint8Array([0x4d, 0x54, 0x68, 0x64])], name, {
    type: "audio/midi",
  });
}

function dropEvent(file: File | undefined) {
  return {
    dataTransfer: { files: file ? [file] : [] },
  } as unknown as DragEvent;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadPyodide.mockResolvedValue({});
  mockConvert.mockResolvedValue("<song></song>");
});

afterEach(() => {
  cleanup();
});

describe("MidiImporter", () => {
  it("renders the dropzone in the idle state", () => {
    render(MidiImporter);
    expect(screen.getByText("Drop a MIDI file")).toBeTruthy();
  });

  it("rejects a non-MIDI file with an error", async () => {
    render(MidiImporter);
    const dropzone = screen.getByRole("button");

    await fireEvent.drop(dropzone, dropEvent(new File(["x"], "song.mp3")));

    expect(screen.getByText("Please drop a .mid or .midi file")).toBeTruthy();
    expect(mockConvert).not.toHaveBeenCalled();
  });

  it("converts a dropped MIDI file and shows the result", async () => {
    render(MidiImporter);
    const dropzone = screen.getByRole("button");

    await fireEvent.drop(dropzone, dropEvent(midiFile("track.mid")));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockConvert).toHaveBeenCalled();
    expect(screen.getByText("Import complete")).toBeTruthy();
    expect(mockTrack).toHaveBeenCalledWith("import", "convert");
  });

  it("shows an error card when conversion fails", async () => {
    mockConvert.mockRejectedValue(new Error("bad midi"));
    render(MidiImporter);
    const dropzone = screen.getByRole("button");

    await fireEvent.drop(dropzone, dropEvent(midiFile("track.mid")));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.getByText("bad midi")).toBeTruthy();
    expect(mockTrack).toHaveBeenCalledWith("import", "convert_error");
  });

  it("falls back to a generic error message when the rejection has none", async () => {
    mockConvert.mockRejectedValue({});
    render(MidiImporter);
    const dropzone = screen.getByRole("button");

    await fireEvent.drop(dropzone, dropEvent(midiFile("track.mid")));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.getByText("Conversion failed")).toBeTruthy();
  });

  it("resets from the error state back to idle", async () => {
    mockConvert.mockRejectedValue(new Error("bad midi"));
    render(MidiImporter);
    const dropzone = screen.getByRole("button");

    await fireEvent.drop(dropzone, dropEvent(midiFile("track.mid")));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("Drop a MIDI file")).toBeTruthy();
  });

  it('resets from the done state via "Import another"', async () => {
    render(MidiImporter);
    const dropzone = screen.getByRole("button");

    await fireEvent.drop(dropzone, dropEvent(midiFile("track.mid")));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    await fireEvent.click(
      screen.getByRole("button", { name: "Import another" }),
    );
    expect(screen.getByText("Drop a MIDI file")).toBeTruthy();
  });

  it("toggles the drag-over state on dragover/dragleave", async () => {
    render(MidiImporter);
    const dropzone = screen.getByRole("button");

    await fireEvent.dragOver(dropzone);
    expect(dropzone.className).toContain("dropzone--over");

    await fireEvent.dragLeave(dropzone);
    expect(dropzone.className).not.toContain("dropzone--over");
  });

  it("does nothing on drop with no files", async () => {
    render(MidiImporter);
    const dropzone = screen.getByRole("button");

    await fireEvent.drop(dropzone, dropEvent(undefined));

    expect(mockConvert).not.toHaveBeenCalled();
    expect(screen.getByText("Drop a MIDI file")).toBeTruthy();
  });

  it("converts a MIDI file chosen via the file input", async () => {
    render(MidiImporter);
    const input = document.getElementById(
      "midi-file-input",
    ) as HTMLInputElement;
    const file = midiFile("picked.mid");
    Object.defineProperty(input, "files", { value: [file] });

    await fireEvent.change(input);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockConvert).toHaveBeenCalled();
    expect(screen.getByText("Import complete")).toBeTruthy();
  });

  it("does nothing when the file input change has no file", async () => {
    render(MidiImporter);
    const input = document.getElementById(
      "midi-file-input",
    ) as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [] });

    await fireEvent.change(input);

    expect(mockConvert).not.toHaveBeenCalled();
    expect(screen.getByText("Drop a MIDI file")).toBeTruthy();
  });

  it("downloads the result XML", async () => {
    render(MidiImporter);
    const dropzone = screen.getByRole("button");
    await fireEvent.drop(dropzone, dropEvent(midiFile("track.mid")));
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
      screen.getByRole("button", { name: "Download Deluge XML" }),
    );

    expect(createUrl).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(revokeUrl).toHaveBeenCalledWith("blob:mock");
    expect(mockTrack).toHaveBeenCalledWith("import", "download");

    clickSpy.mockRestore();
  });

  it("activates the file picker on Enter/Space keydown", async () => {
    render(MidiImporter);
    const dropzone = screen.getByRole("button");
    const input = document.getElementById(
      "midi-file-input",
    ) as HTMLInputElement;
    const clickSpy = vi.spyOn(input, "click").mockImplementation(() => {});

    await fireEvent.keyDown(dropzone, { key: "Enter" });
    expect(clickSpy).toHaveBeenCalledTimes(1);

    await fireEvent.keyDown(dropzone, { key: " " });
    expect(clickSpy).toHaveBeenCalledTimes(2);

    await fireEvent.keyDown(dropzone, { key: "a" });
    expect(clickSpy).toHaveBeenCalledTimes(2);

    clickSpy.mockRestore();
  });
});
