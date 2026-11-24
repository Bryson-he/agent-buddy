#!/usr/bin/env node
// Claude Code Stop: mark the turn finished on the notch.
import { readStdin, setStatus } from "./lib.mjs";

await readStdin();
await setStatus("finished", "Claude Code turn done");
process.exit(0);
