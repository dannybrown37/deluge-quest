import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  diffXml,
  musicalChanges,
  countNotes,
  readBpm,
  compareSavePoints,
  type FieldChange,
} from './xmlDiff';
import type { SavePoint } from './historyStore';

function song(attrs = '', body = ''): string {
  return `<song timePerTimerTick="525" timerTickFraction="0" rootNote="0" ${attrs}>${body}</song>`;
}

function labels(changes: FieldChange[]): string[] {
  return changes.map((c) => c.label);
}

function byLabel(changes: FieldChange[], label: string): FieldChange | undefined {
  return changes.find((c) => c.label === label);
}

describe('readBpm', () => {
  it.each([
    ['525', '0', 105],
    ['420', '0', 131.25],
    ['459', '1610612736', 120],
  ])('timePerTimerTick=%s fraction=%s -> %s BPM', (tick, fraction, bpm) => {
    const value = readBpm(`<song timePerTimerTick="${tick}" timerTickFraction="${fraction}"/>`);
    expect(value).toBeCloseTo(bpm, 1);
  });

  it('is null when the song has no tick rate', () => {
    expect(readBpm('<song/>')).toBeNull();
  });

  it('is null for XML that will not parse', () => {
    expect(readBpm('not xml at all <<<')).toBeNull();
  });
});

describe('countNotes', () => {
  it('counts 10-byte noteData records', () => {
    const two = '0x' + '00'.repeat(20);
    expect(countNotes(`<song><noteRow noteData="${two}"/></song>`)).toBe(2);
  });

  it('counts 11-byte noteDataWithLift records', () => {
    const three = '0x' + '00'.repeat(33);
    expect(countNotes(`<song><noteRow noteDataWithLift="${three}"/></song>`)).toBe(3);
  });

  it('adds up every note row', () => {
    const one = '0x' + '00'.repeat(10);
    expect(countNotes(`<song><noteRow noteData="${one}"/><noteRow noteData="${one}"/></song>`)).toBe(2);
  });

  it('is 0 for a song with no notes', () => {
    expect(countNotes(song())).toBe(0);
  });

  it('is 0 for XML that will not parse', () => {
    expect(countNotes('<<<')).toBe(0);
  });
});

describe('diffXml — view-only fields', () => {
  it.each([
    ['preview', 'preview="00FF"', 'preview="11EE"'],
    ['xScroll', 'xScroll="0"', 'xScroll="48"'],
    ['xZoomSongView', 'xZoomSongView="12"', 'xZoomSongView="24"'],
    ['yScrollArrangementView', 'yScrollArrangementView="1"', 'yScrollArrangementView="3"'],
    ['arrangementAutoScrollOn', 'arrangementAutoScrollOn="0"', 'arrangementAutoScrollOn="1"'],
    ['isArmedForRecording', 'isArmedForRecording="0"', 'isArmedForRecording="1"'],
  ])('still reports %s, flagged view-only', (_name, before, after) => {
    const changes = diffXml(song(before), song(after));
    expect(changes).toHaveLength(1);
    expect(changes[0].viewOnly).toBe(true);
    expect(musicalChanges(changes)).toEqual([]);
  });

  it('keeps the real values, so a save that only moved the view is still visible', () => {
    const changes = diffXml(song('xScroll="0"'), song('xScroll="48"'));
    expect(changes[0].label).toBe('Scroll position');
    expect(changes[0].from).toBe('0');
    expect(changes[0].to).toBe('48');
  });

  it('sorts view-only changes after musical ones', () => {
    const changes = diffXml(
      song('xScroll="0" swingAmount="0"'),
      song('xScroll="48" swingAmount="12"'),
    );
    expect(labels(changes)).toEqual(['Swing', 'Scroll position']);
    expect(changes[1].viewOnly).toBe(true);
  });

  it('reports nothing for two identical songs', () => {
    expect(diffXml(song('swingAmount="0"'), song('swingAmount="0"'))).toEqual([]);
  });
});

