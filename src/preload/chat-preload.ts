import { contextBridge, ipcRenderer } from "electron";

// Bridge for the "Ask Grok" window. The API key goes to main once and never comes back.
contextBridge.exposeInMainWorld("grok", {
  hasKey: () => ipcRenderer.invoke("grok:has-key"),
  saveKey: (key: string) => ipcRenderer.invoke("grok:save-key", key),
  clearKey: () => ipcRenderer.invoke("grok:clear-key"),
  chat: (messages: unknown) => ipcRenderer.invoke("grok:chat", messages),
  cancel: () => ipcRenderer.invoke("grok:cancel"),
});
