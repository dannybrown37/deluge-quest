import { describe, expect, it } from "vitest";
import {
  createEmptyKit,
  createEmptyRow,
  generateKitXml,
  hexToPan,
  hexToVolume,
  type Kit,
  type KitRow,
  panToHex,
  parseKitXml,
  volumeToHex,
} from "./kitXml";

describe("createEmptyRow / createEmptyKit", () => {
  it("creates a row with sane defaults", () => {
    const row = createEmptyRow();
    expect(row).toEqual({
      name: "NEW",
      samplePath: "",
      volume: 80,
      pan: 0,
      loopMode: "once",
      polyphonic: "auto",
    });
  });

  it("creates an empty kit with no selection", () => {
    const kit = createEmptyKit();
    expect(kit).toEqual({ name: "Kit", rows: [], selectedIndex: -1 });
  });
});

describe("volumeToHex / hexToVolume", () => {
  it("maps 0 and 100 to the documented signed-32 extremes", () => {
    expect(volumeToHex(0)).toBe("0x80000000");
    expect(volumeToHex(100)).toBe("0x7FFFFFFF");
  });

  it.each([0, 1, 50, 80, 100])("round-trips volume=%d", (v) => {
    expect(hexToVolume(volumeToHex(v))).toBe(v);
  });

  it.each([
    [-20, 0],
    [150, 100],
  ])("clamps out-of-range volume %d to %d", (input, clamped) => {
    expect(volumeToHex(input)).toBe(volumeToHex(clamped));
  });
});

describe("panToHex / hexToPan", () => {
  it("maps center and the documented extremes", () => {
    expect(panToHex(0)).toBe("0x00000000");
    expect(panToHex(50)).toBe("0x7FFFFFFF");
  });

  it.each([-50, -25, 0, 25, 50])("round-trips pan=%d", (p) => {
    expect(hexToPan(panToHex(p))).toBe(p);
  });

  it.each([
    [-100, -50],
    [100, 50],
  ])("clamps out-of-range pan %d to %d", (input, clamped) => {
    expect(panToHex(input)).toBe(panToHex(clamped));
  });
});

describe("generateKitXml", () => {
  it("produces well-formed XML parseable by DOMParser", () => {
    const kit: Kit = {
      name: "Kit",
      selectedIndex: 0,
      rows: [createEmptyRow("KICK", "SAMPLES/kick.wav")],
    };
    const xml = generateKitXml(kit);
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.querySelectorAll("soundSources > sound")).toHaveLength(1);
  });

  it("emits one <sound> per row, in order", () => {
    const kit: Kit = {
      name: "Kit",
      selectedIndex: 0,
      rows: [createEmptyRow("A"), createEmptyRow("B"), createEmptyRow("C")],
    };
    const xml = generateKitXml(kit);
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const names = [...doc.querySelectorAll("sound")].map((s) =>
      s.getAttribute("name"),
    );
    expect(names).toEqual(["A", "B", "C"]);
  });

  it("clamps a negative selectedIndex to 0", () => {
    const kit = createEmptyKit();
    const xml = generateKitXml(kit);
    expect(xml).toContain("<selectedDrumIndex>0</selectedDrumIndex>");
  });

  it("escapes XML-special characters in name and samplePath", () => {
    const kit: Kit = {
      name: "Kit",
      selectedIndex: 0,
      rows: [createEmptyRow('A & B <"weird">', "SAMPLES/a&b.wav")],
    };
    const xml = generateKitXml(kit);
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    expect(doc.querySelector("parsererror")).toBeNull();
    const sound = doc.querySelector("sound")!;
    expect(sound.getAttribute("name")).toBe('A & B <"weird">');
    expect(sound.querySelector("osc1")!.getAttribute("fileName")).toBe(
      "SAMPLES/a&b.wav",
    );
  });
});

