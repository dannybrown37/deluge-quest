export const TRASH_DIR = "SOFT_DELETE";
export const MOVE_BACKUP_DIR = "MOVE_BACKUP";
export const HISTORY_BACKUP_DIR = "HISTORY_BACKUP";

/** Our own folders. Restoring into one would corrupt the very backups we rely on. */
const APP_MANAGED = [TRASH_DIR, MOVE_BACKUP_DIR, HISTORY_BACKUP_DIR, "REPAIR_BACKUP"];

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

export async function moveFile(
  root: FileSystemDirectoryHandle,
  fromPath: string,
  toPath: string,
): Promise<void> {
  const fromParts = fromPath.split("/");
  const fromName = fromParts.pop()!;
  const fromDir = fromParts.join("/");

  const toParts = toPath.split("/");
  const toName = toParts.pop()!;
  const toDir = toParts.join("/");

  const fromDirHandle = await getOrCreateDir(root, fromDir);
  const fromFileHandle = await fromDirHandle.getFileHandle(fromName);
  const file = await fromFileHandle.getFile();
  const data = await file.arrayBuffer();

  const toDirHandle = await getOrCreateDir(root, toDir);
  const toFileHandle = await toDirHandle.getFileHandle(toName, { create: true });
  const writable = await toFileHandle.createWritable();
  await writable.write(data);
  await writable.close();

  await fromDirHandle.removeEntry(fromName);
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
 * HISTORY_BACKUP first. Nothing is destroyed, matching moveToTrash and moveFile.
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

export interface XmlUpdateResult {
  updated: string[];
  errors: { path: string; message: string }[];
}

export async function updateXmlReferences(
  root: FileSystemDirectoryHandle,
  xmlPaths: string[],
  xmlTexts: Map<string, string>,
  moves: Map<string, string>,
): Promise<XmlUpdateResult> {
  const result: XmlUpdateResult = { updated: [], errors: [] };
  if (moves.size === 0) return result;

  const affectedXmls = new Set<string>();
  for (const [oldPath] of moves) {
    const oldLower = oldPath.toLowerCase();
    for (const [xmlPath, text] of xmlTexts) {
      if (text.toLowerCase().includes(oldLower)) affectedXmls.add(xmlPath);
    }
  }

  for (const xmlPath of affectedXmls) {
    try {
      const parts = xmlPath.split("/");
      const fileName = parts.pop()!;
      const dirPath = parts.join("/");
      const dirHandle = await getOrCreateDir(root, dirPath);
      const fileHandle = await dirHandle.getFileHandle(fileName);
      const file = await fileHandle.getFile();
      const originalText = await file.text();

      const backupDirHandle = await getOrCreateDir(root, `${MOVE_BACKUP_DIR}/${dirPath}`);
      const backupFileHandle = await backupDirHandle.getFileHandle(fileName, { create: true });
      const backupWritable = await backupFileHandle.createWritable();
      await backupWritable.write(originalText);
      await backupWritable.close();

      let newText = originalText;
      for (const [oldPath, newPath] of moves) {
        const pattern = new RegExp(
          `"${oldPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
          "gi",
        );
        newText = newText.replace(pattern, `"${newPath}"`);
      }

      const destWritable = await (await dirHandle.getFileHandle(fileName, { create: true })).createWritable();
      await destWritable.write(newText);
      await destWritable.close();

      xmlTexts.set(xmlPath, newText);
      result.updated.push(xmlPath);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Update failed";
      result.errors.push({ path: xmlPath, message });
    }
  }

  return result;
}
