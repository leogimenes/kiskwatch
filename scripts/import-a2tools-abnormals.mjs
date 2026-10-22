// Builds data/abnormals.json from a checkout of A2Tools DPS Meter (GPL-3.0):
//
//   git clone --depth 1 https://github.com/taengu/A2Tools-DPS-Meter
//   node scripts/import-a2tools-abnormals.mjs ../A2Tools-DPS-Meter
//
// The name (in Portuguese, else English) and icon of each buff and debuff
// (the game's SkillAbnormal table), for the DPS tab's buff uptimes:
// { "<abnormal id>": [name, icon file name] }.

import fs from "node:fs";
import path from "node:path";

const root = process.argv[2];
if (!root) {
  console.error("usage: node scripts/import-a2tools-abnormals.mjs <A2Tools-DPS-Meter checkout>");
  process.exit(1);
}
const data = (name) => JSON.parse(fs.readFileSync(path.join(root, "src", "data", name), "utf8"));
const out = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "data", "abnormals.json");

const pt = data("i18n/abnormals/pt.json");
const en = data("i18n/abnormals/en.json");
const icons = data("abnormals.json").abnormals;
const ids = [...new Set([...Object.keys(pt), ...Object.keys(en), ...Object.keys(icons)])].sort((a, b) => a - b);
const table = {};
for (const id of ids) table[id] = [pt[id] ?? en[id] ?? "", icons[id]?.icon ?? ""];
fs.writeFileSync(out, JSON.stringify(table) + "\n");
console.log(`data/abnormals.json: ${ids.length} buffs and debuffs`);
