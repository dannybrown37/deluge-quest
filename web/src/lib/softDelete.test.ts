import { describe, it, expect } from 'vitest';
import {
  TRASH_DIR,
  MOVE_BACKUP_DIR,
  HISTORY_BACKUP_DIR,
  restoreFile,
  getOrCreateDir,
  moveToTrash,
  moveFile,
  updateXmlReferences,
} from './softDelete';

class FakeFile {
  constructor(private data: string | ArrayBuffer) {}
  async arrayBuffer(): Promise<ArrayBuffer> {
    if (this.data instanceof ArrayBuffer) return this.data;
    return new TextEncoder().encode(this.data).buffer as ArrayBuffer;
  }
  async text(): Promise<string> {
    if (typeof this.data === 'string') return this.data;
    return new TextDecoder().decode(this.data);
  }
}

class FakeWritable {
  private pending: string | ArrayBuffer | null = null;
  constructor(private handle: FakeFileHandle) {}
  async write(data: string | ArrayBuffer): Promise<void> {
    this.pending = data;
  }
  async close(): Promise<void> {
    this.handle.content = this.pending ?? '';
  }
}

class FakeFileHandle {
  kind = 'file' as const;
  content: string | ArrayBuffer;
  constructor(content: string | ArrayBuffer = '') {
    this.content = content;
  }
  async getFile() {
    return new FakeFile(this.content) as unknown as File;
  }
  async createWritable() {
    return new FakeWritable(this) as unknown as FileSystemWritableFileStream;
  }
}

class FakeDirHandle {
  kind = 'directory' as const;
  children = new Map<string, FakeDirHandle | FakeFileHandle>();

  async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
    let child = this.children.get(name);
    if (!child) {
      if (!opts?.create) throw new Error(`NotFoundError: ${name}`);
      child = new FakeDirHandle();
      this.children.set(name, child);
    }
    if (!(child instanceof FakeDirHandle)) throw new Error(`${name} is not a directory`);
    return child as unknown as FileSystemDirectoryHandle;
  }

  async getFileHandle(name: string, opts?: { create?: boolean }) {
    let child = this.children.get(name);
    if (!child) {
      if (!opts?.create) throw new Error(`NotFoundError: ${name}`);
      child = new FakeFileHandle();
      this.children.set(name, child);
    }
    if (!(child instanceof FakeFileHandle)) throw new Error(`${name} is not a file`);
    return child as unknown as FileSystemFileHandle;
  }

  async removeEntry(name: string) {
    if (!this.children.has(name)) throw new Error(`NotFoundError: ${name}`);
    this.children.delete(name);
  }
}

function makeRoot(): FakeDirHandle {
  return new FakeDirHandle();
}

async function seedFile(root: FakeDirHandle, path: string, content: string): Promise<void> {
  const parts = path.split('/').filter(Boolean);
  const fileName = parts.pop()!;
  let dir: FakeDirHandle = root;
  for (const part of parts) {
    dir = (await dir.getDirectoryHandle(part, { create: true })) as unknown as FakeDirHandle;
  }
  const fh = (await dir.getFileHandle(fileName, { create: true })) as unknown as FakeFileHandle;
  fh.content = content;
}

async function readFile(root: FakeDirHandle, path: string): Promise<string> {
  const parts = path.split('/').filter(Boolean);
  const fileName = parts.pop()!;
  let dir: FakeDirHandle = root;
  for (const part of parts) {
    dir = (await dir.getDirectoryHandle(part)) as unknown as FakeDirHandle;
  }
  const fh = (await dir.getFileHandle(fileName)) as unknown as FakeFileHandle;
  const file = await fh.getFile();
  return file.text();
}

async function fileExists(root: FakeDirHandle, path: string): Promise<boolean> {
  try {
    await readFile(root, path);
    return true;
  } catch {
    return false;
  }
}

describe('getOrCreateDir', () => {
  it('creates nested directories', async () => {
    const root = makeRoot();
    const handle = await getOrCreateDir(root as unknown as FileSystemDirectoryHandle, 'A/B/C');
    expect(handle).toBeDefined();
    expect(root.children.has('A')).toBe(true);
  });

  it('returns root unchanged for an empty path', async () => {
    const root = makeRoot();
    const handle = await getOrCreateDir(root as unknown as FileSystemDirectoryHandle, '');
    expect(handle).toBe(root as unknown as FileSystemDirectoryHandle);
  });

  it('ignores leading/trailing slashes', async () => {
    const root = makeRoot();
    await getOrCreateDir(root as unknown as FileSystemDirectoryHandle, '/A/B/');
    expect(root.children.has('A')).toBe(true);
    const a = root.children.get('A') as FakeDirHandle;
    expect(a.children.has('B')).toBe(true);
  });

  it('reuses an existing directory rather than recreating it', async () => {
    const root = makeRoot();
    const first = await getOrCreateDir(root as unknown as FileSystemDirectoryHandle, 'A');
    const second = await getOrCreateDir(root as unknown as FileSystemDirectoryHandle, 'A');
    expect(first).toBe(second);
  });
});

