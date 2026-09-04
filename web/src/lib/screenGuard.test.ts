import { describe, it, expect } from 'vitest';
import { shouldSyncScreen } from './screenGuard';

describe('shouldSyncScreen', () => {
  it.each([
    { isPlaying: true,  timer: null,      knob: null, expected: true,  label: 'playing, no knob activity' },
    { isPlaying: true,  timer: setTimeout(() => {}, 0), knob: null, expected: false, label: 'playing, knob hold timer active' },
    { isPlaying: true,  timer: null,      knob: 3,    expected: false, label: 'playing, knob being dragged' },
    { isPlaying: true,  timer: setTimeout(() => {}, 0), knob: 2, expected: false, label: 'playing, both active' },
    { isPlaying: false, timer: null,      knob: null, expected: false, label: 'not playing' },
    { isPlaying: false, timer: setTimeout(() => {}, 0), knob: null, expected: false, label: 'not playing, timer active' },
  ])('$label → $expected', ({ isPlaying, timer, knob, expected }) => {
    expect(shouldSyncScreen(isPlaying, timer, knob)).toBe(expected);
    if (timer) clearTimeout(timer);
  });
});
