"use client";

import { useEffect, useImperativeHandle, useRef, forwardRef } from "react";
import { GRAPH_SOURCES, SOURCES, hexRgb, sourceDef } from "@/lib/jeff/sources";
import { linksFor } from "@/lib/jeff/retrieve";
import type { JeffDoc } from "@/lib/jeff/demo-data";
import { BRAIN_COLORS, BRAIN_POLICY, pulsePeriodMs, type SourceTone } from "@/lib/jeff/brain/policy";
import type { BrainStateLite } from "@/lib/jeff/brain/state";

/**
 * Jeff's neural network: a decorative 3-D point mesh shaped like a brain,
 * with real records rendered as interactive nodes. Ported from the prototype.
 *
 * The brain is also Jeff's heartbeat (spec §10–§11, §25): the centre core
 * pulses at a period set by the current state, affected sources take on a
 * tone colour (danger / warning / opportunity / stale), sources Jeff is
 * actually reading light up, and investigation shows particles flowing in.
 * Every colour and glow interpolates; nothing snaps. With reduced motion the
 * same information is shown statically.
 */

export interface BrainHandle {
  setZoom: (z: number) => void;
  getZoom: () => number;
  reset: () => void;
  pulse: () => void;
  resize: () => void;
}

interface Point {
  x: number;
  y: number;
  z: number;
  group: number;
  size: number;
  twinkle: number;
  inner?: boolean;
}

interface HitNode {
  x: number;
  y: number;
  id: string;
  title: string;
  source: string;
}

export interface BrainActivityLite {
  kind: "ask" | "scan" | "job" | null;
  sources: string[];
}

interface Props {
  docs: JeffDoc[];
  connected: string[];
  focus: string | null;
  motion: boolean;
  anchors: { id: string; x: number; y: number }[];
  active: boolean;
  onOpen: (id: string) => void;
  onZoom: (z: number) => void;
  onHover: (node: { title: string; x: number; y: number } | null) => void;
  /** What Jeff currently sees. Optional so the canvas still renders without state. */
  brain?: BrainStateLite | null;
  /** Live activity (chat retrieval, scan, job). */
  activity?: BrainActivityLite | null;
  /** Click/tap on the brain's centre. */
  onCenter?: () => void;
}

type RGB = [number, number, number];

/** Per-source visual tone, smoothly interpolated between frames. */
interface ToneMix {
  tone: SourceTone | null;
  toneRGB: RGB;
  blend: number; // 0 = source colour, 1 = tone colour
  targetBlend: number;
  dashed: boolean;
}

interface Particle {
  from: string | null;
  t: number;
  speed: number;
  jitter: number;
}

const TONE_PRIORITY: SourceTone[] = ["active", "danger", "warning", "opportunity", "stale", "neutral"];

