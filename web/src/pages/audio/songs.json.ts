import fs from 'node:fs';
import path from 'node:path';
import type { APIRoute } from 'astro';
import { parseFile } from 'music-metadata';

function fmtDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export const GET: APIRoute = async () => {
  const audioDir = path.join(process.cwd(), 'public', 'audio');
  const files = fs.readdirSync(audioDir)
    .filter(f => /\.(mp3|wav|ogg|flac|m4a)$/i.test(f))
    .sort();
  const songs = await Promise.all(files.map(async f => {
    const base = f.replace(/\.[^.]+$/, '');
    const m = base.match(/^(.*?)\s*\[([^\]]*)\]$/);
    let duration: string | undefined;
    try {
      const meta = await parseFile(path.join(audioDir, f));
      if (meta.format.duration) duration = fmtDuration(meta.format.duration);
    } catch { /* skip */ }
    if (!m) return { file: f, name: base, duration };
    const tags = m[2].split(',').map(s => s.trim()).filter(Boolean);
    return {
      file: f,
      name: m[1],
      year: tags.find(t => /^\d{4}$/.test(t)),
      genre: tags.find(t => !/^\d{4}$/.test(t)),
      duration,
    };
  }));
  return new Response(JSON.stringify(songs), {
    headers: { 'Content-Type': 'application/json' },
  });
};
