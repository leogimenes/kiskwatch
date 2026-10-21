// Builds data/*.json from a checkout of A2Tools-Plugins (GPL-3.0):
//
//   git clone --depth 1 https://github.com/taengu/A2Tools-Plugins
//   node scripts/import-a2tools-data.mjs ../A2Tools-Plugins
//
// The plugins ship their data as browser scripts declaring constants; this
// evaluates each file in a sandbox and keeps the constants, in the languages
// Kiskwatch shows (Portuguese, then English as the fallback).

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const LANGS = ["pt", "en"];

const root = process.argv[2];
if (!root) {
  console.error("usage: node scripts/import-a2tools-data.mjs <A2Tools-Plugins checkout>");
  process.exit(1);
}
const out = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "data");

/** The named top-level constants of a plugin script. */
function constants(file, names) {
  const src = fs.readFileSync(path.join(root, "plugins", file), "utf8");
  const context = {};
  vm.runInNewContext(`${src}\n;globalThis.__out = { ${names.join(", ")} };`, context);
  return context.__out;
}

/** Keep only the languages shown, dropping any the entry lacks. */
const pick = (texts) => Object.fromEntries(LANGS.filter((l) => texts?.[l]).map((l) => [l, texts[l]]));

const write = (name, value) => {
  fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 1) + "\n");
  console.log(`data/${name}`);
};

const sched = constants("event-timers/schedule.js", ["EVENTS", "FIELD_BOSSES", "SERVERS", "EVENT_TEXT"]);
const pets = constants("pet-souls/pets.js", ["PET_NAMES", "PET_GENUS", "GENUS_NAMES"]);
const sources = constants("pet-souls/sources.js", ["PET_SOURCES", "SOURCE_TEXT"]);

// Servers: the id's first digit is the side, its second the region.
const servers = Object.entries(sched.SERVERS).map(([id, names]) => ({
  id: Number(id),
  name: names.en,
  region: Number(id[1]),
  side: id[0] === "1" ? "elyos" : "asmodian",
}));

const text = {};
for (const [key, value] of [...Object.entries(sched.EVENT_TEXT), ...Object.entries(sources.SOURCE_TEXT)]) {
  text[key] = pick(value);
}
// The plugins' own words, which are not in the game's tables.
Object.assign(text, {
  "=rift": { pt: "Fenda Espaço-Temporal", en: "Spacetime Rift" },
  "=daily": { pt: "Reset diário", en: "Daily reset" },
  "=weekly": { pt: "Reset semanal", en: "Weekly reset" },
});

const petList = Object.entries(pets.PET_NAMES).map(([id, names]) => {
  const s = sources.PET_SOURCES[id] || {};
  return {
    id: Number(id),
    name: pick(names),
    genus: pets.PET_GENUS[id] || null,
    unreleased: Boolean(s.unreleased),
    drops: (s.drops || []).map((d) => ({
      npcId: d.npcId,
      npc: d.npc,
      level: d.level,
      chance: d.chance,
      region: d.region,
      map: d.map,
      mapId: d.mapId,
      zones: d.zones || [],
      spawns: d.spawns,
      kibelisk: d.kibelisk || null,
    })),
    chests: (s.chests || []).map((c) => ({ name: c.name, chance: c.chance, from: c.from || [] })),
  };
});

fs.mkdirSync(out, { recursive: true });
write("events.json", sched.EVENTS);
write("field_bosses.json", sched.FIELD_BOSSES);
write("servers.json", servers);
write("pets.json", petList);
write("genus.json", Object.fromEntries(Object.entries(pets.GENUS_NAMES).map(([k, v]) => [k, pick(v)])));
write("text.json", text);