describe('diffXml — friendly labels', () => {
  it('reports BPM once, not two raw tick fields', () => {
    const changes = diffXml(
      '<song timePerTimerTick="525" timerTickFraction="0"/>',
      '<song timePerTimerTick="420" timerTickFraction="0"/>',
    );
    expect(labels(changes)).toEqual(['BPM']);
    expect(byLabel(changes, 'BPM')!.from).toBe('105');
    expect(byLabel(changes, 'BPM')!.to).toBe('131.3');
  });

  it('does not report BPM when only the sub-tick fraction moved a hair', () => {
    const before = '<song timePerTimerTick="525" timerTickFraction="0"/>';
    const after = '<song timePerTimerTick="525" timerTickFraction="1000"/>';
    expect(diffXml(before, after)).toEqual([]);
  });

  it.each([
    ['rootNote', '0', '3', 'Key root note'],
    ['swingAmount', '0', '12', 'Swing'],
  ])('names the %s field', (attr, from, to, label) => {
    const changes = diffXml(
      `<song ${attr}="${from}"/>`,
      `<song ${attr}="${to}"/>`,
    );
    expect(labels(changes)).toEqual([label]);
    expect(changes[0].from).toBe(from);
    expect(changes[0].to).toBe(to);
  });

  it('names nested synth fields by their part', () => {
    const changes = diffXml(
      '<song><sound><lpf frequency="20"/></sound></song>',
      '<song><sound><lpf frequency="40"/></sound></song>',
    );
    expect(labels(changes)).toEqual(['Filter cutoff']);
  });

  it('falls back to the raw path for fields it does not know', () => {
    const changes = diffXml('<song mysteryKnob="1"/>', '<song mysteryKnob="2"/>');
    expect(labels(changes)).toEqual(['song@mysteryKnob']);
  });
});

describe('diffXml — structure', () => {
  it('reports an added element', () => {
    const changes = diffXml('<song/>', '<song><delay rate="20"/></song>');
    expect(changes.some((c) => c.kind === 'added' && c.path.includes('delay'))).toBe(true);
  });

  it('reports a removed element', () => {
    const changes = diffXml('<song><delay rate="20"/></song>', '<song/>');
    expect(changes.some((c) => c.kind === 'removed' && c.path.includes('delay'))).toBe(true);
  });

  it('tells sibling elements apart by position', () => {
    const changes = diffXml(
      '<song><osc type="0"/><osc type="0"/></song>',
      '<song><osc type="0"/><osc type="9"/></song>',
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].path).toContain('osc[1]');
  });

  it('compares element text as well as attributes', () => {
    const changes = diffXml('<song><name>OLD</name></song>', '<song><name>NEW</name></song>');
    expect(changes[0].from).toBe('OLD');
    expect(changes[0].to).toBe('NEW');
  });

  it('reports nothing when the parser itself throws', () => {
    const real = globalThis.DOMParser;
    class Exploding {
      parseFromString(): never {
        throw new Error('parser exploded');
      }
    }
    globalThis.DOMParser = Exploding as unknown as typeof DOMParser;
    try {
      expect(diffXml(song(), song('swingAmount="9"'))).toEqual([]);
      expect(countNotes(song())).toBe(0);
    } finally {
      globalThis.DOMParser = real;
    }
  });

  it('reports nothing when either side will not parse', () => {
    expect(diffXml('<<<', song())).toEqual([]);
    expect(diffXml(song(), '<<<')).toEqual([]);
  });
});

