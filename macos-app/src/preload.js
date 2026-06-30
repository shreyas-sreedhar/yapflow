/**
 * Preload script. Exposes a minimal, deliberately small surface from the
 * main process to the renderer via contextBridge — per Electron security
 * best practice, the renderer never gets direct Node/IPC access, only these
 * specific named functions.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flowLocal', {
  // Renderer -> Main: a chunk of resampled int16 PCM audio, as an
  // ArrayBuffer. Sent continuously while the hotkey is held.
  sendAudioChunk: (arrayBuffer) => ipcRenderer.send('audio-chunk', arrayBuffer),

  // Renderer -> Main: something went wrong capturing audio (e.g. mic
  // permission denied). Surfaced so main.js can show it in the tray /
  // notify the user rather than failing silently.
  reportError: (message) => ipcRenderer.send('renderer-error', message),

  // Main -> Renderer: hotkey state changes, used to start/stop capture.
  onHotkeyDown: (callback) => ipcRenderer.on('hotkey-down', () => callback()),
  onHotkeyUp: (callback) => ipcRenderer.on('hotkey-up', () => callback()),
});
