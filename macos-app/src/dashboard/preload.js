/**
 * Preload for the metrics dashboard window. Exposes exactly one thing — a
 * read-only fetch of the aggregated metrics — over contextBridge, keeping
 * the renderer sandboxed (no Node, no DB handle) per Electron security
 * best practice. The actual SQL runs in the main process (lib/metrics.js)
 * because better-sqlite3 is synchronous and main-only.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('metrics', {
  get: () => ipcRenderer.invoke('metrics:get'),
});
