// The accessibility settings, applied to whichever window loads this.
import { Accessibility } from "./api";

export function applyLook(a: Accessibility) {
  const root = document.documentElement;
  // Zoom scales text, spacing and controls together.
  root.style.zoom = String(a.font_scale / 100);
  root.style.setProperty("--overlay-alpha", String(a.overlay_opacity / 100));
  root.classList.toggle("contrast", a.high_contrast);
  root.classList.toggle("calm", a.reduce_motion);
  root.classList.toggle("colorblind", a.colorblind);
}

/** A short two-tone chime, so no sound file has to ship. */
export function chime(a: Accessibility) {
  if (!a.sound || a.volume <= 0) return;
  const ctx = new AudioContext();
  const peak = 0.4 * (a.volume / 100);
  [880, 1320].forEach((f, i) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const at = ctx.currentTime + i * 0.18;
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
    o.connect(g).connect(ctx.destination);
    o.start(at);
    o.stop(at + 0.55);
  });
}
