import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { crossedMarks, percentPlayed, toolForPath, track, trackToolVisit, trackToolAction } from './analytics';

const { trackMock } = vi.hoisted(() => ({ trackMock: vi.fn() }));
vi.mock('@vercel/analytics', () => ({ track: trackMock }));

beforeEach(() => { trackMock.mockReset(); });
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
  it('forwards event and props to the vercel analytics client', () => {
    track('song_play', { song: 'demo' });
    expect(trackMock).toHaveBeenCalledWith('song_play', { song: 'demo' });
  });

  it('swallows errors thrown by the analytics client', () => {
    trackMock.mockImplementation(() => { throw new Error('blocked by adblock'); });
    expect(() => track('song_play')).not.toThrow();
  });

  it('is a no-op outside a browser context', () => {
    vi.stubGlobal('window', undefined);
    track('song_play');
    expect(trackMock).not.toHaveBeenCalled();
  });
});

describe('trackToolVisit', () => {
  it('tracks tool_visit for a known tool route', () => {
    trackToolVisit('/kits');
    expect(trackMock).toHaveBeenCalledWith('tool_visit', { tool: 'kits' });
  });

  it('does not track for a non-tool route', () => {
    trackToolVisit('/faq');
    expect(trackMock).not.toHaveBeenCalled();
  });
});

describe('trackToolAction', () => {
  it('tracks tool_action with tool, action, and any extra props merged in', () => {
    trackToolAction('kits', 'export', { rows: 4 });
    expect(trackMock).toHaveBeenCalledWith('tool_action', { tool: 'kits', action: 'export', rows: 4 });
  });

  it('tracks tool_action with no extra props', () => {
    trackToolAction('preview', 'play');
    expect(trackMock).toHaveBeenCalledWith('tool_action', { tool: 'preview', action: 'play' });
  });
});

describe('toolForPath', () => {
  it.each([
    { path: '/kits', expected: 'kits' },
    { path: '/kits/', expected: 'kits' },
    { path: '/manage', expected: 'manage' },
    { path: '/history', expected: 'history' },
    { path: '/', expected: null },
    { path: '/faq', expected: null },
    { path: '/songs/some-song', expected: null },
  ])('$path → $expected', ({ path, expected }) => {
    expect(toolForPath(path)).toBe(expected);
  });
});