describe('moveToTrash', () => {
  it('moves a top-level file into SOFT_DELETE and removes the original', async () => {
    const root = makeRoot();
    await seedFile(root, 'song.xml', 'song-data');

    await moveToTrash(root as unknown as FileSystemDirectoryHandle, 'song.xml');

    expect(await fileExists(root, 'song.xml')).toBe(false);
    expect(await readFile(root, `${TRASH_DIR}/song.xml`)).toBe('song-data');
  });

  it('mirrors nested source directories under SOFT_DELETE', async () => {
    const root = makeRoot();
    await seedFile(root, 'SAMPLES/DRUMS/kick.wav', 'audio-bytes');

    await moveToTrash(root as unknown as FileSystemDirectoryHandle, 'SAMPLES/DRUMS/kick.wav');

    expect(await fileExists(root, 'SAMPLES/DRUMS/kick.wav')).toBe(false);
    expect(await readFile(root, `${TRASH_DIR}/SAMPLES/DRUMS/kick.wav`)).toBe('audio-bytes');
  });
});

describe('moveFile', () => {
  it('moves a file between arbitrary paths, creating destination dirs', async () => {
    const root = makeRoot();
    await seedFile(root, 'SAMPLES/kick.wav', 'audio-bytes');

    await moveFile(
      root as unknown as FileSystemDirectoryHandle,
      'SAMPLES/kick.wav',
      'SAMPLES/DRUMS/kick.wav',
    );

    expect(await fileExists(root, 'SAMPLES/kick.wav')).toBe(false);
    expect(await readFile(root, 'SAMPLES/DRUMS/kick.wav')).toBe('audio-bytes');
  });

  it('preserves file content across the move', async () => {
    const root = makeRoot();
    await seedFile(root, 'a/one.wav', 'unique-payload-123');

    await moveFile(root as unknown as FileSystemDirectoryHandle, 'a/one.wav', 'b/one.wav');

    expect(await readFile(root, 'b/one.wav')).toBe('unique-payload-123');
  });
});

describe('updateXmlReferences', () => {
  it('returns immediately with no moves', async () => {
    const root = makeRoot();
    const result = await updateXmlReferences(
      root as unknown as FileSystemDirectoryHandle,
      ['song.xml'],
      new Map([['song.xml', '"SAMPLES/kick.wav"']]),
      new Map(),
    );
    expect(result).toEqual({ updated: [], errors: [] });
  });

  it('skips XML files that do not reference a moved path', async () => {
    const root = makeRoot();
    await seedFile(root, 'song.xml', '"SAMPLES/snare.wav"');
    const moves = new Map([['SAMPLES/kick.wav', 'SAMPLES/DRUMS/kick.wav']]);

    const result = await updateXmlReferences(
      root as unknown as FileSystemDirectoryHandle,
      ['song.xml'],
      new Map([['song.xml', '"SAMPLES/snare.wav"']]),
      moves,
    );

    expect(result).toEqual({ updated: [], errors: [] });
  });

  it('rewrites matching references, case-insensitively, and backs up the original', async () => {
    const root = makeRoot();
    await seedFile(root, 'song.xml', 'sample="SAMPLES/Kick.wav" other="x"');
    const xmlTexts = new Map([['song.xml', 'sample="SAMPLES/Kick.wav" other="x"']]);
    const moves = new Map([['SAMPLES/kick.wav', 'SAMPLES/DRUMS/kick.wav']]);

    const result = await updateXmlReferences(
      root as unknown as FileSystemDirectoryHandle,
      ['song.xml'],
      xmlTexts,
      moves,
    );

    expect(result.updated).toEqual(['song.xml']);
    expect(result.errors).toEqual([]);
    expect(await readFile(root, 'song.xml')).toBe('sample="SAMPLES/DRUMS/kick.wav" other="x"');
    expect(await readFile(root, `${MOVE_BACKUP_DIR}/song.xml`)).toBe(
      'sample="SAMPLES/Kick.wav" other="x"',
    );
    expect(xmlTexts.get('song.xml')).toBe('sample="SAMPLES/DRUMS/kick.wav" other="x"');
  });

  it('escapes regex-special characters in the moved path', async () => {
    const root = makeRoot();
    const original = 'sample="SAMPLES/kick (1).wav"';
    await seedFile(root, 'song.xml', original);
    const xmlTexts = new Map([['song.xml', original]]);
    const moves = new Map([['SAMPLES/kick (1).wav', 'SAMPLES/DRUMS/kick (1).wav']]);

    const result = await updateXmlReferences(
      root as unknown as FileSystemDirectoryHandle,
      ['song.xml'],
      xmlTexts,
      moves,
    );

    expect(result.updated).toEqual(['song.xml']);
    expect(await readFile(root, 'song.xml')).toBe('sample="SAMPLES/DRUMS/kick (1).wav"');
  });

  it('falls back to a generic message when a non-Error is thrown', async () => {
    const root = makeRoot();
    await seedFile(root, 'SUBDIR/song.xml', '"SAMPLES/kick.wav"');
    root.getDirectoryHandle = () => {
      throw 'boom';
    };
    const xmlTexts = new Map([['SUBDIR/song.xml', '"SAMPLES/kick.wav"']]);
    const moves = new Map([['SAMPLES/kick.wav', 'SAMPLES/DRUMS/kick.wav']]);

    const result = await updateXmlReferences(
      root as unknown as FileSystemDirectoryHandle,
      ['SUBDIR/song.xml'],
      xmlTexts,
      moves,
    );

    expect(result.errors).toEqual([{ path: 'SUBDIR/song.xml', message: 'Update failed' }]);
  });

  it('records an error and continues when a referenced XML file is missing', async () => {
    const root = makeRoot();
    const xmlTexts = new Map([['missing.xml', '"SAMPLES/kick.wav"']]);
    const moves = new Map([['SAMPLES/kick.wav', 'SAMPLES/DRUMS/kick.wav']]);

    const result = await updateXmlReferences(
      root as unknown as FileSystemDirectoryHandle,
      ['missing.xml'],
      xmlTexts,
      moves,
    );

    expect(result.updated).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].path).toBe('missing.xml');
  });
});

