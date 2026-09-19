const STORAGE_KEY = "deluge-channel-labels";

export const CHANNEL_PLACEHOLDERS = [
  "e.g. Peak",
  "e.g. Hydrasynth",
  "e.g. Rev2",
  "e.g. Minilogue XD",
  "e.g. Bass Station",
  "e.g. Blofeld",
  "e.g. Typhon",
  "e.g. System-8",
  "e.g. MicroFreak",
  "e.g. Moog One",
  "e.g. Virus TI",
  "e.g. Volca Keys",
  "e.g. Summit",
  "e.g. Grandmother",
  "e.g. Matriarch",
  "e.g. Prophet-10",
];

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
