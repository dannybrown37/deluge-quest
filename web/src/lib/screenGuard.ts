export function shouldSyncScreen(
  isPlaying: boolean,
  knobDisplayTimer: unknown,
  draggingKnob: number | null,
): boolean {
  return isPlaying && !knobDisplayTimer && draggingKnob === null;
}
