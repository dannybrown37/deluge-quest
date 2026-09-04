import type { SavePoint, SaveKind } from "./historyStore";

export type ChangeKind = "added" | "removed" | "changed";

export interface FieldChange {
  /** Plain-words name for the field, or the raw path when we do not know it. */
  label: string;
  /** Where in the XML the change is, for anyone who wants the detail. */
  path: string;
  kind: ChangeKind;
  from?: string;
  to?: string;
  /** One line ready to show. */
  summary: string;
  /**
   * True for fields the Deluge rewrites as part of saving — scroll, zoom, the pad preview.
   * These are real changes and are never dropped, but they are not musical, so the view keeps
   * them out of the headline and collapses them behind a count.
   */
  viewOnly?: boolean;
}

export type FileStatus = "added" | "removed" | "changed" | "unchanged";

export interface FileChange {
  path: string;
  kind: SaveKind;
  status: FileStatus;
  beforeHash?: string;
  afterHash?: string;
}

const TICKS_PER_QUARTER = 48;
const SAMPLE_RATE = 44100;
const NOTE_RECORD_BYTES = 10;
const NOTE_WITH_LIFT_RECORD_BYTES = 11;

/**
 * Fields the Deluge rewrites as part of saving. They still mean the file changed, so they are
 * reported — just marked view-only and sorted last, or they would swamp every diff.
 */
const VIEW_ONLY_ATTRS = new Set([
  "preview",
  "previewNumPads",
  "arrangementAutoScrollOn",
  "isArmedForRecording",
  "selectedDrumIndex",
  "activeModFunction",
]);
const VIEW_ONLY_PREFIXES = ["xScroll", "xZoom", "yScroll", "yZoom"];

/** Handled on their own, as BPM and as note counts, so they never appear raw. */
const TEMPO_ATTRS = new Set(["timePerTimerTick", "timerTickFraction"]);
const NOTE_ATTRS = new Set(["noteData", "noteDataWithLift"]);

/** `parentTag@attribute`, or `@attribute` to match the attribute anywhere. */
const LABELS: Record<string, string> = {
  "@rootNote": "Key root note",
  "@preview": "Pad preview",
  "@xScroll": "Scroll position",
  "@xScrollSongView": "Scroll position (song view)",
  "@xScrollArrangementView": "Scroll position (arranger)",
  "@yScrollSongView": "Row scroll (song view)",
  "@yScrollArrangementView": "Row scroll (arranger)",
  "@xZoom": "Zoom level",
  "@xZoomSongView": "Zoom level (song view)",
  "@xZoomArrangementView": "Zoom level (arranger)",
  "@arrangementAutoScrollOn": "Arranger auto-scroll",
  "@isArmedForRecording": "Armed for recording",
  "@selectedDrumIndex": "Selected drum",
  "@swingAmount": "Swing",
  "@swingInterval": "Swing interval",
  "@tripletsLevel": "Triplets",
  "@firmwareVersion": "Firmware version",
  "lpf@frequency": "Filter cutoff",
  "lpf@resonance": "Filter resonance",
  "hpf@frequency": "High-pass cutoff",
  "hpf@resonance": "High-pass resonance",
  "delay@rate": "Delay rate",
  "delay@feedback": "Delay feedback",
  "reverb@roomSize": "Reverb room size",
  "reverb@dampening": "Reverb dampening",
  "envelope1@attack": "Env 1 attack",
  "envelope1@decay": "Env 1 decay",
  "envelope1@sustain": "Env 1 sustain",
  "envelope1@release": "Env 1 release",
  "envelope2@attack": "Env 2 attack",
  "envelope2@decay": "Env 2 decay",
  "envelope2@sustain": "Env 2 sustain",
  "envelope2@release": "Env 2 release",
  "osc1@type": "Osc 1 shape",
  "osc2@type": "Osc 2 shape",
  "osc1@transpose": "Osc 1 transpose",
  "osc2@transpose": "Osc 2 transpose",
  "unison@num": "Unison voices",
  "unison@detune": "Unison detune",
};

function isViewOnly(attr: string): boolean {
  return (
    VIEW_ONLY_ATTRS.has(attr) || VIEW_ONLY_PREFIXES.some((prefix) => attr.startsWith(prefix))
  );
}

