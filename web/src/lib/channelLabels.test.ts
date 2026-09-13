import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getChannelLabels,
  setChannelLabel,
  removeChannelLabel,
  formatChannel,
} from "./channelLabels";

const storageMap = new Map<string, string>();

beforeEach(() => {
  storageMap.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storageMap.get(k) ?? null,
    setItem: (k: string, v: string) => storageMap.set(k, v),
    removeItem: (k: string) => storageMap.delete(k),
  });
});

describe("getChannelLabels", () => {
  it("returns empty object when nothing stored", () => {
    expect(getChannelLabels()).toEqual({});
  });

  it("returns parsed labels", () => {
    storageMap.set("deluge-channel-labels", JSON.stringify({ 9: "Peak", 10: "Sub Phatty" }));
    expect(getChannelLabels()).toEqual({ 9: "Peak", 10: "Sub Phatty" });
  });

  it("strips whitespace-only values", () => {
    storageMap.set("deluge-channel-labels", JSON.stringify({ 9: "  ", 10: "Valid" }));
    expect(getChannelLabels()).toEqual({ 10: "Valid" });
  });

  it("returns empty object on corrupt JSON", () => {
    storageMap.set("deluge-channel-labels", "not json");
    expect(getChannelLabels()).toEqual({});
  });
});

describe("setChannelLabel", () => {
  it("adds a label", () => {
    setChannelLabel(9, "Peak");
    expect(getChannelLabels()).toEqual({ 9: "Peak" });
  });

  it("trims whitespace", () => {
    setChannelLabel(9, "  Peak  ");
    expect(getChannelLabels()).toEqual({ 9: "Peak" });
  });

  it("overwrites existing", () => {
    setChannelLabel(9, "Peak");
    setChannelLabel(9, "Hydra");
    expect(getChannelLabels()).toEqual({ 9: "Hydra" });
  });
});

describe("removeChannelLabel", () => {
  it("removes an existing label", () => {
    setChannelLabel(9, "Peak");
    setChannelLabel(10, "Sub");
    removeChannelLabel(9);
    expect(getChannelLabels()).toEqual({ 10: "Sub" });
  });

  it("is a no-op for missing channel", () => {
    removeChannelLabel(99);
    expect(getChannelLabels()).toEqual({});
  });
});

describe("formatChannel", () => {
  it("returns label when present", () => {
    expect(formatChannel(9, { 9: "Peak" })).toBe("Peak");
  });

  it("falls back to 'Ch N'", () => {
    expect(formatChannel(9, {})).toBe("Ch 9");
  });

  it("reads from localStorage when no labels passed", () => {
    setChannelLabel(9, "Peak");
    expect(formatChannel(9)).toBe("Peak");
  });
});
