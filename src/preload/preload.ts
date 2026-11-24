import { contextBridge, ipcRenderer } from "electron";

// The only bridge the overlay page gets.
contextBridge.exposeInMainWorld("buddy", {
  onState: (cb: (s: unknown) => void) => ipcRenderer.on("buddy:state", (_e, s) => cb(s)),
  onReact: (cb: (r: unknown) => void) => ipcRenderer.on("buddy:react", (_e, r) => cb(r)),
  onCursor: (cb: (p: unknown) => void) => ipcRenderer.on("buddy:cursor", (_e, p) => cb(p)),
  reportPillRect: (r: unknown) => ipcRenderer.send("buddy:pill-rect", r),
  setInteractive: (on: boolean) => ipcRenderer.send("buddy:interactive", on === true),
  onSettings: (cb: (s: unknown) => void) => ipcRenderer.on("buddy:settings", (_e, s) => cb(s)),
  onPlaySound: (cb: (name: string) => void) => ipcRenderer.on("buddy:play-sound", (_e, n) => cb(String(n))),
  setNeedsYou: (on: boolean) => ipcRenderer.send("buddy:needs-you", on === true),
  decide: (choice: 0 | 1) => ipcRenderer.send("buddy:decision", choice),
  decideAlways: () => ipcRenderer.send("buddy:decision-always"),
  answerText: (text: string) => ipcRenderer.send("buddy:text-answer", String(text)),
});