function parseXml(xml: string): Element | null {
  try {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) return null;
    return doc.documentElement ?? null;
  } catch {
    return null;
  }
}

/** Strips the `[n]` sibling index so labels read as the plain tag name. */
function tagOf(path: string): string {
  const last = path.slice(path.lastIndexOf("/") + 1);
  const bracket = last.indexOf("[");
  return bracket >= 0 ? last.slice(0, bracket) : last;
}

function labelFor(path: string, attr: string): string {
  return LABELS[`${tagOf(path)}@${attr}`] ?? LABELS[`@${attr}`] ?? `${tagOf(path)}@${attr}`;
}

/** Notes packed into one `noteData` / `noteDataWithLift` value, from its length alone. */
function notesInValue(attr: string, value: string): number {
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  const bytes = Math.floor(hex.length / 2);
  const size = attr === "noteDataWithLift" ? NOTE_WITH_LIFT_RECORD_BYTES : NOTE_RECORD_BYTES;
  return Math.floor(bytes / size);
}

interface Indexed {
  /** `path@attr` or `path#text` -> value */
  fields: Map<string, string>;
  elements: Set<string>;
  /** clip element path -> total notes in it */
  clipNotes: Map<string, number>;
}

function indexTree(root: Element): Indexed {
  const fields = new Map<string, string>();
  const elements = new Set<string>();
  const clipNotes = new Map<string, number>();

  const visit = (el: Element, path: string, clipPath: string | null) => {
    elements.add(path);
    const here = el.tagName.endsWith("Clip") ? path : clipPath;

    for (const attr of Array.from(el.attributes)) {
      if (TEMPO_ATTRS.has(attr.name)) continue;
      if (NOTE_ATTRS.has(attr.name)) {
        if (here) clipNotes.set(here, (clipNotes.get(here) ?? 0) + notesInValue(attr.name, attr.value));
        continue;
      }
      fields.set(`${path}@${attr.name}`, attr.value);
    }

    const children = Array.from(el.children);
    if (!children.length) {
      const text = el.textContent?.trim() ?? "";
      if (text) fields.set(`${path}#text`, text);
    }

    const seen = new Map<string, number>();
    for (const child of children) {
      const index = seen.get(child.tagName) ?? 0;
      seen.set(child.tagName, index + 1);
      const suffix = index > 0 ? `[${index}]` : "";
      visit(child, `${path}/${child.tagName}${suffix}`, here);
    }
  };

  visit(root, root.tagName, null);
  return { fields, elements, clipNotes };
}

/** Tempo in BPM, or null if the song does not say. */
export function readBpm(xml: string): number | null {
  const root = parseXml(xml);
  if (!root) return null;
  const tick = Number(root.getAttribute("timePerTimerTick") ?? 0);
  if (!tick) return null;
  const fraction = Number(root.getAttribute("timerTickFraction") ?? 0);
  const ticksPerSecond = SAMPLE_RATE / (tick + fraction / 2 ** 32);
  return (ticksPerSecond * 60) / TICKS_PER_QUARTER;
}

/** Every note in the song, read straight off the packed hex — no decoding needed. */
export function countNotes(xml: string): number {
  const root = parseXml(xml);
  if (!root) return 0;
  let total = 0;
  for (const attr of NOTE_ATTRS) {
    for (const el of Array.from(root.querySelectorAll(`[${attr}]`))) {
      total += notesInValue(attr, el.getAttribute(attr) ?? "");
    }
  }
  return total;
}

function bpmChange(before: string, after: string): FieldChange | null {
  const from = readBpm(before);
  const to = readBpm(after);
  if (from === null || to === null) return null;
  const fromText = String(Math.round(from * 10) / 10);
  const toText = String(Math.round(to * 10) / 10);
  if (fromText === toText) return null;
  return {
    label: "BPM",
    path: "song@timePerTimerTick",
    kind: "changed",
    from: fromText,
    to: toText,
    summary: `${fromText} -> ${toText}`,
  };
}

