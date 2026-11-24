import { contextBridge, ipcRenderer } from "electron";

// Bridge for the Settings window.
contextBridge.exposeInMainWorld("settingsApi", {
  get: () => ipcRenderer.invoke("settings:get"),
  set: (patch: unknown) => ipcRenderer.invoke("settings:set", patch),
  forgetRule: (agent: string, question: string) => ipcRenderer.invoke("settings:forget-rule", agent, question),
  testSound: (name: string) => ipcRenderer.send("settings:test-sound", name),
});
