// Builds data/combat.json from a checkout of A2Tools DPS Meter (GPL-3.0):
//
//   git clone --depth 1 https://github.com/taengu/A2Tools-DPS-Meter
//   node scripts/import-a2tools-combat.mjs ../A2Tools-DPS-Meter
//
// Game data the DPS tracker reads packets with: which skills' ticks are
// damage over time, which restore a resource rather than HP, and which NPC
// codes are bosses.

import fs from "node:fs";
import path from "node:path";

const root = process.argv[2];
if (!root) {
  console.error("usage: node scripts/import-a2tools-combat.mjs <A2Tools-DPS-Meter checkout>");
  process.exit(1);
}
const data = (name) => JSON.parse(fs.readFileSync(path.join(root, "src", "data", name), "utf8"));
const out = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "data", "combat.json");

const npcs = data("i18n/npcs/pt.json");
const combat = {
  dots: data("dot_skill_ids.json").sort((a, b) => a - b),
  resource: data("resource_restore_skills.json").skills.sort((a, b) => a - b),
  bosses: Object.keys(npcs).filter((code) => npcs[code].isBoss).map(Number).sort((a, b) => a - b),
};
fs.writeFileSync(out, JSON.stringify(combat) + "\n");
console.log(`data/combat.json: ${combat.dots.length} DoT skills, ${combat.resource.length} resource skills, ${combat.bosses.length} bosses`);