describe('diffXml — note counts', () => {
  const row = (bytes: number) => `noteData="0x${'00'.repeat(bytes * 10)}"`;

  it('reports notes added to a clip as one line, not raw hex', () => {
    const changes = diffXml(
      `<song><sessionClips><instrumentClip><noteRows><noteRow ${row(4)}/></noteRows></instrumentClip></sessionClips></song>`,
      `<song><sessionClips><instrumentClip><noteRows><noteRow ${row(16)}/></noteRows></instrumentClip></sessionClips></song>`,
    );
    expect(labels(changes)).toEqual(['Clip 1 notes']);
    expect(changes[0].summary).toBe('+12 notes');
  });

  it('reports notes removed with a minus', () => {
    const changes = diffXml(
      `<song><sessionClips><instrumentClip><noteRows><noteRow ${row(16)}/></noteRows></instrumentClip></sessionClips></song>`,
      `<song><sessionClips><instrumentClip><noteRows><noteRow ${row(4)}/></noteRows></instrumentClip></sessionClips></song>`,
    );
    expect(changes[0].summary).toBe('-12 notes');
  });

  it('adds up every row in the same clip into one line', () => {
    const changes = diffXml(
      `<song><sessionClips><instrumentClip><noteRows><noteRow ${row(1)}/><noteRow ${row(1)}/></noteRows></instrumentClip></sessionClips></song>`,
      `<song><sessionClips><instrumentClip><noteRows><noteRow ${row(3)}/><noteRow ${row(3)}/></noteRows></instrumentClip></sessionClips></song>`,
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].summary).toBe('+4 notes');
  });

  it('keeps clips apart', () => {
    const clip = (n: number) =>
      `<instrumentClip><noteRows><noteRow ${row(n)}/></noteRows></instrumentClip>`;
    const changes = diffXml(
      `<song><sessionClips>${clip(1)}${clip(1)}</sessionClips></song>`,
      `<song><sessionClips>${clip(2)}${clip(5)}</sessionClips></song>`,
    );
    expect(labels(changes)).toEqual(['Clip 1 notes', 'Clip 2 notes']);
  });

  it('says nothing when the notes moved but the count held', () => {
    const before = `<song><sessionClips><instrumentClip><noteRows><noteRow noteData="0x${'00'.repeat(10)}"/></noteRows></instrumentClip></sessionClips></song>`;
    const after = `<song><sessionClips><instrumentClip><noteRows><noteRow noteData="0x${'11'.repeat(10)}"/></noteRows></instrumentClip></sessionClips></song>`;
    expect(diffXml(before, after)).toEqual([]);
  });
});

describe('compareSavePoints', () => {
  const savePoint = (id: number, files: Record<string, string>): SavePoint => ({
    id,
    cardName: 'DELUGE',
    takenAt: id * 1000,
    label: `sp-${id}`,
    entries: Object.entries(files).map(([path, hash]) => ({
      path,
      kind: 'song' as const,
      hash,
      size: 10,
    })),
  });

  it('spots added, removed, changed and unchanged files', () => {
    const before = savePoint(1, {
      'SONGS/SAME.XML': 'aaa',
      'SONGS/EDIT.XML': 'bbb',
      'SONGS/GONE.XML': 'ccc',
    });
    const after = savePoint(2, {
      'SONGS/SAME.XML': 'aaa',
      'SONGS/EDIT.XML': 'zzz',
      'SONGS/NEW.XML': 'ddd',
    });
    const result = compareSavePoints(before, after);
    expect(result.map((f) => [f.path, f.status])).toEqual([
      ['SONGS/EDIT.XML', 'changed'],
      ['SONGS/GONE.XML', 'removed'],
      ['SONGS/NEW.XML', 'added'],
      ['SONGS/SAME.XML', 'unchanged'],
    ]);
  });

  it('carries both hashes on a changed file, so the XML can be fetched', () => {
    const result = compareSavePoints(
      savePoint(1, { 'SONGS/A.XML': 'aaa' }),
      savePoint(2, { 'SONGS/A.XML': 'bbb' }),
    );
    expect(result[0].beforeHash).toBe('aaa');
    expect(result[0].afterHash).toBe('bbb');
  });

  it('leaves the missing side undefined on an added file', () => {
    const result = compareSavePoints(savePoint(1, {}), savePoint(2, { 'SONGS/A.XML': 'bbb' }));
    expect(result[0].beforeHash).toBeUndefined();
    expect(result[0].afterHash).toBe('bbb');
  });

  it('keeps the kind, so the view can filter by song, kit or patch', () => {
    const result = compareSavePoints(savePoint(1, {}), savePoint(2, { 'SONGS/A.XML': 'b' }));
    expect(result[0].kind).toBe('song');
  });

  it('is empty for two identical save points', () => {
    const files = { 'SONGS/A.XML': 'aaa' };
    const result = compareSavePoints(savePoint(1, files), savePoint(2, files));
    expect(result.every((f) => f.status === 'unchanged')).toBe(true);
  });
});

describe('diffXml — a real song', () => {
  const realSong = () =>
    readFileSync(resolve(process.cwd(), '../tests/fixtures/square_spelunking.XML'), 'utf8');

  it('finds no changes', () => {
    const xml = realSong();
    expect(diffXml(xml, xml)).toEqual([]);
  });

  it('finds only BPM when only the tempo moved', () => {
    const xml = realSong();
    const faster = xml.replace(/timePerTimerTick="\d+"/, 'timePerTimerTick="420"');
    expect(labels(diffXml(xml, faster))).toEqual(['BPM']);
  });
});
