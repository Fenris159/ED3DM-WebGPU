#!/usr/bin/env node
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { convertSystems, parseDump, writeCatalog } from "./convert";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

function has(flag: string): boolean {
  return process.argv.includes(flag);
}

const input = arg("--in") ?? arg("-i");
const out = arg("--out") ?? arg("-o");
if (!input || !out || has("--help") || has("-h")) {
  process.stderr.write(
    "Usage: ed3dm-convert --in dump.json --out catalogDir [--budget 2000]\n" +
      "Operator-only. Do not run this on GitHub Actions; dumps are too large.\n",
  );
  process.exit(input && out ? 0 : 1);
}

const budget = Number(arg("--budget") ?? "2000");
const dump = readFileSync(resolve(input), "utf8");
const parsed = JSON.parse(dump.startsWith("{") && !dump.startsWith("[") ? dump : "null");
const stations =
  parsed && typeof parsed === "object" && parsed.stations ? parsed.stations : undefined;
const bodies =
  parsed && typeof parsed === "object" && parsed.bodies ? parsed.bodies : undefined;
const systems = parseDump(dump);
const catalog = convertSystems(systems, {
  budget: Number.isFinite(budget) ? budget : 2000,
  stations,
  bodies,
});
const dest = resolve(out);
mkdirSync(dest, { recursive: true });
writeCatalog(dest, catalog);
process.stdout.write(
  `Wrote ${catalog.overview.cells.length} tiles, ${systems.length} systems → ${dest}\n`,
);
