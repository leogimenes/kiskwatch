// A recording drawn as a PNG to paste in Discord: the same rows as the DPS
// tab, for the chosen target and bars, on a dark card that reads on its own.
import { DpsBars, Fight } from "./api";
import { BARS, Row, TARGETS, Target, bossTime, clock, rows, secondsFor, short } from "./dpsView";
import { bossName } from "./bossHistory";

const W = 640;
const PAD = 20;
const ROW = 44;
const HEAD = 78;
const FOOT = 34;
/** Drawn at twice the size so it stays sharp when Discord zooms it. */
const SCALE = 2;
const FONT = '"Segoe UI", system-ui, sans-serif';
const BG = "#16191f";
const TEXT = "#e8ecf2";
const MUTED = "#8d99ab";
const HEAL = "#6fd06f";

const when = (ms: number) => new Date(ms).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** The class shields, loaded once. */
const shields = new Map<string, Promise<HTMLImageElement | null>>();
function shieldImage(name: string) {
  let p = shields.get(name);
  if (!p) {
    p = new Promise((done) => {
      const img = new Image();
      img.onload = () => done(img);
      img.onerror = () => done(null);
      img.src = `/classes/${name}.png`;
    });
    shields.set(name, p);
  }
  return p;
}

/** Cut text to fit `max` pixels, with an ellipsis. */
function fit(g: CanvasRenderingContext2D, text: string, max: number) {
  if (g.measureText(text).width <= max) return text;
  let t = text;
  while (t && g.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}

function rounded(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

async function drawRow(g: CanvasRenderingContext2D, r: Row, name: string, y: number, bars: DpsBars, top: number) {
  const x = PAD, w = W - 2 * PAD, h = ROW - 6;
  rounded(g, x, y, w, h, 6);
  g.save();
  g.globalAlpha = 0.16;
  g.fillStyle = r.color;
  g.fill();
  g.restore();
  if (r.player.local) {
    g.strokeStyle = r.color;
    g.lineWidth = 1;
    g.stroke();
  }
  g.save();
  rounded(g, x, y, w, h, 6);
  g.clip();
  g.fillStyle = r.color;
  g.fillRect(x, y, 4, h);
  g.restore();
  g.fillStyle = r.color;

  const img = r.player.class ? await shieldImage(r.player.class) : null;
  if (img) g.drawImage(img, x + 12, y + 5, 20, 20);
  else {
    g.beginPath();
    g.arc(x + 22, y + 15, 5, 0, Math.PI * 2);
    g.fill();
  }

  const unit = bars === "heal" ? "/s cura" : "/s";
  const nums = `${short(r.total)} · ${short(r.rate)}${unit} · ${Math.round(r.share * 100)}%`;
  g.font = `14px ${FONT}`;
  g.textBaseline = "middle";
  g.textAlign = "right";
  g.fillStyle = TEXT;
  g.fillText(nums, x + w - 10, y + 15);
  const numsWidth = g.measureText(nums).width;
  g.textAlign = "left";
  g.font = `600 15px ${FONT}`;
  g.fillStyle = r.color;
  g.fillText(fit(g, name, w - 60 - numsWidth), x + 40, y + 15);

  const tx = x + 12, ty = y + h - 9, tw = w - 22, th = 5;
  const width = (n: number) => (top ? (tw * n) / top : 0);
  rounded(g, tx, ty, tw, th, 3);
  g.fillStyle = "rgba(255, 255, 255, 0.1)";
  g.fill();
  g.save();
  g.clip();
  if (bars === "both") {
    g.fillStyle = r.color;
    g.fillRect(tx, ty, width(r.damage), th);
    g.fillStyle = HEAL;
    g.fillRect(tx + width(r.damage), ty, width(r.heal), th);
  } else {
    g.fillStyle = bars === "heal" ? HEAL : r.color;
    g.fillRect(tx, ty, width(r.total), th);
  }
  g.restore();
}

/** The recording as a PNG. With `hideNames`, only you keep your name: the
 *  others are "Jogador 2", "Jogador 3"… in the order of the bars, so an image
 *  passed around names no one who didn't agree to it. */
export async function fightImage(f: Fight, target: Target, bars: DpsBars, hideNames: boolean): Promise<Blob> {
  const list = rows(f, target, bars);
  const top = list.reduce((n, r) => Math.max(n, r.total), 0);
  const h = HEAD + Math.max(1, list.length) * ROW + FOOT;
  const canvas = document.createElement("canvas");
  canvas.width = W * SCALE;
  canvas.height = h * SCALE;
  const g = canvas.getContext("2d")!;
  g.scale(SCALE, SCALE);

  g.fillStyle = BG;
  g.fillRect(0, 0, W, h);

  g.textBaseline = "alphabetic";
  g.textAlign = "left";
  g.fillStyle = TEXT;
  g.font = `600 19px ${FONT}`;
  g.fillText(fit(g, f.name, W - 2 * PAD), PAD, 34);
  const label = (options: [string, string][], v: string) => options.find(([k]) => k === v)?.[1] ?? v;
  const total = list.reduce((n, r) => n + r.total, 0);
  const secs = secondsFor(f, target);
  const boss = bossTime(f, target);
  g.font = `13px ${FONT}`;
  g.fillStyle = MUTED;
  g.fillText(fit(g, `${when(f.started_ms)} · ${clock(f.ended_ms - f.started_ms)}${boss ? ` (${clock(boss)} no chefe)` : ` (${clock(secs * 1000)} em combate)`} · ${typeof target === "number" ? bossName(target) : label(TARGETS, target)} · ${label(BARS, bars)} · ${short(total)} no grupo (${short(total / secs)}/s)`, W - 2 * PAD), PAD, 56);

  let y = HEAD;
  if (!list.length) {
    g.fillText("Nada para este alvo.", PAD, y + 20);
  }
  let other = 1;
  for (const r of list) {
    const name = hideNames && !r.player.local ? `Jogador ${++other}` : r.player.name;
    await drawRow(g, r, name, y, bars, top);
    y += ROW;
  }

  g.font = `12px ${FONT}`;
  g.fillStyle = MUTED;
  g.textBaseline = "middle";
  g.textAlign = "right";
  g.fillText("Kiskwatch · AION 2", W - PAD, h - FOOT / 2);

  return new Promise((done, fail) => canvas.toBlob((b) => (b ? done(b) : fail(new Error("canvas vazio"))), "image/png"));
}