describe('restoreFile', () => {
  it('writes the old version over the file on the card', async () => {
    const root = makeRoot();
    await seedFile(root, 'SONGS/A.XML', '<song>new</song>');
    await restoreFile(root as unknown as FileSystemDirectoryHandle, 'SONGS/A.XML', '<song>old</song>');
    expect(await readFile(root, 'SONGS/A.XML')).toBe('<song>old</song>');
  });

  it('backs the current version up first, so nothing is destroyed', async () => {
    const root = makeRoot();
    await seedFile(root, 'SONGS/A.XML', '<song>new</song>');
    await restoreFile(root as unknown as FileSystemDirectoryHandle, 'SONGS/A.XML', '<song>old</song>');
    expect(await readFile(root, `${HISTORY_BACKUP_DIR}/SONGS/A.XML`)).toBe('<song>new</song>');
  });

  it('says whether it made a backup', async () => {
    const root = makeRoot();
    await seedFile(root, 'SONGS/A.XML', '<song>new</song>');
    const result = await restoreFile(
      root as unknown as FileSystemDirectoryHandle,
      'SONGS/A.XML',
      '<song>old</song>',
    );
    expect(result).toEqual({ backedUp: true, created: false });
  });

  it('recreates a file that is no longer on the card', async () => {
    const root = makeRoot();
    const result = await restoreFile(
      root as unknown as FileSystemDirectoryHandle,
      'SONGS/GONE.XML',
      '<song>old</song>',
    );
    expect(await readFile(root, 'SONGS/GONE.XML')).toBe('<song>old</song>');
    expect(result).toEqual({ backedUp: false, created: true });
  });

  it('makes no backup when there was nothing to overwrite', async () => {
    const root = makeRoot();
    await restoreFile(root as unknown as FileSystemDirectoryHandle, 'SONGS/GONE.XML', '<song/>');
    expect(await fileExists(root, `${HISTORY_BACKUP_DIR}/SONGS/GONE.XML`)).toBe(false);
  });

  it('keeps a second restore of the same file from losing the first backup', async () => {
    const root = makeRoot();
    await seedFile(root, 'SONGS/A.XML', 'v2');
    const handle = root as unknown as FileSystemDirectoryHandle;
    await restoreFile(handle, 'SONGS/A.XML', 'v1');
    await restoreFile(handle, 'SONGS/A.XML', 'v0');
    expect(await readFile(root, 'SONGS/A.XML')).toBe('v0');
    expect(await readFile(root, `${HISTORY_BACKUP_DIR}/SONGS/A.XML`)).toBe('v2');
    expect(await readFile(root, `${HISTORY_BACKUP_DIR}/SONGS/A.XML.1`)).toBe('v1');
  });

  it.each([
    [`${HISTORY_BACKUP_DIR}/SONGS/A.XML`],
    ['SOFT_DELETE/SONGS/A.XML'],
    ['MOVE_BACKUP/SONGS/A.XML'],
    ['REPAIR_BACKUP/SONGS/A.XML'],
  ])('refuses to write into our own backup folder %s', async (path) => {
    const root = makeRoot();
    await expect(
      restoreFile(root as unknown as FileSystemDirectoryHandle, path, '<song/>'),
    ).rejects.toThrow(/app-managed/i);
  });

  it.each([[''], ['   '], ['A.XML']])('refuses the unusable path %s', async (path) => {
    const root = makeRoot();
    await expect(
      restoreFile(root as unknown as FileSystemDirectoryHandle, path, '<song/>'),
    ).rejects.toThrow();
  });
});
