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
  decide: (choice: number) => ipcRenderer.send("buddy:decision", choice),
  decideAlways: () => ipcRenderer.send("buddy:decision-always"),
  answerText: (text: string) => ipcRenderer.send("buddy:text-answer", String(text)),
  decideMulti: (indexes: number[]) => ipcRenderer.send("buddy:decision-multi", indexes),
  // A note, or Pause / Stop, for an agent: it gets it with its next status update.
  leave: (agent: string, what: unknown) => ipcRenderer.send("buddy:leave", String(agent), what),
  onOutbox: (cb: (o: unknown) => void) => ipcRenderer.on("buddy:outbox", (_e, o) => cb(o)),
  // Opens the link an agent attached to its status. The address stays in the main process.
  openLink: (agent: string) => ipcRenderer.send("buddy:open-link", String(agent)),
});
