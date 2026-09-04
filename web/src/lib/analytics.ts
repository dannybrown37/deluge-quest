import { track as vercelTrack } from '@vercel/analytics';

export type AnalyticsProps = Record<string, string | number | boolean | null>;

const PROGRESS_MARKS = [25, 50, 75, 100] as const;

export function track(event: string, props?: AnalyticsProps): void {
  if (typeof window === 'undefined') return;
  try {
    vercelTrack(event, props);
  } catch { /* analytics must never break playback */ }
}

// Vercel counts each event, so only fire on the marks a listener newly crossed.
export function crossedMarks(prevPercent: number, nowPercent: number): number[] {
  return PROGRESS_MARKS.filter((m) => prevPercent < m && nowPercent >= m);
}

export function percentPlayed(elapsed: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.min(100, (elapsed / duration) * 100);
}

const TOOL_ROUTES: Record<string, string> = {
  '/manage': 'manage',
  '/stats': 'stats',
  '/preview': 'preview',
  '/score': 'score',
  '/kits': 'kits',
  '/patch': 'patch',
  '/import': 'import',
  '/history': 'history',
};

export function toolForPath(pathname: string): string | null {
  const clean = pathname.replace(/\/+$/, '') || '/';
  return TOOL_ROUTES[clean] ?? null;
}

export function trackToolVisit(pathname: string): void {
  const tool = toolForPath(pathname);
  if (tool) track('tool_visit', { tool });
}

export function trackToolAction(tool: string, action: string, extra?: AnalyticsProps): void {
  track('tool_action', { tool, action, ...extra });
}
