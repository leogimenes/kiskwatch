// The app's commands and events, typed.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

export interface Accessibility {
  font_scale: number;
  high_contrast: boolean;
  reduce_motion: boolean;
  colorblind: boolean;
  overlay_opacity: number;
  sound: boolean;
  volume: number;
  alert_seconds: number;
}

export interface RouteStop {
  pet: number;
  npc: number;
}

export interface Settings {
  server_id: number;
  alarms: Record<string, number[]>;
  click_through: boolean;
  timer_overlay: boolean;
  pet_overlay: boolean;
  overlays_with_game: boolean;
  pinned_pets: number[];
  route: RouteStop[];
  a11y: Accessibility;
  dps: DpsSettings;
  hotkeys: Hotkeys;
}

/** Global keyboard shortcuts, as "Ctrl+Alt+D"; empty is off. */
export interface Hotkeys {
  dps: string;
  click_through: string;
}

export type DpsTarget = "all" | "mob" | "boss";
export type DpsBars = "damage" | "heal" | "both";

export interface DpsSettings {
  overlay: boolean;
  /** "hit": recording starts on your first hit; "button": by hand. */
  start: "hit" | "button";
  target: DpsTarget;
  bars: DpsBars;
}

export type ClassName = "Gladiator" | "Templar" | "Assassin" | "Ranger" | "Sorcerer" | "Elementalist" | "Cleric" | "Chanter";

export interface FightPlayer {
  id: number; name: string; class: ClassName | null; local: boolean; boss_damage: number; mob_damage: number; heal: number;
  /** Damage in each second; empty in recordings from before the timeline. */
  timeline: number[];
  /** Stretches of 3 s or more without acting, [from, to] in ms from the start. */
  idle: [number, number][];
  idle_ms: number;
  /** Damage by skill, biggest first. */
  skills: SkillStat[];
  /** When each skill (by base id) was used, in ms from the start; absent in older recordings. */
  casts?: SkillCasts[];
  /** What monsters did to this player, most damage first. */
  taken: Taken[];
}

/** The damage a player took from one monster's skill; `npc` is 0 when its spawn was missed. */
export interface Taken {
  npc: number; boss: boolean; skill: number; damage: number; hits: number; max_hit: number;
}

/** Hits and their damage. */
export interface Tally { damage: number; hits: number; crits: number; max_hit: number }

/** One skill's damage in a recording (its base code: no specializations),
 *  on bosses and on everything else; `dot` is its damage-over-time ticks. */
export interface SkillStat { skill: number; dot: boolean; boss: Tally; mob: Tally }

export interface SkillCasts { skill: number; at: number[] }

/** How long one buff or debuff stayed on one entity over a recording. */
export interface Uptime {
  entity: number; abnormal: number; skill: number | null; caster: number; uptime_ms: number; applied: number; stacks: number;
}

/** The buffs and debuffs on each player, and on the enemy that took the most damage. */
export interface FightEffects {
  target: number | null; target_boss: boolean; list: Uptime[];
}

/** A DPS recording, live or saved. */
export interface Fight {
  id: string; name: string; started_ms: number; ended_ms: number; players: FightPlayer[];
  /** Each boss hit, most damaged first (none in recordings from before). */
  bosses?: FightBoss[];
  /** Missing from recordings made before buffs were read. */
  effects?: FightEffects;
}

export interface SkillDamage { skill: number; damage: number; hits: number }

export interface FightBoss {
  code: number; first_ms: number; last_ms: number; damage: number; my_damage: number; my_skills: SkillDamage[];
}

/** One recording against a boss: time from its first to last hit. */
export interface Attempt {
  fight_id: string; name: string; started_ms: number; kill_ms: number; my_dps: number; group_dps: number; players: number;
}

export interface BossHistory {
  code: number; attempts: Attempt[]; best_id: string; avg_kill_ms: number; fastest_kill_ms: number; avg_my_dps: number; avg_group_dps: number;
}

export interface SkillDiff { skill: number; damage: number; hits: number; dps: number; best_damage: number; best_hits: number; best_dps: number }

/** A recording against your best one against the same boss. */
export interface Comparison { code: number; now: Attempt; best: Attempt; is_best: boolean; skills: SkillDiff[] }

