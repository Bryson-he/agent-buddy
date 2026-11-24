#!/usr/bin/env node
import { readStdin, reply, setStatus } from "./lib.mjs";

const input = await readStdin();
const file = String(input.file_path ?? input.path ?? input.file ?? "").split(/[/\\]/).pop() || "a file";
await setStatus("working", `Edited ${file}`.slice(0, 60));
reply({});
