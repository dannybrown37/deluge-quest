export const TRASH_DIR = "SOFT_DELETE";
export const HISTORY_BACKUP_DIR = "HISTORY_BACKUP";

/** Our own folders. Restoring into one would corrupt the very backups we rely on. */
const APP_MANAGED = [TRASH_DIR, HISTORY_BACKUP_DIR, "MOVE_BACKUP", "REPAIR_BACKUP"];

export async function getOrCreateDir(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<FileSystemDirectoryHandle> {
  const parts = path.split("/").filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = await current.getDirectoryHandle(part, { create: true });
  }
  return current;
}

/** Moves a file into TRASH_DIR, mirroring its original path under the given root. */
export async function moveToTrash(
  root: FileSystemDirectoryHandle,
  filePath: string,
): Promise<void> {
  const parts = filePath.split("/");
  const fileName = parts.pop()!;
  const sourceDir = parts.join("/");

  const sourceDirHandle = await getOrCreateDir(root, sourceDir);
  const sourceFileHandle = await sourceDirHandle.getFileHandle(fileName);
  const file = await sourceFileHandle.getFile();
  const data = await file.arrayBuffer();

  const trashPath = `${TRASH_DIR}/${sourceDir}`;
  const trashDirHandle = await getOrCreateDir(root, trashPath);
  const destFileHandle = await trashDirHandle.getFileHandle(fileName, { create: true });
  const writable = await destFileHandle.createWritable();
  await writable.write(data);
  await writable.close();

  await sourceDirHandle.removeEntry(fileName);
}

export interface RestoreResult {
  /** True when a file was already there and was copied into HISTORY_BACKUP first. */
  backedUp: boolean;
  /** True when the file was gone from the card and this put it back. */
  created: boolean;
}

/** A free name in the backup folder, so a second restore cannot overwrite the first backup. */
async function freeBackupName(
  dir: FileSystemDirectoryHandle,
  fileName: string,
): Promise<string> {
  for (let suffix = 0; ; suffix++) {
    const candidate = suffix === 0 ? fileName : `${fileName}.${suffix}`;
    try {
      await dir.getFileHandle(candidate);
    } catch {
      return candidate;
    }
  }
}

/**
 * Puts an earlier version of a file back on the card, copying whatever is there now into
 * HISTORY_BACKUP first. Nothing is destroyed, matching moveToTrash.
 */
export async function restoreFile(
  root: FileSystemDirectoryHandle,
  filePath: string,
  xml: string,
): Promise<RestoreResult> {
  const parts = filePath.split("/").filter((part) => part.trim());
  if (parts.length < 2) {
    throw new Error(`Cannot restore "${filePath}": expected a path like SONGS/NAME.XML`);
  }
  if (APP_MANAGED.includes(parts[0].toUpperCase())) {
    throw new Error(`Cannot restore into "${parts[0]}": that is an app-managed folder`);
  }

  const fileName = parts.pop()!;
  const dirPath = parts.join("/");
  const dirHandle = await getOrCreateDir(root, dirPath);

  let current: string | null = null;
  try {
    current = await (await (await dirHandle.getFileHandle(fileName)).getFile()).text();
  } catch {
    /* not on the card any more — nothing to back up, we are putting it back */
  }

  if (current !== null) {
    const backupDir = await getOrCreateDir(root, `${HISTORY_BACKUP_DIR}/${dirPath}`);
    const backupName = await freeBackupName(backupDir, fileName);
    const backupWritable = await (
      await backupDir.getFileHandle(backupName, { create: true })
    ).createWritable();
    await backupWritable.write(current);
    await backupWritable.close();
  }

  const writable = await (
    await dirHandle.getFileHandle(fileName, { create: true })
  ).createWritable();
  await writable.write(xml);
  await writable.close();

  return { backedUp: current !== null, created: current === null };
}
