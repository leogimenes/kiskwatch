// The app's commands and events, typed.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
  pinned_pets: number[];
  route: RouteStop[];
  a11y: Accessibility;
}

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
}

export interface ProfileSkill {
  id: number; name: string; category: string; skillLevel: number; needLevel: number; acquired: number; equip: number; icon: string;
}

export interface ProfileEquipment {
  skill?: { skillList?: ProfileSkill[] };
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
export const captureStatus = () => invoke<CaptureStatus>("capture_status");
export const getSouls = () => invoke<SoulSeen[]>("get_souls");
export const searchCharacters = (name: string) => invoke<Hit[]>("search_characters", { name });
export const loadProfile = (serverId?: number, characterId?: string) => invoke("load_profile", { serverId, characterId });
export const clearProfile = () => invoke("clear_profile");
export const gameData = <T>(name: "skill-points" | "daevanion") => invoke<T>("game_data", { name });
export { openUrl } from "@tauri-apps/plugin-opener";

export const onStateChanged = (f: () => void) => listen("state-changed", f);
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