function rgbOf(hex: string): RGB {
  return hexRgb(hex).split(",").map(Number) as RGB;
}
function mixRGB(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function rgba(c: RGB, a: number) {
  return `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}
function approach(cur: number, target: number, dt: number, ms: number) {
  if (ms <= 0) return target;
  const k = Math.min(1, dt / ms);
  return cur + (target - cur) * k;
}

const TONE_RGB: Record<SourceTone, RGB> = {
  danger: rgbOf(BRAIN_COLORS.danger),
  warning: rgbOf(BRAIN_COLORS.warning),
  opportunity: rgbOf(BRAIN_COLORS.opportunity),
  active: rgbOf(BRAIN_COLORS.active),
  stale: rgbOf(BRAIN_COLORS.stale),
  neutral: rgbOf(BRAIN_COLORS.neutral),
};
const JEFF_RGB = rgbOf(BRAIN_COLORS.jeff);
const JEFF_BRIGHT_RGB = rgbOf(BRAIN_COLORS.jeffBright);

/** Centre core colour for the ambient state (spec §10). */
export function centerToneFor(brain: BrainStateLite | null | undefined, investigating: boolean): { rgb: RGB; intensity: number } {
  if (investigating) return { rgb: JEFF_BRIGHT_RGB, intensity: 0.9 };
  if (!brain) return { rgb: JEFF_RGB, intensity: 0.35 };
  switch (brain.state) {
    case "attention":
      return brain.urgency === "urgent" ? { rgb: TONE_RGB.danger, intensity: 1 } : { rgb: TONE_RGB.warning, intensity: 0.75 };
    case "opportunity":
      return { rgb: TONE_RGB.opportunity, intensity: 0.6 };
    case "degraded":
      return { rgb: TONE_RGB.warning, intensity: 0.5 };
    case "investigating":
      return { rgb: JEFF_BRIGHT_RGB, intensity: 0.9 };
    default:
      return { rgb: JEFF_RGB, intensity: 0.35 };
  }
}

/** Resolve the tone each source should show right now (activity beats state tones). */
export function toneTargets(brain: BrainStateLite | null | undefined, activity: BrainActivityLite | null | undefined): Map<string, { tone: SourceTone; dashed: boolean }> {
  const out = new Map<string, { tone: SourceTone; dashed: boolean }>();
  const put = (id: string, tone: SourceTone, dashed = false) => {
    const cur = out.get(id);
    if (!cur || TONE_PRIORITY.indexOf(tone) < TONE_PRIORITY.indexOf(cur.tone)) out.set(id, { tone, dashed: dashed || (cur?.dashed ?? false) });
    else if (dashed) out.set(id, { ...cur, dashed: true });
  };
  for (const s of brain?.affectedSources ?? []) put(s.source, s.tone, s.dashed);
  for (const s of brain?.activeSources ?? []) put(s, "active");
  for (const s of activity?.sources ?? []) put(s, "active");
  return out;
}

export const BrainCanvas = forwardRef<BrainHandle, Props>(function BrainCanvas(props, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  const state = useRef({
    points: [] as Point[],
    edges: [] as [number, number][],
    zoom: 1,
    yaw: -0.16,
    pitch: 0.06,
    dragging: false,
    moved: 0,
    last: [0, 0] as [number, number],
    frame: 0,
    pulseAt: 0,
    pulseRGB: JEFF_RGB as RGB,
    hitNodes: [] as HitNode[],
    hover: null as string | null,
    drawn: 0,
    w: 0,
    h: 0,
    dpr: 1,
    // Heartbeat state (interpolated per frame).
    tones: new Map<string, ToneMix>(),
    centerRGB: JEFF_RGB as RGB,
    centerIntensity: 0.35,
    periodMs: BRAIN_POLICY.pulseMs.watching!,
    particles: [] as Particle[],
    lastTime: 0,
    reasonIds: null as Set<string> | null,
    settled: false,
  });

  useImperativeHandle(ref, () => ({
    setZoom: (z) => {
      state.current.zoom = Math.min(1.7, Math.max(0.55, z));
      state.current.drawn = 0;
      propsRef.current.onZoom(state.current.zoom);
    },
    getZoom: () => state.current.zoom,
    reset: () => {
      state.current.yaw = -0.16;
      state.current.pitch = 0.06;
      state.current.zoom = 1;
      state.current.drawn = 0;
      propsRef.current.onZoom(1);
    },
    pulse: () => {
      state.current.pulseAt = performance.now();
      state.current.pulseRGB = JEFF_RGB;
      state.current.drawn = 0;
    },
    resize: () => resize(),
  }));

  function makeMesh() {
    const s = state.current;
    s.points = [];
    s.edges = [];
    const rows = 26;
    const cols = 46;
    let seed = 48;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const groups = GRAPH_SOURCES.length;
    for (let side = 0; side < 2; side++) {
      const start = s.points.length;
      for (let r = 0; r <= rows; r++) {
        const theta = (Math.PI * (r + 0.28)) / (rows + 0.56);
        for (let c = 0; c < cols; c++) {
          const phi = (2 * Math.PI * c) / cols;
          const st = Math.sin(theta);
          const ct = Math.cos(theta);
          const fold = 1 + 0.085 * Math.sin(phi * 8 + theta * 6) + 0.045 * Math.cos(theta * 14 - phi * 3);
          const taper = ct < -0.2 ? 1 + (ct + 0.2) * 0.26 : 1;
          let lobe = (0.43 + 0.72 * st * Math.cos(phi) * fold) * taper;
          if (lobe < 0.06) lobe = 0.055 + Math.abs(lobe) * 0.07;
          const x = (side ? 1 : -1) * lobe;
          const y = ct * 0.98 * fold;
          const z = st * Math.sin(phi) * 0.68 * fold;
          const group = (Math.floor((theta / Math.PI) * 3) + (side ? 2 : 0) + Math.floor((phi / (2 * Math.PI)) * 2)) % groups;
          s.points.push({ x, y, z, group, size: 0.65 + rand() * 0.7, twinkle: rand() * 6.3 });
          if (c > 0) s.edges.push([s.points.length - 1, s.points.length - 2]);
          if (r > 0) s.edges.push([s.points.length - 1, s.points.length - 1 - cols]);
          if (c === cols - 1) s.edges.push([s.points.length - 1, start + r * cols]);
        }
      }
    }
    for (let i = 0; i < 260; i++) {
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand());
      const y = (rand() - 0.5) * 1.8;
      s.points.push({ x: Math.cos(a) * r * 0.64, y, z: Math.sin(a) * r * 0.54, group: i % groups, size: 0.45, twinkle: rand() * 6.3, inner: true });
    }
  }

  function resize() {
    const canvas = canvasRef.current;
    const s = state.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    s.w = rect.width;
    s.h = rect.height;
    if (!s.w || !s.h) return;
    s.dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = s.w * s.dpr;
    canvas.height = s.h * s.dpr;
    canvas.getContext("2d")?.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
    s.drawn = 0;
  }

  function project(p: Point, time: number) {
    const s = state.current;
    const yaw = s.yaw + (propsRef.current.motion && !s.dragging ? Math.sin(time * 0.00012) * 0.09 : 0);
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const cp = Math.cos(s.pitch);
    const sp = Math.sin(s.pitch);
    const x = p.x * cy + p.z * sy;
    const z = -p.x * sy + p.z * cy;
    const y = p.y * cp - z * sp;
    const zz = p.y * sp + z * cp;
    const scale = Math.min(s.w * 0.3, s.h * 0.405) * s.zoom;
    const perspective = 3.8 / (3.8 - zz);
    return { x: s.w * 0.5 + x * scale * perspective, y: s.h * 0.46 - y * scale * perspective, z: zz, scale: perspective };
  }

  /** Advance every interpolated visual value toward its target (spec §25). */
  function step(time: number) {
    const s = state.current;
    const { brain, activity, motion } = propsRef.current;
    const dt = s.lastTime ? Math.min(100, time - s.lastTime) : 16;
    s.lastTime = time;
    const instant = !motion || !s.settled; // first frame and reduced motion: no transition
    const lerpMs = instant ? 0 : BRAIN_POLICY.colorLerpMs;

    const targets = toneTargets(brain, activity);
    for (const [id, t] of targets) {
      const cur = s.tones.get(id);
      if (!cur) s.tones.set(id, { tone: t.tone, toneRGB: TONE_RGB[t.tone], blend: instant ? 1 : 0, targetBlend: 1, dashed: t.dashed });
      else {
        cur.tone = t.tone;
        cur.targetBlend = 1;
        cur.dashed = t.dashed;
        cur.toneRGB = instant ? TONE_RGB[t.tone] : mixRGB(cur.toneRGB, TONE_RGB[t.tone], Math.min(1, dt / BRAIN_POLICY.colorLerpMs));
      }
    }
    for (const [id, cur] of s.tones) {
      if (!targets.has(id)) {
        cur.targetBlend = 0;
        cur.dashed = false;
      }
      cur.blend = approach(cur.blend, cur.targetBlend, dt, lerpMs);
      if (cur.targetBlend === 0 && cur.blend < 0.01) s.tones.delete(id);
    }

    const investigating = !!activity?.kind;
    const ct = centerToneFor(brain, investigating);
    const haloMs = instant ? 0 : BRAIN_POLICY.haloLerpMs;
    s.centerRGB = haloMs ? mixRGB(s.centerRGB, ct.rgb, Math.min(1, dt / haloMs)) : ct.rgb;
    s.centerIntensity = approach(s.centerIntensity, ct.intensity, dt, haloMs);
    const quiet = !propsRef.current.connected.length;
    const target = investigating ? BRAIN_POLICY.pulseMs.investigating! : pulsePeriodMs(brain?.state ?? "watching", brain?.urgency ?? "normal", quiet);
    s.periodMs = approach(s.periodMs, target, dt, haloMs);

    // Particles only while investigating and only with motion; fewer on small screens.
    const mobile = s.w < 640;
    const max = investigating && motion ? (mobile ? 8 : 22) : 0;
    const from = activity?.sources.length ? activity.sources : [null];
    while (s.particles.length < max) s.particles.push({ from: from[Math.floor(Math.random() * from.length)] ?? null, t: Math.random(), speed: 0.00035 + Math.random() * 0.00045, jitter: (Math.random() - 0.5) * 0.4 });
    if (s.particles.length > max) s.particles.length = max;
    for (const p of s.particles) {
      p.t += p.speed * dt;
      if (p.t > 1) {
        p.t = 0;
        p.from = from[Math.floor(Math.random() * from.length)] ?? null;
        p.jitter = (Math.random() - 0.5) * 0.4;
      }
    }
    s.settled = true;
  }

  function toneFor(id: string): ToneMix | undefined {
    return state.current.tones.get(id);
  }

  function draw(time: number) {
    const canvas = canvasRef.current;
    const s = state.current;
    const c = canvas?.getContext("2d");
    if (!canvas || !c) return;
    step(time);
    const { docs, connected: ids, focus: focused, anchors, motion, activity } = propsRef.current;
    const w = s.w;
    const h = s.h;
    const cx = w * 0.5;
    const cy = h * 0.46;
    c.clearRect(0, 0, w, h);
    const colorRGB = GRAPH_SOURCES.map((p) => rgbOf(p.color));
    const pos = s.points.map((p) => project(p, time));

    // Heartbeat: 0..1 within the current period; urgent beats are sharper.
    const phase = motion ? (time % s.periodMs) / s.periodMs : 0.5;
    const beatRaw = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
    const beat = s.periodMs < 3000 ? beatRaw * beatRaw : beatRaw;

    c.save();
    c.lineWidth = 0.45;
    for (let gi = 0; gi < GRAPH_SOURCES.length; gi++) {
      const sid = GRAPH_SOURCES[gi]!.id;
      const active = ids.includes(sid);
      const dim = focused && focused !== sid;
      const tone = toneFor(sid);
      c.beginPath();
      for (const [i, j] of s.edges) {
        if (s.points[i]!.group !== gi) continue;
        if (pos[i]!.z < -0.4) continue;
        c.moveTo(pos[i]!.x, pos[i]!.y);
        c.lineTo(pos[j]!.x, pos[j]!.y);
      }
      // Inactive connections are neutral (#202026); active ones carry a restrained source tint, shifted toward the tone when affected.
      if (active) {
        const col = tone ? mixRGB(colorRGB[gi]!, tone.toneRGB, tone.blend * 0.9) : colorRGB[gi]!;
        const lift = tone ? tone.blend * (tone.tone === "active" ? 0.16 : 0.08) : 0;
        c.strokeStyle = rgba(col, dim ? 0.03 : 0.11 + lift);
      } else c.strokeStyle = "rgba(32,32,38,0.9)";
      c.stroke();
    }
    for (let i = 0; i < s.points.length; i++) {
      const p = s.points[i]!;
      const pt = pos[i]!;
      const sid = GRAPH_SOURCES[p.group]!.id;
      const active = ids.includes(sid);
      const dim = focused && focused !== sid;
      const depth = (pt.z + 0.85) / 1.7;
      let alpha = (0.24 + depth * 0.69) * (p.inner ? 0.34 : 1) * (active ? 1 : 0.12) * (dim ? 0.19 : 1);
      if (motion) alpha *= 0.91 + 0.09 * Math.sin(time * 0.001 + p.twinkle);
      // Inactive nodes are neutral (#45454D); active nodes use their source tint, shifted toward the tone when affected.
      if (active) {
        const tone = toneFor(sid);
        const col = tone ? mixRGB(colorRGB[p.group]!, tone.toneRGB, tone.blend * 0.9) : colorRGB[p.group]!;
        const lift = tone ? tone.blend * (tone.tone === "active" ? 0.22 : 0.1) : 0;
        c.fillStyle = rgba(col, Math.max(0.02, Math.min(0.9, alpha + lift)));
      } else c.fillStyle = `rgba(69,69,77,${Math.max(0.03, Math.min(0.45, alpha * 0.6))})`;
      c.beginPath();
      c.arc(pt.x, pt.y, p.size * (0.65 + depth * 0.5), 0, Math.PI * 2);
      c.fill();
    }
    s.hitNodes = [];
    docs.slice(0, 130).forEach((d, i) => {
      const gi = Math.max(0, SOURCES.findIndex((p) => p.id === d.source));
      let index = (i * 83 + 211 + gi * 91) % s.points.length;
      let tries = 0;
      while ((s.points[index]!.group !== gi % GRAPH_SOURCES.length || pos[index]!.z < -0.06) && tries++ < 200) index = (index + 13) % s.points.length;
      const p = pos[index]!;
      const dim = focused && focused !== d.source;
      const tone = toneFor(d.source);
      const colour = tone ? rgba(mixRGB(rgbOf(sourceDef(d.source).color), tone.toneRGB, tone.blend * 0.9), 1) : sourceDef(d.source).color;
      c.globalAlpha = dim ? 0.12 : 1;
      c.shadowColor = colour;
      c.shadowBlur = 8;
      c.fillStyle = colour;
      c.beginPath();
      c.arc(p.x, p.y, s.hover === d.id ? 4 : 2.15, 0, Math.PI * 2);
      c.fill();
      c.shadowBlur = 0;
      c.globalAlpha = dim ? 0.08 : 0.25;
      c.beginPath();
      c.arc(p.x, p.y, 5, 0, Math.PI * 2);
      c.strokeStyle = colour;
      c.lineWidth = 0.55;
      c.stroke();
      s.hitNodes.push({ x: p.x, y: p.y, id: d.id, title: d.title, source: d.source });
      c.globalAlpha = 1;
    });
    for (const [a, b] of linksFor(docs).slice(0, 30)) {
      const pa = s.hitNodes.find((p) => p.id === a);
      const pb = s.hitNodes.find((p) => p.id === b);
      if (!pa || !pb) continue;
      c.strokeStyle = focused ? "rgba(77,163,255,0.14)" : "rgba(77,163,255,0.2)";
      c.lineWidth = 0.65;
      c.beginPath();
      c.moveTo(pa.x, pa.y);
      c.quadraticCurveTo(w * 0.5, h * 0.4, pb.x, pb.y);
      c.stroke();
    }

    // Anchor paths. Affected sources pulse along the path: attention flows inward, opportunity outward (§11).
    const bez = (x: number, y: number, tx: number, ty: number, tt: number) => {
      const mt = 1 - tt;
      const mx = (x + tx) / 2;
      return {
        x: mt * mt * mt * x + 3 * mt * mt * tt * mx + 3 * mt * tt * tt * mx + tt * tt * tt * tx,
        y: mt * mt * mt * y + 3 * mt * mt * tt * y + 3 * mt * tt * tt * ty + tt * tt * tt * ty,
      };
    };
    for (const a of anchors) {
      const target = s.hitNodes.find((n) => n.source === a.id) ?? { x: cx, y: h * 0.48 };
      const x = a.x * w;
      const y = a.y * h;
      const tx = target.x;
      const ty = target.y;
      const dim = focused && focused !== a.id;
      const tone = toneFor(a.id);
      const base = rgbOf(sourceDef(a.id).color);
      const col = tone ? mixRGB(base, tone.toneRGB, tone.blend) : base;
      const degraded = !!tone && tone.dashed && tone.blend > 0.5;
      const strength = tone ? tone.blend : 0;
      c.strokeStyle = rgba(col, 1);
      c.globalAlpha = dim ? 0.04 : degraded ? 0.12 : 0.24 + strength * 0.3;
      c.lineWidth = 0.7 + strength * 0.4;
      c.setLineDash(degraded ? [1, 6] : [2, 4]);
      c.beginPath();
      c.moveTo(x, y);
      c.bezierCurveTo((x + tx) / 2, y, (x + tx) / 2, ty, tx, ty);
      c.stroke();
      c.setLineDash([]);
      if (degraded) {
        // Small warning marker on a source Jeff can't see properly.
        const m = bez(x, y, tx, ty, 0.35);
        c.globalAlpha = dim ? 0.1 : 0.85;
        c.fillStyle = BRAIN_COLORS.warning;
        c.beginPath();
        c.arc(m.x, m.y, 2.2, 0, Math.PI * 2);
        c.fill();
        c.globalAlpha = 1;
        continue;
      }
      c.globalAlpha = dim ? 0.08 : 0.75;
      const speed = tone && tone.tone === "active" ? 0.00032 : tone && tone.blend > 0.5 ? 0.0002 : 0.00013;
      let tt = motion ? (time * speed + ids.indexOf(a.id) * 0.13) % 1 : 0.65;
      if (tone && tone.tone === "opportunity" && tone.blend > 0.5) tt = 1 - tt; // outward: from the brain to the source
      const b = bez(x, y, tx, ty, tt);
      c.fillStyle = rgba(col, 1);
      c.shadowColor = rgba(col, 1);
      c.shadowBlur = 8 + strength * 6;
      c.beginPath();
      c.arc(b.x, b.y, 1.8 + strength * 0.6, 0, Math.PI * 2);
      c.fill();
      c.shadowBlur = 0;
      c.globalAlpha = 1;
    }

    // Investigating: particles flow from the sources being read toward the centre.
    if (s.particles.length) {
      const activeRGB = TONE_RGB.active;
      for (const p of s.particles) {
        const a = p.from ? anchors.find((x) => x.id === p.from) : null;
        let sx: number;
        let sy: number;
        if (a) {
          sx = a.x * w;
          sy = a.y * h;
        } else {
          // No known source: originate from the mesh rim so nothing is fabricated as "read".
          const ang = p.jitter * 8 + p.speed * 9000;
          sx = cx + Math.cos(ang) * w * 0.28;
          sy = cy + Math.sin(ang) * h * 0.34;
        }
        const t = p.t;
        const mx = (sx + cx) / 2 + p.jitter * 40;
        const my = (sy + cy) / 2 - p.jitter * 40;
        const mt = 1 - t;
        const px = mt * mt * sx + 2 * mt * t * mx + t * t * cx;
        const py = mt * mt * sy + 2 * mt * t * my + t * t * cy;
        c.fillStyle = rgba(activeRGB, 0.15 + 0.6 * Math.sin(t * Math.PI));
        c.beginPath();
        c.arc(px, py, 1.3, 0, Math.PI * 2);
        c.fill();
      }
    }

    // Centre core: Jeff's heartbeat. Radius/alpha follow the beat; colour follows the state.
    {
      const inv = !!activity?.kind;
      const r = 14 + beat * 10 + s.centerIntensity * 6;
      const g = c.createRadialGradient(cx, cy, 0, cx, cy, r * 2.4);
      const a0 = 0.1 + beat * 0.14 + s.centerIntensity * 0.12;
      g.addColorStop(0, rgba(s.centerRGB, a0));
      g.addColorStop(0.45, rgba(s.centerRGB, a0 * 0.35));
      g.addColorStop(1, rgba(s.centerRGB, 0));
      c.fillStyle = g;
      c.beginPath();
      c.arc(cx, cy, r * 2.4, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = rgba(s.centerRGB, 0.55 + beat * 0.35);
      c.shadowColor = rgba(s.centerRGB, 1);
      c.shadowBlur = 10 + beat * 8;
      c.beginPath();
      c.arc(cx, cy, 2.6 + beat * 1.1 + (inv ? 0.6 : 0), 0, Math.PI * 2);
      c.fill();
      c.shadowBlur = 0;
    }

    const elapsed = time - s.pulseAt;
    if (s.pulseAt && elapsed < BRAIN_POLICY.newReasonPulseMs) {
      const p = elapsed / BRAIN_POLICY.newReasonPulseMs;
      c.strokeStyle = rgba(s.pulseRGB, (1 - p) * 0.3);
      c.lineWidth = 1;
      c.beginPath();
      c.ellipse(w / 2, h * 0.46, 40 + p * w * 0.45, 40 + p * h * 0.48, 0, 0, Math.PI * 2);
      c.stroke();
    }
    c.restore();
  }

  function nodeAt(e: { clientX: number; clientY: number }) {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const focus = propsRef.current.focus;
    return state.current.hitNodes
      .filter((n) => !focus || n.source === focus)
      .map((n) => ({ ...n, dist: Math.hypot(n.x - x, n.y - y) }))
      .sort((a, b) => a.dist - b.dist)
      .find((n) => n.dist < 12);
  }

  function nearCenter(e: { clientX: number; clientY: number }) {
    const canvas = canvasRef.current;
    if (!canvas) return false;
    const r = canvas.getBoundingClientRect();
    const s = state.current;
    return Math.hypot(e.clientX - r.left - s.w * 0.5, e.clientY - r.top - s.h * 0.46) < 30;
  }

  useEffect(() => {
    makeMesh();
    resize();
    const canvas = canvasRef.current!;
    const ro = new ResizeObserver(() => resize());
    if (canvas.parentElement) ro.observe(canvas.parentElement);
    let raf = 0;
    const animate = (t: number) => {
      raf = requestAnimationFrame(animate);
      const s = state.current;
      if (document.hidden || !propsRef.current.active || !s.w) return;
      if (!propsRef.current.motion && s.drawn && t - s.pulseAt > 2000) return;
      if (propsRef.current.motion && t - s.frame < 32) return;
      s.frame = t;
      draw(t);
      s.drawn++;
    };
    raf = requestAnimationFrame(animate);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Redraw when data changes.
  useEffect(() => {
    state.current.drawn = 0;
  }, [props.docs, props.connected, props.focus, props.anchors, props.motion, props.brain, props.activity]);

  // One-time outward pulse when a NEW reason appears (client diff, never on first load) — spec §11.
  useEffect(() => {
    const s = state.current;
    const ids = props.brain?.reasonIds ?? [];
    const next = new Set(ids);
    if (s.reasonIds) {
      const fresh = ids.filter((id) => !s.reasonIds!.has(id));
      if (fresh.length && props.motion) {
        const b = props.brain;
        const tone = b?.state === "attention" ? (b.urgency === "urgent" ? TONE_RGB.danger : TONE_RGB.warning) : b?.state === "opportunity" ? TONE_RGB.opportunity : b?.state === "degraded" ? TONE_RGB.warning : JEFF_RGB;
        s.pulseAt = performance.now();
        s.pulseRGB = tone;
        s.drawn = 0;
      }
    }
    s.reasonIds = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.brain]);

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label="Interactive brain-shaped network. Use the source buttons to filter, the memory list to open documents, and the zoom controls to explore."
      onPointerDown={(e) => {
        const s = state.current;
        s.dragging = true;
        s.moved = 0;
        s.last = [e.clientX, e.clientY];
        (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const s = state.current;
        if (s.dragging) {
          const dx = e.clientX - s.last[0];
          const dy = e.clientY - s.last[1];
          s.yaw += dx * 0.007;
          s.pitch = Math.max(-0.55, Math.min(0.55, s.pitch + dy * 0.006));
          s.moved += Math.abs(dx) + Math.abs(dy);
          s.last = [e.clientX, e.clientY];
          s.drawn = 0;
        } else {
          const n = nodeAt(e);
          s.hover = n?.id ?? null;
          propsRef.current.onHover(n ? { title: n.title, x: n.x, y: n.y } : null);
          (e.target as HTMLCanvasElement).style.cursor = n ? "pointer" : propsRef.current.onCenter && nearCenter(e) ? "pointer" : "grab";
          s.drawn = 0;
        }
      }}
      onPointerUp={(e) => {
        const s = state.current;
        s.dragging = false;
        if (s.moved < 5) {
          const n = nodeAt(e);
          if (n) propsRef.current.onOpen(n.id);
          else if (propsRef.current.onCenter && nearCenter(e)) propsRef.current.onCenter();
        }
      }}
      onPointerCancel={() => (state.current.dragging = false)}
      onPointerLeave={() => {
        state.current.hover = null;
        propsRef.current.onHover(null);
      }}
      onWheel={(e) => {
        const s = state.current;
        s.zoom = Math.min(1.7, Math.max(0.55, s.zoom + (e.deltaY < 0 ? 0.08 : -0.08)));
        s.drawn = 0;
        propsRef.current.onZoom(s.zoom);
      }}
    />
  );
});
