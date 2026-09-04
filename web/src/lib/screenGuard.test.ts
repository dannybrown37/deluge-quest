import { describe, it, expect } from 'vitest';
import { shouldSyncScreen } from './screenGuard';

describe('shouldSyncScreen', () => {
  it.each([
    { isPlaying: true,  knobHoldTimer: null, draggingKnob: null, hoveredPad: false, expected: true,  label: 'playing, nothing else active' },
    { isPlaying: true,  knobHoldTimer: setTimeout(() => {}, 0), draggingKnob: null, hoveredPad: false, expected: false, label: 'playing, knob hold timer active' },
    { isPlaying: true,  knobHoldTimer: null, draggingKnob: 3,    hoveredPad: false, expected: false, label: 'playing, knob being dragged' },
    { isPlaying: true,  knobHoldTimer: null, draggingKnob: null, hoveredPad: true,  expected: false, label: 'playing, pad hovered' },
    { isPlaying: true,  knobHoldTimer: setTimeout(() => {}, 0), draggingKnob: 2, hoveredPad: true, expected: false, label: 'playing, everything active' },
    { isPlaying: false, knobHoldTimer: null, draggingKnob: null, hoveredPad: false, expected: false, label: 'not playing' },
    { isPlaying: false, knobHoldTimer: null, draggingKnob: null, hoveredPad: true,  expected: false, label: 'not playing, pad hovered' },
    { isPlaying: false, knobHoldTimer: setTimeout(() => {}, 0), draggingKnob: null, hoveredPad: false, expected: false, label: 'not playing, timer active' },
  ])('$label → $expected', ({ isPlaying, knobHoldTimer, draggingKnob, hoveredPad, expected }) => {
    expect(shouldSyncScreen({ isPlaying, knobHoldTimer, draggingKnob, hoveredPad })).toBe(expected);
    if (knobHoldTimer) clearTimeout(knobHoldTimer);
  });
});
