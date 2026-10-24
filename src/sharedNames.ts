// Names found for the codes players shared (see share.ts): data/shared_names.json
// as of this version, under the Worker's table that the app downloads now and
// then. They fill only what data/ and the profile leave unnamed.
import { invoke } from "@tauri-apps/api/core";
import bundled from "../data/shared_names.json";

export type NameKind = "npcs" | "npc_skills" | "skills" | "effects";
type Names = Record<NameKind, Record<string, string>>;

let names: Names = bundled as Names;

/** A shared name for a code, if there is one. */
export const sharedName = (kind: NameKind, code: number): string | undefined => names[kind]?.[code];

/** The downloaded table over the bundled one; the panel awaits it before drawing. */
export async function reloadNames() {
  const got = await invoke<Names | null>("shared_names").catch(() => null);
  if (!got) return;
  const base = bundled as Names;
  names = Object.fromEntries((Object.keys(base) as NameKind[]).map((k) => [k, { ...base[k], ...got[k] }])) as Names;
}