export interface PetProgress {
  level: number;
  points: number;
}

/** A character's official profile, as the site sends it. */
export interface Profile {
  server_id: number;
  character_id: string;
  name: string;
  info: ProfileInfo;
  equipment: ProfileEquipment;
  boards: Record<string, BoardDetail>;
  fetched_ms: number;
}

export interface ProfileInfo {
  profile?: {
    characterName: string; characterLevel: number; className: string; combatPower: number; raceId: number; raceName: string;
    serverName: string; titleName?: string; profileImage?: string;
  };
  daevanion?: { boardList?: { id: number; name: string; icon: string; open: number; openNodeCount: number; totalNodeCount: number }[] };
  stat?: { statList?: ProfileStat[] };
}

export interface ProfileStat {
  type: string; name: string; value: number; statSecondList?: string[] | null;
}

export interface ProfileItem {
  id: number; name: string; grade: string; icon: string; enchantLevel: number; exceedLevel?: number; slotPos: number; slotPosName: string;
}

export interface ProfileSkill {
  id: number; name: string; category: string; skillLevel: number; needLevel: number; acquired: number; equip: number; icon: string;
}

export interface ProfileEquipment {
  skill?: { skillList?: ProfileSkill[] };
  equipment?: { equipmentList?: ProfileItem[] };
  petwing?: {
    pet?: { id: number; name: string; level: number; icon: string } | null;
    wing?: { id: number; name: string; grade: string; enchantLevel: number; icon: string } | null;
  };
}

/** A player the game named around you. */
export interface SeenPlayer {
  name: string; class: ClassName | null; seen_ms: number; fighting: boolean;
}

/** A build kept to compare against. */
export interface Reference {
  id: string; label: string; profile: Profile;
}

export interface BoardNode {
  nodeId: number; row: number; col: number; open: number; grade: string; type: string; name: string; effectList: { desc: string }[];
}

export interface BoardDetail {
  nodeList?: BoardNode[];
  openStatEffectList?: { desc: string }[];
  openSkillEffectList?: { desc: string }[];
}

export interface Hit {
  character_id: string; name: string; level: number; server_id: number; server_name: string; race: number; pc_id: number;
}

export interface Saved {
  settings: Settings;
  pets: Record<string, { pets: Record<string, PetProgress> }>;
  profile: Profile | null;
  /** The pets overlay's queue by server: newest first. */
  pet_queue: Record<string, { pets: number[]; last: number | null }>;
  /** DPS recordings, newest first. */
  fights: Fight[];
  /** When the DPS overlay was last cleared, in ms. */
  dps_cleared_ms: number;
  /** Saved builds, newest first. */
  references: Reference[];
}

export type Period = "daily" | "weekly";

export interface ChecklistTask {
  id: string; name: string; period: Period;
  /** How many times a period it can be done. */
  times: number;
}

export interface ChecklistCharacter {
  id: string; name: string;
  /** Task ids this character doesn't do. */
  skip: string[];
}

/** The checklist, with what counts since the last resets. */
export interface ChecklistView {
  tasks: ChecklistTask[];
  characters: ChecklistCharacter[];
  /** Times done by character id, then task id (missing: 0). */
  counts: Record<string, Record<string, number>>;
  /** When each period last reset, unix ms. */
  resets: { daily_ms: number; weekly_ms: number };
  /** Names to offer for a new character. */
  known: string[];
}

export interface TimerRow {
  id: string;
  kind: "event" | "boss" | "reset" | "field-boss";
  name: string;
  also: string[];
  where: string[];
  level: number | null;
  up: boolean;
  start_ms: number | null;
  end_ms: number | null;
  leads: number[];
}

export interface Alarm {
  id: string;
  name: string;
  lead: number;
  start_ms: number;
}

export interface SoulSeen {
  pet: number;
  amount: number;
  at_ms: number;
}

/** A pet's farming pace in its latest run (see `pets::pace`). */
export interface Pace {
  pet: number;
  souls: number;
  span_ms: number;
  last_ms: number;
  per_hour: number;
  /** Time to level 3 at this pace; null once there. */
  to_max_ms: number | null;
}

export interface CaptureStatus {
  running: boolean;
  error: string | null;
  devices: string[];
  locked: boolean;
  last_event_ms: number;
}

