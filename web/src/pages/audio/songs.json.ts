import fs from 'node:fs';
import path from 'node:path';
import type { APIRoute } from 'astro';

export const GET: APIRoute = () => {
  const audioDir = path.join(process.cwd(), 'public', 'audio');
  const files = fs.readdirSync(audioDir)
    .filter(f => /\.(mp3|wav|ogg|flac|m4a)$/i.test(f))
    .sort();
  const songs = files.map(f => {
    const base = f.replace(/\.[^.]+$/, '');
    const m = base.match(/^(.*?)\s*\[([^\]]*)\]$/);
    if (!m) return { file: f, name: base };
    const tags = m[2].split(',').map(s => s.trim()).filter(Boolean);
    return {
      file: f,
      name: m[1],
      year: tags.find(t => /^\d{4}$/.test(t)),
      genre: tags.find(t => !/^\d{4}$/.test(t)),
    };
  });
  return new Response(JSON.stringify(songs), {
    headers: { 'Content-Type': 'application/json' },
  });
};
