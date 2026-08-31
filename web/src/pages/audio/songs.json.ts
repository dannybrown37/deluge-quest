import fs from 'node:fs';
import path from 'node:path';
import type { APIRoute } from 'astro';

export const GET: APIRoute = () => {
  const audioDir = path.join(process.cwd(), 'public', 'audio');
  const files = fs.readdirSync(audioDir)
    .filter(f => /\.(mp3|wav|ogg|flac|m4a)$/i.test(f))
    .sort();
  const songs = files.map(f => ({
    file: f,
    name: f.replace(/\.[^.]+$/, ''),
  }));
  return new Response(JSON.stringify(songs), {
    headers: { 'Content-Type': 'application/json' },
  });
};
