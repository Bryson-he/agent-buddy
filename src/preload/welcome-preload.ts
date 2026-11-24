import { contextBridge, ipcRenderer } from "electron";

// Bridge for the Quick start window. Settings go through the same channel as the Settings window.
contextBridge.exposeInMainWorld("welcomeApi", {
  get: () => ipcRenderer.invoke("welcome:get"),
  set: (patch: unknown) => ipcRenderer.invoke("settings:set", patch),
  copy: (what: string, arg?: string) => ipcRenderer.invoke("welcome:copy", what, arg),
  setTunnel: (on: boolean) => ipcRenderer.invoke("welcome:tunnel", on),
  demo: () => ipcRenderer.send("welcome:demo"),
  testSound: (name: string) => ipcRenderer.send("settings:test-sound", name),
  open: (what: string) => ipcRenderer.send("welcome:open", what),
  done: () => ipcRenderer.send("welcome:done"),
});
