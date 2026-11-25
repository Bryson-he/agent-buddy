// Builds the pictures used in README.md from a folder of snapshots.
//
//   npx electron . --snapshot-dir=shots        (takes the snapshots)
//   npx electron scripts/readme-images.js shots (lays them out into docs/images)
//
// Snapshot mode uses a throwaway data folder, so nothing personal ends up in the pictures.
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const shots = path.resolve(process.argv[process.argv.length - 1]);
const out = path.join(__dirname, "..", "docs", "images");
const uri = (name) => `data:image/png;base64,${fs.readFileSync(path.join(shots, `${name}.png`)).toString("base64")}`;

const TILES = [
  ["progress-link", "Working", "The current step, progress and a link to the work"],
  ["needsYou-scout", "Needs you", "Two buttons, a shortcut or a notification"],
  ["finished-scout", "Finished", "A one-line result, then it gets out of the way"],
  ["error-with-others", "Several agents", "One leads, the rest get a row each"],
  ["claude-needsYou", "Risky command", "Claude Code and Cursor ask before they run it"],
  ["ask-list", "More than yes or no", "Up to four choices, or type your own"],
];

const heroHtml = `<!doctype html><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  html { overflow: hidden; }
  body { margin: 0; width: 1280px; background: #0b0d12; font: 15px "Segoe UI Variable Text", "Segoe UI", sans-serif; color: #e9ecf2; padding: 20px; }
  .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
  figure { margin: 0; min-width: 0; }
  .screen { height: 250px; border-radius: 14px; overflow: hidden; border: 1px solid #262931; display: flex; justify-content: center;
    background: linear-gradient(135deg, #16324f 0%, #1c5d8f 38%, #2aa3d6 62%, #101a33 100%); }
  .screen img { width: 400px; height: 550px; flex: none; }
  figcaption { padding: 10px 4px 0; }
  figcaption b { display: block; font-size: 16px; font-weight: 600; }
  figcaption span { color: #9aa3b2; font-size: 13.5px; }
</style><div class="grid">${TILES.map(([file, title, text]) =>
  `<figure><div class="screen"><img src="${uri(file)}"></div><figcaption><b>${title}</b><span>${text}</span></figcaption></figure>`).join("")}</div>`;

const stripHtml = (names) => `<!doctype html><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  html { overflow: hidden; }
  body { margin: 0; width: 1280px; background: #0b0d12; padding: 28px; display: flex; gap: 20px; align-items: flex-start; }
  img { flex: 1; min-width: 0; width: 50%; border-radius: 12px; border: 1px solid #262931; }
</style>${names.map((n) => `<img src="${uri(n)}">`).join("")}`;

async function render(html, file) {
  const win = new BrowserWindow({ show: false, width: 1280, height: 800, useContentSize: true, webPreferences: { offscreen: true } });
  // A page this size is too long for a data: address, so it goes through a temporary file.
  const page = path.join(app.getPath("temp"), `agent-buddy-${file}.html`);
  fs.writeFileSync(page, html);
  await win.loadFile(page);
  const height = await win.webContents.executeJavaScript("Math.ceil(document.body.getBoundingClientRect().height)");
  win.setContentSize(1280, height);
  await new Promise((r) => setTimeout(r, 600));
  fs.writeFileSync(path.join(out, file), (await win.webContents.capturePage({ x: 0, y: 0, width: 1280, height })).toPNG());
  win.destroy();
  fs.rmSync(page, { force: true });
}

// Each picture closes its window; that must not end the run.
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  await render(heroHtml, "states.png");
  await render(stripHtml(["welcome-1", "welcome-4"]), "quick-start.png");
  await render(stripHtml(["settings-window", "activity-panel"]), "windows.png");
  app.quit();
});
