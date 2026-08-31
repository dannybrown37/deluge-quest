export const TRASH_DIR = "SOFT_DELETE";

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