export const ALARM_LEADS = [60, 30, 15, 10, 5, 2, 1];

export const getTimers = () => invoke<TimerRow[]>("get_timers");
export const getSaved = () => invoke<Saved>("get_saved");
export const setSettings = (settings: Settings) => invoke("set_settings", { settings });
export const setAlarm = (id: string, leads: number[]) => invoke("set_alarm", { id, leads });
export const setPet = (pet: number, level: number, points: number) => invoke("set_pet", { pet, level, points });
export const setClickThrough = (on: boolean) => invoke("set_click_through", { on });
export const setHotkeys = (hotkeys: Hotkeys) => invoke("set_hotkeys", { hotkeys });
export const pauseHotkeys = (paused: boolean) => invoke("pause_hotkeys", { paused });
export const hotkeysStatus = () => invoke<string | null>("hotkeys_status");
export const captureStatus = () => invoke<CaptureStatus>("capture_status");
export const getSouls = () => invoke<SoulSeen[]>("get_souls");
export const getPaces = () => invoke<Pace[]>("get_paces");
export const searchCharacters = (name: string) => invoke<Hit[]>("search_characters", { name });
export const loadProfile = (serverId?: number, characterId?: string) => invoke("load_profile", { serverId, characterId });
export const clearProfile = () => invoke("clear_profile");
export const gameData = <T>(name: "skill-points" | "daevanion" | "skills") => invoke<T>("game_data", { name });
export const dpsLive = () => invoke<Fight | null>("dps_live");
export const dpsStart = () => invoke("dps_start");
export const dpsStop = () => invoke("dps_stop");
export const dpsClear = () => invoke("dps_clear");
/** Rename the recording under way (no id) or a saved one. */
export const dpsRename = (id: string | null, name: string) => invoke("dps_rename", { id, name });
export const dpsDelete = (id: string) => invoke("dps_delete", { id });
export const bossHistory = () => invoke<BossHistory[]>("boss_history");
export const dpsCompare = (id: string) => invoke<Comparison | null>("dps_compare", { id });
/** Save a recording's PNG to Pictures/Kiskwatch; returns where it went. */
export const dpsSaveImage = async (name: string, png: Blob) => invoke<string>("dps_save_image", { name, png: Array.from(new Uint8Array(await png.arrayBuffer())) });
export const nearbyPlayers = () => invoke<SeenPlayer[]>("nearby_players");
/** A player by name anywhere in the region: exact names, your server first. */
export const findPlayer = (name: string) => invoke<Hit[]>("find_player", { name });
/** Someone's profile, not followed. */
export const inspectProfile = (serverId: number, characterId: string) => invoke<Profile>("inspect_profile", { serverId, characterId });
export const saveReference = (profile: Profile, label: string) => invoke<string>("save_reference", { profile, label });
export const renameReference = (id: string, label: string) => invoke("rename_reference", { id, label });
export const deleteReference = (id: string) => invoke("delete_reference", { id });
export { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
export const getChecklist = () => invoke<ChecklistView>("get_checklist");
export const checklistMark = (character: string, task: string, count: number) => invoke("checklist_mark", { character, task, count });
export const checklistEdit = (tasks: ChecklistTask[], characters: ChecklistCharacter[]) => invoke("checklist_edit", { tasks, characters });

export const onStateChanged = (f: () => void) => listen("state-changed", f);
export const onDpsChanged = (f: () => void) => listen("dps-changed", f);
/** Only this window's notes: the app sends each to one overlay. */
export const onToast = (f: (text: string) => void) => getCurrentWebviewWindow().listen<string>("toast", (e) => f(e.payload));
export const onChecklistChanged = (f: () => void) => listen("checklist-changed", f);
export const onAlarm = (f: (a: Alarm) => void) => listen<Alarm>("alarm", (e) => f(e.payload));

/** "2d 04h", "1h 05m", "4m 09s", "agora". */
export function countdown(ms: number): string {
  if (ms <= 0) return "agora";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (d > 0) return `${d}d ${pad(h)}h`;
  if (h > 0) return `${h}h ${pad(m)}m`;
  return `${m}m ${pad(sec)}s`;
}
