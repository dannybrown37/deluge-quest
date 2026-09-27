// File System Access API surface not yet in TypeScript's lib.dom.d.ts:
// permission methods on handles, and the picker entry point on Window.
interface FileSystemHandle {
  queryPermission(descriptor?: {
    mode?: "read" | "readwrite";
  }): Promise<PermissionState>;
  requestPermission(descriptor?: {
    mode?: "read" | "readwrite";
  }): Promise<PermissionState>;
}

interface Window {
  showDirectoryPicker(options?: {
    mode?: "read" | "readwrite";
  }): Promise<FileSystemDirectoryHandle>;
}
