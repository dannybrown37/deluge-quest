const STORAGE_KEY = "deluge-channel-labels";

export function getChannelLabels(): Record<number, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    const result: Record<number, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && v.trim()) result[Number(k)] = v.trim();
    }
    return result;
  } catch {
    return {};
  }
}

function save(labels: Record<number, string>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(labels));
}

export function setChannelLabel(channel: number, label: string): void {
  const labels = getChannelLabels();
  labels[channel] = label.trim();
  save(labels);
}

export function removeChannelLabel(channel: number): void {
  const labels = getChannelLabels();
  delete labels[channel];
  save(labels);
}

export function formatChannel(
  channel: number,
  labels?: Record<number, string>,
): string {
  const resolved = labels ?? getChannelLabels();
  return resolved[channel] || `Ch ${channel}`;
}
