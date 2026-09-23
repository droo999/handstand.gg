/**
 * Chunked video storage for Spike B: each `MediaRecorder` chunk is written straight to
 * durable browser storage and dropped from JS memory, instead of buffering a whole
 * 20-30 minute recording in an array. This is the thing spike B is actually testing.
 *
 * Backend preference: OPFS (Origin Private File System) > IndexedDB > in-memory (last
 * resort; no crash protection, kept only so the app still works somewhere with neither).
 * Sessions that are still on disk when the app reloads (e.g. the tab was killed mid
 * recording) show up via `listOrphanSessions`, so a crash doesn't silently lose footage.
 */

export type StorageBackend = "opfs" | "indexeddb" | "memory";

export type SessionStore = {
  id: string;
  backend: StorageBackend;
  mimeType: string;
  startedAt: number;
};

export type OrphanSession = {
  id: string;
  backend: StorageBackend;
  mimeType: string;
  startedAt: number;
  chunkCount: number;
};

type Meta = { mimeType: string; startedAt: number; chunkCount: number };

const pad = (n: number) => String(n).padStart(6, "0");
const chunkName = (index: number) => `${pad(index)}.chunk`;

// ---- Backend detection ------------------------------------------------------------------

let backendPromise: Promise<StorageBackend> | null = null;

/** Feature-detects the best available backend. Cached for the life of the page. */
export function detectBackend(): Promise<StorageBackend> {
  if (!backendPromise) backendPromise = probeBackend();
  return backendPromise;
}

async function probeBackend(): Promise<StorageBackend> {
  try {
    if ("storage" in navigator && "getDirectory" in navigator.storage) {
      const root = await navigator.storage.getDirectory();
      // Some browsers expose the API but throw on use (e.g. in a locked-down iframe);
      // confirm we can actually create and remove an entry before trusting it.
      await root.getDirectoryHandle("__probe__", { create: true });
      await root.removeEntry("__probe__", { recursive: true });
      return "opfs";
    }
  } catch {
    /* fall through to IndexedDB */
  }
  if ("indexedDB" in window) return "indexeddb";
  return "memory";
}

export async function estimateStorage(): Promise<{ usage: number; quota: number } | null> {
  if (!("storage" in navigator) || !navigator.storage.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage: usage ?? 0, quota: quota ?? 0 };
  } catch {
    return null;
  }
}

// ---- OPFS -------------------------------------------------------------------------------

async function opfsSessionsDir(create: boolean): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle("sessions", { create });
}

async function opfsSessionDir(id: string, create: boolean): Promise<FileSystemDirectoryHandle> {
  const sessions = await opfsSessionsDir(create);
  return sessions.getDirectoryHandle(id, { create });
}

