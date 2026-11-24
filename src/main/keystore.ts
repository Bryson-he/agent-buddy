// Stores the xAI API key encrypted with Windows DPAPI (Electron safeStorage),
// readable only by this Windows user. XAI_API_KEY in the environment wins, for development.
import { app, safeStorage } from "electron";
import * as fs from "fs";
import * as path from "path";

const keyFile = () => path.join(app.getPath("userData"), "xai-key.bin");

export function getApiKey(): string | null {
  if (process.env.XAI_API_KEY) return process.env.XAI_API_KEY;
  try {
    return safeStorage.decryptString(fs.readFileSync(keyFile()));
  } catch {
    return null;
  }
}

export function saveApiKey(key: string): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows encryption is not available, so the key was not saved.");
  fs.mkdirSync(path.dirname(keyFile()), { recursive: true });
  fs.writeFileSync(keyFile(), safeStorage.encryptString(key));
}

export function clearApiKey(): void {
  fs.rmSync(keyFile(), { force: true });
}