function noteChanges(before: Indexed, after: Indexed): FieldChange[] {
  const paths = new Set([...before.clipNotes.keys(), ...after.clipNotes.keys()]);
  const changes: FieldChange[] = [];
  for (const path of Array.from(paths).sort()) {
    const from = before.clipNotes.get(path) ?? 0;
    const to = after.clipNotes.get(path) ?? 0;
    if (from === to) continue;
    const delta = to - from;
    const match = /\[(\d+)\]$/.exec(path);
    const clipNumber = (match ? Number(match[1]) : 0) + 1;
    changes.push({
      label: `Clip ${clipNumber} notes`,
      path,
      kind: "changed",
      from: String(from),
      to: String(to),
      summary: `${delta > 0 ? "+" : ""}${delta} notes`,
    });
  }
  return changes;
}

/** True when an ancestor of this path is already reported, so we report the parent only. */
function coveredBy(path: string, reported: string[]): boolean {
  return reported.some((other) => path.startsWith(`${other}/`));
}

function structureChanges(before: Indexed, after: Indexed): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const [kind, from, to] of [
    ["added", before, after],
    ["removed", after, before],
  ] as const) {
    const reported: string[] = [];
    for (const path of Array.from(to.elements).sort()) {
      if (from.elements.has(path)) continue;
      if (path.includes("/noteRow")) continue;
      if (coveredBy(path, reported)) continue;
      reported.push(path);
      changes.push({
        label: tagOf(path),
        path,
        kind,
        summary: `${tagOf(path)} ${kind}`,
      });
    }
  }
  return changes;
}

function valueChanges(before: Indexed, after: Indexed): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const [key, fromValue] of before.fields) {
    const toValue = after.fields.get(key);
    if (toValue === undefined || toValue === fromValue) continue;
    const isText = key.endsWith("#text");
    const path = key.slice(0, key.lastIndexOf(isText ? "#" : "@"));
    const attr = key.slice(path.length + 1);
    changes.push({
      label: isText ? tagOf(path) : labelFor(path, attr),
      path: key,
      kind: "changed",
      from: fromValue,
      to: toValue,
      summary: `${fromValue} -> ${toValue}`,
      ...(!isText && isViewOnly(attr) ? { viewOnly: true } : {}),
    });
  }
  return changes;
}

/**
 * What changed between two versions of one file, in words rather than hex. Returns an empty
 * list when either side will not parse — a diff we cannot trust is worse than no diff.
 */
export function diffXml(before: string, after: string): FieldChange[] {
  const beforeRoot = parseXml(before);
  const afterRoot = parseXml(after);
  if (!beforeRoot || !afterRoot) return [];

  const beforeIndex = indexTree(beforeRoot);
  const afterIndex = indexTree(afterRoot);

  const bpm = bpmChange(before, after);
  const changes = [
    ...(bpm ? [bpm] : []),
    ...valueChanges(beforeIndex, afterIndex),
    ...structureChanges(beforeIndex, afterIndex),
    ...noteChanges(beforeIndex, afterIndex),
  ];
  // Stable partition: musical changes keep their order and lead, view-only ones trail.
  return [...changes.filter((c) => !c.viewOnly), ...changes.filter((c) => c.viewOnly)];
}

/** The changes worth putting in front of someone — everything except save-time bookkeeping. */
export function musicalChanges(changes: FieldChange[]): FieldChange[] {
  return changes.filter((c) => !c.viewOnly);
}

/**
 * File-level comparison of two save points. Uses hashes only, so the timeline can show what
 * moved without loading a single XML.
 */
export function compareSavePoints(before: SavePoint, after: SavePoint): FileChange[] {
  const beforeByPath = new Map(before.entries.map((e) => [e.path, e]));
  const afterByPath = new Map(after.entries.map((e) => [e.path, e]));
  const paths = new Set([...beforeByPath.keys(), ...afterByPath.keys()]);

  const changes: FileChange[] = [];
  for (const path of Array.from(paths).sort()) {
    const from = beforeByPath.get(path);
    const to = afterByPath.get(path);
    const status: FileStatus = !from
      ? "added"
      : !to
        ? "removed"
        : from.hash === to.hash
          ? "unchanged"
          : "changed";
    changes.push({
      path,
      kind: (to ?? from)!.kind,
      status,
      beforeHash: from?.hash,
      afterHash: to?.hash,
    });
  }

  const order: Record<FileStatus, number> = { changed: 0, removed: 1, added: 2, unchanged: 3 };
  return changes.sort((a, b) => order[a.status] - order[b.status] || a.path.localeCompare(b.path));
}