async function opfsWriteMeta(id: string, meta: Meta): Promise<void> {
  const dir = await opfsSessionDir(id, true);
  const handle = await dir.getFileHandle("meta.json", { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(meta));
  await writable.close();
}

async function opfsReadMeta(id: string): Promise<Meta | null> {
  try {
    const dir = await opfsSessionDir(id, false);
    const handle = await dir.getFileHandle("meta.json");
    const file = await handle.getFile();
    return JSON.parse(await file.text()) as Meta;
  } catch {
    return null;
  }
}

async function opfsAppendChunk(id: string, index: number, blob: Blob): Promise<void> {
  const dir = await opfsSessionDir(id, true);
  const handle = await dir.getFileHandle(chunkName(index), { create: true });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

async function opfsFinalize(id: string): Promise<{ blob: Blob; chunkCount: number; totalBytes: number }> {
  const meta = await opfsReadMeta(id);
  const chunkCount = meta?.chunkCount ?? 0;
  const dir = await opfsSessionDir(id, false);
  const parts: Blob[] = [];
  let totalBytes = 0;
  for (let i = 0; i < chunkCount; i++) {
    const file = await (await dir.getFileHandle(chunkName(i))).getFile();
    parts.push(file);
    totalBytes += file.size;
  }
  return { blob: new Blob(parts, { type: meta?.mimeType || "video/webm" }), chunkCount, totalBytes };
}

async function opfsDiscard(id: string): Promise<void> {
  const sessions = await opfsSessionsDir(true);
  await sessions.removeEntry(id, { recursive: true }).catch(() => {});
}

async function opfsListOrphans(): Promise<OrphanSession[]> {
  try {
    const sessions = await opfsSessionsDir(false);
    const out: OrphanSession[] = [];
    for await (const name of sessions.keys()) {
      const meta = await opfsReadMeta(name);
      if (meta) out.push({ id: name, backend: "opfs", ...meta });
    }
    return out;
  } catch {
    return []; // no "sessions" directory yet (nothing has ever recorded)
  }
}

// ---- IndexedDB --------------------------------------------------------------------------

const IDB_NAME = "handstand-video-store";
const IDB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions", { keyPath: "id" });
      if (!db.objectStoreNames.contains("chunks")) db.createObjectStore("chunks", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbTxDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function idbWriteMeta(id: string, meta: Meta): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("sessions", "readwrite");
  tx.objectStore("sessions").put({ id, ...meta });
  await idbTxDone(tx);
  db.close();
}

async function idbReadMeta(id: string): Promise<Meta | null> {
  const db = await openDb();
  const tx = db.transaction("sessions", "readonly");
  const record = await idbRequest<{ mimeType: string; startedAt: number; chunkCount: number } | undefined>(
    tx.objectStore("sessions").get(id),
  );
  db.close();
  return record ? { mimeType: record.mimeType, startedAt: record.startedAt, chunkCount: record.chunkCount } : null;
}

async function idbAppendChunk(id: string, index: number, blob: Blob): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("chunks", "readwrite");
  tx.objectStore("chunks").put({ key: `${id}#${pad(index)}`, blob });
  await idbTxDone(tx);
  db.close();
}

async function idbFinalize(id: string): Promise<{ blob: Blob; chunkCount: number; totalBytes: number }> {
  const meta = await idbReadMeta(id);
  const chunkCount = meta?.chunkCount ?? 0;
  const db = await openDb();
  const tx = db.transaction("chunks", "readonly");
  const store = tx.objectStore("chunks");
  const parts: Blob[] = [];
  let totalBytes = 0;
  for (let i = 0; i < chunkCount; i++) {
    const record = await idbRequest<{ blob: Blob } | undefined>(store.get(`${id}#${pad(i)}`));
    if (record?.blob) {
      parts.push(record.blob);
      totalBytes += record.blob.size;
    }
  }
  db.close();
  return { blob: new Blob(parts, { type: meta?.mimeType || "video/webm" }), chunkCount, totalBytes };
}

async function idbDiscard(id: string): Promise<void> {
  const meta = await idbReadMeta(id);
  const chunkCount = meta?.chunkCount ?? 0;
  const db = await openDb();
  const tx = db.transaction(["sessions", "chunks"], "readwrite");
  tx.objectStore("sessions").delete(id);
  const chunks = tx.objectStore("chunks");
  for (let i = 0; i < chunkCount; i++) chunks.delete(`${id}#${pad(i)}`);
  await idbTxDone(tx);
  db.close();
}

async function idbListOrphans(): Promise<OrphanSession[]> {
  const db = await openDb();
  const tx = db.transaction("sessions", "readonly");
  const records = await idbRequest<Array<Meta & { id: string }>>(tx.objectStore("sessions").getAll());
  db.close();
  return records.map((r) => ({ id: r.id, backend: "indexeddb", mimeType: r.mimeType, startedAt: r.startedAt, chunkCount: r.chunkCount }));
}

// ---- In-memory fallback (no crash protection) ------------------------------------------

const memoryStore = new Map<string, { meta: Meta; chunks: Blob[] }>();

function memoryWriteMeta(id: string, meta: Meta): void {
  const existing = memoryStore.get(id);
  memoryStore.set(id, { meta, chunks: existing?.chunks ?? [] });
}

function memoryAppendChunk(id: string, index: number, blob: Blob): void {
  const entry = memoryStore.get(id);
  if (entry) entry.chunks[index] = blob;
}

function memoryFinalize(id: string): { blob: Blob; chunkCount: number; totalBytes: number } {
  const entry = memoryStore.get(id);
  const chunks = entry?.chunks ?? [];
  const totalBytes = chunks.reduce((sum, b) => sum + (b?.size ?? 0), 0);
  return { blob: new Blob(chunks, { type: entry?.meta.mimeType || "video/webm" }), chunkCount: chunks.length, totalBytes };
}

function memoryDiscard(id: string): void {
  memoryStore.delete(id);
}

function memoryListOrphans(): OrphanSession[] {
  return [...memoryStore.entries()].map(([id, { meta, chunks }]) => ({
    id,
    backend: "memory",
    mimeType: meta.mimeType,
    startedAt: meta.startedAt,
    chunkCount: chunks.length,
  }));
}

// ---- Public API, dispatching on backend --------------------------------------------------

export async function createSessionStore(id: string, mimeType: string): Promise<SessionStore> {
  const backend = await detectBackend();
  const meta: Meta = { mimeType, startedAt: Date.now(), chunkCount: 0 };
  if (backend === "opfs") await opfsWriteMeta(id, meta);
  else if (backend === "indexeddb") await idbWriteMeta(id, meta);
  else memoryWriteMeta(id, meta);
  return { id, backend, mimeType, startedAt: meta.startedAt };
}

/** Rebuilds a store handle for a session found by `listOrphanSessions` (app was reloaded). */
export function storeFromOrphan(orphan: OrphanSession): SessionStore {
  return { id: orphan.id, backend: orphan.backend, mimeType: orphan.mimeType, startedAt: orphan.startedAt };
}

export async function appendChunk(store: SessionStore, index: number, blob: Blob): Promise<void> {
  const meta: Meta = { mimeType: store.mimeType, startedAt: store.startedAt, chunkCount: index + 1 };
  if (store.backend === "opfs") {
    await opfsAppendChunk(store.id, index, blob);
    await opfsWriteMeta(store.id, meta);
  } else if (store.backend === "indexeddb") {
    await idbAppendChunk(store.id, index, blob);
    await idbWriteMeta(store.id, meta);
  } else {
    memoryAppendChunk(store.id, index, blob);
    memoryWriteMeta(store.id, meta);
  }
}

export async function finalizeSession(
  store: SessionStore,
): Promise<{ blob: Blob; chunkCount: number; totalBytes: number }> {
  if (store.backend === "opfs") return opfsFinalize(store.id);
  if (store.backend === "indexeddb") return idbFinalize(store.id);
  return memoryFinalize(store.id);
}

export async function discardSession(store: SessionStore): Promise<void> {
  if (store.backend === "opfs") return opfsDiscard(store.id);
  if (store.backend === "indexeddb") return idbDiscard(store.id);
  memoryDiscard(store.id);
}

/** Sessions still on disk (backend hasn't changed since) after a reload — likely a crash. */
export async function listOrphanSessions(): Promise<OrphanSession[]> {
  const backend = await detectBackend();
  if (backend === "opfs") return opfsListOrphans();
  if (backend === "indexeddb") return idbListOrphans();
  return memoryListOrphans();
}
