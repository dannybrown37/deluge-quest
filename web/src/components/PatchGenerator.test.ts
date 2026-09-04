import { render, fireEvent, screen, cleanup } from '@testing-library/svelte';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import PatchGenerator from './PatchGenerator.svelte';

vi.mock('../lib/patchAudio', () => ({
  playPreview: vi.fn(),
  stopPreview: vi.fn(),
  isPlaying: vi.fn(() => false),
}));

vi.mock('../lib/analytics', () => ({
  trackToolAction: vi.fn(),
}));

import { playPreview, stopPreview } from '../lib/patchAudio';
import { trackToolAction } from '../lib/analytics';

const mockPlayPreview = playPreview as unknown as ReturnType<typeof vi.fn>;
const mockStopPreview = stopPreview as unknown as ReturnType<typeof vi.fn>;
const mockTrack = trackToolAction as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PatchGenerator', () => {
  it('renders the five category buttons with Lead active by default', () => {
    render(PatchGenerator);
    expect(screen.getByText('Pad')).toBeTruthy();
    expect(screen.getByText('Lead')).toBeTruthy();
    expect(screen.getByText('Bass')).toBeTruthy();
    expect(screen.getByText('Keys')).toBeTruthy();
    expect(screen.getByText('FX')).toBeTruthy();
    expect(screen.getByText('Lead').closest('button')?.className).toContain('active');
  });

  it('switches the selected category on click', async () => {
    render(PatchGenerator);
    await fireEvent.click(screen.getByText('Bass'));
    expect(screen.getByText('Bass').closest('button')?.className).toContain('active');
    expect(screen.getByText('Lead').closest('button')?.className).not.toContain('active');
  });

  it('generates a patch and displays it', async () => {
    render(PatchGenerator);
    await fireEvent.click(screen.getByText('Generate Patch'));

    expect(document.querySelector('.patch-name')).toBeTruthy();
    expect(screen.getByText('Subtractive') || screen.getByText('FM')).toBeTruthy();
    expect(mockTrack).toHaveBeenCalledWith('patch', 'generate');
  });

  it('toggles preview playback', async () => {
    let onEnd: (() => void) | undefined;
    mockPlayPreview.mockImplementation((_patch: unknown, cb: () => void) => {
      onEnd = cb;
    });

    render(PatchGenerator);
    await fireEvent.click(screen.getByText('Generate Patch'));
    await fireEvent.click(screen.getByText('▶ Preview'));

    expect(mockPlayPreview).toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith('patch', 'preview');
    expect(screen.getByText('■ Stop')).toBeTruthy();

    onEnd?.();
    await Promise.resolve();
    expect(screen.getByText('▶ Preview')).toBeTruthy();
  });

  it('stops preview playback manually', async () => {
    render(PatchGenerator);
    await fireEvent.click(screen.getByText('Generate Patch'));
    await fireEvent.click(screen.getByText('▶ Preview'));
    await fireEvent.click(screen.getByText('■ Stop'));

    expect(mockStopPreview).toHaveBeenCalled();
    expect(screen.getByText('▶ Preview')).toBeTruthy();
  });

  it('downloads the generated patch as XML', async () => {
    const createUrl = vi.fn().mockReturnValue('blob:mock');
    const revokeUrl = vi.fn();
    URL.createObjectURL = createUrl;
    URL.revokeObjectURL = revokeUrl;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    render(PatchGenerator);
    await fireEvent.click(screen.getByText('Generate Patch'));
    await fireEvent.click(screen.getByText('Download .XML'));

    expect(createUrl).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(revokeUrl).toHaveBeenCalledWith('blob:mock');
    expect(mockTrack).toHaveBeenCalledWith('patch', 'download');

    clickSpy.mockRestore();
  });

  it('bulk-downloads a zip of generated patches', async () => {
    const createUrl = vi.fn().mockReturnValue('blob:mock');
    const revokeUrl = vi.fn();
    URL.createObjectURL = createUrl;
    URL.revokeObjectURL = revokeUrl;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    render(PatchGenerator);
    const bulkInput = document.querySelector('.bulk-input') as HTMLInputElement;
    await fireEvent.input(bulkInput, { target: { value: '3' } });
    await fireEvent.click(screen.getByText('Bulk Download .ZIP'));

    expect(createUrl).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith('patch', 'bulk_download');

    const anchor = clickSpy.mock.contexts[0] as HTMLAnchorElement;
    expect(anchor.download).toBe('deluge_lead_patches.zip');

    clickSpy.mockRestore();
  });

  it('toggles a parameter lock', async () => {
    render(PatchGenerator);
    await fireEvent.click(screen.getByText('Generate Patch'));

    const lockBtn = screen.getByTitle('Lock Osc 1');
    expect(lockBtn.className).not.toContain('locked');
    await fireEvent.click(lockBtn);
    expect(lockBtn.className).toContain('locked');
    await fireEvent.click(lockBtn);
    expect(lockBtn.className).not.toContain('locked');
  });

  it('builds a history list after multiple generations and can revisit an entry', async () => {
    render(PatchGenerator);
    await fireEvent.click(screen.getByText('Generate Patch'));
    expect(document.querySelector('.history')).toBeNull();

    await fireEvent.click(screen.getByText('Generate Patch'));
    const historyItems = document.querySelectorAll('.history-item');
    expect(historyItems.length).toBe(2);

    await fireEvent.click(historyItems[1]);
    expect(historyItems[1].className).toContain('active');
  });

  it('shows FM-specific rows when the generated patch uses FM mode', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.95);
    render(PatchGenerator);
    await fireEvent.click(screen.getByText('Bass'));
    await fireEvent.click(screen.getByText('Generate Patch'));

    expect(screen.getByText('FM')).toBeTruthy();
    expect(screen.getByText('MOD 1')).toBeTruthy();
  });
});
