import { contextBridge, ipcRenderer } from "electron";

// Bridge for the Activity panel: read-only.
contextBridge.exposeInMainWorld("panelApi", {
  get: () => ipcRenderer.invoke("panel:get"),
  colours: () => ipcRenderer.invoke("panel:colours"),
  onUpdate: (cb: (bots: unknown) => void) => ipcRenderer.on("panel:update", (_e, bots) => cb(bots)),
});
