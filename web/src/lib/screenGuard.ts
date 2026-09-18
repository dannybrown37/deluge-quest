export interface ScreenGuardState {
  isPlaying: boolean;
  knobHoldTimer: unknown;
  draggingKnob: number | null;
  hoveredPad: boolean;
}

export function shouldSyncScreen(state: ScreenGuardState): boolean {
  return (
    state.isPlaying &&
    !state.knobHoldTimer &&
    state.draggingKnob === null &&
    !state.hoveredPad
  );
}
