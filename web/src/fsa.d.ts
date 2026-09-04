// File System Access API surface not yet in TypeScript's lib.dom.d.ts:
// permission methods on handles, and the picker entry point on Window.
interface FileSystemHandle {
  queryPermission(descriptor?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission(descriptor?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
}

interface Window {
  showDirectoryPicker(options?: { mode?: "read" | "readwrite" }): Promise<FileSystemDirectoryHandle>;
}

// Pyodide is loaded at runtime from a CDN URL (see pyodide.ts); no published types for that specifier.
declare module "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/pyodide.mjs" {
  export function loadPyodide(options?: Record<string, unknown>): Promise<import("./lib/pyodide").Pyodide>;
}
