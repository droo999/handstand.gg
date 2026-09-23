// TypeScript's lib.dom.d.ts (as of TS 5.5) doesn't type the async-iterable methods on
// FileSystemDirectoryHandle yet, even though they're implemented in Chrome and Safari.
// This augments the ambient type instead of casting to `any` at every call site.
export {};

declare global {
  interface FileSystemDirectoryHandle {
    keys(): AsyncIterableIterator<string>;
    values(): AsyncIterableIterator<FileSystemHandle>;
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  }
}