describe("parseKitXml", () => {
  it("throws when there is no <kit> root element", () => {
    expect(() => parseKitXml("<notakit></notakit>")).toThrow(
      "No <kit> root element found",
    );
  });

  it("parses attribute-style sound elements", () => {
    const xml = `<kit><soundSources>
      <sound name="KICK" polyphonic="2">
        <osc1 fileName="SAMPLES/kick.wav" loopMode="2" />
        <defaultParams volume="0x7FFFFFFF" pan="0x00000000" />
      </sound>
    </soundSources></kit>`;
    const kit = parseKitXml(xml);
    expect(kit.rows).toEqual([
      {
        name: "KICK",
        samplePath: "SAMPLES/kick.wav",
        volume: 100,
        pan: 0,
        loopMode: "loop",
        polyphonic: "poly",
      },
    ]);
    expect(kit.selectedIndex).toBe(0);
  });

  it("parses child-element-style sound elements (getAttrOrChild fallback)", () => {
    const xml = `<kit><soundSources>
      <sound>
        <name>SNARE</name>
        <polyphonic>choke</polyphonic>
        <osc1>
          <fileName>SAMPLES/snare.wav</fileName>
          <loopMode>0</loopMode>
        </osc1>
        <defaultParams>
          <volume>0x80000000</volume>
          <pan>0x7FFFFFFF</pan>
        </defaultParams>
      </sound>
    </soundSources></kit>`;
    const kit = parseKitXml(xml);
    expect(kit.rows).toEqual([
      {
        name: "SNARE",
        samplePath: "SAMPLES/snare.wav",
        volume: 0,
        pan: 50,
        loopMode: "cut",
        polyphonic: "choke",
      },
    ]);
  });

  it("falls back to defaults for missing fields", () => {
    const xml = `<kit><soundSources><sound></sound></soundSources></kit>`;
    const kit = parseKitXml(xml);
    expect(kit.rows).toEqual([
      {
        name: "UNNAMED",
        samplePath: "",
        volume: hexToVolume("0x4CCCCCA8"),
        pan: hexToPan("0x00000000"),
        loopMode: "once",
        polyphonic: "auto",
      },
    ]);
  });

  it("maps unrecognized loopMode/polyphonic codes to their defaults", () => {
    const xml = `<kit><soundSources>
      <sound polyphonic="99">
        <osc1 fileName="x.wav" loopMode="99" />
      </sound>
    </soundSources></kit>`;
    const kit = parseKitXml(xml);
    expect(kit.rows[0].loopMode).toBe("once");
    expect(kit.rows[0].polyphonic).toBe("auto");
  });

  it("returns selectedIndex -1 for a kit with no sounds", () => {
    const xml = `<kit><soundSources></soundSources></kit>`;
    const kit = parseKitXml(xml);
    expect(kit.rows).toEqual([]);
    expect(kit.selectedIndex).toBe(-1);
  });

  it("parses multiple sounds in document order", () => {
    const xml = `<kit><soundSources>
      <sound name="A"><osc1 fileName="a.wav" /></sound>
      <sound name="B"><osc1 fileName="b.wav" /></sound>
    </soundSources></kit>`;
    const kit = parseKitXml(xml);
    expect(kit.rows.map((r) => r.name)).toEqual(["A", "B"]);
  });
});

describe("generateKitXml -> parseKitXml round trip", () => {
  it("preserves row data through a full save/load cycle", () => {
    const rows: KitRow[] = [
      {
        name: "KICK",
        samplePath: "SAMPLES/kick.wav",
        volume: 90,
        pan: -20,
        loopMode: "once",
        polyphonic: "mono",
      },
      {
        name: "SNARE & CLAP",
        samplePath: 'SAMPLES/DRUMS/sn "1".wav',
        volume: 0,
        pan: 50,
        loopMode: "loop",
        polyphonic: "poly",
      },
      {
        name: "HAT",
        samplePath: "SAMPLES/hat.wav",
        volume: 100,
        pan: 0,
        loopMode: "cut",
        polyphonic: "choke",
      },
    ];
    const kit: Kit = { name: "Kit", selectedIndex: 1, rows };

    const xml = generateKitXml(kit);
    const roundTripped = parseKitXml(xml);

    expect(roundTripped.rows).toHaveLength(rows.length);
    roundTripped.rows.forEach((row, i) => {
      expect(row.name).toBe(rows[i].name);
      expect(row.samplePath).toBe(rows[i].samplePath);
      expect(row.loopMode).toBe(rows[i].loopMode);
      expect(row.polyphonic).toBe(rows[i].polyphonic);
      expect(row.volume).toBeCloseTo(rows[i].volume, 0);
      expect(row.pan).toBeCloseTo(rows[i].pan, 0);
    });
  });
});
