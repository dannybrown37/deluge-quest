declare global {
  interface Window {
    umami?: { track: (event: string) => void };
  }
}

const PROGRESS_MARKS = [25, 50, 75, 100] as const;

export function track(event: string): void {
  if (typeof window === "undefined") return;
  try {
    window.umami?.track(event);
  } catch {
    /* analytics must never break playback */
  }
}

export function crossedMarks(
  prevPercent: number,
  nowPercent: number,
): number[] {
  return PROGRESS_MARKS.filter((m) => prevPercent < m && nowPercent >= m);
}

export function percentPlayed(elapsed: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.min(100, (elapsed / duration) * 100);
}

const TOOL_ROUTES: Record<string, string> = {
  "/manage": "manage",
  "/stats": "stats",
  "/preview": "preview",
  "/score": "score",
  "/kits": "kits",
  "/patch": "patch",
  "/import": "import",
  "/backup": "backup",
};

export function toolForPath(pathname: string): string | null {
  const clean = pathname.replace(/\/+$/, "") || "/";
  return TOOL_ROUTES[clean] ?? null;
}

export function trackToolVisit(pathname: string): void {
  const tool = toolForPath(pathname);
  if (tool) track(`visit:${tool}`);
}

export function trackToolAction(tool: string, action: string): void {
  track(`action:${tool}:${action}`);
}

export function trackSong(
  event: string,
  song: string,
  detail?: string | number,
): void {
  const slug = song.replace(/\s+/g, "-").toLowerCase();
  track(detail != null ? `${event}:${slug}:${detail}` : `${event}:${slug}`);
}
