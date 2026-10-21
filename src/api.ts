// The app's commands and events, typed.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface Settings {
  server_id: number;
  alarms: Record<string, number[]>;
  click_through: boolean;
}

export interface PetProgress {
  level: number;
  points: number;
}

export interface Saved {
  settings: Settings;
  pets: Record<string, { pets: Record<string, PetProgress> }>;
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
export const ingestHex = (hex: string) => invoke<number>("ingest_hex", { hex });

export const onStateChanged = (f: () => void) => listen("state-changed", f);
export const onAlarm = (f: (a: Alarm) => void) => listen<Alarm>("alarm", (e) => f(e.payload));

/** "1h 05m", "4m 09s", "agora". */
export function countdown(ms: number): string {
  if (ms <= 0) return "agora";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return `${h}h ${pad(m)}m`;
  return `${m}m ${pad(sec)}s`;
}
