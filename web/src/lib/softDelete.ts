export const TRASH_DIR = "SOFT_DELETE";
export const MOVE_BACKUP_DIR = "MOVE_BACKUP";

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
    } catch (e: any) {
      result.errors.push({ path: xmlPath, message: e.message || "Update failed" });
    }
  }

  return result;
}
