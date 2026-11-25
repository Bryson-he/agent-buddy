// The Rive version of the main character (trial, Settings > New character).
//
// The character is one file, renderer/rive/buddy.riv, built from rive/buddy/scene.rml.
// This script only feeds it: the lead agent's colour, where the eyes look, and a
// state number. All the motion lives in the Rive file. If anything fails to
// load, the drawn character simply stays.
//
// Top-level names start with "rv" because renderer scripts share one global scope.

// Just the parts of Rive's runtime (vendor/rive/rive.js, a global) used here.
interface RvNumber { value: number }
interface RvColor { rgb(r: number, g: number, b: number): void }
interface RvInstance { number(path: string): RvNumber | null; color(path: string): RvColor | null }
interface RvRive { viewModelInstance: RvInstance | null; cleanup(): void; resizeToCanvas(): void }
declare const rive: {
  Rive: new (options: Record<string, unknown>) => RvRive;
  RuntimeLoader: { setWasmUrl(url: string): void };
  Layout: new (options: Record<string, unknown>) => unknown;
  Fit: { Contain: unknown };
};

/** The numbers scene.rml's state machine expects. */
const RV_STATE: Record<string, number> = {
  idle: 0, working: 1, needsYou: 2, finished: 3, error: 4, upload: 5, greeting: 6,
  doze: 7, annoyed: 8, slap: 9, dizzy: 10,
};

const rvCanvas = document.getElementById("rive-face") as HTMLCanvasElement;
let rvWanted = false;
let rvInstance: RvRive | null = null;
let rvData: { state: RvNumber; shape: RvNumber; lookX: RvNumber; lookY: RvNumber; color: RvColor } | null = null;
let rvLoop = 0;
// What was last sent, so the file is only told about changes.
let rvSent = { state: -1, shape: -1, colour: "", x: 0, y: 0 };

function rvStop(): void {
  cancelAnimationFrame(rvLoop);
  rvLoop = 0;
  body.dataset.rive = "0";
  rvData = null;
  try { rvInstance?.cleanup(); } catch { /* already gone */ }
  rvInstance = null;
}

function rvStart(): void {
  if (rvInstance || typeof rive === "undefined") return;
  try {
    // The engine is shipped with the app; without this the runtime fetches it from the internet.
    rive.RuntimeLoader.setWasmUrl("vendor/rive/rive.wasm");
    const made: RvRive = new rive.Rive({
      src: "rive/buddy.riv",
      canvas: rvCanvas,
      stateMachine: "Buddy",
      autoplay: true,
      autoBind: true,
      layout: new rive.Layout({ fit: rive.Fit.Contain }),
      onLoad: () => {
        const vm = made.viewModelInstance;
        const state = vm?.number("state");
        const shape = vm?.number("shape");
        const lookX = vm?.number("lookX");
        const lookY = vm?.number("lookY");
        const color = vm?.color("color");
        if (!rvWanted || !state || !shape || !lookX || !lookY || !color) { console.error("[rive] the character's data did not bind"); rvStop(); return; }
        rvData = { state, shape, lookX, lookY, color };
        rvSent = { state: -1, shape: -1, colour: "", x: 0, y: 0 };
        rvPixels = 0;
        rvLeft = NaN;
        body.dataset.rive = "1";
        rvLoop = requestAnimationFrame(rvTick);
      },
      onLoadError: (e: unknown) => { console.error("[rive] could not load the character", e); rvStop(); },
    });
    rvInstance = made;
  } catch (e) {
    console.error("[rive] could not start", e);
    rvStop();
  }
}

/**
 * Keeps the canvas exactly over the drawn ball, at a whole number of screen pixels,
 * and drawn at exactly twice that resolution. Seen on a real screen, Rive's own edge
 * smoothing was not enough at this size: the circle showed steps. Drawing at double
 * size and letting the browser halve it averages four drawn pixels into each screen
 * pixel, which smooths every edge. (Much more than double looks jagged again: the
 * browser only blends neighbouring pixels when it shrinks a canvas.)
 *
 * The face's viewBox is 92 units wide and the drawn ball is 56 across, centred at
 * (46, 46) of it. The Rive artboard is 200 wide with a 124 ball centred at (100, 104).
 */
let rvPixels = 0;
let rvLeft = NaN;
let rvTop = NaN;
function rvFit(): void {
  const f = face.getBoundingClientRect();
  const row = rvCanvas.parentElement!.getBoundingClientRect();
  const size = Math.max(16, Math.round(f.width * (56 / 92) * (200 / 124)));
  const left = Math.round(f.left - row.left + f.width / 2 - size / 2);
  const top = Math.round(f.top - row.top + f.height / 2 - size * 0.52);
  if (left !== rvLeft || top !== rvTop) {
    rvLeft = left;
    rvTop = top;
    rvCanvas.style.transform = `translate(${left}px, ${top}px)`;
  }
  const pixels = Math.round(size * window.devicePixelRatio) * 2;
  if (pixels === rvPixels) return;
  rvPixels = pixels;
  rvCanvas.style.width = `${size}px`;
  rvCanvas.style.height = `${size}px`;
  rvCanvas.width = pixels;
  rvCanvas.height = pixels;
  rvInstance?.resizeToCanvas();
}

/** Once a frame: tell the character what changed. The eyes ease towards where they should look. */
function rvTick(): void {
  rvLoop = requestAnimationFrame(rvTick);
  if (!rvData) return;
  rvFit();

  const mood = reaction !== "none" ? reaction : dozing && lead.state === "idle" ? "doze" : lead.state;
  const state = RV_STATE[mood] ?? 0;
  if (state !== rvSent.state) { rvSent.state = state; rvData.state.value = state; }

  // The body shape: the same names as the drawn character. The Rive file has no
  // block with limbs, so Claude Code's block shows as the square.
  const style = bodyStyle(lead.key);
  const shape = Math.max(0, (SHAPE_NAMES as readonly string[]).indexOf(style === "block" ? "square" : style));
  if (shape !== rvSent.shape) { rvSent.shape = shape; rvData.shape.value = shape; }

  const colour = colourFor(lead.key);
  if (colour !== rvSent.colour) {
    rvSent.colour = colour;
    const n = parseInt(colour.slice(1), 16);
    rvData.color.rgb((n >> 16) & 255, (n >> 8) & 255, n & 255);
  }

  // Eyes follow the cursor only when the face is free to: not while dozing or mid-reaction.
  const free = mood === "idle" || mood === "working" || mood === "needsYou" || mood === "finished" || mood === "greeting";
  const tx = free ? look.x : 0;
  const ty = free ? look.y : 0;
  const x = rvSent.x + (tx - rvSent.x) * 0.2;
  const y = rvSent.y + (ty - rvSent.y) * 0.2;
  if (Math.abs(x - rvSent.x) > 0.002 || Math.abs(y - rvSent.y) > 0.002) {
    rvSent.x = x;
    rvSent.y = y;
    rvData.lookX.value = x;
    rvData.lookY.value = y;
  }
}

/** Called when the setting arrives or changes. */
function setRiveCharacter(on: boolean): void {
  if (on === rvWanted) return;
  rvWanted = on;
  if (on) rvStart();
  else rvStop();
}
