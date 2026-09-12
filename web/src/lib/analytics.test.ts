import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { crossedMarks, percentPlayed, toolForPath, track, trackToolVisit, trackToolAction, trackSong } from './analytics';

const trackMock = vi.fn();

beforeEach(() => {
  trackMock.mockReset();
  vi.stubGlobal('window', { umami: { track: trackMock } });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('crossedMarks', () => {
  it.each([
    { prev: 0, now: 10, expected: [], label: 'no mark crossed' },
    { prev: 0, now: 25, expected: [25], label: 'exactly on 25' },
    { prev: 24, now: 26, expected: [25], label: 'crosses 25' },
    { prev: 25, now: 26, expected: [], label: 'already past 25' },
    { prev: 10, now: 80, expected: [25, 50, 75], label: 'seek forward crosses three' },
    { prev: 0, now: 100, expected: [25, 50, 75, 100], label: 'whole track at once' },
    { prev: 80, now: 20, expected: [], label: 'seek backward crosses nothing' },
    { prev: 99, now: 100, expected: [100], label: 'completion' },
  ])('$label', ({ prev, now, expected }) => {
    expect(crossedMarks(prev, now)).toEqual(expected);
  });
});

describe('percentPlayed', () => {
  it.each([
    { elapsed: 0, duration: 200, expected: 0, label: 'start' },
    { elapsed: 50, duration: 200, expected: 25, label: 'quarter' },
    { elapsed: 200, duration: 200, expected: 100, label: 'end' },
    { elapsed: 300, duration: 200, expected: 100, label: 'clamped past end' },
    { elapsed: 10, duration: 0, expected: 0, label: 'zero duration' },
    { elapsed: 10, duration: NaN, expected: 0, label: 'unknown duration' },
    { elapsed: 10, duration: Infinity, expected: 0, label: 'streaming duration' },
  ])('$label', ({ elapsed, duration, expected }) => {
    expect(percentPlayed(elapsed, duration)).toBe(expected);
  });
});

describe('track', () => {
  it('forwards event name to umami', () => {
    track('play:demo');
    expect(trackMock).toHaveBeenCalledWith('play:demo');
  });

  it('swallows errors thrown by the analytics client', () => {
    trackMock.mockImplementation(() => { throw new Error('blocked by adblock'); });
    expect(() => track('play:demo')).not.toThrow();
  });

  it('is a no-op outside a browser context', () => {
    vi.stubGlobal('window', undefined);
    track('play:demo');
    expect(trackMock).not.toHaveBeenCalled();
  });
});

describe('trackToolVisit', () => {
  it('tracks visit for a known tool route', () => {
    trackToolVisit('/kits');
    expect(trackMock).toHaveBeenCalledWith('visit:kits');
  });

  it('does not track for a non-tool route', () => {
    trackToolVisit('/faq');
    expect(trackMock).not.toHaveBeenCalled();
  });
});

describe('trackToolAction', () => {
  it('tracks action with tool and action in event name', () => {
    trackToolAction('kits', 'export');
    expect(trackMock).toHaveBeenCalledWith('action:kits:export');
  });
});

describe('trackSong', () => {
  it('tracks song event with slug', () => {
    trackSong('play', 'My Song');
    expect(trackMock).toHaveBeenCalledWith('play:my-song');
  });

  it('includes detail when provided', () => {
    trackSong('listen', 'My Song', 42);
    expect(trackMock).toHaveBeenCalledWith('listen:my-song:42');
  });

  it('includes string detail', () => {
    trackSong('progress', 'Demo Track', '75');
    expect(trackMock).toHaveBeenCalledWith('progress:demo-track:75');
  });
});

describe('toolForPath', () => {
  it.each([
    { path: '/kits', expected: 'kits' },
    { path: '/kits/', expected: 'kits' },
    { path: '/manage', expected: 'manage' },
    { path: '/backup', expected: 'backup' },
    { path: '/', expected: null },
    { path: '/faq', expected: null },
    { path: '/songs/some-song', expected: null },
  ])('$path → $expected', ({ path, expected }) => {
    expect(toolForPath(path)).toBe(expected);
  });
});
