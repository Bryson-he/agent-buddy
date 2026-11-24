#!/usr/bin/env node
import { readStdin, reply, setStatus } from "./lib.mjs";

await readStdin();
await setStatus("finished", "Cursor turn done");
reply({});
