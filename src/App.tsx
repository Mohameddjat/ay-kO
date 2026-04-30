import React, { useEffect, useRef, useState, useMemo } from 'react';
import Matter from 'matter-js';
import { motion, AnimatePresence } from 'motion/react';
import { 
  doc, 
  onSnapshot, 
  setDoc, 
  updateDoc, 
  collection, 
  deleteDoc, 
  getDoc,
  getDocs,
  serverTimestamp,
  increment,
  query,
  where,
  orderBy,
  limit
} from 'firebase/firestore';
import { onAuthStateChanged } from 'firebase/auth';
import { db, auth } from './lib/firebase';
import { 
  Settings, 
  Play, 
  RotateCcw, 
  Thermometer, 
  Zap, 
  AlertTriangle, 
  Users, 
  Trophy,
  ShoppingCart,
  Coins,
  Flame,
  Wind,
  Check,
  ChevronLeft,
  ChevronRight,
  X,
  Shield,
  Magnet,
  Rocket,
  Gauge,
  Disc,
  Sparkles,
  Battery,
  Wrench
} from 'lucide-react';
import { Gear, PlayerState, GameRoom } from './types';
import { audioBus } from './lib/audio';

const GRID_COLS = 6;
const GRID_ROWS = 2;
const CELL_SIZE = 60;

// 4-speed gearbox defaults: low gear = small ratio (high accel, low top speed),
// high gear = big ratio (low accel, high top speed).
const DEFAULT_GEARBOX: number[] = [0.55, 0.85, 1.20, 1.65];
const GEARBOX_OPTIONS = [0.4, 0.55, 0.7, 0.85, 1.0, 1.2, 1.4, 1.65, 1.9, 2.2];

// Mechanical tuning — each slider goes 1..5 (3 = stock).
// The interpretation is in `applyTuning` further below.
type Tuning = {
  tires: number;    // grip: lane responsiveness + near-miss window
  brakes: number;   // braking power + brake heat
  cooling: number;  // engine cooling rate
  turbo: number;    // boost duration & top-end power
  chassis: number;  // weight: lower = better accel, higher = slope resilience
};
const DEFAULT_TUNING: Tuning = { tires: 3, brakes: 3, cooling: 3, turbo: 3, chassis: 3 };

// Procedural slope along the track (returns radians, ~ -0.18 to +0.18).
const slopeAt = (z: number) => {
  return Math.sin(z * 0.0011) * 0.11 + Math.sin(z * 0.00037) * 0.07;
};
const GEAR_TYPES = [16, 24, 32, 48, 64, 80, 96, 128];
const TRACK_LENGTH = 100000;

// Audio System — multi-oscillator engine + richer SFX
class SoundManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private engineParts: { oscs: OscillatorNode[]; gain: GainNode; filter: BiquadFilterNode; lfo: OscillatorNode; lfoGain: GainNode } | null = null;

  init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.7;
    this.master.connect(this.ctx.destination);
  }

  private dest() {
    return this.master || this.ctx!.destination;
  }

  playClick() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(1200, t);
    osc.frequency.exponentialRampToValueAtTime(600, t + 0.06);
    gain.gain.setValueAtTime(0.08, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    osc.connect(gain);
    gain.connect(this.dest());
    osc.start(t);
    osc.stop(t + 0.1);
  }

  playBoost() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    // Saw sweep
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(1100, t + 0.45);
    gain.gain.setValueAtTime(0.12, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.setValueAtTime(900, t);
    filt.Q.value = 6;
    osc.connect(filt);
    filt.connect(gain);
    gain.connect(this.dest());
    osc.start(t);
    osc.stop(t + 0.55);
    // Whoosh noise burst
    const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.4, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const noise = this.ctx.createBufferSource();
    noise.buffer = buf;
    const ng = this.ctx.createGain();
    ng.gain.value = 0.08;
    const nf = this.ctx.createBiquadFilter();
    nf.type = 'highpass';
    nf.frequency.value = 1500;
    noise.connect(nf);
    nf.connect(ng);
    ng.connect(this.dest());
    noise.start(t);
  }

  playCrash() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const bufferSize = this.ctx.sampleRate * 0.7;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    }
    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(2500, t);
    filt.frequency.exponentialRampToValueAtTime(150, t + 0.6);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.4, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
    noise.connect(filt);
    filt.connect(gain);
    gain.connect(this.dest());
    noise.start(t);
    // Low thump
    const thump = this.ctx.createOscillator();
    const tg = this.ctx.createGain();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(120, t);
    thump.frequency.exponentialRampToValueAtTime(40, t + 0.25);
    tg.gain.setValueAtTime(0.5, t);
    tg.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    thump.connect(tg);
    tg.connect(this.dest());
    thump.start(t);
    thump.stop(t + 0.35);
  }

  playLevelUp() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
    notes.forEach((f, i) => {
      const o = this.ctx!.createOscillator();
      const g = this.ctx!.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(f, t + i * 0.1);
      g.gain.setValueAtTime(0, t + i * 0.1);
      g.gain.linearRampToValueAtTime(0.18, t + i * 0.1 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.1 + 0.45);
      o.connect(g);
      g.connect(this.dest());
      o.start(t + i * 0.1);
      o.stop(t + i * 0.1 + 0.5);
    });
  }

  playVictory() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    // Triumphant fanfare
    const seq = [
      [392.00, 0.00, 0.18], // G4
      [523.25, 0.18, 0.18], // C5
      [659.25, 0.36, 0.18], // E5
      [783.99, 0.54, 0.50], // G5 hold
    ];
    seq.forEach(([f, start, dur]) => {
      [1, 2].forEach((mult, idx) => {
        const o = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        o.type = idx === 0 ? 'sawtooth' : 'triangle';
        o.frequency.setValueAtTime(f * mult, t + start);
        g.gain.setValueAtTime(0, t + start);
        g.gain.linearRampToValueAtTime(idx === 0 ? 0.10 : 0.06, t + start + 0.02);
        g.gain.linearRampToValueAtTime(0.0001, t + start + dur);
        o.connect(g);
        g.connect(this.dest());
        o.start(t + start);
        o.stop(t + start + dur + 0.05);
      });
    });
  }

  playDefeat() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(440, t);
    o.frequency.exponentialRampToValueAtTime(110, t + 1.2);
    g.gain.setValueAtTime(0.15, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.3);
    o.connect(g);
    g.connect(this.dest());
    o.start(t);
    o.stop(t + 1.4);
  }

  playCoin() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [880, 1320].forEach((f, i) => {
      const o = this.ctx!.createOscillator();
      const g = this.ctx!.createGain();
      o.type = 'square';
      o.frequency.setValueAtTime(f, t + i * 0.06);
      g.gain.setValueAtTime(0.08, t + i * 0.06);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.06 + 0.15);
      o.connect(g);
      g.connect(this.dest());
      o.start(t + i * 0.06);
      o.stop(t + i * 0.06 + 0.18);
    });
  }

  startEngine() {
    if (!this.ctx || this.engineParts) return;
    const t = this.ctx.currentTime;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0, t);
    gain.gain.linearRampToValueAtTime(0.025, t + 0.3);
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(280, t);
    filter.Q.value = 4;

    // Three detuned saws + sub sine for richer engine timbre
    const o1 = this.ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 50;
    const o2 = this.ctx.createOscillator(); o2.type = 'sawtooth'; o2.frequency.value = 50.7;
    const o3 = this.ctx.createOscillator(); o3.type = 'square';   o3.frequency.value = 25;
    const sub = this.ctx.createOscillator(); sub.type = 'sine';   sub.frequency.value = 35;

    [o1, o2, o3, sub].forEach(o => o.connect(filter));
    filter.connect(gain);
    gain.connect(this.dest());

    // Subtle vibrato/rumble via LFO on filter freq
    const lfo = this.ctx.createOscillator();
    const lfoGain = this.ctx.createGain();
    lfo.type = 'sine';
    lfo.frequency.value = 7;
    lfoGain.gain.value = 30;
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);

    [o1, o2, o3, sub, lfo].forEach(o => o.start(t));
    this.engineParts = { oscs: [o1, o2, o3, sub], gain, filter, lfo, lfoGain };
  }

  updateEngine(speed: number, isAccelerating: boolean) {
    if (!this.ctx || !this.engineParts) return;
    const t = this.ctx.currentTime;
    const baseFreq = 45 + speed * 0.18;
    const { oscs, gain, filter } = this.engineParts;
    oscs[0].frequency.setTargetAtTime(baseFreq, t, 0.08);
    oscs[1].frequency.setTargetAtTime(baseFreq * 1.014, t, 0.08);
    oscs[2].frequency.setTargetAtTime(baseFreq * 0.5, t, 0.08);
    oscs[3].frequency.setTargetAtTime(baseFreq * 0.7, t, 0.08);
    filter.frequency.setTargetAtTime(220 + speed * 1.2 + (isAccelerating ? 250 : 0), t, 0.1);
    const volume = isAccelerating ? 0.06 : 0.025;
    gain.gain.setTargetAtTime(volume, t, 0.1);
  }

  stopEngine() {
    if (!this.engineParts) return;
    const { oscs, gain, lfo } = this.engineParts;
    const t = this.ctx!.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(gain.gain.value, t);
    gain.gain.linearRampToValueAtTime(0, t + 0.15);
    [...oscs, lfo].forEach(o => { try { o.stop(t + 0.2); } catch {} });
    this.engineParts = null;
  }
}

const sounds = new SoundManager();

// Material palettes for gears (used by GearIcon and the material picker UI)
const GEAR_MATERIALS = {
  steel:    { label: 'Steel',     body: '#cbd5e1', edge: '#475569', highlight: '#f1f5f9', hub: '#94a3b8' },
  titanium: { label: 'Titanium',  body: '#fde68a', edge: '#a16207', highlight: '#fef9c3', hub: '#facc15' },
  heavy:    { label: 'Heavy-Duty',body: '#64748b', edge: '#1e293b', highlight: '#94a3b8', hub: '#475569' },
  helical:  { label: 'Helical',   body: '#67e8f9', edge: '#0e7490', highlight: '#cffafe', hub: '#22d3ee' },
} as const;

type GearMaterialKey = keyof typeof GEAR_MATERIALS;

const GearIcon = ({
  teeth,
  className,
  material = 'steel',
  spinning = false,
  spinReverse = false,
  spinDuration,
  glow = 0,
  dim = false,
}: {
  teeth: number,
  className?: string,
  material?: GearMaterialKey,
  spinning?: boolean,
  spinReverse?: boolean,
  /** Seconds per full revolution. Defaults to teeth/20 (bigger gears spin slower). */
  spinDuration?: number,
  glow?: number,
  dim?: boolean,
}) => {
  // Cap visible teeth so very dense gears still render cleanly inside the cell
  const N = Math.max(8, Math.min(teeth, 48));
  const baseR = 38;
  const toothH = 7;
  const outerR = baseR + toothH;
  const innerR = baseR - 4;
  const hubR = 11;
  const mat = GEAR_MATERIALS[material];

  // Build trapezoidal teeth around the pitch circle.
  const halfTooth = (Math.PI / N) * 0.36; // narrow tooth, wider gap
  const tipShrink = 0.6; // tip is narrower than base for an involute-ish wedge
  let path = '';
  for (let i = 0; i < N; i++) {
    const cAngle = (i * 2 * Math.PI) / N - Math.PI / 2;
    const a1 = cAngle - halfTooth;
    const a2 = cAngle - halfTooth * tipShrink;
    const a3 = cAngle + halfTooth * tipShrink;
    const a4 = cAngle + halfTooth;
    const p1 = `${(Math.cos(a1) * baseR).toFixed(2)},${(Math.sin(a1) * baseR).toFixed(2)}`;
    const p2 = `${(Math.cos(a2) * outerR).toFixed(2)},${(Math.sin(a2) * outerR).toFixed(2)}`;
    const p3 = `${(Math.cos(a3) * outerR).toFixed(2)},${(Math.sin(a3) * outerR).toFixed(2)}`;
    const p4 = `${(Math.cos(a4) * baseR).toFixed(2)},${(Math.sin(a4) * baseR).toFixed(2)}`;
    if (i === 0) path += `M ${p1} L ${p2} L ${p3} L ${p4}`;
    else path += ` L ${p1} L ${p2} L ${p3} L ${p4}`;
    const nextAngle = ((i + 1) * 2 * Math.PI) / N - Math.PI / 2 - halfTooth;
    const np = `${(Math.cos(nextAngle) * baseR).toFixed(2)},${(Math.sin(nextAngle) * baseR).toFixed(2)}`;
    if (i < N - 1) path += ` A ${baseR} ${baseR} 0 0 1 ${np}`;
  }
  path += ' Z';

  // Lightening holes around the inner ring
  const holeCount = Math.min(6, Math.max(4, Math.floor(N / 6)));
  const holeR = 3.5;
  const holeRadius = (innerR + hubR) / 2 + 1;

  const matId = `gg-${material}`;
  const spinClass = spinning
    ? (spinReverse ? 'animate-gear-spin-r' : 'animate-gear-spin')
    : '';
  // Larger gears (more teeth) spin slower — matches the angular-velocity rule
  // ω₂ = ω₁ · (T₁ / T₂). Spec: spinDuration = teeth / 20 (seconds per revolution).
  const dur = spinDuration ?? teeth / 20;
  const spinStyle: React.CSSProperties | undefined = spinning
    ? { animationDuration: `${dur}s` }
    : undefined;
  const opacity = dim ? 0.45 : 1;

  return (
    <svg viewBox="-50 -50 100 100" className={className} style={{ overflow: 'visible' }}>
      <defs>
        <radialGradient id={matId} cx="35%" cy="35%" r="70%">
          <stop offset="0%"  stopColor={mat.highlight} />
          <stop offset="55%" stopColor={mat.body} />
          <stop offset="100%" stopColor={mat.edge} />
        </radialGradient>
      </defs>

      {/* Heat halo behind the gear when generating heat */}
      {glow > 0 && (
        <circle r={outerR + 6} fill={`rgba(239, 68, 68, ${Math.min(0.6, glow * 0.7)})`}
                style={{ filter: 'blur(4px)' }} />
      )}

      <g className={spinClass} style={{ opacity, ...(spinStyle ?? {}) }}>
        {/* Tooth body */}
        <path d={path} fill={`url(#${matId})`} stroke={mat.edge} strokeWidth="0.9" strokeLinejoin="round" />
        {/* Inner darker face */}
        <circle r={innerR} fill={mat.edge} opacity="0.35" />
        {/* Lightening holes */}
        {Array.from({ length: holeCount }).map((_, i) => {
          const a = (i * 2 * Math.PI) / holeCount - Math.PI / 2;
          return (
            <circle key={i}
              cx={(Math.cos(a) * holeRadius).toFixed(2)}
              cy={(Math.sin(a) * holeRadius).toFixed(2)}
              r={holeR}
              fill="#0a0a0a" stroke={mat.edge} strokeWidth="0.4" />
          );
        })}
        {/* Hub bolt-circle */}
        <circle r={hubR} fill={mat.highlight} stroke={mat.edge} strokeWidth="0.8" />
        <circle r={hubR * 0.4} fill={mat.edge} />
        {/* Tiny highlight on top of hub */}
        <ellipse cx="-3" cy="-3" rx="3" ry="1.5" fill="rgba(255,255,255,0.5)" />
      </g>

      {/* Heat shimmer overlay (does NOT spin so it stays bright) */}
      {glow > 0.3 && (
        <circle r={outerR + 1} fill="none" stroke={`rgba(248, 113, 113, ${glow * 0.8})`} strokeWidth="1.5" />
      )}
    </svg>
  );
};

// Detailed V8 engine block (replaces simple Zap icon)
const EngineVisual = ({ className }: { className?: string }) => (
  <div className={`flex flex-col items-center gap-2 ${className}`}>
    <div className="relative">
      <div className="absolute -inset-4 bg-blue-500/25 blur-xl rounded-full animate-pulse" />
      <div className="relative bg-gradient-to-br from-[#1f2937] to-[#0a0a0a] p-2 rounded-2xl border border-blue-500/30 shadow-lg shadow-blue-500/10">
        <svg viewBox="-44 -32 88 64" className="w-20 h-16">
          <defs>
            <linearGradient id="engBlock" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#475569" />
              <stop offset="100%" stopColor="#1e293b" />
            </linearGradient>
          </defs>
          {/* Engine block */}
          <rect x="-32" y="-20" width="64" height="40" rx="4" fill="url(#engBlock)" stroke="#0f172a" strokeWidth="1.2" />
          {/* Cooling fins */}
          {[-26, -22, -18, -14, -10, -6, -2, 2, 6, 10, 14, 18, 22, 26].map(x => (
            <line key={x} x1={x} y1="-18" x2={x} y2="18" stroke="rgba(0,0,0,0.35)" strokeWidth="0.6" />
          ))}
          {/* V8 valve covers — two angled banks */}
          <g transform="translate(0,-12)">
            <rect x="-26" y="-5" width="52" height="8" rx="2" fill="#1e293b" stroke="#0f172a" />
            {[-19, -10, 10, 19].map(x => (
              <g key={x} className="piston-anim" style={{ animationDelay: `${(x + 20) * 0.04}s` }}>
                <circle cx={x} cy="-5" r="2" fill="#fde68a" />
                <circle cx={x} cy="-5" r="1" fill="#f59e0b" />
              </g>
            ))}
            <text x="0" y="1" textAnchor="middle" fontSize="4" fontWeight="900" fill="#94a3b8">V8</text>
          </g>
          {/* Lower bank shadow */}
          <rect x="-26" y="6" width="52" height="6" rx="2" fill="#0f172a" />
          {/* Crank pulley */}
          <circle cx="-32" cy="0" r="6" fill="#0a0a0a" stroke="#475569" strokeWidth="1" />
          <circle cx="-32" cy="0" r="3" fill="#f59e0b" />
          <circle cx="-32" cy="0" r="1" fill="#fde68a" />
          {/* Exhaust headers (right side) */}
          <path d="M 32 -10 Q 38 -10 38 -4 L 42 -4" stroke="#475569" strokeWidth="2.5" fill="none" />
          <path d="M 32 10 Q 38 10 38 4 L 42 4" stroke="#475569" strokeWidth="2.5" fill="none" />
          <circle cx="42" cy="-4" r="1.5" fill="#0a0a0a" />
          <circle cx="42" cy="4" r="1.5" fill="#0a0a0a" />
        </svg>
      </div>
    </div>
    <span className="text-[10px] font-black text-blue-400/60 uppercase tracking-tighter">V8 ENGINE</span>
  </div>
);

// Detailed drive wheel with rim, brake disc, tire tread
const WheelVisual = ({ className, brakeHot = false }: { className?: string, brakeHot?: boolean }) => (
  <div className={`flex flex-col items-center gap-2 ${className}`}>
    <div className="relative">
      <div className="absolute -inset-4 bg-green-500/20 blur-xl rounded-full animate-pulse" />
      <div className="relative bg-gradient-to-br from-[#1f2937] to-[#0a0a0a] p-2 rounded-2xl border border-green-500/30 shadow-lg shadow-green-500/10">
        <svg viewBox="-44 -44 88 88" className="w-20 h-20 animate-gear-spin" style={{ animationDuration: '6s' }}>
          {/* Outer tire */}
          <circle r="40" fill="#0a0a0a" stroke="#1f2937" strokeWidth="1" />
          {/* Tread blocks */}
          {Array.from({ length: 28 }).map((_, i) => {
            const a = (i / 28) * 2 * Math.PI;
            const x1 = Math.cos(a) * 34, y1 = Math.sin(a) * 34;
            const x2 = Math.cos(a) * 40, y2 = Math.sin(a) * 40;
            return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#374151" strokeWidth="2" />;
          })}
          {/* Sidewall ring */}
          <circle r="33" fill="none" stroke="#1e293b" strokeWidth="1.5" />
          {/* Alloy rim background */}
          <circle r="29" fill="#475569" />
          {/* Brake disc — glows red when brakes are hot */}
          <circle r="22" fill={brakeHot ? '#dc2626' : '#94a3b8'} opacity="0.85"
                  style={{ filter: brakeHot ? 'drop-shadow(0 0 6px #ef4444)' : 'none' }} />
          {Array.from({ length: 8 }).map((_, i) => {
            const a = (i / 8) * 2 * Math.PI;
            return <circle key={i} cx={Math.cos(a) * 17} cy={Math.sin(a) * 17} r="1.6" fill="#0a0a0a" />;
          })}
          {/* 5 alloy spokes */}
          {[0, 1, 2, 3, 4].map(i => {
            const deg = (i / 5) * 360;
            return (
              <g key={i} transform={`rotate(${deg})`}>
                <path d="M -3.5 0 L -2 -26 Q 0 -28 2 -26 L 3.5 0 Z"
                      fill="#cbd5e1" stroke="#64748b" strokeWidth="0.5" strokeLinejoin="round" />
              </g>
            );
          })}
          {/* Center hub & lugnuts */}
          <circle r="7" fill="#1f2937" stroke="#94a3b8" strokeWidth="0.6" />
          {[0, 72, 144, 216, 288].map(deg => (
            <circle key={deg} cx={Math.cos(deg * Math.PI / 180) * 4.5} cy={Math.sin(deg * Math.PI / 180) * 4.5} r="1" fill="#94a3b8" />
          ))}
          <circle r="2" fill="#fbbf24" />
        </svg>
      </div>
    </div>
    <span className="text-[10px] font-black text-green-400/60 uppercase tracking-tighter">DRIVE WHEEL</span>
  </div>
);

// Lightweight burst of sparks rendered when a gear is placed/changed/removed.
const SparkBurst = ({ x, y }: { x: number, y: number }) => {
  const sparks = Array.from({ length: 8 }).map((_, i) => {
    const a = (i / 8) * Math.PI * 2;
    return { sx: Math.cos(a) * 24, sy: Math.sin(a) * 24, key: i };
  });
  return (
    <div className="pointer-events-none absolute z-[400]" style={{ left: x, top: y }}>
      {sparks.map(s => (
        <span key={s.key} className="spark"
          style={{ ['--sx' as any]: `${s.sx}px`, ['--sy' as any]: `${s.sy}px` }} />
      ))}
    </div>
  );
};

export default function App() {
  const [roomId, setRoomId] = useState('main-race');
  const [socketId, setSocketId] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected'>('disconnected');
  const [playerState, setPlayerState] = useState<PlayerState | null>(null);
  const [otherPlayers, setOtherPlayers] = useState<Record<string, PlayerState>>({});
  const [gears, setGears] = useState<Gear[]>(() => {
    const saved = localStorage.getItem('gear_race_gears');
    if (saved) {
      const parsed = JSON.parse(saved);
      // Filter out gears that don't fit in 6x2
      return parsed.filter((g: any) => g.x < 6 && g.y < 2);
    }
    return [
      { id: '0-0', x: 0, y: 0, teeth: 16, type: 'intermediate' },
      { id: '1-0', x: 1, y: 0, teeth: 32, type: 'intermediate' },
      { id: '2-0', x: 2, y: 0, teeth: 48, type: 'intermediate' },
      { id: '3-1', x: 3, y: 1, teeth: 64, type: 'intermediate' },
      { id: '4-1', x: 4, y: 1, teeth: 80, type: 'intermediate' },
      { id: '5-1', x: 5, y: 1, teeth: 128, type: 'intermediate' },
    ];
  });

  useEffect(() => {
    localStorage.setItem('gear_race_gears', JSON.stringify(gears));
  }, [gears]);
  const [gameState, setGameState] = useState<'setup' | 'racing' | 'exploded' | 'finished'>('setup');
  const [multiplayerWinner, setMultiplayerWinner] = useState<{ id: string, reason: string } | null>(null);
  const [isWaiting, setIsWaiting] = useState(false);
  const [gameMode, setGameMode] = useState<'single' | 'multi' | null>(null);
  const [availableRooms, setAvailableRooms] = useState<{id: string, createdAt: any}[]>([]);
  const [multiRoomConfirmed, setMultiRoomConfirmed] = useState(false);
  const [joinIdInput, setJoinIdInput] = useState('');
  const [isGarageOpen, setIsGarageOpen] = useState(false);
  const [isMissionsOpen, setIsMissionsOpen] = useState(false);
  const [gearRatio, setGearRatio] = useState(1);
  const [engineTemp, setEngineTemp] = useState(20);
  const [brakeTemp, setBrakeTemp] = useState(20);
  const [currentSpeed, setCurrentSpeed] = useState(0);
  const [gearboxRatios, setGearboxRatios] = useState<number[]>(() => {
    try {
      const saved = localStorage.getItem('gear_race_gearbox');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length === 4) return parsed.map(Number);
      }
    } catch {}
    return [...DEFAULT_GEARBOX];
  });
  useEffect(() => {
    localStorage.setItem('gear_race_gearbox', JSON.stringify(gearboxRatios));
  }, [gearboxRatios]);
  const [currentGear, setCurrentGear] = useState(2); // 1..4
  const currentGearRef = useRef(2);
  useEffect(() => { currentGearRef.current = currentGear; }, [currentGear]);
  const gearboxRatiosRef = useRef(gearboxRatios);
  useEffect(() => { gearboxRatiosRef.current = gearboxRatios; }, [gearboxRatios]);

  // Mechanical tuning (tires/brakes/cooling/turbo/chassis).
  const [tuning, setTuning] = useState<Tuning>(() => {
    try {
      const raw = localStorage.getItem('gear_race_tuning');
      if (raw) {
        const t = JSON.parse(raw);
        return { ...DEFAULT_TUNING, ...t };
      }
    } catch {}
    return { ...DEFAULT_TUNING };
  });
  useEffect(() => {
    localStorage.setItem('gear_race_tuning', JSON.stringify(tuning));
  }, [tuning]);
  const tuningRef = useRef(tuning);
  useEffect(() => { tuningRef.current = tuning; }, [tuning]);
  const [currentSlope, setCurrentSlope] = useState(0); // radians, for HUD

  // Reset transmission to 2nd gear at the start of every race
  useEffect(() => {
    if (gameState === 'racing') {
      setCurrentGear(2);
      setCurrentSlope(0);
    }
  }, [gameState]);
  const [isConnected, setIsConnected] = useState(false);
  const [isAccelerating, setIsAccelerating] = useState(false);
  const [isBraking, setIsBraking] = useState(false);
  const [playerLane, setPlayerLane] = useState(0); // -1, 0, 1
  const [targetLane, setTargetLane] = useState(0);
  const targetLaneRef = useRef(0);
  const lastSyncTimeRef = useRef(0);
  const lastLaneChangeZRef = useRef(0);
  const nextObstacleZRef = useRef(0);
  const nearMissTextRef = useRef<{text: string, x: number, y: number, opacity: number} | null>(null);
  const [obstacles, setObstacles] = useState<{ id: string, lane: number, z: number, type: string, processed?: boolean }[]>([]);

  useEffect(() => {
    if (targetLane !== targetLaneRef.current) {
      lastLaneChangeZRef.current = distance;
      targetLaneRef.current = targetLane;
    }
  }, [targetLane]);
  const [distance, setDistance] = useState(0);
  const [showInstructions, setShowInstructions] = useState(true);
  const [connectedGears, setConnectedGears] = useState<string[]>([]);
  // Per-gear parity from the BFS-tree — drives correct alternating spin direction.
  const [gearParity, setGearParity] = useState<Map<string, 0 | 1>>(new Map());
  const [selectedGearId, setSelectedGearId] = useState<string | null>(null);
  // Named preset slots saved to localStorage. 3 prebuilt builds + an empty Custom slot.
  const [presets, setPresets] = useState<{ name: string, gears: Gear[] }[]>(() => {
    const saved = localStorage.getItem('gear_race_presets');
    if (saved) {
      try { return JSON.parse(saved); } catch { /* fall through */ }
    }
    return [
      { name: 'Drag', gears: [
        { id: '0-0', x: 0, y: 0, teeth: 16, type: 'intermediate' },
        { id: '1-0', x: 1, y: 0, teeth: 24, type: 'intermediate' },
        { id: '2-0', x: 2, y: 0, teeth: 48, type: 'intermediate' },
        { id: '3-0', x: 3, y: 0, teeth: 80, type: 'intermediate' },
        { id: '4-0', x: 4, y: 0, teeth: 96, type: 'intermediate' },
        { id: '5-0', x: 5, y: 0, teeth: 128, type: 'intermediate' },
      ]},
      { name: 'Hill Climb', gears: [
        { id: '0-0', x: 0, y: 0, teeth: 64, type: 'intermediate' },
        { id: '1-0', x: 1, y: 0, teeth: 48, type: 'intermediate' },
        { id: '2-1', x: 2, y: 1, teeth: 32, type: 'intermediate' },
        { id: '3-1', x: 3, y: 1, teeth: 24, type: 'intermediate' },
        { id: '4-0', x: 4, y: 0, teeth: 16, type: 'intermediate' },
        { id: '5-0', x: 5, y: 0, teeth: 16, type: 'intermediate' },
      ]},
      { name: 'Endurance', gears: [
        { id: '0-0', x: 0, y: 0, teeth: 32, type: 'intermediate' },
        { id: '1-0', x: 1, y: 0, teeth: 32, type: 'intermediate' },
        { id: '2-0', x: 2, y: 0, teeth: 48, type: 'intermediate' },
        { id: '4-0', x: 4, y: 0, teeth: 48, type: 'intermediate' },
        { id: '5-0', x: 5, y: 0, teeth: 64, type: 'intermediate' },
      ]},
      { name: 'Custom', gears: [] },
    ];
  });
  // Spark burst trigger (re-renders SparkBurst at given grid position)
  const [sparkBurst, setSparkBurst] = useState<{ id: number, x: number, y: number } | null>(null);
  const sparkIdRef = useRef(0);
  // Hover preview for "what would the ratio become if I picked this teeth count?"
  const [previewTeeth, setPreviewTeeth] = useState<number | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 400 });
  const [credits, setCredits] = useState(() => {
    const saved = localStorage.getItem('gear_race_credits');
    return saved ? parseInt(saved) : 0;
  });
  const [totalWins, setTotalWins] = useState(() => {
    const saved = localStorage.getItem('gear_race_total_wins');
    return saved ? parseInt(saved) : 0;
  });
  const [totalCoinsEarned, setTotalCoinsEarned] = useState(() => {
    const saved = localStorage.getItem('gear_race_total_coins_earned');
    return saved ? parseInt(saved) : 0;
  });
  const [bountyResult, setBountyResult] = useState<{ amount: number; type: 'won' | 'lost' } | null>(null);
  const bountyAppliedRef = useRef<string | null>(null);
  const lastLevelRef = useRef<number>(-1);
  const [upgrades, setUpgrades] = useState<{ id: string, level: number }[]>(() => {
    const saved = localStorage.getItem('gear_race_upgrades');
    return saved ? JSON.parse(saved) : [];
  });

  // Level: requires N*100 wins AND N*1000 lifetime coins earned
  const level = Math.max(0, Math.min(Math.floor(totalWins / 100), Math.floor(totalCoinsEarned / 1000)));
  const nextLevelWins = (level + 1) * 100;
  const nextLevelCoins = (level + 1) * 1000;
  const winsProgress = Math.min(1, totalWins / nextLevelWins);
  const coinsProgress = Math.min(1, totalCoinsEarned / nextLevelCoins);
  const levelProgress = Math.min(winsProgress, coinsProgress);

  // addCredits: positive = earned (counts toward level), negative = spent (does not subtract from lifetime)
  const addCredits = (delta: number) => {
    setCredits(prev => Math.max(0, prev + delta));
    if (delta > 0) setTotalCoinsEarned(prev => prev + delta);
  };

  useEffect(() => {
    localStorage.setItem('gear_race_total_wins', totalWins.toString());
  }, [totalWins]);
  useEffect(() => {
    localStorage.setItem('gear_race_total_coins_earned', totalCoinsEarned.toString());
  }, [totalCoinsEarned]);

  // Level-up notification + sound
  useEffect(() => {
    if (lastLevelRef.current === -1) {
      lastLevelRef.current = level;
      return;
    }
    if (level > lastLevelRef.current) {
      sounds.playLevelUp();
      audioBus.playSfx('levelup');
      lastLevelRef.current = level;
    } else {
      lastLevelRef.current = level;
    }
  }, [level]);

  // Mute toggle (persisted)
  const [isMuted, setIsMuted] = useState(() => localStorage.getItem('gear_race_muted') === '1');
  useEffect(() => {
    audioBus.setMusicMuted(isMuted);
    audioBus.setSfxMuted(isMuted);
    localStorage.setItem('gear_race_muted', isMuted ? '1' : '0');
  }, [isMuted]);

  // Background music director — picks a track based on the game state.
  useEffect(() => {
    audioBus.init();
    if (gameState === 'racing') {
      // Alternate between two race tracks for variety
      const track = Math.random() < 0.5 ? 'race' : 'race2';
      audioBus.playMusic(track, { loop: true, fadeMs: 800 });
    } else if (gameState === 'finished') {
      audioBus.playMusic('victoryMusic', { loop: false, fadeMs: 600 });
    } else if (gameState === 'exploded') {
      audioBus.stopMusic(400);
    } else {
      // setup / shop / menu
      audioBus.playMusic('menu', { loop: true, fadeMs: 800 });
    }
  }, [gameState]);

  const [boostTime, setBoostTime] = useState(0);
  const [lastBoostType, setLastBoostType] = useState<string | null>(null);

  // Daily Missions State
  const [missions, setMissions] = useState<{
    id: string;
    label: string;
    goal: number;
    current: number;
    reward: number;
    type: 'speed' | 'distance' | 'win' | 'temp';
    completed: boolean;
    claimed: boolean;
  }[]>(() => {
    const saved = localStorage.getItem('gear_race_missions');
    const lastDate = localStorage.getItem('gear_race_missions_date');
    const today = new Date().toDateString();

    if (saved && lastDate === today) {
      return JSON.parse(saved);
    }
    return [];
  });

  const [missionDate, setMissionDate] = useState(() => localStorage.getItem('gear_race_missions_date') || '');

  // Mission Generation
  useEffect(() => {
    const today = new Date().toDateString();
    if (missionDate !== today) {
      const dailyPool = [
        { id: 'm1', label: 'Hit 250 KM/H', goal: 250, reward: 100, type: 'speed' },
        { id: 'm2', label: 'Travel 50,000 KM', goal: 50000, reward: 150, type: 'distance' },
        { id: 'm3', label: 'Win a Single Race', goal: 1, reward: 200, type: 'win' },
        { id: 'm4', label: 'Finish with Engine < 50°C', goal: 50, reward: 300, type: 'temp' },
        { id: 'm5', label: 'Hit 400 KM/H', goal: 400, reward: 250, type: 'speed' },
        { id: 'm6', label: 'Total Distance 100k', goal: 100000, reward: 500, type: 'distance' },
      ];
      
      // Pick 3 random missions
      const shuffled = dailyPool.sort(() => 0.5 - Math.random());
      const selected = shuffled.slice(0, 3).map(m => ({ ...m, current: 0, completed: false, claimed: false }));
      
      setMissions(selected as any);
      setMissionDate(today);
      localStorage.setItem('gear_race_missions', JSON.stringify(selected));
      localStorage.setItem('gear_race_missions_date', today);
    }
  }, [missionDate]);

  useEffect(() => {
    localStorage.setItem('gear_race_missions', JSON.stringify(missions));
  }, [missions]);

  const updateMissionProgress = (type: string, value: number, isFinished = false) => {
    setMissions(prev => prev.map(m => {
      if (m.type === type && !m.completed) {
        let newCurrent = m.current;
        if (type === 'distance') newCurrent += value;
        else if (type === 'speed') newCurrent = Math.max(m.current, value);
        else if (type === 'win' && isFinished) newCurrent += value;
        else if (type === 'temp' && isFinished && value <= m.goal) newCurrent = 1;
        
        const completed = newCurrent >= m.goal;
        return { ...m, current: newCurrent, completed };
      }
      return m;
    }));
  };

  const claimMissionReward = (id: string) => {
    // Lucky Charm boosts mission payouts by 25%.
    const luckyMult = hasUpgrade('lucky_charm') ? 1.25 : 1;
    setMissions(prev => prev.map(m => {
      if (m.id === id && m.completed && !m.claimed) {
        addCredits(Math.round(m.reward * luckyMult));
        sounds.playCoin();
        audioBus.playSfx('coin');
        return { ...m, claimed: true };
      }
      return m;
    }));
  };

  // Publish wallet to Firestore so opponents can compute the 10% bounty.
  useEffect(() => {
    if (!auth.currentUser) return;
    const uid = auth.currentUser.uid;
    setDoc(doc(db, 'wallets', uid), {
      credits,
      totalWins,
      totalCoinsEarned,
      lastUpdate: serverTimestamp(),
    }, { merge: true }).catch(() => {});
  }, [credits, totalWins, totalCoinsEarned, socketId]);

  // Reset bounty marker when a new race starts
  useEffect(() => {
    if (gameState === 'racing') {
      bountyAppliedRef.current = null;
      setBountyResult(null);
    }
  }, [gameState]);

  // 10% bounty on multiplayer race finish: winner takes 10% of each loser's wallet.
  useEffect(() => {
    if (gameMode !== 'multi' || gameState !== 'finished' || !multiplayerWinner || !auth.currentUser) return;
    const myUid = auth.currentUser.uid;
    const raceKey = `${roomId}:${multiplayerWinner.id}:${multiplayerWinner.reason}`;
    if (bountyAppliedRef.current === raceKey) return;
    bountyAppliedRef.current = raceKey;

    const isWinner = multiplayerWinner.id === myUid;

    if (isWinner) {
      sounds.playVictory();
      audioBus.playSfx('victory');
      setTotalWins(w => w + 1);
      // Read each opponent's wallet and take 10%
      (async () => {
        const opponentIds = Object.keys(otherPlayers).filter(id => id !== myUid);
        let bountyTotal = 0;
        for (const opId of opponentIds) {
          try {
            const snap = await getDoc(doc(db, 'wallets', opId));
            if (snap.exists()) {
              const data = snap.data();
              const opCredits = typeof data.credits === 'number' ? data.credits : 0;
              bountyTotal += Math.floor(opCredits * 0.1);
            }
          } catch {}
        }
        if (bountyTotal > 0) {
          addCredits(bountyTotal);
          sounds.playCoin();
          audioBus.playSfx('coin');
        }
        setBountyResult({ amount: bountyTotal, type: 'won' });
      })();
    } else {
      sounds.playDefeat();
      audioBus.playSfx('defeat');
      // Loser pays 10% of own wallet
      const loss = Math.floor(credits * 0.1);
      if (loss > 0) {
        setCredits(prev => Math.max(0, prev - loss));
      }
      setBountyResult({ amount: loss, type: 'lost' });
    }
  }, [gameState, multiplayerWinner, gameMode, roomId]);

  const canvasRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Matter.Engine | null>(null);
  const playerBodyRef = useRef<Matter.Body | null>(null);
  const wheelARef = useRef<Matter.Body | null>(null);
  const wheelBRef = useRef<Matter.Body | null>(null);
  const particlesRef = useRef<{ x: number, y: number, vx: number, vy: number, life: number, color: string }[]>([]);
  
  const controlsRef = useRef({
    isAccelerating: false,
    isBraking: false,
    connectedGears: [] as string[]
  });

  useEffect(() => {
    controlsRef.current.isAccelerating = isAccelerating;
    controlsRef.current.isBraking = isBraking;
    controlsRef.current.connectedGears = connectedGears;
  }, [isAccelerating, isBraking, connectedGears]);

  useEffect(() => {
    localStorage.setItem('gear_race_credits', credits.toString());
  }, [credits]);

  useEffect(() => {
    localStorage.setItem('gear_race_upgrades', JSON.stringify(upgrades));
  }, [upgrades]);

  useEffect(() => {
    localStorage.setItem('gear_race_presets', JSON.stringify(presets));
  }, [presets]);

  const SHOP_ITEMS = [
    { id: 'titanium_gears',     name: 'Titanium Gears',           description: 'Removes efficiency penalty from gear chains.',                price: 500, icon: <Settings className="w-5 h-5" /> },
    { id: 'super_cooler',       name: 'Super Cooler',             description: 'Reduces engine heat generation by 40%.',                      price: 300, icon: <Zap className="w-5 h-5" /> },
    { id: 'nitro_system',       name: 'Nitro System',             description: 'Increases base torque by 25%.',                               price: 450, icon: <Flame className="w-5 h-5" /> },
    { id: 'aero_chassis',       name: 'Aero Chassis',             description: 'Reduces air resistance at high speeds.',                      price: 600, icon: <Wind className="w-5 h-5" /> },
    { id: 'premium_gears',      name: 'Premium Gear Materials',   description: 'Unlocks Titanium / Heavy-Duty / Helical gear materials.',     price: 800, icon: <Settings className="w-5 h-5" /> },
    { id: 'magnetic_tires',     name: 'Magnetic Tires',           description: '+50% lane-change responsiveness.',                            price: 350, icon: <Magnet className="w-5 h-5" /> },
    { id: 'carbon_brakes',      name: 'Carbon Brakes',            description: 'Brake heat ×0.5 — brake harder, longer.',                     price: 400, icon: <Disc className="w-5 h-5" /> },
    { id: 'heat_shield',        name: 'Heat Shield',              description: 'Engine overheat threshold raised from 90°C to 100°C.',        price: 550, icon: <Shield className="w-5 h-5" /> },
    { id: 'reserve_tank',       name: 'Reserve Tank',             description: 'Near-Miss boost duration ×1.6.',                              price: 500, icon: <Battery className="w-5 h-5" /> },
    { id: 'reinforced_bumper',  name: 'Reinforced Bumper',        description: 'Crash speed-loss & heat damage halved.',                      price: 400, icon: <Shield className="w-5 h-5" /> },
    { id: 'coin_magnet',        name: 'Coin Magnet',              description: 'Race finish reward ×1.5.',                                    price: 700, icon: <Coins className="w-5 h-5" /> },
    { id: 'quick_start',        name: 'Quick Start',              description: 'Free 2.5s boost the moment the race begins.',                 price: 450, icon: <Rocket className="w-5 h-5" /> },
    { id: 'precision_intake',   name: 'Precision Intake',         description: 'Top speed ×1.08.',                                            price: 650, icon: <Gauge className="w-5 h-5" /> },
    { id: 'lucky_charm',        name: 'Lucky Charm',              description: 'Mission rewards ×1.25.',                                      price: 350, icon: <Sparkles className="w-5 h-5" /> },
  ];

  const hasUpgrade = (id: string) => upgrades.some(u => u.id === id);

  const buyItem = (item: typeof SHOP_ITEMS[0]) => {
    if (credits >= item.price && !hasUpgrade(item.id)) {
      setCredits(prev => prev - item.price);
      setUpgrades(prev => [...prev, { id: item.id, level: 1 }]);
    }
  };

  // Keyboard Controls
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (key === 'arrowup' || key === 'w' || key === ' ') setIsAccelerating(true);
      if (key === 'arrowdown' || key === 's') setIsBraking(true);
      
      if (gameState === 'racing') {
        if (key === 'arrowleft' || key === 'a') setTargetLane(prev => Math.max(-1, prev - 1));
        if (key === 'arrowright' || key === 'd') setTargetLane(prev => Math.min(1, prev + 1));
        // Gearbox shifting
        if (key === 'q' || key === '[' || key === 'shift') {
          setCurrentGear(g => Math.max(1, g - 1));
          audioBus.playSfx('click');
        }
        if (key === 'e' || key === ']') {
          setCurrentGear(g => Math.min(4, g + 1));
          audioBus.playSfx('click');
        }
        // Direct gear selection with number keys 1..4
        if (key === '1' || key === '2' || key === '3' || key === '4') {
          const g = parseInt(key, 10);
          setCurrentGear(g);
          audioBus.playSfx('click');
        }
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (key === 'arrowup' || key === 'w' || key === ' ') setIsAccelerating(false);
      if (key === 'arrowdown' || key === 's') setIsBraking(false);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [gameState]);

  // Fetch available rooms
  useEffect(() => {
    if (gameMode !== 'multi' || multiRoomConfirmed) return;
    const roomsQuery = query(
      collection(db, 'rooms'),
      where('status', '==', 'waiting'),
      orderBy('createdAt', 'desc'),
      limit(20)
    );
    const unsubscribe = onSnapshot(roomsQuery, (snapshot) => {
      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      const rooms = snapshot.docs
        .map(doc => {
          const data = doc.data();
          return { 
            id: doc.id, 
            createdAt: data.createdAt?.toMillis() || Date.now(),
            status: data.status
          };
        })
        .filter(room => room.createdAt > oneHourAgo);
        
      setAvailableRooms(rooms);
    });
    return () => unsubscribe();
  }, [gameMode, multiRoomConfirmed]);

  // Firebase Initialization Effect (Join/Leave Only)
  useEffect(() => {
    if (gameMode !== 'multi' || !multiRoomConfirmed || !auth.currentUser) {
      if (gameMode === 'multi') setConnectionStatus('connecting');
      else {
        setConnectionStatus('disconnected');
        setOtherPlayers({});
      }
      return;
    }

    const myUid = auth.currentUser.uid;
    const roomRef = doc(db, 'rooms', roomId);

    const initRoom = async () => {
      // Only run if we are in setup mode to avoid resetting during race
      if (gameState !== 'setup') return;
      
      const snap = await getDoc(roomRef);
      if (!snap.exists()) {
        await setDoc(roomRef, {
          status: 'waiting',
          createdAt: serverTimestamp()
        });
      } else if (snap.data().status === 'finished') {
        await updateDoc(roomRef, {
          status: 'waiting',
          winnerId: null,
          winReason: null
        });
      }
      
      // Register player with initial state ONLY if not already ready
      // This prevents the reset bug when clicking ENGINE START
      await setDoc(doc(db, 'rooms', roomId, 'players', myUid), {
        id: myUid,
        isReady: false,
        progress: 0,
        x: 0,
        y: 0,
        temp: 20,
        brakeTemp: 20,
        gearRatio: 0,
        isExploded: false,
        lastUpdate: serverTimestamp()
      }, { merge: true });

      setConnectionStatus('connected');
    };
    initRoom();

    const handleUnload = () => {
      if (roomId && myUid) {
        deleteDoc(doc(db, 'rooms', roomId, 'players', myUid)).catch(() => {});
      }
    };
    window.addEventListener('beforeunload', handleUnload);

    return () => {
      window.removeEventListener('beforeunload', handleUnload);
      handleUnload();
    };
  }, [roomId, gameMode, multiRoomConfirmed, auth.currentUser]);

  // Firebase Real-time Listeners Effect
  useEffect(() => {
    const unsubAuth = onAuthStateChanged(auth, (user) => {
      if (user) {
        setSocketId(user.uid);
      }
    });

    if (gameMode !== 'multi' || !multiRoomConfirmed || !auth.currentUser) {
      return () => unsubAuth();
    }

    const myUid = auth.currentUser.uid;
    const roomRef = doc(db, 'rooms', roomId);
    const playersRef = collection(db, 'rooms', roomId, 'players');

    // Listen to Room Status
    const unsubscribeRoom = onSnapshot(doc(db, 'rooms', roomId), (snapshot) => {
      if (!snapshot.exists()) return;
      const data = snapshot.data();
      
      if (data.status === 'racing' && (gameState === 'setup' || isWaiting)) {
        setIsWaiting(false);
        setGameState('racing');
        setMultiplayerWinner(null);
      } else if (data.status === 'finished') {
        // Stop engine for everyone if race ended
        sounds.stopEngine();
        
        if (data.winnerId) {
          setMultiplayerWinner({ id: data.winnerId, reason: data.winReason || 'Race Finished' });
          setGameState('finished');
        } else {
          // Fallback if winner not recorded yet but room is finished
          setGameState('finished');
        }
      }
    });

    // Listen to Players
    const unsubscribePlayers = onSnapshot(playersRef, (snapshot) => {
      const players: Record<string, PlayerState> = {};
      snapshot.forEach((d) => {
        if (d.id !== myUid) {
          const data = d.data() as PlayerState;
          players[d.id] = data;
          
          // Detect rival explosion check (needs latest gameState from closure)
          if (data.isExploded && gameState === 'racing') {
            updateDoc(roomRef, {
              status: 'finished',
              winnerId: myUid,
              winReason: 'rival engine failure'
            }).catch(console.error);
          }
        }
      });
      setOtherPlayers(players);

      // Auto-start logic: ALL players in room must be ready
      const allPlayers = snapshot.docs.map(d => d.data());
      const allReady = allPlayers.length >= 2 && allPlayers.every(p => p.isReady);
      
      if (allReady && gameState === 'setup' && multiRoomConfirmed) {
        updateDoc(roomRef, { status: 'racing' }).catch(console.error);
      }
    });

    return () => {
      unsubAuth();
      unsubscribeRoom();
      unsubscribePlayers();
    };
  }, [roomId, gameMode, multiRoomConfirmed, auth.currentUser, gameState, isWaiting]);

  // Gear Connectivity Logic (BFS-tree).
  // Returns the set of connected gear ids AND a parity map (0 = "input phase", 1 = "output phase")
  // assigned by tree level so neighboring meshing gears always have opposite parity.
  // That way the visual rotation directions actually look like meshed gears, not random spinners.
  const computeConnectedGears = (gs: Gear[], _cols: number, _rows: number): { ids: Set<string>, parity: Map<string, 0 | 1> } => {
    const ids = new Set<string>();
    const parity = new Map<string, 0 | 1>();
    if (gs.length === 0) return { ids, parity };
    const gearMap = new Map<string, Gear>(gs.map(g => [g.id, g]));
    const queue: string[] = [];
    gs.filter(g => g.x === 0).forEach(g => {
      queue.push(g.id);
      ids.add(g.id);
      parity.set(g.id, 0); // input column gears are the "drivers" (parity 0)
    });
    while (queue.length > 0) {
      const curId = queue.shift()!;
      const cur = gearMap.get(curId);
      if (!cur) continue;
      const curPar = parity.get(curId) ?? 0;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const nid = `${cur.x + dx}-${cur.y + dy}`;
          if (gearMap.has(nid) && !ids.has(nid)) {
            ids.add(nid);
            // BFS-tree: meshing neighbor flips parity → opposite spin direction.
            parity.set(nid, curPar === 0 ? 1 : 0);
            queue.push(nid);
          }
        }
      }
    }
    return { ids, parity };
  };

  const computeRatio = (gs: Gear[], connected: string[] | Set<string>): number => {
    const visited = connected instanceof Set ? connected : new Set(connected);
    const ends   = gs.filter(g => g.x === GRID_COLS - 1 && visited.has(g.id));
    const starts = gs.filter(g => g.x === 0 && visited.has(g.id));
    if (ends.length === 0 || starts.length === 0) return 0;
    const avgEnd   = ends.reduce((a, g) => a + g.teeth, 0) / ends.length;
    const avgStart = starts.reduce((a, g) => a + g.teeth, 0) / starts.length;
    return avgEnd / avgStart;
  };

  useEffect(() => {
    if (gears.length === 0) {
      setGearRatio(0);
      setIsConnected(false);
      setConnectedGears([]);
      setGearParity(new Map());
      return;
    }
    const { ids, parity } = computeConnectedGears(gears, GRID_COLS, GRID_ROWS);
    const connectedList = Array.from(ids);
    setConnectedGears(connectedList);
    setGearParity(parity);
    const ratio = computeRatio(gears, ids);
    if (ratio > 0) {
      setGearRatio(ratio);
      setIsConnected(true);
    } else {
      setGearRatio(0);
      setIsConnected(false);
    }
  }, [gears]);

  // Responsive Canvas
  useEffect(() => {
    if (!canvasRef.current) return;
    
    const observer = new ResizeObserver((entries) => {
      for (let entry of entries) {
        const { width, height } = entry.contentRect;
        setCanvasSize({ width, height });
      }
    });
    
    observer.observe(canvasRef.current);
    return () => observer.disconnect();
  }, []);

  // Pseudo-3D Racing Logic
  useEffect(() => {
    if (gameState !== 'racing') return;

    let animFrame: number;
    let lastTime = performance.now();
    let localDistance = distance;
    let localSpeed = currentSpeed;
    let localPlayerLane = playerLane;
    let localObstacles: { id: string, lane: number, z: number, type: string, processed?: boolean, oldLane?: number }[] = [];
    let localEngineTemp = engineTemp;
    let screenShake = 0;
    // Quick Start upgrade gives the player a free 2.5s boost the moment racing begins.
    let localBoostTimer = hasUpgrade('quick_start') ? 2.5 : 0;
    if (localBoostTimer > 0) {
      setBoostTime(localBoostTimer);
      setLastBoostType('QUICK START');
    }
    let nearMissText: { text: string, x: number, y: number, opacity: number } | null = null;
    
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvasRef.current?.appendChild(canvas);

    const update = (time: number) => {
      if (gameState !== 'racing') {
        sounds.stopEngine();
        return;
      }
      sounds.startEngine();

      const dt = (time - lastTime) / 1000;
      lastTime = time;

      const { isAccelerating: acc, isBraking: brake } = controlsRef.current;
      const activeAcceleration = acc;

      sounds.updateEngine(localSpeed, activeAcceleration);
      
      // Realistic Speed and Torque calculation (with 4-speed gearbox + tuning)
      const tn = tuningRef.current;
      // Tuning multipliers — each level moves ~10-15% off stock (level 3).
      const turboTopMult = 1 + (tn.turbo - 3) * 0.07;       // top speed
      const chassisAccelMult = 1 + (3 - tn.chassis) * 0.08; // lighter = more accel
      const chassisSlopeMult = 1 + (tn.chassis - 3) * 0.10; // heavier = less hurt by slope
      // Connected gears that use Titanium negate their efficiency penalty (like the upgrade, but per-gear).
      // Helical gears each give a small top-speed bonus.
      const connectedGearObjs = gears.filter(g => connectedGears.includes(g.id));
      const titaniumCount = connectedGearObjs.filter(g => g.material === 'titanium').length;
      const helicalCount  = connectedGearObjs.filter(g => g.material === 'helical').length;
      const heavyCount    = connectedGearObjs.filter(g => g.material === 'heavy').length;
      const effectivePenaltyCount = Math.max(0, connectedGears.length - titaniumCount);
      const efficiency = hasUpgrade('titanium_gears') ? 1 : Math.max(0.5, 1 - (effectivePenaltyCount * 0.02));
      const gboxMult = gearboxRatiosRef.current[currentGearRef.current - 1] ?? 1;
      const effectiveRatio = Math.max(0.05, gearRatio * gboxMult);
      const helicalTopMult = 1 + helicalCount * 0.10; // +10% top speed per helical gear
      const intakeMult = hasUpgrade('precision_intake') ? 1.08 : 1; // Precision Intake → +8% top speed
      let topSpeed = (200 + (effectiveRatio * 300 * efficiency)) * turboTopMult * helicalTopMult * intakeMult;
      let baseTorque = 150 * efficiency * (hasUpgrade('nitro_system') ? 1.25 : 1);
      const currentTorque = effectiveRatio > 0 ? baseTorque / Math.max(0.3, Math.pow(effectiveRatio, 0.7)) : 0;
      let acceleration = currentTorque * chassisAccelMult;

      // Slope (hills): positive = uphill, negative = downhill
      const slope = slopeAt(localDistance);
      
      // Apply Boost
      if (localBoostTimer > 0) {
        topSpeed *= 1.5;
        acceleration *= 2;
        localBoostTimer -= dt;
        setBoostTime(localBoostTimer);
      }

      // Aero Chassis cuts air resistance ~40%.
      const drag = 0.5 * (hasUpgrade('aero_chassis') ? 0.6 : 1);
      const friction = 20; // Ground friction

      // Brake power scales with brake tuning (level 1 = 70%, level 5 = 130%).
      const brakePower = 600 * (1 + (tn.brakes - 3) * 0.15);
      if (activeAcceleration) {
        localSpeed = Math.min(topSpeed, localSpeed + acceleration * dt);
      } else if (brake) {
        localSpeed = Math.max(0, localSpeed - brakePower * dt);
      } else {
        // Natural deceleration
        localSpeed = Math.max(0, localSpeed - (friction + localSpeed * drag * 0.01) * dt);
      }

      // Slope physics: heavier chassis fights gravity better (smaller pull).
      const gravityPull = (slope * 700) / chassisSlopeMult;
      localSpeed = Math.max(0, Math.min(topSpeed * 1.25, localSpeed - gravityPull * dt));

      localDistance += localSpeed * dt;
      setDistance(localDistance);
      setCurrentSpeed(localSpeed);
      // Throttled slope HUD update (every other frame is fine — small object, cheap)
      setCurrentSlope(slope);
      
      // Update missions
      updateMissionProgress('speed', localSpeed / 10);
      updateMissionProgress('distance', localSpeed * dt);

      // Lane interpolation — better tires = sharper steering response.
      // Magnetic Tires upgrade adds another +50% on top.
      const tireResponse = 10 * (1 + (tn.tires - 3) * 0.15) * (hasUpgrade('magnetic_tires') ? 1.5 : 1);
      const diff = targetLaneRef.current - localPlayerLane;
      if (Math.abs(diff) < 0.01) localPlayerLane = targetLaneRef.current;
      else localPlayerLane += diff * tireResponse * dt;
      setPlayerLane(localPlayerLane);

      // Heat management — driven primarily by ENGINE RPM, which is proportional to
      // (speed / torque). High torque setup → lower RPM at any given speed → less heat.
      // Low torque setup → higher RPM to chase top speed → much more heat.
      const overRev = Math.max(0, (localSpeed / Math.max(50, topSpeed)) - 0.95) * 8;
      // Cooling tuning: level 1 = +50% heat, level 5 = -40% heat. Stacks with super_cooler.
      const coolMult = (1 - (tn.cooling - 3) * 0.18) * (hasUpgrade('super_cooler') ? 0.6 : 1);
      const coolDecay = 6 * (1 + (tn.cooling - 3) * 0.25); // off-throttle cool-down (slightly faster)
      // RPM proxy — high when speed is high relative to available torque.
      // currentTorque ~ baseTorque / ratio^0.7; higher ratio (lower torque) → larger rpmHeat.
      // Heavy-Duty gears reduce gear-related heat by 30% per gear (cap at -75%).
      const heavyHeatMult = Math.max(0.25, 1 - heavyCount * 0.30);
      const rpmHeat = (localSpeed / Math.max(20, currentTorque)) * 1.4 * heavyHeatMult;
      if (activeAcceleration) {
        const slopeHeat = Math.max(0, slope) * 14; // uphill burst, slightly softer
        const heatGen = (rpmHeat + slopeHeat + overRev) * coolMult;
        localEngineTemp = Math.min(100, localEngineTemp + heatGen * dt);
      } else {
        // Engine still warms a bit going uphill even off-throttle
        const idleHeat = Math.max(0, slope) * 3 + overRev * 0.4;
        localEngineTemp = Math.max(20, localEngineTemp + (idleHeat - coolDecay) * dt);
      }
      setEngineTemp(localEngineTemp);

      // Brake heat: better brakes shed less heat per unit work but apply harder.
      // Carbon Brakes upgrade halves brake heat on top of tuning.
      const brakeHeatMult = (1 - (tn.brakes - 3) * 0.10) * (hasUpgrade('carbon_brakes') ? 0.5 : 1);
      if (brake) {
        const downhillBoost = Math.max(0, -slope) * 60;
        setBrakeTemp(prev => Math.min(100, prev + (20 + downhillBoost) * brakeHeatMult * dt));
      } else {
        setBrakeTemp(prev => Math.max(20, prev - 10 * dt));
      }

      // Heat Shield upgrade pushes the explode threshold from 90°C → 100°C.
      const overheatThreshold = hasUpgrade('heat_shield') ? 100 : 90;
      if (localEngineTemp >= overheatThreshold) {
        setGameState('exploded');
        if (gameMode === 'multi' && auth.currentUser) {
          // Just update our own state, the winner's listener or common room listener will handle the rest
          const playerRef = doc(db, 'rooms', roomId, 'players', auth.currentUser.uid);
          updateDoc(playerRef, { isExploded: true }).catch(console.error);
        }
        sounds.stopEngine();
        return;
      }

      if (localDistance >= TRACK_LENGTH) {
        setGameState('finished');
        
        // Rewards and Missions — Coin Magnet boosts the finish payout 50%.
        const baseReward = gameMode === 'multi' ? 300 : 100;
        const reward = Math.round(baseReward * (hasUpgrade('coin_magnet') ? 1.5 : 1));
        addCredits(reward);
        setTotalWins(w => w + 1);
        updateMissionProgress('win', 1, true);
        updateMissionProgress('temp', localEngineTemp, true);

        if (gameMode === 'multi' && auth.currentUser) {
          updateDoc(doc(db, 'rooms', roomId), {
            status: 'finished',
            winnerId: auth.currentUser.uid,
            winReason: 'crossed finish line'
          });
        }
        return;
      }

      // Obstacle generation (Distance-based for better spacing)
      if (localDistance > nextObstacleZRef.current) {
        const r = Math.random();
        const type = r < 0.30 ? 'truck'
                   : r < 0.55 ? 'car'
                   : r < 0.78 ? 'van'
                   : r < 0.92 ? 'bike'
                   : 'bus';
        localObstacles.push({
          id: Math.random().toString(36).substr(2, 9),
          lane: Math.floor(Math.random() * 3) - 1,
          z: localDistance + 2500,
          type
        });
        nextObstacleZRef.current = localDistance + 400 + Math.random() * 600;
      }

      // Filter and collision
      localObstacles = localObstacles.filter(obs => {
        const relativeZ = obs.z - localDistance;
        
        // Collision detection
        if (relativeZ < 50 && relativeZ > -50 && Math.abs(obs.lane - targetLaneRef.current) < 0.5) {
          // Better tires soften the crash (less heat, less speed lost).
          const grip = 1 + (tn.tires - 3) * 0.15;
          // Reinforced Bumper halves both the heat damage and the speed lost.
          const bumperMult = hasUpgrade('reinforced_bumper') ? 0.5 : 1;
          localEngineTemp += (15 / grip) * bumperMult;
          // Speed retention: with bumper, lerp halfway back to the pre-crash speed.
          const crashedSpeed = localSpeed * Math.min(0.7, 0.4 * grip);
          localSpeed = crashedSpeed + (localSpeed - crashedSpeed) * (1 - bumperMult);
          screenShake = 20; // Trigger screen shake
          localBoostTimer = 0; // Cancel boost on hit
          sounds.playCrash();
          audioBus.playSfx('crash');
          return false;
        }

        // Near Miss Detection (Trigger when approaching closely)
        if (relativeZ > 0 && relativeZ < 150 && !obs.processed) {
          const lateralDist = Math.abs(localPlayerLane - obs.lane);
          const zDistSinceChange = localDistance - lastLaneChangeZRef.current;
          
          // Only trigger if we just changed lane or are in a different lane
          if (lateralDist > 0.6 && lateralDist < 1.4 && zDistSinceChange < 300) {
            obs.processed = true;
            let boost = 0;
            let msg = "";
            
            if (lateralDist < 0.8) { boost = 6; msg = "EXTREME MISS! 6s"; }
            else if (lateralDist < 1.0) { boost = 4; msg = "CLOSE MISS! 4s"; }
            else if (lateralDist < 1.3) { boost = 2; msg = "NEAR MISS! 2s"; }
            
            if (boost > 0) {
              // Turbo tuning extends boost duration (level 1 = 80%, level 5 = 130%).
              const turboDur = 1 + (tn.turbo - 3) * 0.12;
              // Reserve Tank stretches near-miss boosts ×1.6.
              const reserveDur = hasUpgrade('reserve_tank') ? 1.6 : 1;
              boost *= turboDur * reserveDur;
              localBoostTimer = Math.max(localBoostTimer, boost); // Calculate the latest best boost, don't stack
              setBoostTime(localBoostTimer);
              setLastBoostType('NEAR MISS');
              nearMissTextRef.current = { text: msg, x: 0, y: 0, opacity: 1 };
              sounds.playBoost();
              audioBus.playSfx('boost');
            }
          }
        }
        
        return relativeZ > -100;
      });
      setObstacles([...localObstacles]);

      // Rendering
      const w = canvasSize.width;
      const h = canvasSize.height;
      canvas.width = w;
      canvas.height = h;

      // Horizon shifts a little with slope (camera pitch feel).
      const visualSlope = slopeAt(localDistance + 600);
      const baseHorizon = h * 0.45;
      const horizon = Math.max(h * 0.25, Math.min(h * 0.62, baseHorizon + visualSlope * h * 0.18));
      const LANE_WIDTH_BOTTOM = w < 640 ? w * 0.6 : w * 0.4; // Wider road on mobile
      const LANE_WIDTH_HORIZON = w * 0.02; // 2% of canvas at horizon

      const getX = (lane: number, s: number) => {
        const spread = LANE_WIDTH_HORIZON + (LANE_WIDTH_BOTTOM - LANE_WIDTH_HORIZON) * s;
        return w/2 + (lane * spread);
      };

      // yAt(s): vertical position for perspective fraction s in [0..1].
      // Adds a smooth vertical "bend" for hills so the road visually climbs/dips.
      // s = perspective scale (0 = horizon, 1 = foreground / camera).
      // We use a *bounded* look-ahead instead of true inverse perspective —
      // otherwise adjacent samples near the horizon would land thousands of
      // units apart in z and produce a chaotic, jittery road.
      const MAX_LOOK_AHEAD = 2000;
      const yAt = (s: number) => {
        const baseY = horizon + (h - horizon) * s;
        // Quadratic falloff: smooth, max look-ahead at horizon, 0 at camera.
        const t = 1 - s;
        const zRel = t * t * MAX_LOOK_AHEAD;
        const slopeAhead = slopeAt(localDistance + zRel);
        // Negative slope (downhill) pulls road DOWN visually; positive UP.
        // Magnitude tapers near foreground so the camera stays anchored to the car.
        const taper = Math.pow(t, 0.7);
        const bend = -slopeAhead * (h - horizon) * 0.6 * taper;
        return baseY + bend;
      };

      ctx.save();
      if (screenShake > 0) {
        ctx.translate((Math.random() - 0.5) * screenShake, (Math.random() - 0.5) * screenShake);
        screenShake *= 0.9;
        if (screenShake < 1) screenShake = 0;
      }

      ctx.clearRect(0, 0, w, h);

      // Sky Gradient — bright vivid blue like the cover, lighter near horizon
      const skyGrad = ctx.createLinearGradient(0, 0, 0, horizon);
      skyGrad.addColorStop(0, '#1d4ed8');  // Rich royal blue at top
      skyGrad.addColorStop(0.5, '#3b82f6'); // Sky blue
      skyGrad.addColorStop(1, '#bae6fd');  // Pale haze at horizon
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, w, horizon);

      // Sun position (upper-right like the cover)
      const sunX = w * 0.82;
      const sunY = h * 0.16;

      // Sun rays — soft radial lens flare
      const rayGrad = ctx.createRadialGradient(sunX, sunY, 8, sunX, sunY, w * 0.55);
      rayGrad.addColorStop(0, 'rgba(255, 245, 200, 0.55)');
      rayGrad.addColorStop(0.15, 'rgba(255, 230, 150, 0.25)');
      rayGrad.addColorStop(0.5, 'rgba(255, 230, 150, 0.05)');
      rayGrad.addColorStop(1, 'rgba(255, 230, 150, 0)');
      ctx.fillStyle = rayGrad;
      ctx.fillRect(0, 0, w, horizon);

      // Sun core (bright white-yellow with strong glow)
      ctx.shadowBlur = 60;
      ctx.shadowColor = '#fde68a';
      ctx.fillStyle = '#fefce8';
      ctx.beginPath();
      ctx.arc(sunX, sunY, 28, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      // Outer halo
      ctx.fillStyle = 'rgba(254, 240, 138, 0.5)';
      ctx.beginPath();
      ctx.arc(sunX, sunY, 42, 0, Math.PI * 2);
      ctx.fill();

      // Soft puffy clouds
      const drawCloud = (cx: number, cy: number, size: number, alpha: number = 0.55) => {
        ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
        ctx.beginPath();
        ctx.arc(cx, cy, size, 0, Math.PI * 2);
        ctx.arc(cx + size * 0.6, cy - size * 0.2, size * 0.8, 0, Math.PI * 2);
        ctx.arc(cx + size * 1.2, cy, size * 0.7, 0, Math.PI * 2);
        ctx.arc(cx + size * 0.3, cy + size * 0.15, size * 0.7, 0, Math.PI * 2);
        ctx.fill();
      };
      drawCloud(w * 0.18, h * 0.12, 22, 0.55);
      drawCloud(w * 0.45, h * 0.07, 16, 0.45);
      drawCloud(w * 0.62, h * 0.18, 18, 0.4);
      drawCloud(w * 0.05, h * 0.22, 14, 0.35);

      // Distant mountains — far layer (light blue/grey haze)
      ctx.fillStyle = '#7dd3fc';
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      ctx.moveTo(0, horizon);
      ctx.lineTo(w * 0.05, horizon - 18);
      ctx.lineTo(w * 0.15, horizon - 35);
      ctx.lineTo(w * 0.25, horizon - 22);
      ctx.lineTo(w * 0.38, horizon - 48);
      ctx.lineTo(w * 0.5, horizon - 30);
      ctx.lineTo(w * 0.65, horizon - 55);
      ctx.lineTo(w * 0.78, horizon - 25);
      ctx.lineTo(w * 0.92, horizon - 40);
      ctx.lineTo(w, horizon - 15);
      ctx.lineTo(w, horizon);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;

      // Closer mountains — darker silhouette
      ctx.fillStyle = '#1e3a8a';
      ctx.beginPath();
      ctx.moveTo(0, horizon);
      ctx.lineTo(w * 0.1, horizon - 12);
      ctx.lineTo(w * 0.22, horizon - 28);
      ctx.lineTo(w * 0.32, horizon - 8);
      ctx.lineTo(w * 0.45, horizon - 22);
      ctx.lineTo(w * 0.6, horizon - 40);
      ctx.lineTo(w * 0.72, horizon - 18);
      ctx.lineTo(w * 0.85, horizon - 32);
      ctx.lineTo(w, horizon - 10);
      ctx.lineTo(w, horizon);
      ctx.closePath();
      ctx.fill();

      // Vivid grass — bright track-side green like the cover
      const grassGrad = ctx.createLinearGradient(0, horizon, 0, h);
      grassGrad.addColorStop(0, '#16a34a');
      grassGrad.addColorStop(0.5, '#15803d');
      grassGrad.addColorStop(1, '#14532d');
      ctx.fillStyle = grassGrad;
      ctx.fillRect(0, horizon, w, h - horizon);

      // Horizon haze line — softens the grass/sky transition
      const hazeGrad = ctx.createLinearGradient(0, horizon - 4, 0, horizon + 8);
      hazeGrad.addColorStop(0, 'rgba(186, 230, 253, 0)');
      hazeGrad.addColorStop(0.5, 'rgba(186, 230, 253, 0.65)');
      hazeGrad.addColorStop(1, 'rgba(34, 197, 94, 0)');
      ctx.fillStyle = hazeGrad;
      ctx.fillRect(0, horizon - 4, w, 12);

      // Draw Road as N vertical strips. Lighter asphalt with subtle gradient near foreground.
      const ROAD_STRIPS = 36;
      for (let i = 0; i < ROAD_STRIPS; i++) {
        const s1 = i / ROAD_STRIPS;
        const s2 = (i + 1) / ROAD_STRIPS;
        const y1 = yAt(s1);
        const y2 = yAt(s2);
        // Darker far away, slightly lighter near camera
        const shade = 30 + Math.floor(s2 * 22);
        ctx.fillStyle = `rgb(${shade}, ${shade}, ${shade + 2})`;
        ctx.beginPath();
        ctx.moveTo(getX(-1.8, s1), y1);
        ctx.lineTo(getX(1.8, s1), y1);
        ctx.lineTo(getX(1.8, s2), y2);
        ctx.lineTo(getX(-1.8, s2), y2);
        ctx.closePath();
        ctx.fill();
      }
      // Grass on the SIDES of the bent road.
      ctx.fillStyle = '#15803d';
      // Left side
      ctx.beginPath();
      ctx.moveTo(0, h);
      ctx.lineTo(0, yAt(0));
      for (let i = 0; i <= ROAD_STRIPS; i++) {
        const s = i / ROAD_STRIPS;
        ctx.lineTo(getX(-1.8, s), yAt(s));
      }
      ctx.lineTo(getX(-1.8, 1), h);
      ctx.closePath();
      ctx.fill();
      // Right side
      ctx.beginPath();
      ctx.moveTo(w, h);
      ctx.lineTo(w, yAt(0));
      for (let i = 0; i <= ROAD_STRIPS; i++) {
        const s = i / ROAD_STRIPS;
        ctx.lineTo(getX(1.8, s), yAt(s));
      }
      ctx.lineTo(getX(1.8, 1), h);
      ctx.closePath();
      ctx.fill();

      // ─── Procedural roadside scenery ───────────────────────────────────────
      // Deterministic per-bucket placement so the world feels stable as the
      // camera moves; depth-sorted far-first so closer items paint on top.
      {
        type SceneryKind = 'tree_pine' | 'tree_round' | 'rock' | 'billboard';
        type Scenery = { z: number; lane: number; kind: SceneryKind; seed: number };
        const BUCKET = 70;
        const VIEW_FAR = 2500;
        const hash = (n: number) => {
          let x = (n | 0) ^ 0x9e3779b9;
          x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
          x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
          return ((x ^ (x >>> 16)) >>> 0) / 4294967295;
        };
        const sceneryItems: Scenery[] = [];
        const startBucket = Math.floor(localDistance / BUCKET);
        const endBucket = Math.floor((localDistance + VIEW_FAR) / BUCKET);
        for (let b = startBucket; b <= endBucket; b++) {
          for (const side of [-1, 1] as const) {
            const r0 = hash(b * 131 + side * 7);
            if (r0 < 0.15) continue;
            const count = r0 < 0.55 ? 1 : r0 < 0.85 ? 2 : 3;
            for (let i = 0; i < count; i++) {
              const r1 = hash(b * 131 + side * 7 + i * 11 + 1);
              const r2 = hash(b * 131 + side * 7 + i * 13 + 2);
              const r3 = hash(b * 131 + side * 7 + i * 17 + 3);
              const z = b * BUCKET + r1 * BUCKET;
              const offset = 2.15 + r2 * 1.5; // ±2.15..±3.65 → just outside the rumble strips
              const lane = side * offset;
              let kind: SceneryKind;
              if (r3 < 0.45) kind = 'tree_pine';
              else if (r3 < 0.75) kind = 'tree_round';
              else if (r3 < 0.93) kind = 'rock';
              else kind = 'billboard';
              sceneryItems.push({ z, lane, kind, seed: Math.floor(r3 * 1000) });
            }
          }
        }
        sceneryItems.sort((a, b) => b.z - a.z); // far → near
        const billboardLabels = ['SHELL', 'GO!', 'GEAR', 'TURBO', 'V8', 'NITRO', 'PIT'];
        const billboardColors = ['#dc2626', '#2563eb', '#facc15', '#16a34a', '#9333ea'];
        for (const item of sceneryItems) {
          const relZ = item.z - localDistance;
          if (relZ < 0 || relZ > VIEW_FAR) continue;
          const scale = 800 / (relZ + 800);
          const sx = getX(item.lane, scale);
          const sy = yAt(scale);
          // Distance fog: fade out into the horizon.
          const fog = Math.max(0.15, 1 - relZ / VIEW_FAR);
          ctx.globalAlpha = fog;

          if (item.kind === 'tree_pine') {
            const sz = 90 * scale;
            ctx.fillStyle = '#5b3a1a';
            ctx.fillRect(sx - sz * 0.05, sy - sz * 0.3, sz * 0.1, sz * 0.3);
            ctx.fillStyle = '#1f6f3b';
            for (let t = 0; t < 3; t++) {
              const yT = sy - sz * 0.3 - t * sz * 0.25;
              const wT = sz * 0.5 - t * sz * 0.1;
              ctx.beginPath();
              ctx.moveTo(sx - wT, yT);
              ctx.lineTo(sx + wT, yT);
              ctx.lineTo(sx, yT - sz * 0.35);
              ctx.closePath();
              ctx.fill();
            }
          } else if (item.kind === 'tree_round') {
            const sz = 80 * scale;
            ctx.fillStyle = '#5b3a1a';
            ctx.fillRect(sx - sz * 0.05, sy - sz * 0.3, sz * 0.1, sz * 0.3);
            ctx.fillStyle = '#2d8a4a';
            ctx.beginPath();
            ctx.arc(sx, sy - sz * 0.55, sz * 0.4, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#3aa55c';
            ctx.beginPath();
            ctx.arc(sx - sz * 0.15, sy - sz * 0.65, sz * 0.28, 0, Math.PI * 2);
            ctx.fill();
          } else if (item.kind === 'rock') {
            const sz = 50 * scale;
            ctx.fillStyle = '#6b6b6b';
            ctx.beginPath();
            ctx.ellipse(sx, sy - sz * 0.2, sz * 0.5, sz * 0.35, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#8a8a8a';
            ctx.beginPath();
            ctx.ellipse(sx - sz * 0.1, sy - sz * 0.32, sz * 0.25, sz * 0.18, 0, 0, Math.PI * 2);
            ctx.fill();
          } else { // billboard
            const sz = 130 * scale;
            ctx.fillStyle = '#3f3f46';
            ctx.fillRect(sx - sz * 0.45, sy - sz * 0.3, sz * 0.05, sz * 0.3);
            ctx.fillRect(sx + sz * 0.4, sy - sz * 0.3, sz * 0.05, sz * 0.3);
            ctx.fillStyle = billboardColors[item.seed % billboardColors.length];
            ctx.fillRect(sx - sz * 0.5, sy - sz * 0.7, sz, sz * 0.4);
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = Math.max(1, scale * 2);
            ctx.strokeRect(sx - sz * 0.5, sy - sz * 0.7, sz, sz * 0.4);
            ctx.fillStyle = '#ffffff';
            const fs = Math.max(6, sz * 0.13);
            ctx.font = `900 ${fs}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(billboardLabels[item.seed % billboardLabels.length], sx, sy - sz * 0.5);
            ctx.textAlign = 'start';
            ctx.textBaseline = 'alphabetic';
          }
        }
        ctx.globalAlpha = 1;
      }

      // Rumble Strips (Side of road) — bold red/white checker like the cover.
      // Each block fully spans 1 unit of z (no half-step) so blocks don't overlap or look striped.
      const stripCount = 24;
      const rumbleInner = 1.62;
      const rumbleOuter = 1.92;
      for (let i = 0; i < stripCount; i++) {
        const zPos = ((localDistance / 90) + i) % stripCount;
        const s1 = 1 - (zPos / stripCount);
        const s2 = 1 - ((zPos + 1) / stripCount);
        if (s1 <= 0.001 || s2 <= 0.001) continue;

        const isWhite = Math.floor(zPos) % 2 === 0;
        const ry1 = yAt(s1);
        const ry2 = yAt(s2);

        // Left curb — solid block
        ctx.fillStyle = isWhite ? '#ffffff' : '#dc2626';
        ctx.beginPath();
        ctx.moveTo(getX(-rumbleOuter, s1), ry1);
        ctx.lineTo(getX(-rumbleInner, s1), ry1);
        ctx.lineTo(getX(-rumbleInner, s2), ry2);
        ctx.lineTo(getX(-rumbleOuter, s2), ry2);
        ctx.closePath();
        ctx.fill();

        // Right curb — solid block
        ctx.beginPath();
        ctx.moveTo(getX(rumbleInner, s1), ry1);
        ctx.lineTo(getX(rumbleOuter, s1), ry1);
        ctx.lineTo(getX(rumbleOuter, s2), ry2);
        ctx.lineTo(getX(rumbleInner, s2), ry2);
        ctx.closePath();
        ctx.fill();
      }
      // Thin dark separator line between curb and asphalt — gives that crisp painted-edge look
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i <= 24; i++) {
        const s = i / 24;
        const xL = getX(-rumbleInner, s);
        const xR = getX(rumbleInner, s);
        const yy = yAt(s);
        if (i === 0) {
          ctx.moveTo(xL, yy);
        } else {
          ctx.lineTo(xL, yy);
        }
        // We'll draw the right line in a second pass
      }
      ctx.stroke();
      ctx.beginPath();
      for (let i = 0; i <= 24; i++) {
        const s = i / 24;
        const xR = getX(rumbleInner, s);
        const yy = yAt(s);
        if (i === 0) ctx.moveTo(xR, yy); else ctx.lineTo(xR, yy);
      }
      ctx.stroke();

      // Lane Lines — bent dashed segments that *flow* from horizon → camera
      // for a real sense of forward motion. Same scroll rhythm as the rumble
      // strips so curbs and dashes feel locked together.
      ctx.strokeStyle = localBoostTimer > 0 ? '#fbbf24' : 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 2;
      const LANE_SEGMENTS = 18;
      const LANE_SCROLL_DIVISOR = 90; // matches the rumble-strip scroll rate
      for (let lane = -0.5; lane <= 0.5; lane += 1) {
        for (let i = 0; i < LANE_SEGMENTS; i++) {
          // zPos slides smoothly toward the camera as localDistance grows.
          const zPos = ((localDistance / LANE_SCROLL_DIVISOR) + i) % LANE_SEGMENTS;
          // Each slot = dash + gap; first half of slot is the painted dash.
          const s1 = 1 - (zPos / LANE_SEGMENTS);                 // closer end
          const s2 = 1 - ((zPos + 0.5) / LANE_SEGMENTS);         // farther end
          if (s1 <= 0.001 || s2 <= 0.001) continue;
          ctx.beginPath();
          ctx.moveTo(getX(lane, s1), yAt(s1));
          ctx.lineTo(getX(lane, s2), yAt(s2));
          ctx.stroke();
        }
      }

      // Draw Obstacles
      localObstacles.forEach(obs => {
        const relZ = obs.z - localDistance;
        if (relZ < 0 || relZ > 3000) return; // Increased view distance

        const scale = 800 / (relZ + 800); // Increased perspective constant for "further" feel
        const x = getX(obs.lane, scale);
        const y = yAt(scale);
        const size = 78 * scale; // Bumped up from 60 for chunkier presence

        // Soft shadow under every vehicle
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.beginPath();
        ctx.ellipse(x, y + size * 0.04, size * 0.55, size * 0.12, 0, 0, Math.PI * 2);
        ctx.fill();

        if (obs.type === 'truck') {
          const truckW = size * 1.1;
          const truckH = size * 1.35;
          // Trailer body with subtle vertical gradient
          const grad = ctx.createLinearGradient(x, y - truckH, x, y);
          grad.addColorStop(0, '#64748b');
          grad.addColorStop(1, '#334155');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.roundRect(x - truckW/2, y - truckH, truckW, truckH - size * 0.12, 6 * scale);
          ctx.fill();
          // Top highlight band
          ctx.fillStyle = 'rgba(255,255,255,0.06)';
          ctx.fillRect(x - truckW/2 + 3 * scale, y - truckH + 3 * scale, truckW - 6 * scale, size * 0.08);
          // Center door seam
          ctx.strokeStyle = 'rgba(0,0,0,0.45)';
          ctx.lineWidth = Math.max(1, 1.5 * scale);
          ctx.beginPath();
          ctx.moveTo(x, y - truckH + 4 * scale);
          ctx.lineTo(x, y - size * 0.15);
          ctx.stroke();
          // Door handles
          ctx.fillStyle = '#cbd5e1';
          ctx.fillRect(x - size * 0.12, y - size * 0.55, size * 0.05, size * 0.04);
          ctx.fillRect(x + size * 0.07, y - size * 0.55, size * 0.05, size * 0.04);
          // Tail Lights with glow
          ctx.fillStyle = '#ef4444';
          ctx.shadowBlur = 18 * scale;
          ctx.shadowColor = '#ef4444';
          ctx.fillRect(x - truckW/2 + 6 * scale, y - size * 0.32, size * 0.18, size * 0.12);
          ctx.fillRect(x + truckW/2 - 6 * scale - size * 0.18, y - size * 0.32, size * 0.18, size * 0.12);
          ctx.shadowBlur = 0;
          // Bumper
          ctx.fillStyle = '#0f172a';
          ctx.fillRect(x - truckW/2 - 2 * scale, y - size * 0.18, truckW + 4 * scale, size * 0.06);
          // Wheels
          ctx.fillStyle = '#0a0a0a';
          ctx.beginPath();
          ctx.roundRect(x - truckW/2 + 2 * scale, y - size * 0.12, size * 0.22, size * 0.12, 3 * scale);
          ctx.roundRect(x + truckW/2 - 2 * scale - size * 0.22, y - size * 0.12, size * 0.22, size * 0.12, 3 * scale);
          ctx.fill();
        } else if (obs.type === 'bus') {
          const busW = size * 1.2;
          const busH = size * 1.45;
          // Bus body — yellow school-bus style
          const grad = ctx.createLinearGradient(x, y - busH, x, y);
          grad.addColorStop(0, '#fde047');
          grad.addColorStop(1, '#ca8a04');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.roundRect(x - busW/2, y - busH, busW, busH - size * 0.12, 8 * scale);
          ctx.fill();
          // Window strip
          ctx.fillStyle = 'rgba(15,23,42,0.85)';
          ctx.fillRect(x - busW/2 + 5 * scale, y - busH + 6 * scale, busW - 10 * scale, size * 0.32);
          // Window dividers
          ctx.strokeStyle = '#ca8a04';
          ctx.lineWidth = Math.max(1, 1.5 * scale);
          for (let i = 1; i < 4; i++) {
            const wx = x - busW/2 + 5 * scale + (busW - 10 * scale) * (i / 4);
            ctx.beginPath();
            ctx.moveTo(wx, y - busH + 6 * scale);
            ctx.lineTo(wx, y - busH + 6 * scale + size * 0.32);
            ctx.stroke();
          }
          // Side stripe
          ctx.fillStyle = '#000';
          ctx.fillRect(x - busW/2 + 4 * scale, y - size * 0.55, busW - 8 * scale, size * 0.06);
          // Tail lights
          ctx.fillStyle = '#ef4444';
          ctx.shadowBlur = 15 * scale;
          ctx.shadowColor = '#ef4444';
          ctx.fillRect(x - busW/2 + 6 * scale, y - size * 0.32, size * 0.16, size * 0.1);
          ctx.fillRect(x + busW/2 - 6 * scale - size * 0.16, y - size * 0.32, size * 0.16, size * 0.1);
          ctx.shadowBlur = 0;
          // Bumper
          ctx.fillStyle = '#1f2937';
          ctx.fillRect(x - busW/2 - 2 * scale, y - size * 0.18, busW + 4 * scale, size * 0.06);
          // Wheels
          ctx.fillStyle = '#0a0a0a';
          ctx.beginPath();
          ctx.roundRect(x - busW/2 + 4 * scale, y - size * 0.12, size * 0.2, size * 0.12, 3 * scale);
          ctx.roundRect(x + busW/2 - 4 * scale - size * 0.2, y - size * 0.12, size * 0.2, size * 0.12, 3 * scale);
          ctx.fill();
        } else if (obs.type === 'van') {
          const vanW = size * 0.95;
          const vanH = size * 1.05;
          // Van body — white delivery van
          const grad = ctx.createLinearGradient(x, y - vanH, x, y);
          grad.addColorStop(0, '#f1f5f9');
          grad.addColorStop(1, '#94a3b8');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.roundRect(x - vanW/2, y - vanH, vanW, vanH - size * 0.1, 6 * scale);
          ctx.fill();
          // Roof curve highlight
          ctx.fillStyle = 'rgba(255,255,255,0.4)';
          ctx.fillRect(x - vanW/2 + 4 * scale, y - vanH + 3 * scale, vanW - 8 * scale, size * 0.05);
          // Rear window
          ctx.fillStyle = 'rgba(15,23,42,0.75)';
          ctx.beginPath();
          ctx.roundRect(x - vanW/2 + 6 * scale, y - vanH + size * 0.15, vanW - 12 * scale, size * 0.22, 3 * scale);
          ctx.fill();
          // Door split
          ctx.strokeStyle = 'rgba(0,0,0,0.3)';
          ctx.lineWidth = Math.max(1, 1.2 * scale);
          ctx.beginPath();
          ctx.moveTo(x, y - vanH + size * 0.15);
          ctx.lineTo(x, y - size * 0.12);
          ctx.stroke();
          // Tail lights
          ctx.fillStyle = '#f97316';
          ctx.shadowBlur = 14 * scale;
          ctx.shadowColor = '#f97316';
          ctx.fillRect(x - vanW/2 + 4 * scale, y - size * 0.28, size * 0.13, size * 0.1);
          ctx.fillRect(x + vanW/2 - 4 * scale - size * 0.13, y - size * 0.28, size * 0.13, size * 0.1);
          ctx.shadowBlur = 0;
          // Bumper
          ctx.fillStyle = '#1f2937';
          ctx.fillRect(x - vanW/2 - 2 * scale, y - size * 0.16, vanW + 4 * scale, size * 0.05);
          // Wheels
          ctx.fillStyle = '#0a0a0a';
          ctx.beginPath();
          ctx.roundRect(x - vanW/2 + 3 * scale, y - size * 0.1, size * 0.18, size * 0.1, 3 * scale);
          ctx.roundRect(x + vanW/2 - 3 * scale - size * 0.18, y - size * 0.1, size * 0.18, size * 0.1, 3 * scale);
          ctx.fill();
        } else if (obs.type === 'car') {
          const carW = size * 0.9;
          const carH = size * 0.7;
          // Car body — sporty blue sedan
          const grad = ctx.createLinearGradient(x, y - carH, x, y);
          grad.addColorStop(0, '#3b82f6');
          grad.addColorStop(1, '#1e40af');
          ctx.fillStyle = grad;
          // Lower body
          ctx.beginPath();
          ctx.roundRect(x - carW/2, y - carH * 0.55, carW, carH * 0.45, 5 * scale);
          ctx.fill();
          // Cabin / roof
          ctx.beginPath();
          ctx.moveTo(x - carW * 0.35, y - carH * 0.55);
          ctx.lineTo(x - carW * 0.28, y - carH);
          ctx.lineTo(x + carW * 0.28, y - carH);
          ctx.lineTo(x + carW * 0.35, y - carH * 0.55);
          ctx.closePath();
          ctx.fill();
          // Rear window
          ctx.fillStyle = 'rgba(15,23,42,0.85)';
          ctx.beginPath();
          ctx.moveTo(x - carW * 0.30, y - carH * 0.58);
          ctx.lineTo(x - carW * 0.24, y - carH * 0.95);
          ctx.lineTo(x + carW * 0.24, y - carH * 0.95);
          ctx.lineTo(x + carW * 0.30, y - carH * 0.58);
          ctx.closePath();
          ctx.fill();
          // Tail lights
          ctx.fillStyle = '#ef4444';
          ctx.shadowBlur = 16 * scale;
          ctx.shadowColor = '#ef4444';
          ctx.fillRect(x - carW/2 + 3 * scale, y - carH * 0.45, size * 0.12, size * 0.07);
          ctx.fillRect(x + carW/2 - 3 * scale - size * 0.12, y - carH * 0.45, size * 0.12, size * 0.07);
          ctx.shadowBlur = 0;
          // License plate
          ctx.fillStyle = '#fde68a';
          ctx.fillRect(x - size * 0.12, y - carH * 0.32, size * 0.24, size * 0.08);
          // Bumper
          ctx.fillStyle = '#0f172a';
          ctx.fillRect(x - carW/2 - 2 * scale, y - size * 0.13, carW + 4 * scale, size * 0.04);
          // Wheels
          ctx.fillStyle = '#0a0a0a';
          ctx.beginPath();
          ctx.roundRect(x - carW/2 + 2 * scale, y - size * 0.09, size * 0.18, size * 0.09, 3 * scale);
          ctx.roundRect(x + carW/2 - 2 * scale - size * 0.18, y - size * 0.09, size * 0.18, size * 0.09, 3 * scale);
          ctx.fill();
        } else {
          // Bike (Rear View) — refined
          const bikeW = size * 0.5;
          const bikeH = size * 0.95;
          // Rear tire
          ctx.fillStyle = '#0a0a0a';
          ctx.beginPath();
          ctx.roundRect(x - bikeW/5, y - size * 0.22, (bikeW/5) * 2, size * 0.22, 3 * scale);
          ctx.fill();
          // Tail / fairing
          const grad = ctx.createLinearGradient(x, y - bikeH, x, y - size * 0.3);
          grad.addColorStop(0, '#f43f5e');
          grad.addColorStop(1, '#9f1239');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.moveTo(x - bikeW/2, y - size * 0.3);
          ctx.lineTo(x + bikeW/2, y - size * 0.3);
          ctx.lineTo(x + bikeW/4, y - bikeH * 0.85);
          ctx.lineTo(x - bikeW/4, y - bikeH * 0.85);
          ctx.closePath();
          ctx.fill();
          // Rider torso
          ctx.fillStyle = '#1e293b';
          ctx.beginPath();
          ctx.roundRect(x - bikeW/3, y - bikeH - size * 0.15, (bikeW/3) * 2, size * 0.45, 5 * scale);
          ctx.fill();
          // Helmet
          ctx.fillStyle = '#0f172a';
          ctx.beginPath();
          ctx.arc(x, y - bikeH - size * 0.05, size * 0.13, 0, Math.PI * 2);
          ctx.fill();
          // Helmet visor
          ctx.fillStyle = '#38bdf8';
          ctx.beginPath();
          ctx.arc(x, y - bikeH - size * 0.05, size * 0.09, Math.PI * 1.1, Math.PI * 1.9);
          ctx.fill();
          // Rear Light
          ctx.fillStyle = '#ff2d2d';
          ctx.shadowBlur = 12 * scale;
          ctx.shadowColor = '#ff2d2d';
          ctx.beginPath();
          ctx.arc(x, y - size * 0.5, size * 0.06, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
        }
      });

      // Draw Other Players (Ghosts)
      Object.values(otherPlayers).forEach((p: any) => {
        const relZ = p.y - localDistance;
        if (relZ < -300 || relZ > 4000) return;

        const scale = 800 / (relZ + 800);
        const x = getX(p.x, scale);
        const y = yAt(scale);
        
        // Render ghost car
        ctx.save();
        ctx.globalAlpha = 0.4;
        ctx.shadowBlur = 20;
        ctx.shadowColor = '#3b82f6';
        
        // Ghost Body
        ctx.fillStyle = '#3b82f6';
        ctx.beginPath();
        const gSize = 60 * scale;
        ctx.roundRect(x - gSize/2, y - gSize/2, gSize, gSize/2, 6 * scale);
        ctx.fill();
        
        // Ghost identifier
        ctx.globalAlpha = 0.8;
        ctx.fillStyle = '#60a5fa';
        ctx.font = `bold ${Math.max(8, 14 * scale)}px Inter`;
        ctx.textAlign = 'center';
        ctx.fillText(`RIVAL P-${p.id.slice(0, 2)}`, x, y - gSize/2 - 5);
        ctx.restore();
      });

      // Draw Player Car — sleek sports car (rear view) inspired by the cover art
      const carX = getX(localPlayerLane, 0.9);
      const carY = h - 38;
      const cw = 110;  // car width (enlarged)
      const ch = 56;   // car body height (enlarged)
      const isBoost = localBoostTimer > 0;
      const bodyMain = isBoost ? '#fbbf24' : '#dc2626';
      const bodyDark = isBoost ? '#b45309' : '#7f1d1d';
      const bodyLite = isBoost ? '#fde68a' : '#f87171';

      // Ground shadow under car
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.beginPath();
      ctx.ellipse(carX, carY + 14, cw * 0.55, 10, 0, 0, Math.PI * 2);
      ctx.fill();

      // Lower body / diffuser (darkest)
      ctx.fillStyle = '#0a0a0a';
      ctx.beginPath();
      ctx.roundRect(carX - cw/2 - 2, carY + 4, cw + 4, 14, 4);
      ctx.fill();

      // Main body — wedge with rounded sides
      const bodyGrad = ctx.createLinearGradient(carX, carY - ch/2, carX, carY + 8);
      bodyGrad.addColorStop(0, bodyLite);
      bodyGrad.addColorStop(0.5, bodyMain);
      bodyGrad.addColorStop(1, bodyDark);
      ctx.fillStyle = bodyGrad;
      ctx.shadowBlur = isBoost ? 28 : 0;
      ctx.shadowColor = '#fbbf24';
      ctx.beginPath();
      ctx.moveTo(carX - cw/2, carY + 6);
      ctx.lineTo(carX - cw/2 + 4, carY - ch/2 + 6);
      ctx.quadraticCurveTo(carX - cw/2 + 12, carY - ch/2, carX - cw/2 + 18, carY - ch/2);
      ctx.lineTo(carX + cw/2 - 18, carY - ch/2);
      ctx.quadraticCurveTo(carX + cw/2 - 12, carY - ch/2, carX + cw/2 - 4, carY - ch/2 + 6);
      ctx.lineTo(carX + cw/2, carY + 6);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;

      // Roof / cabin (slightly darker for shape)
      ctx.fillStyle = bodyDark;
      ctx.beginPath();
      ctx.moveTo(carX - cw/2 + 16, carY - ch/2 + 2);
      ctx.lineTo(carX - cw/2 + 22, carY - ch/2 - 14);
      ctx.lineTo(carX + cw/2 - 22, carY - ch/2 - 14);
      ctx.lineTo(carX + cw/2 - 16, carY - ch/2 + 2);
      ctx.closePath();
      ctx.fill();

      // Rear window (glossy black with highlight)
      const winGrad = ctx.createLinearGradient(carX, carY - ch/2 - 13, carX, carY - ch/2);
      winGrad.addColorStop(0, '#1e293b');
      winGrad.addColorStop(0.6, '#0f172a');
      winGrad.addColorStop(1, '#020617');
      ctx.fillStyle = winGrad;
      ctx.beginPath();
      ctx.moveTo(carX - cw/2 + 20, carY - ch/2 + 1);
      ctx.lineTo(carX - cw/2 + 24, carY - ch/2 - 12);
      ctx.lineTo(carX + cw/2 - 24, carY - ch/2 - 12);
      ctx.lineTo(carX + cw/2 - 20, carY - ch/2 + 1);
      ctx.closePath();
      ctx.fill();
      // Window highlight
      ctx.fillStyle = 'rgba(125, 211, 252, 0.25)';
      ctx.beginPath();
      ctx.moveTo(carX - cw/2 + 22, carY - ch/2 - 11);
      ctx.lineTo(carX - cw/2 + 26, carY - ch/2 - 11);
      ctx.lineTo(carX - cw/2 + 22, carY - ch/2 - 5);
      ctx.closePath();
      ctx.fill();

      // Rear spoiler
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(carX - cw/2 + 8, carY - ch/2 - 17, cw - 16, 3);
      ctx.fillRect(carX - cw/2 + 12, carY - ch/2 - 14, 4, 4);
      ctx.fillRect(carX + cw/2 - 16, carY - ch/2 - 14, 4, 4);

      // Body horizontal highlight band
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(carX - cw/2 + 6, carY - ch/2 + 8, cw - 12, 2);

      // Center body crease (dark line for shape)
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(carX, carY - ch/2 + 6);
      ctx.lineTo(carX, carY + 4);
      ctx.stroke();

      // Brake lights — wide LED strip (sized relative to car width)
      const brakeW = cw * 0.26;
      ctx.fillStyle = isBraking ? '#ff1d1d' : '#7f1d1d';
      ctx.shadowBlur = isBraking ? 24 : 5;
      ctx.shadowColor = '#ff0000';
      ctx.fillRect(carX - cw/2 + 8, carY - 9, brakeW, 10);
      ctx.fillRect(carX + cw/2 - 8 - brakeW, carY - 9, brakeW, 10);
      // Center brake bar
      if (isBraking) {
        ctx.fillStyle = '#ff4d4d';
        ctx.fillRect(carX - cw * 0.22, carY - ch/2 - 18, cw * 0.44, 3);
      }
      ctx.shadowBlur = 0;

      // License plate
      ctx.fillStyle = '#f1f5f9';
      ctx.fillRect(carX - 16, carY + 2, 32, 11);
      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 9px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('GS-01', carX, carY + 10);

      // Dual exhaust pipes
      const exhX = cw * 0.22;
      ctx.fillStyle = '#1f2937';
      ctx.beginPath();
      ctx.arc(carX - exhX, carY + 18, 4.5, 0, Math.PI * 2);
      ctx.arc(carX + exhX, carY + 18, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(carX - exhX, carY + 18, 2.6, 0, Math.PI * 2);
      ctx.arc(carX + exhX, carY + 18, 2.6, 0, Math.PI * 2);
      ctx.fill();

      // Wheel arches peeking out at the bottom
      ctx.fillStyle = '#0a0a0a';
      ctx.beginPath();
      ctx.roundRect(carX - cw/2 - 3, carY + 10, 17, 14, 4);
      ctx.roundRect(carX + cw/2 - 14, carY + 10, 17, 14, 4);
      ctx.fill();
      
      // Draw Near Miss Text
      if (nearMissTextRef.current) {
        const t = nearMissTextRef.current;
        ctx.fillStyle = `rgba(251, 191, 36, ${t.opacity})`;
        ctx.font = 'bold 24px Inter';
        ctx.textAlign = 'center';
        ctx.fillText(t.text, w/2, h/2 - 50);
        t.opacity -= dt * 1.5;
        if (t.opacity <= 0) nearMissTextRef.current = null;
      }

      ctx.restore();

      // Emit state to Firebase (throttled to 5Hz to save quota)
      if (gameMode === 'multi' && auth.currentUser) {
        const now = Date.now();
        if (!lastSyncTimeRef.current || now - lastSyncTimeRef.current > 200) {
          lastSyncTimeRef.current = now;
          const playerRef = doc(db, 'rooms', roomId, 'players', auth.currentUser.uid);
          setDoc(playerRef, {
            id: auth.currentUser.uid,
            x: playerLane,
            y: localDistance,
            progress: localDistance / TRACK_LENGTH,
            temp: localEngineTemp,
            brakeTemp: brakeTemp,
            gearRatio: gearRatio,
            isExploded: gameState === 'exploded',
            lastUpdate: serverTimestamp()
          }, { merge: true }).catch(() => {}); // silently catch quota errors in main game loop
        }
      }

      animFrame = requestAnimationFrame(update);
    };

    animFrame = requestAnimationFrame(update);

    return () => {
      cancelAnimationFrame(animFrame);
      canvas.remove();
    };
  }, [gameState, canvasSize, gearRatio]);

  // Trigger a sparks burst at the given grid cell (gear coordinates).
  // We translate grid -> approximate pixel offset based on the layout used in the garage canvas.
  const triggerSparks = (gx: number, gy: number) => {
    const cellW = 100, cellH = 100;
    sparkIdRef.current += 1;
    setSparkBurst({ id: sparkIdRef.current, x: gx * cellW + cellW / 2, y: gy * cellH + cellH / 2 });
    window.setTimeout(() => setSparkBurst(curr => (curr && curr.id === sparkIdRef.current) ? null : curr), 600);
  };

  const addGear = (x: number, y: number) => {
    sounds.init();
    audioBus.init();
    audioBus.playSfx('click');
    const id = `${x}-${y}`;
    const existingGear = gears.find(g => g.id === id);
    if (existingGear) {
      // If clicking an existing gear, open the selection menu
      setSelectedGearId(selectedGearId === id ? null : id);
    } else {
      setGears([...gears, { id, x, y, teeth: 16, type: 'intermediate', material: 'steel' }]);
      setSelectedGearId(id); // Open menu for the new gear
      triggerSparks(x, y);
    }
  };

  const setTeeth = (id: string, teeth: number) => {
    audioBus.playSfx('click');
    const g = gears.find(gg => gg.id === id);
    setGears(gears.map(g => g.id === id ? { ...g, teeth } : g));
    setSelectedGearId(null);
    if (g) triggerSparks(g.x, g.y);
  };

  const setGearMaterial = (id: string, material: GearMaterialKey) => {
    audioBus.playSfx('click');
    const g = gears.find(gg => gg.id === id);
    setGears(gears.map(gg => gg.id === id ? { ...gg, material } : gg));
    if (g) triggerSparks(g.x, g.y);
  };

  const removeGear = (id: string) => {
    audioBus.playSfx('click');
    const g = gears.find(gg => gg.id === id);
    setGears(gears.filter(gg => gg.id !== id));
    setSelectedGearId(null);
    if (g) triggerSparks(g.x, g.y);
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white font-sans selection:bg-rose-500/30">
      <button
        onClick={() => { audioBus.init(); setIsMuted(m => !m); }}
        title={isMuted ? 'Unmute audio' : 'Mute audio'}
        aria-label={isMuted ? 'Unmute audio' : 'Mute audio'}
        className="fixed top-3 right-3 z-50 w-10 h-10 rounded-full bg-black/60 hover:bg-black/80 border border-white/10 backdrop-blur-md flex items-center justify-center text-white/80 hover:text-white transition-all"
      >
        {isMuted ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" /></svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M15.54 8.46a5 5 0 0 1 0 7.07" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14" /></svg>
        )}
      </button>
      <AnimatePresence>
        {gameState === 'shop' && (
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-xl flex items-center justify-center p-6"
          >
            <motion.div 
              initial={{ y: 20 }}
              animate={{ y: 0 }}
              className="bg-[#111111] border border-white/10 rounded-3xl p-4 md:p-8 max-w-4xl w-full shadow-2xl max-h-[90vh] overflow-y-auto"
            >
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-8 gap-4">
                <div>
                  <h2 className="text-2xl md:text-3xl font-black text-rose-500 mb-1 uppercase italic tracking-tighter">Performance Shop</h2>
                  <p className="text-white/40 font-mono text-[10px] md:text-xs uppercase tracking-widest">Upgrade your mechanical assembly</p>
                </div>
                <div className="flex items-center gap-3 bg-white/5 p-3 md:p-4 rounded-2xl border border-white/10 w-full sm:w-auto">
                  <Coins className="w-6 h-6 md:w-8 md:h-8 text-rose-500" />
                  <div>
                    <p className="text-[8px] md:text-[10px] text-white/40 uppercase font-bold">Available Credits</p>
                    <p className="text-xl md:text-2xl font-mono font-black text-white">{credits}</p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {SHOP_ITEMS.map(item => (
                  <div 
                    key={item.id}
                    className={`relative group p-6 rounded-2xl border transition-all ${
                      hasUpgrade(item.id) 
                        ? 'bg-rose-600/10 border-rose-600/50' 
                        : 'bg-[#1a1a1a] border-white/10 hover:border-rose-600/30'
                    }`}
                  >
                    <div className="flex justify-between items-start mb-4">
                      <div className={`p-3 rounded-xl ${hasUpgrade(item.id) ? 'bg-rose-600 text-white' : 'bg-white/5 text-white/60'}`}>
                        {item.icon}
                      </div>
                      {!hasUpgrade(item.id) && (
                        <div className="flex items-center gap-1 bg-white/5 px-3 py-1 rounded-full border border-white/10">
                          <Coins className="w-3 h-3 text-rose-500" />
                          <span className="text-sm font-mono font-bold text-white">{item.price}</span>
                        </div>
                      )}
                    </div>
                    
                    <h3 className="text-xl font-bold text-white mb-1 uppercase tracking-tight">{item.name}</h3>
                    <p className="text-sm text-white/40 mb-6 leading-relaxed">{item.description}</p>
                    
                    <button
                      onClick={() => buyItem(item)}
                      disabled={hasUpgrade(item.id) || credits < item.price}
                      className={`w-full py-3 rounded-xl font-black uppercase tracking-widest transition-all ${
                        hasUpgrade(item.id)
                          ? 'bg-green-500/20 text-green-400 cursor-default border border-green-500/30'
                          : credits >= item.price
                            ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-lg shadow-rose-600/20'
                            : 'bg-white/5 text-white/20 cursor-not-allowed border border-white/5'
                      }`}
                    >
                      {hasUpgrade(item.id) ? 'Installed' : credits >= item.price ? 'Purchase Upgrade' : 'Insufficient Credits'}
                    </button>

                    {hasUpgrade(item.id) && (
                      <div className="absolute top-4 right-4">
                        <div className="flex items-center gap-1 text-[10px] font-black text-green-400 uppercase bg-green-400/10 px-2 py-1 rounded border border-green-400/20">
                          <Check className="w-3 h-3" />
                          Active
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div className="mt-8 flex justify-center">
                <button 
                  onClick={() => setGameState('setup')}
                  className="px-8 py-3 bg-white text-black font-black uppercase tracking-widest rounded-full hover:bg-gray-200 transition-all"
                >
                  Return to Garage
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}

        {showInstructions && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-xl flex items-center justify-center p-6"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="bg-[#111111] border border-white/10 rounded-3xl p-8 max-w-2xl w-full shadow-2xl"
            >
              <div className="flex justify-between items-start mb-8">
                <div>
                  <h2 className="text-3xl font-black text-rose-500 mb-2 uppercase">Gearshift Protocol</h2>
                  <p className="text-white/40 font-mono text-sm uppercase">Speed & Reflexes Guide</p>
                </div>
                <button 
                  onClick={() => setShowInstructions(false)}
                  className="p-2 hover:bg-white/5 rounded-full transition-colors"
                >
                  <RotateCcw className="w-6 h-6 rotate-45" />
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                <div className="space-y-6">
                  <div className="flex gap-4">
                    <div className="w-10 h-10 rounded-xl bg-blue-500/20 flex items-center justify-center shrink-0">
                      <Settings className="w-5 h-5 text-blue-400" />
                    </div>
                    <div>
                      <h3 className="font-bold mb-1">1. High Speed Gears</h3>
                      <p className="text-sm text-white/60 leading-relaxed">Use small start gears and large end gears for maximum top speed on the straight road.</p>
                    </div>
                  </div>
                  <div className="flex gap-4">
                    <div className="w-10 h-10 rounded-xl bg-rose-500/20 flex items-center justify-center shrink-0">
                      <Zap className="w-5 h-5 text-rose-400" />
                    </div>
                    <div>
                      <h3 className="font-bold mb-1">2. Avoid Obstacles</h3>
                      <p className="text-sm text-white/60 leading-relaxed">Watch out for trucks, bikes, and other debris. Hitting obstacles at high speed will damage your engine!</p>
                    </div>
                  </div>
                </div>

                <div className="space-y-6">
                  <div className="flex gap-4">
                    <div className="w-10 h-10 rounded-xl bg-yellow-500/20 flex items-center justify-center shrink-0">
                      <Play className="w-5 h-5 text-yellow-400" />
                    </div>
                    <div>
                      <h3 className="font-bold mb-1">3. Race & Control</h3>
                      <p className="text-sm text-white/60 leading-relaxed">Use <span className="bg-white/10 px-1.5 py-0.5 rounded text-white">A / D</span> or <span className="bg-white/10 px-1.5 py-0.5 rounded text-white">← / →</span> to switch lanes. Hold <span className="bg-white/10 px-1.5 py-0.5 rounded text-white">SPACE</span> to boost acceleration.</p>
                    </div>
                  </div>
                  <div className="flex gap-4">
                    <div className="w-10 h-10 rounded-xl bg-red-500/20 flex items-center justify-center shrink-0">
                      <Thermometer className="w-5 h-5 text-red-400" />
                    </div>
                    <div>
                      <h3 className="font-bold mb-1">4. Watch the Heat</h3>
                      <p className="text-sm text-white/60 leading-relaxed">Don't let the engine exceed 90°C or it will explode! Balance speed and load.</p>
                    </div>
                  </div>
                </div>
              </div>

              <button 
                onClick={() => setShowInstructions(false)}
                className="w-full mt-10 bg-rose-600 hover:bg-rose-500 py-4 rounded-2xl font-black text-lg shadow-xl shadow-rose-600/20 transition-all active:scale-95"
              >
                GOT IT, LET'S RACE!
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <main className="h-screen w-full flex flex-col relative overflow-hidden bg-gradient-to-b from-blue-600 via-blue-400 to-blue-900">
        {/* Race View - Full Screen Container */}
        <div className="flex-1 relative overflow-hidden flex flex-col">
          <div className="flex-1 relative bg-transparent overflow-hidden flex flex-col">
            {/* Header Overlay */}
            <div className="absolute top-0 left-0 right-0 p-4 flex justify-between items-start z-40">
              <div className="flex flex-col gap-4">
                <div className="flex items-center gap-2">
                  <Trophy className="w-5 h-5 text-yellow-500" />
                  <h2 className="text-sm font-black uppercase tracking-tighter italic text-white/60">Live Race</h2>
                </div>
                
                {/* HUD: Comp Stats - Always visible */}
                <div className="flex flex-col gap-2 pointer-events-none">
                  <div className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-xl p-2 w-48 shadow-lg">
                    <p className="text-[8px] text-white/40 uppercase font-black tracking-widest mb-2 flex items-center justify-between">
                      <span>Competitors</span>
                      <Users className="w-2 h-2 text-rose-500" />
                    </p>
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-bold text-rose-500">YOU</span>
                        <div className="flex-1 mx-2 h-1 bg-white/5 rounded-full overflow-hidden">
                          <div className="h-full bg-rose-500" style={{ width: `${(distance / TRACK_LENGTH) * 100}%` }} />
                        </div>
                        <span className="text-[10px] font-mono text-white/40">{Math.floor((distance / TRACK_LENGTH) * 100)}%</span>
                      </div>
                      {Object.values(otherPlayers).slice(0, 3).map((p: any) => (
                        <div key={p.id} className="flex items-center justify-between opacity-60">
                          <span className="text-[10px] font-bold text-blue-400">P-{p.id.slice(0, 2)}</span>
                          <div className="flex-1 mx-2 h-1 bg-white/5 rounded-full overflow-hidden">
                            <div className="h-full bg-blue-400" style={{ width: `${p.progress * 100}%` }} />
                          </div>
                          <span className="text-[10px] font-mono text-white/40">{Math.floor(p.progress * 100)}%</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex gap-4 items-center">
                <button 
                  onClick={() => setIsGarageOpen(!isGarageOpen)}
                  aria-label="Open Garage"
                  title="Garage"
                  className={`p-2 rounded-full transition-all border ${isGarageOpen ? 'bg-rose-600 border-rose-400 shadow-lg shadow-rose-600/20' : 'bg-white/5 border-white/10 hover:bg-white/10'}`}
                >
                  <Wrench className={`w-4 h-4 ${isGarageOpen ? 'animate-pulse text-white' : ''}`} />
                </button>
                {gameState === 'racing' && (
                  <button 
                    onClick={() => {
                      if (gameMode === 'multi' && auth.currentUser) {
                        const roomRef = doc(db, 'rooms', roomId);
                        const playerRef = doc(db, 'rooms', roomId, 'players', auth.currentUser.uid);
                        updateDoc(playerRef, { isReady: false, progress: 0, x: 0, y: 0, isExploded: false }).catch(console.error);
                        updateDoc(roomRef, { status: 'waiting', winnerId: null, winReason: null }).catch(console.error);
                      }
                      setIsWaiting(false);
                      setMultiplayerWinner(null);
                      setGameState('setup');
                      setGameMode(null);
                      setMultiRoomConfirmed(false);
                      setDistance(0);
                      setCurrentSpeed(0);
                    }}
                    className="p-2 rounded-full bg-red-600/20 border border-red-500/40 hover:bg-red-600 transition-all text-white group"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>

            {/* Vertical Speed Gauge - Left Side (only during racing) */}
            {gameState === 'racing' && (() => {
              const efficiency = Math.max(0.5, 1 - (connectedGears.length * 0.02));
              const turboTopMult = 1 + (tuning.turbo - 3) * 0.07;
              const estTopSpeed = (200 + (gearRatio * 300 * efficiency)) * turboTopMult;
              const speedKmh = currentSpeed / 10;
              const speedMaxKmh = Math.max(50, estTopSpeed / 10);
              const speedPct = Math.min(1, speedKmh / speedMaxKmh);
              const torqueVal = gearRatio > 0
                ? (150 * efficiency * (hasUpgrade('nitro_system') ? 1.25 : 1)) / Math.max(0.3, Math.pow(gearRatio, 0.7))
                : 0;
              const torqueMax = 320;
              const torquePct = Math.min(1, torqueVal / torqueMax);
              return (
                <>
                  <div className="absolute left-2 top-20 z-30 pointer-events-none hidden sm:flex flex-row items-center gap-3 bg-black/40 backdrop-blur-md border border-white/15 rounded-2xl px-3 py-3 shadow-2xl">
                    <div className="relative w-5 h-44 bg-white/5 rounded-full overflow-hidden border border-white/15">
                      <motion.div
                        className="absolute bottom-0 left-0 right-0 rounded-full"
                        style={{
                          background: 'linear-gradient(to top, #f43f5e, #fb923c, #fbbf24)'
                        }}
                        animate={{ height: `${speedPct * 100}%` }}
                        transition={{ duration: 0.15 }}
                      />
                      {[0.25, 0.5, 0.75].map(t => (
                        <div key={t} className="absolute left-0 right-0 h-px bg-white/15" style={{ bottom: `${t * 100}%` }} />
                      ))}
                    </div>
                    <div className="flex flex-col items-start leading-tight min-w-[68px]">
                      <p className="text-[10px] text-white/60 uppercase font-black tracking-widest">Speed</p>
                      <p className="text-3xl font-mono font-black text-rose-500 italic">
                        {speedKmh.toFixed(0)}
                      </p>
                      <p className="text-[10px] text-white/50 font-black tracking-widest">KM/H</p>
                    </div>
                  </div>

                  {/* Vertical Torque Gauge - Top Right */}
                  <div className="absolute right-2 top-20 z-30 pointer-events-none hidden sm:flex flex-row-reverse items-center gap-3 bg-black/40 backdrop-blur-md border border-white/15 rounded-2xl px-3 py-3 shadow-2xl">
                    <div className="relative w-5 h-44 bg-white/5 rounded-full overflow-hidden border border-white/15">
                      <motion.div
                        className="absolute bottom-0 left-0 right-0 rounded-full"
                        style={{
                          background: 'linear-gradient(to top, #92400e, #f59e0b, #fde68a)'
                        }}
                        animate={{ height: `${torquePct * 100}%` }}
                        transition={{ duration: 0.15 }}
                      />
                      {[0.25, 0.5, 0.75].map(t => (
                        <div key={t} className="absolute left-0 right-0 h-px bg-white/15" style={{ bottom: `${t * 100}%` }} />
                      ))}
                    </div>
                    <div className="flex flex-col items-end leading-tight min-w-[68px]">
                      <p className="text-[10px] text-white/60 uppercase font-black tracking-widest">Torque</p>
                      <p className="text-3xl font-mono font-black text-amber-500 italic">
                        {torqueVal.toFixed(0)}
                      </p>
                      <p className="text-[10px] text-white/50 font-black tracking-widest">Nm</p>
                    </div>
                  </div>
                </>
              );
            })()}

            {/* Auxiliary indicators — always a vertical column on the left during racing */}
            {gameState === 'racing' && (
            <div className="absolute left-2 top-[260px] z-30 pointer-events-none">
              <div className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl p-2 flex flex-col gap-2 shadow-xl w-[96px]">
                <div className="text-center">
                  <p className="text-[8px] text-white/40 uppercase font-black tracking-widest mb-0.5">Efficiency</p>
                  <p className="text-lg font-mono font-black text-blue-400 italic leading-none">
                    {(Math.max(0.5, 1 - (connectedGears.length * 0.02)) * 100).toFixed(0)}%
                  </p>
                </div>
                <div className="h-px bg-white/10" />
                <div className="text-center">
                  <p className="text-[8px] text-white/40 uppercase font-black tracking-widest mb-1">Gear</p>
                  <div className="flex items-center justify-center gap-1">
                    {[1, 2, 3, 4].map(g => (
                      <button
                        key={g}
                        onClick={() => { setCurrentGear(g); audioBus.playSfx('click'); }}
                        className={`pointer-events-auto w-4 h-6 rounded text-[9px] font-mono font-black transition-all border ${
                          currentGear === g
                            ? 'bg-rose-600 text-white border-rose-300 scale-110 shadow-md shadow-rose-600/40'
                            : 'bg-white/5 text-white/40 border-white/10 hover:bg-white/10'
                        }`}
                        title={`Gear ${g} (×${gearboxRatios[g - 1].toFixed(2)})`}
                      >
                        {g}
                      </button>
                    ))}
                  </div>
                  <p className="text-[7px] text-white/40 font-mono mt-0.5">×{gearboxRatios[currentGear - 1].toFixed(2)}</p>
                </div>
                <div className="h-px bg-white/10" />
                <div className="text-center">
                  <p className="text-[8px] text-white/40 uppercase font-black tracking-widest mb-0.5">Slope</p>
                  <div className="flex items-center justify-center h-[24px]">
                    <svg width="44" height="24" viewBox="-22 -12 44 24" className="overflow-visible">
                      <line x1="-20" y1="0" x2="20" y2="0" stroke="rgba(255,255,255,0.08)" strokeWidth="1.5" strokeDasharray="2 3" />
                      <g transform={`rotate(${(-currentSlope * 180 / Math.PI).toFixed(2)})`}>
                        <line x1="-18" y1="0" x2="18" y2="0" stroke={Math.abs(currentSlope) > 0.12 ? '#f43f5e' : currentSlope > 0.04 ? '#f59e0b' : currentSlope < -0.04 ? '#3b82f6' : '#10b981'} strokeWidth="3" strokeLinecap="round" />
                        <polygon points="18,0 12,-4 12,4" fill={Math.abs(currentSlope) > 0.12 ? '#f43f5e' : currentSlope > 0.04 ? '#f59e0b' : currentSlope < -0.04 ? '#3b82f6' : '#10b981'} />
                      </g>
                    </svg>
                  </div>
                  <p className={`text-[10px] font-mono font-black ${Math.abs(currentSlope) > 0.12 ? 'text-rose-500' : currentSlope > 0.04 ? 'text-amber-400' : currentSlope < -0.04 ? 'text-blue-400' : 'text-emerald-400'}`}>
                    {(currentSlope * 180 / Math.PI).toFixed(0)}°
                  </p>
                </div>
                {gameMode === 'multi' && Object.values(otherPlayers).length > 0 && (
                  <>
                    <div className="h-px bg-white/10" />
                    <div className="text-center">
                      <p className="text-[8px] text-white/40 uppercase font-black tracking-widest mb-0.5">Gap</p>
                      <p className={`text-lg font-mono font-black ${(distance - (Object.values(otherPlayers)[0] as PlayerState).y) > 0 ? 'text-green-400' : 'text-rose-500'}`}>
                        {((distance - (Object.values(otherPlayers)[0] as PlayerState).y) / 10).toFixed(1)}
                          <span className="text-[8px] ml-0.5 opacity-40 text-white font-black italic">M</span>
                      </p>
                    </div>
                  </>
                )}
              </div>
            </div>
            )}

            {gameState === 'racing' && (
            <div className="absolute bottom-[220px] sm:bottom-32 right-4 z-30 pointer-events-none">
              {/* Thermal HUD - Circular Gauges */}
              <div className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl p-2 sm:p-4 flex flex-col sm:flex-row gap-4 sm:gap-10 shadow-xl">
                <div className="relative flex flex-col items-center">
                  <div className="relative w-16 h-16 flex items-center justify-center">
                    <svg className="w-full h-full -rotate-90">
                      <circle cx="32" cy="32" r="28" fill="transparent" stroke="rgba(255,255,255,0.05)" strokeWidth="6" />
                      <motion.circle 
                        cx="32" cy="32" r="28" fill="transparent" 
                        stroke={engineTemp > 80 ? '#f43f5e' : engineTemp > 65 ? '#f59e0b' : '#3b82f6'} 
                        strokeWidth="6" 
                        strokeDasharray="175.9"
                        animate={{ strokeDashoffset: 175.9 - (175.9 * (engineTemp / 90)) }}
                        strokeLinecap="round"
                      />
                    </svg>
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                      <span className={`text-sm font-mono font-black ${engineTemp > 80 ? 'text-rose-500 animate-pulse' : 'text-white'}`}>{engineTemp.toFixed(0)}°</span>
                    </div>
                  </div>
                  <span className="text-[8px] font-black text-white/40 uppercase tracking-widest mt-2 flex items-center gap-1">
                    <Thermometer className="w-2 h-2" />
                    Engine
                  </span>
                </div>

                <div className="relative flex flex-col items-center">
                  <div className="relative w-16 h-16 flex items-center justify-center">
                    <svg className="w-full h-full -rotate-90">
                      <circle cx="32" cy="32" r="28" fill="transparent" stroke="rgba(255,255,255,0.05)" strokeWidth="6" />
                      <motion.circle 
                        cx="32" cy="32" r="28" fill="transparent" 
                        stroke={brakeTemp > 80 ? '#f43f5e' : brakeTemp > 65 ? '#f59e0b' : '#10b981'} 
                        strokeWidth="6" 
                        strokeDasharray="175.9"
                        animate={{ strokeDashoffset: 175.9 - (175.9 * Math.min(1, brakeTemp / 100)) }}
                        strokeLinecap="round"
                      />
                    </svg>
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                      <span className={`text-sm font-mono font-black ${brakeTemp > 80 ? 'text-rose-500 animate-pulse' : 'text-white'}`}>{brakeTemp.toFixed(0)}°</span>
                    </div>
                  </div>
                  <span className="text-[8px] font-black text-white/40 uppercase tracking-widest mt-2 flex items-center gap-1">
                    <Zap className="w-2 h-2 text-yellow-400" />
                    Brakes
                  </span>
                </div>
              </div>
            </div>
            )}

            <div className="flex-1 relative overflow-hidden bg-transparent">
              <div ref={canvasRef} className="w-full h-full relative">
                {/* Boost Notification */}
                <AnimatePresence>
                  {boostTime > 0 && (
                    <motion.div 
                      initial={{ opacity: 0, y: -20, scale: 0.8 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, scale: 1.2 }}
                      className="absolute top-24 right-4 z-50 pointer-events-none"
                    >
                      <div className="bg-rose-600/90 backdrop-blur-md text-white px-4 py-2 rounded-2xl font-black italic text-sm shadow-xl border border-white/20 flex items-center gap-2">
                        <Flame className="w-4 h-4 animate-pulse" />
                        <div className="flex flex-col">
                          <span className="text-[8px] opacity-60 uppercase tracking-widest">{lastBoostType}</span>
                          <span className="leading-none">BOOST ACTIVE</span>
                        </div>
                        <span className="text-lg font-mono ml-2 text-yellow-400">{boostTime.toFixed(1)}s</span>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Scanline & Vignette */}
                <div className="absolute inset-0 pointer-events-none z-20 scanline opacity-[0.03]" />
                
                {/* Overheat Warning Overlay */}
                <AnimatePresence>
                  {(engineTemp > 80 || brakeTemp > 80) && gameState === 'racing' && (
                    <motion.div 
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 1.2 }}
                      className="absolute inset-0 flex items-center justify-center z-50 pointer-events-none"
                    >
                      <div className="flex flex-col items-center gap-2">
                        <motion.div 
                          animate={{ opacity: [1, 0, 1] }}
                          transition={{ repeat: Infinity, duration: 0.5 }}
                          className="bg-rose-600/90 text-white px-8 py-4 rounded-3xl border-4 border-white shadow-[0_0_100px_rgba(225,29,72,0.8)]"
                        >
                          <div className="flex items-center gap-4">
                            <AlertTriangle className="w-10 h-10" />
                            <div className="flex flex-col">
                              <span className="text-4xl font-black italic tracking-tighter">OVERHEAT WARNING</span>
                              <span className="text-xs uppercase tracking-widest font-bold opacity-80">Immediate cooling required</span>
                            </div>
                          </div>
                        </motion.div>
                        <div className="bg-black/80 px-4 py-2 rounded-xl border border-white/20 text-rose-400 font-mono text-sm">
                          {engineTemp > 80 && `ENGINE: ${engineTemp.toFixed(1)}°C `}
                          {brakeTemp > 80 && `BRAKES: ${brakeTemp.toFixed(1)}°C`}
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
                <div className="absolute inset-0 pointer-events-none z-20 shadow-[inset_0_0_150px_rgba(0,0,0,0.3)]" />
              </div>

              {/* Progress Bar - Moved to Bottom edge for better visibility and no header overlap */}
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 w-full max-w-md h-8 bg-black/60 backdrop-blur-md border border-white/10 rounded-full overflow-hidden pointer-events-none z-40">
                <div className="absolute inset-x-4 inset-y-0 flex items-center">
                  <div className="w-full h-[2px] bg-white/10 relative">
                    {/* Finish Line */}
                    <div className="absolute right-0 top-1/2 -translate-y-1/2 w-1 h-3 bg-yellow-500" />
                    {/* Player Dot */}
                    <motion.div 
                      className="absolute top-1/2 -translate-y-1/2 w-2 h-2 bg-rose-500 rounded-full shadow-[0_0_10px_rgba(244,63,94,0.8)] border border-white"
                      animate={{ left: `${(distance / TRACK_LENGTH) * 100}%` }}
                    />
                    {/* Rival Dots */}
                    {(Object.values(otherPlayers) as PlayerState[]).map(p => (
                      <motion.div 
                        key={p.id}
                        className="absolute top-1/2 -translate-y-1/2 w-1.5 h-1.5 bg-blue-400 rounded-full shadow-[0_0_5px_rgba(96,165,250,0.5)] border border-white/50"
                        animate={{ left: `${p.progress * 100}%` }}
                      />
                    ))}
                  </div>
                </div>
                <div className="absolute bottom-0.5 right-4 text-[5px] font-black text-white/20 uppercase tracking-widest">Sector Completion</div>
              </div>
            </div>

            {/* Setup Mode Overlay */}
            {gameState === 'setup' && !isGarageOpen && (
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="absolute inset-0 z-40 bg-black/60 backdrop-blur-md flex flex-col items-center justify-center pointer-events-auto p-6"
              >
                <div className="max-w-xl w-full flex flex-col gap-8 items-center text-center">
                  <motion.div
                    initial={{ y: -20, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    className="mb-4"
                  >
                    <h1 className="text-6xl font-black italic tracking-tighter text-rose-500 drop-shadow-[0_0_30px_rgba(244,63,94,0.3)]">GEARSHIFT</h1>
                    <p className="text-white/40 uppercase tracking-[0.5em] text-[10px] font-black -mt-2">ASSEMBLY RACE</p>
                  </motion.div>

                  {!gameMode ? (
                    <>
                      <div className="absolute top-8 left-1/2 -translate-x-1/2 flex items-center gap-5 bg-white/5 border border-white/10 px-5 py-3 rounded-2xl backdrop-blur-xl shadow-[0_0_40px_rgba(244,63,94,0.15)]">
                        <div className="flex items-center gap-3">
                          <div className="relative w-12 h-12 flex items-center justify-center">
                            <svg className="absolute inset-0 -rotate-90" viewBox="0 0 36 36">
                              <circle cx="18" cy="18" r="15" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="3" />
                              <circle cx="18" cy="18" r="15" fill="none" stroke="url(#lvlGrad)" strokeWidth="3" strokeLinecap="round"
                                strokeDasharray={`${levelProgress * 94.25} 94.25`} />
                              <defs>
                                <linearGradient id="lvlGrad" x1="0" y1="0" x2="1" y2="1">
                                  <stop offset="0%" stopColor="#fbbf24" />
                                  <stop offset="100%" stopColor="#f43f5e" />
                                </linearGradient>
                              </defs>
                            </svg>
                            <div className="text-base font-black italic text-white drop-shadow-[0_0_8px_rgba(244,63,94,0.6)]">{level}</div>
                          </div>
                          <div className="flex flex-col items-start leading-none">
                            <span className="text-[10px] font-black text-white/40 uppercase tracking-widest mb-1">Level</span>
                            <span className="text-[10px] font-mono text-white/60">{totalWins}/{nextLevelWins} W · {totalCoinsEarned}/{nextLevelCoins} C</span>
                          </div>
                        </div>
                        <div className="w-[1px] h-8 bg-white/10" />
                        <div className="flex items-center gap-3">
                          <Coins className="w-5 h-5 text-yellow-500 animate-pulse" />
                          <div className="flex flex-col items-start leading-none">
                            <span className="text-[10px] font-black text-white/40 uppercase tracking-widest mb-1">Wallet</span>
                            <span className="text-xl font-mono font-black text-white">{credits.toLocaleString()}</span>
                          </div>
                        </div>
                        <div className="w-[1px] h-8 bg-white/10" />
                        <button 
                          onClick={() => { sounds.playClick(); setGameState('shop'); }}
                          className="flex flex-col items-center group"
                        >
                          <ShoppingCart className="w-6 h-6 text-rose-500 group-hover:scale-110 transition-transform" />
                          <span className="text-[8px] font-black uppercase text-white/40 group-hover:text-white transition-colors">Shop</span>
                        </button>
                      </div>

                      <div className="space-y-2">
                        <h2 className="text-4xl font-black italic tracking-tighter text-white">CHOOSE OPERATIONAL MODE</h2>
                        <p className="text-white/40 uppercase tracking-widest text-xs font-bold">Select your mission profile</p>
                      </div>
                      
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full">
                        <motion.button
                          whileHover={{ scale: 1.02, backgroundColor: 'rgba(255,255,255,0.1)' }}
                          whileTap={{ scale: 0.98 }}
                          onClick={() => setGameMode('single')}
                          className="flex flex-col items-center gap-4 p-8 bg-white/5 border border-white/10 rounded-3xl transition-all group"
                        >
                          <div className="w-16 h-16 rounded-2xl bg-blue-500/20 flex items-center justify-center group-hover:bg-blue-500/40 transition-colors">
                            <Zap className="w-8 h-8 text-blue-400" />
                          </div>
                          <div className="text-center">
                            <h3 className="text-xl font-black italic text-white uppercase">Solo Mission</h3>
                            <p className="text-[10px] text-white/40 mt-1 uppercase font-bold tracking-wider">Race against the track</p>
                          </div>
                        </motion.button>

                        <motion.button
                          whileHover={{ scale: 1.02, backgroundColor: 'rgba(255,255,255,0.1)' }}
                          whileTap={{ scale: 0.98 }}
                          onClick={() => setGameMode('multi')}
                          className="flex flex-col items-center gap-4 p-8 bg-white/5 border border-white/10 rounded-3xl transition-all group"
                        >
                          <div className="w-16 h-16 rounded-2xl bg-rose-500/20 flex items-center justify-center group-hover:bg-rose-500/40 transition-colors">
                            <Users className="w-8 h-8 text-rose-400" />
                          </div>
                          <div className="text-center">
                            <h3 className="text-xl font-black italic text-white uppercase">Network Race</h3>
                            <p className="text-[10px] text-white/40 mt-1 uppercase font-bold tracking-wider">Compete with global rivals</p>
                          </div>
                        </motion.button>
                      </div>

                      {/* Missions Dashboard Quick View */}
                      <motion.button
                        onClick={() => setIsMissionsOpen(true)}
                        className="w-full mt-4 p-4 bg-gradient-to-r from-yellow-500/10 to-amber-500/10 border border-yellow-500/20 rounded-2xl flex items-center justify-between group hover:bg-yellow-500/20 transition-all"
                      >
                        <div className="flex items-center gap-4">
                          <div className="bg-yellow-500/20 p-2 rounded-lg">
                            <Trophy className="w-5 h-5 text-yellow-500" />
                          </div>
                          <div className="text-left">
                            <p className="text-xs font-black text-yellow-500 uppercase">Daily Missions</p>
                            <p className="text-[10px] text-white/40 uppercase font-bold">
                              {missions.filter(m => m.completed && !m.claimed).length} Rewards Ready to Claim
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                           <div className="flex -space-x-1">
                              {missions.map((m, i) => (
                                <div key={i} className={`w-2 h-2 rounded-full border border-black ${m.completed ? 'bg-yellow-500' : 'bg-white/10'}`} />
                              ))}
                           </div>
                           <ChevronRight className="w-4 h-4 text-white/40 group-hover:translate-x-1 transition-transform" />
                        </div>
                      </motion.button>
                    </>
                  ) : gameMode === 'multi' && !multiRoomConfirmed ? (
                    <>
                       <div className="space-y-2">
                        <button 
                          onClick={() => setGameMode(null)}
                          className="text-[10px] font-black text-rose-500/60 uppercase tracking-widest hover:text-rose-500 transition-colors mb-4"
                        >
                          ← Back to mode selection
                        </button>
                        <h2 className="text-4xl font-black italic tracking-tighter text-white uppercase">Multiplayer Gateway</h2>
                        <p className="text-white/40 uppercase tracking-widest text-xs font-bold">Synchronize with the neural net</p>
                      </div>

                      <div className="flex flex-col gap-4 w-full max-w-sm">
                        <button
                          onClick={async () => {
                            const newId = Math.random().toString(36).substring(2, 8).toUpperCase();
                            // Pre-create room to ensure immediate visibility in the list for others
                            if (auth.currentUser) {
                              await setDoc(doc(db, 'rooms', newId), {
                                status: 'waiting',
                                createdAt: serverTimestamp()
                              });
                            }
                            setRoomId(newId);
                            setMultiRoomConfirmed(true);
                          }}
                          className="bg-rose-600 hover:bg-rose-500 px-8 py-5 rounded-2xl font-black text-lg italic tracking-tighter text-white shadow-xl shadow-rose-600/20 transition-all active:scale-95 border-b-4 border-rose-800"
                        >
                          CREATE NEW ROOM
                        </button>
                        
                        <div className="bg-white/5 border border-white/10 rounded-2xl p-6 flex flex-col gap-4">
                          <p className="text-[10px] font-black text-white/40 uppercase tracking-widest">Join existing sector</p>
                          <div className="flex gap-2">
                            <input 
                              type="text" 
                              value={joinIdInput}
                              onChange={(e) => setJoinIdInput(e.target.value.toUpperCase())}
                              placeholder="ROOM ID"
                              className="bg-black/40 border border-white/10 rounded-xl px-4 py-3 flex-1 font-mono text-white placeholder:text-white/20 focus:outline-none focus:border-rose-500/50 transition-all text-sm"
                            />
                            <button
                              onClick={() => {
                                if (joinIdInput) {
                                  setRoomId(joinIdInput);
                                  setMultiRoomConfirmed(true);
                                }
                              }}
                              className="bg-white/10 hover:bg-white/20 px-6 py-3 rounded-xl font-black text-xs uppercase tracking-widest transition-all"
                            >
                              JOIN
                            </button>
                          </div>

                          <div className="h-[1px] w-full bg-white/10 my-2" />
                          
                          <div className="flex flex-col gap-2 max-h-48 overflow-y-auto pr-2">
                            <p className="text-[10px] font-black text-white/40 uppercase tracking-widest mb-1 text-left">Available Open Sectors</p>
                            {availableRooms.length === 0 ? (
                               <div className="text-xs text-white/20 italic text-center p-4 bg-black/20 rounded-xl border border-white/5">No open sectors found</div>
                            ) : (
                               availableRooms.map(room => (
                                  <button
                                    key={room.id}
                                    onClick={() => {
                                      setRoomId(room.id);
                                      setMultiRoomConfirmed(true);
                                    }}
                                    className="bg-black/40 hover:bg-rose-500/20 border border-white/10 hover:border-rose-500/30 p-3 rounded-xl flex items-center justify-between group transition-all"
                                  >
                                    <span className="font-mono text-sm font-bold text-white group-hover:text-rose-400 transition-colors">Sector: {room.id}</span>
                                    <span className="text-[10px] font-black uppercase text-white/40 group-hover:text-rose-400 bg-white/5 group-hover:bg-rose-500/20 px-2 py-1 rounded transition-colors">JOIN</span>
                                  </button>
                               ))
                            )}
                          </div>
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="space-y-6">
                        <div className="flex flex-col gap-2">
                          <button 
                            onClick={() => {
                              if (gameMode === 'multi' && auth.currentUser) {
                                const roomRef = doc(db, 'rooms', roomId);
                                const playerRef = doc(db, 'rooms', roomId, 'players', auth.currentUser.uid);
                                updateDoc(playerRef, { isReady: false, progress: 0, x: 0, y: 0, isExploded: false }).catch(console.error);
                                updateDoc(roomRef, { status: 'waiting', winnerId: null, winReason: null }).catch(console.error);
                              }
                              setGameMode(null);
                              setMultiRoomConfirmed(false);
                              setIsWaiting(false);
                              setRoomId('main-race');
                            }}
                            className="text-[10px] font-black text-rose-500/60 uppercase tracking-widest hover:text-rose-500 transition-colors"
                          >
                            ← Back to mode selection
                          </button>
                          <h2 className="text-4xl font-black italic tracking-tighter text-white uppercase">Unit Ready</h2>
                          <p className="text-white/40 uppercase tracking-widest text-[10px] font-bold">
                            Mode: <span className="text-white">{gameMode === 'multi' ? 'Multiplayer' : 'Solo'}</span>
                            {gameMode === 'multi' && <> | Sector: <span className="text-white uppercase font-black text-rose-400">{roomId}</span></>}
                          </p>
                          {gameMode === 'multi' && (
                            <div className="flex flex-col gap-3 items-center w-full max-w-xs mt-4">
                              <div className="flex flex-wrap justify-center gap-2">
                                {/* Current Player */}
                                <div className="flex items-center gap-2 bg-white/10 border border-white/20 px-3 py-2 rounded-xl">
                                  <div className={`w-2 h-2 rounded-full ${isWaiting ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]' : 'bg-white/20'}`} />
                                  <span className="text-[10px] font-black text-white uppercase tracking-widest">YOU</span>
                                </div>
                                
                                {/* Other Players */}
                                {Object.values(otherPlayers).map((p: any) => (
                                  <div key={p.id} className="flex items-center gap-2 bg-white/5 border border-white/10 px-3 py-2 rounded-xl">
                                    <div className={`w-2 h-2 rounded-full ${p.isReady ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]' : 'bg-rose-500/40 animate-pulse'}`} />
                                    <span className="text-[10px] font-black text-white/60 uppercase tracking-widest">P-{p.id.slice(0, 4)}</span>
                                  </div>
                                ))}
                              </div>

                              <div className="flex items-center gap-2 bg-rose-500/10 border border-rose-500/20 px-3 py-1 rounded-full">
                                <Users className="w-3 h-3 text-rose-400" />
                                <span className="text-[10px] font-black text-rose-400 uppercase tracking-widest">
                                  {Object.keys(otherPlayers).length + 1} Player(s) in Sector
                                </span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className={`w-1.5 h-1.5 rounded-full ${connectionStatus === 'connected' ? 'bg-green-500' : connectionStatus === 'connecting' ? 'bg-yellow-500 animate-pulse' : 'bg-red-500'}`} />
                                <span className="text-[8px] font-bold text-white/40 uppercase tracking-widest">
                                  Neural Link: {connectionStatus}
                                </span>
                              </div>
                            </div>
                          )}
                        </div>

                        <motion.button
                          whileHover={{ scale: 1.05 }}
                          whileTap={{ scale: 0.95 }}
                          onClick={() => {
                            if (gameMode === 'multi') {
                              setIsWaiting(true);
                              if (auth.currentUser) {
                                const playerRef = doc(db, 'rooms', roomId, 'players', auth.currentUser.uid);
                                setDoc(playerRef, {
                                  id: auth.currentUser.uid,
                                  isReady: true,
                                  progress: 0,
                                  x: 0,
                                  y: 0,
                                  temp: 20,
                                  brakeTemp: 20,
                                  isExploded: false,
                                  lastUpdate: serverTimestamp()
                                }, { merge: true });
                              }
                            } else {
                              setGameState('racing');
                            }
                          }}
                          className="group relative bg-rose-600 px-16 py-6 rounded-3xl font-black text-3xl italic tracking-tighter text-white shadow-[0_0_50px_rgba(225,29,72,0.4)] border-b-4 border-rose-800 transition-all disabled:opacity-50"
                          disabled={isWaiting}
                        >
                          <div className="flex items-center gap-4">
                            {isWaiting ? <RotateCcw className="w-10 h-10 animate-spin" /> : <Play className="w-10 h-10 fill-current" />}
                            {isWaiting ? 'WAITING FOR RIVAL...' : 'ENGINE START'}
                          </div>
                        </motion.button>

                        <div className="flex flex-col gap-3">
                          <button
                            onClick={() => setIsGarageOpen(true)}
                            className="flex items-center gap-3 bg-white/5 hover:bg-white/10 px-8 py-3 rounded-2xl border border-white/10 backdrop-blur-xl transition-all group"
                          >
                            <Wrench className="w-4 h-4 text-rose-500 group-hover:rotate-12 transition-transform" />
                            <span className="text-[10px] font-black uppercase tracking-[0.2em] text-white italic">Open Assembly Garage</span>
                          </button>
                          <p className="text-[10px] text-white/20 uppercase tracking-[0.3em] font-black">All systems operational</p>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </motion.div>
            )}

            {/* On-Screen Controls */}
            {gameState === 'racing' && (
              <div className="absolute bottom-6 left-4 right-4 pointer-events-none z-40">
                <div className="flex flex-col gap-4">
                  <div className="flex justify-between items-end">
                    {/* Left: Steering/Brake */}
                    <div className="flex gap-4">
                      <button
                        onClick={() => setTargetLane(prev => Math.max(-1, prev - 1))}
                        className="pointer-events-auto w-16 h-16 bg-white/5 backdrop-blur-xl border border-white/20 rounded-3xl flex items-center justify-center active:scale-90 active:bg-white/20 transition-all shadow-2xl"
                      >
                        <ChevronLeft className="w-8 h-8 text-white" />
                      </button>
                      <button
                        onMouseDown={() => setIsBraking(true)}
                        onMouseUp={() => setIsBraking(false)}
                        onTouchStart={() => setIsBraking(true)}
                        onTouchEnd={() => setIsBraking(false)}
                        className="pointer-events-auto w-16 h-16 bg-red-600/40 backdrop-blur-xl border border-red-500/40 rounded-3xl flex flex-col items-center justify-center active:scale-90 active:bg-red-500 transition-all shadow-2xl"
                      >
                        <RotateCcw className="w-6 h-6 text-white" />
                        <span className="text-[8px] font-bold text-white uppercase">Brake</span>
                      </button>
                    </div>

                    {/* Right: Steering/Boost */}
                    <div className="flex gap-4">
                      <button
                        onMouseDown={() => setIsAccelerating(true)}
                        onMouseUp={() => setIsAccelerating(false)}
                        onTouchStart={() => setIsAccelerating(true)}
                        onTouchEnd={() => setIsAccelerating(false)}
                        className="pointer-events-auto w-24 h-24 bg-rose-600 backdrop-blur-xl border-2 border-rose-400 rounded-3xl flex flex-col items-center justify-center active:scale-90 active:bg-rose-500 transition-all shadow-2xl shadow-rose-600/60"
                      >
                        <Play className="w-10 h-10 text-white fill-current" />
                        <span className="text-sm font-black text-white uppercase italic mt-1">Accelerate</span>
                      </button>
                      <button
                        onClick={() => setTargetLane(prev => Math.min(1, prev + 1))}
                        className="pointer-events-auto w-16 h-16 bg-white/5 backdrop-blur-xl border border-white/20 rounded-3xl flex items-center justify-center active:scale-90 active:bg-white/20 transition-all shadow-2xl"
                      >
                        <ChevronRight className="w-8 h-8 text-white" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Result Overlays */}
            <AnimatePresence mode="wait">
              {gameState === 'exploded' && (
                <motion.div 
                  key="exploded-screen"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="absolute inset-0 bg-rose-950/90 backdrop-blur-xl flex flex-col items-center justify-center p-8 text-center z-[150] overflow-hidden"
                >
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(244,63,94,0.4)_0%,transparent_70%)] animate-pulse" />
                  <div className="w-24 h-24 bg-rose-600 rounded-full flex items-center justify-center mb-8 relative border-4 border-white/20">
                    <AlertTriangle className="w-12 h-12 text-white" />
                  </div>
                  <h3 className="text-6xl font-black mb-4 italic tracking-tighter text-white uppercase drop-shadow-lg">Critical Failure</h3>
                  <p className="text-white/60 mb-10 max-w-sm text-lg italic leading-tight">
                    {gameMode === 'multi' ? 'MISSION FAILED: Unit compromised. Rival has secured the sector.' : 'The mechanical pressure was too extreme. The engine has detonated.'}
                  </p>
                  <button 
                    onClick={() => {
                      if (gameMode === 'multi' && auth.currentUser) {
                        const rRef = doc(db, 'rooms', roomId);
                        const pRef = doc(db, 'rooms', roomId, 'players', auth.currentUser.uid);
                        updateDoc(pRef, { isReady: false, progress: 0, x: 0, y: 0, isExploded: false }).catch(console.error);
                        updateDoc(rRef, { status: 'waiting', winnerId: null, winReason: null }).catch(console.error);
                      }
                      setIsWaiting(false);
                      setMultiplayerWinner(null);
                      setGameState('setup');
                      setEngineTemp(20);
                      setGameMode(null);
                      setMultiRoomConfirmed(false);
                      setDistance(0);
                      setCurrentSpeed(0);
                    }}
                    className="relative z-10 bg-white text-rose-950 px-12 py-4 rounded-2xl font-black text-xl hover:bg-neutral-100 active:scale-95 transition-all shadow-2xl"
                  >
                    RETURN TO ASSEMBLY
                  </button>
                  <div className="absolute inset-0 pointer-events-none scanline opacity-[0.05]" />
                </motion.div>
              )}

              {gameState === 'finished' && (
                <motion.div 
                  key="finished-screen"
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 1.1 }}
                  className={`absolute inset-0 ${(gameMode === 'multi' ? (multiplayerWinner?.id === auth.currentUser?.uid) : true) ? 'bg-emerald-900/95' : 'bg-rose-900/95'} backdrop-blur-xl flex flex-col items-center justify-center p-8 text-center z-[150] overflow-hidden`}
                >
                  <div className={`absolute inset-0 bg-[radial-gradient(circle_at_center,${(gameMode === 'multi' ? (multiplayerWinner?.id === auth.currentUser?.uid) : true) ? 'rgba(16,185,129,0.4)' : 'rgba(244,63,94,0.4)'}_0%,transparent_70%)] animate-pulse`} />
                  
                  {/* Content Container to ensure layering */}
                  <div className="relative z-10 flex flex-col items-center">
                    {(gameMode === 'single' || (multiplayerWinner?.id === auth.currentUser?.uid)) ? (
                      <div className="relative mb-8 pt-6">
                        <Trophy className="w-32 h-32 text-yellow-500 drop-shadow-[0_0_50px_rgba(234,179,8,0.6)] animate-bounce" />
                        <div className="absolute top-0 right-0 bg-yellow-500 text-black text-[10px] font-black px-3 py-1 rounded-full italic shadow-lg">CHAMPION</div>
                      </div>
                    ) : (
                      <div className="w-24 h-24 bg-rose-600 rounded-full flex items-center justify-center mb-8 border-4 border-white/20">
                        <AlertTriangle className="w-12 h-12 text-white" />
                      </div>
                    )}
                    
                    <h3 className="text-7xl font-black mb-4 italic tracking-tighter text-white drop-shadow-2xl">
                      {gameMode === 'multi' 
                        ? (multiplayerWinner?.id === auth.currentUser?.uid ? 'VICTORY SECURED' : 'SECTOR LOST') 
                        : 'GLORY ACHIEVED'}
                    </h3>
                    
                    <div className="max-w-md w-full bg-white/5 border border-white/10 rounded-2xl p-6 mb-6 backdrop-blur-md shadow-2xl">
                      <p className="text-xl italic leading-tight text-white/80">
                        {gameMode === 'multi' && multiplayerWinner
                          ? (multiplayerWinner.id === auth.currentUser?.uid 
                            ? `Protocol success: Rival neutralized via ${multiplayerWinner.reason}. Credits awarded.` 
                            : `Mission compromised. Rival has achieved completion via ${multiplayerWinner.reason}.`)
                          : `Your machine has survived the gauntlet. You are the ultimate master of mechanics.`}
                      </p>
                    </div>

                    {gameMode === 'multi' && bountyResult && (
                      <motion.div
                        initial={{ opacity: 0, y: 20, scale: 0.9 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        transition={{ delay: 0.3, type: 'spring' }}
                        className={`max-w-md w-full mb-6 rounded-2xl border-2 p-5 backdrop-blur-md shadow-2xl ${
                          bountyResult.type === 'won'
                            ? 'bg-yellow-500/15 border-yellow-400/40 shadow-yellow-500/30'
                            : 'bg-rose-950/40 border-rose-500/40 shadow-rose-500/30'
                        }`}
                      >
                        <div className="flex items-center justify-center gap-3">
                          <Coins className={`w-7 h-7 ${bountyResult.type === 'won' ? 'text-yellow-300 animate-pulse' : 'text-rose-300'}`} />
                          <div className="text-left">
                            <div className="text-[10px] font-black uppercase tracking-widest text-white/60">
                              {bountyResult.type === 'won' ? 'Bounty Collected (10%)' : 'Bounty Paid (10%)'}
                            </div>
                            <div className={`text-3xl font-mono font-black ${bountyResult.type === 'won' ? 'text-yellow-300' : 'text-rose-300'}`}>
                              {bountyResult.type === 'won' ? '+' : '−'}{bountyResult.amount.toLocaleString()}
                            </div>
                          </div>
                        </div>
                      </motion.div>
                    )}

                    <div className="max-w-md w-full mb-10 grid grid-cols-3 gap-3">
                      <div className="bg-white/5 border border-white/10 rounded-xl p-3 backdrop-blur-md">
                        <div className="text-[9px] font-black uppercase tracking-widest text-white/40">Level</div>
                        <div className="text-2xl font-mono font-black text-white drop-shadow-[0_0_8px_rgba(244,63,94,0.5)]">{level}</div>
                      </div>
                      <div className="bg-white/5 border border-white/10 rounded-xl p-3 backdrop-blur-md">
                        <div className="text-[9px] font-black uppercase tracking-widest text-white/40">Wins</div>
                        <div className="text-2xl font-mono font-black text-white">{totalWins.toLocaleString()}</div>
                      </div>
                      <div className="bg-white/5 border border-white/10 rounded-xl p-3 backdrop-blur-md">
                        <div className="text-[9px] font-black uppercase tracking-widest text-white/40">Wallet</div>
                        <div className="text-2xl font-mono font-black text-yellow-300">{credits.toLocaleString()}</div>
                      </div>
                    </div>
                    
                    <button 
                      onClick={() => {
                        if (gameMode === 'multi' && auth.currentUser) {
                          const rRef = doc(db, 'rooms', roomId);
                          const pRef = doc(db, 'rooms', roomId, 'players', auth.currentUser.uid);
                          updateDoc(pRef, { isReady: false, progress: 0, x: 0, y: 0, isExploded: false }).catch(console.error);
                          updateDoc(rRef, { status: 'waiting', winnerId: null, winReason: null }).catch(console.error);
                        }
                        setIsWaiting(false);
                        setMultiplayerWinner(null);
                        setGameState('setup');
                        setGameMode(null);
                        setMultiRoomConfirmed(false);
                        setDistance(0);
                        setCurrentSpeed(0);
                        setEngineTemp(20);
                      }}
                      className={`px-16 py-5 rounded-2xl font-black text-2xl active:scale-95 transition-all shadow-2xl border-b-8 ${
                        (gameMode === 'single' || (multiplayerWinner?.id === auth.currentUser?.uid))
                          ? 'bg-emerald-500 text-white hover:bg-emerald-400 border-emerald-700 shadow-emerald-500/30' 
                          : 'bg-white text-rose-950 hover:bg-neutral-100 border-neutral-300'
                      }`}
                    >
                      CONTINUE MISSION
                    </button>
                  </div>
                  <div className="absolute inset-0 pointer-events-none scanline opacity-[0.05]" />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Missions Overlay */}
        <AnimatePresence>
          {isMissionsOpen && (
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="fixed inset-0 z-[110] bg-black/90 backdrop-blur-2xl flex items-center justify-center p-6"
              onClick={(e) => e.target === e.currentTarget && setIsMissionsOpen(false)}
            >
              <div className="max-w-md w-full bg-[#111] rounded-3xl border border-white/10 overflow-hidden shadow-2xl">
                <div className="p-6 border-b border-white/5 flex justify-between items-center bg-gradient-to-r from-yellow-500/10 to-transparent">
                  <div className="flex items-center gap-3">
                    <Trophy className="w-6 h-6 text-yellow-500" />
                    <h2 className="text-2xl font-black italic text-white uppercase tracking-tighter">Daily Briefing</h2>
                  </div>
                  <button onClick={() => setIsMissionsOpen(false)} className="p-2 hover:bg-white/5 rounded-full transition-colors text-white/40">
                    <X className="w-6 h-6" />
                  </button>
                </div>
                
                <div className="p-6 space-y-4">
                  {missions.map((mission) => (
                    <div key={mission.id} className={`p-4 rounded-2xl border transition-all ${mission.claimed ? 'bg-white/5 border-white/5 opacity-50' : mission.completed ? 'bg-yellow-500/10 border-yellow-500/30 shadow-lg shadow-yellow-500/5' : 'bg-white/5 border-white/10'}`}>
                      <div className="flex justify-between items-start mb-3">
                        <div>
                          <h4 className="font-black text-white uppercase italic text-sm">{mission.label}</h4>
                          <div className="flex items-center gap-1 mt-1">
                            <Coins className="w-3 h-3 text-yellow-500" />
                            <span className="text-[10px] font-black text-yellow-500 uppercase">{mission.reward} Credits</span>
                          </div>
                        </div>
                        {mission.claimed ? (
                          <div className="bg-green-500/20 text-green-400 p-1 rounded">
                            <Check className="w-4 h-4" />
                          </div>
                        ) : mission.completed && (
                          <button 
                            onClick={() => claimMissionReward(mission.id)}
                            className="bg-yellow-500 text-black px-3 py-1 rounded-lg text-[10px] font-black uppercase hover:bg-yellow-400 transition-colors"
                          >
                            Claim
                          </button>
                        )}
                      </div>
                      
                      <div className="space-y-1">
                        <div className="flex justify-between text-[8px] font-black uppercase text-white/40">
                          <span>Progress</span>
                          <span>{mission.type === 'speed' ? `${Math.floor(mission.current)} / ${mission.goal} KM/H` : mission.type === 'temp' ? `${mission.current === 1 ? 'LOCKED' : 'FAIL'}` : `${Math.floor(mission.current)} / ${mission.goal}`}</span>
                        </div>
                        <div className="h-1.5 bg-black rounded-full overflow-hidden">
                          <motion.div 
                            className="h-full bg-yellow-500"
                            initial={{ width: 0 }}
                            animate={{ width: `${Math.min(100, (mission.current / mission.goal) * 100)}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                
                <div className="p-6 bg-white/5 text-center">
                  <p className="text-[10px] text-white/40 uppercase font-black italic tracking-widest">
                    Briefing expires in {24 - new Date().getHours()} hours
                  </p>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Garage Overlay */}
        <AnimatePresence>
          {isGarageOpen && (
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="fixed inset-0 z-[100] bg-black/95 backdrop-blur-2xl p-4 md:p-8 flex items-center justify-center overflow-y-auto"
              onClick={(e) => {
                if (e.target === e.currentTarget) setIsGarageOpen(false);
              }}
            >
              <div className="max-w-4xl w-full my-auto">
                <div className="bg-[#111111] rounded-3xl border border-white/10 p-6 shadow-[0_0_50px_rgba(0,0,0,0.8)] relative">
                  <div className="absolute top-4 right-4 z-[101]">
                    <button 
                      onClick={() => setIsGarageOpen(false)}
                      className="p-4 bg-rose-600 hover:bg-rose-500 rounded-2xl border border-rose-400 shadow-xl shadow-rose-600/20 transition-all active:scale-90"
                    >
                      <X className="w-6 h-6 text-white" />
                    </button>
                  </div>

                  <div className="flex justify-between items-center mb-6 pr-16">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-rose-600 rounded-lg">
                        <Settings className="w-6 h-6 text-white animate-spin-slow" />
                      </div>
                      <div>
                        <h2 className="text-2xl font-black italic uppercase tracking-tighter text-rose-500">Gear Assembly</h2>
                        <p className="text-[10px] text-white/40 uppercase tracking-widest">Fine-tune your mechanical beast</p>
                      </div>
                    </div>
                  </div>

                  <div className="relative flex flex-col md:flex-row items-center gap-8">
                    <EngineVisual className="shrink-0" />
                    
                    <div className="flex-1 w-full overflow-x-auto py-12 scrollbar-none">
                      <div 
                        className="grid gap-1 bg-black/40 p-4 rounded-2xl border border-white/5 min-h-[250px] gear-grid-bg relative min-w-[500px]"
                        style={{ gridTemplateColumns: `repeat(${GRID_COLS}, 1fr)` }}
                      >
                        <div className="absolute inset-0 grayscale scanline pointer-events-none opacity-20" />
                        {sparkBurst && (
                          <div key={sparkBurst.id} className="contents">
                            <SparkBurst x={sparkBurst.x} y={sparkBurst.y} />
                          </div>
                        )}
                      {Array.from({ length: GRID_COLS * GRID_ROWS }).map((_, i) => {
                        const x = i % GRID_COLS;
                        const y = Math.floor(i / GRID_COLS);
                        const gear = gears.find(g => g.x === x && g.y === y);
                        const isEngine = x === 0;
                        const isWheel = x === GRID_COLS - 1;

                        return (
                          <div key={i} className={`relative ${selectedGearId === gear?.id ? 'z-[300]' : 'z-0'}`}>
                            <button
                              onClick={() => addGear(x, y)}
                              className={`w-full aspect-square min-h-[40px] rounded-lg transition-all flex items-center justify-center relative group overflow-hidden border ${
                                gear 
                                  ? connectedGears.includes(gear.id) 
                                    ? 'bg-rose-600 border-rose-400 shadow-lg shadow-rose-600/40 ring-1 ring-white/20' 
                                    : 'bg-neutral-800 border-white/10 opacity-60'
                                  : 'bg-white/5 border-white/5 hover:bg-white/10'
                              } ${isEngine ? 'border-l-4 border-blue-500/50' : ''} ${isWheel ? 'border-r-4 border-green-500/50' : ''}`}
                            >
                              {gear && (() => {
                                const isConnected = connectedGears.includes(gear.id);
                                // Heat estimate per gear: scales with current effective ratio (proxy for RPM at this stage).
                                const ratioHeat = Math.min(1, Math.max(0, (gearRatio - 0.6) / 2.5));
                                const glow = isConnected ? ratioHeat : 0;
                                // Spin direction comes from the BFS-tree parity, so meshing gears truly oppose each other.
                                const reverse = (gearParity.get(gear.id) ?? 0) === 1;
                                return (
                                  <div className="relative flex items-center justify-center w-full h-full p-1">
                                    <GearIcon
                                      teeth={gear.teeth}
                                      material={(gear.material ?? 'steel') as GearMaterialKey}
                                      spinning={isConnected}
                                      spinReverse={reverse}
                                      spinDuration={gear.teeth / 20}
                                      glow={glow}
                                      dim={!isConnected}
                                      className="w-full h-full"
                                    />
                                    <span className="absolute text-[9px] font-black text-white bg-black/80 px-1 rounded-sm">{gear.teeth}T</span>
                                  </div>
                                );
                              })()}
                              {!gear && (isEngine || isWheel) && (
                                <div className={`w-1.5 h-1.5 rounded-full ${isEngine ? 'bg-blue-500' : 'bg-green-500'} opacity-30`} />
                              )}
                            </button>

                            {/* Selection logic (keep as is) */}
                            <AnimatePresence>
                              {selectedGearId === gear?.id && (
                                <motion.div 
                                  initial={{ opacity: 0, scale: 0.8, y: y < 2 ? 10 : -10 }}
                                  animate={{ opacity: 1, scale: 1, y: 0 }}
                                  exit={{ opacity: 0, scale: 0.8, y: y < 2 ? 10 : -10 }}
                                  className={`absolute z-[500] ${y < 2 ? 'top-full mt-2' : 'bottom-full mb-2'} left-1/2 -translate-x-1/2 bg-neutral-900 border border-white/20 rounded-2xl p-4 shadow-2xl min-w-[240px]`}
                                  onMouseLeave={() => setPreviewTeeth(null)}
                                >
                                  <div className="flex justify-between items-center mb-3">
                                    <p className="text-[10px] font-black text-white/40 uppercase tracking-widest italic">Tooth Count</p>
                                    <X className="w-3 h-3 cursor-pointer" onClick={() => setSelectedGearId(null)} />
                                  </div>
                                  {/* Live ratio preview — shows what the chain ratio would become */}
                                  {(() => {
                                    const previewGears = previewTeeth != null
                                      ? gears.map(g => g.id === gear.id ? { ...g, teeth: previewTeeth } : g)
                                      : gears;
                                    const conn = computeConnectedGears(previewGears, GRID_COLS, GRID_ROWS);
                                    const previewRatio = computeRatio(previewGears, conn.ids);
                                    const isPreview = previewTeeth != null && previewTeeth !== gear.teeth;
                                    return (
                                      <div className="mb-3 px-2 py-1.5 rounded-lg bg-black/40 border border-white/5 flex items-center justify-between gap-2">
                                        <span className="text-[9px] text-white/40 uppercase tracking-widest font-black">Ratio</span>
                                        <span className="font-mono font-black text-xs">
                                          <span className={isPreview ? 'text-white/40' : 'text-rose-400'}>{gearRatio.toFixed(2)}</span>
                                          {isPreview && (
                                            <>
                                              <span className="text-white/30 mx-1">→</span>
                                              <span className={previewRatio > gearRatio ? 'text-emerald-400' : 'text-amber-400'}>
                                                {previewRatio.toFixed(2)}
                                              </span>
                                            </>
                                          )}
                                        </span>
                                      </div>
                                    );
                                  })()}
                                  <div className="grid grid-cols-4 gap-1.5">
                                    {GEAR_TYPES.map(t => (
                                      <button
                                        key={t}
                                        onMouseEnter={() => setPreviewTeeth(t)}
                                        onMouseLeave={() => setPreviewTeeth(null)}
                                        onClick={(e) => { e.stopPropagation(); setPreviewTeeth(null); setTeeth(gear.id, t); }}
                                        className={`px-1 py-2 rounded-lg text-[10px] font-black transition-all ${
                                          gear.teeth === t ? 'bg-rose-600 text-white scale-110' : 'bg-white/5 hover:bg-white/10 text-white/60'
                                        }`}
                                      >
                                        {t}T
                                      </button>
                                    ))}
                                  </div>
                                  {/* Material picker — only unlocked when premium_gears purchased */}
                                  <div className="mt-4 pt-3 border-t border-white/10">
                                    <div className="flex items-center justify-between mb-2">
                                      <p className="text-[10px] font-black text-white/40 uppercase tracking-widest italic">Material</p>
                                      {!hasUpgrade('premium_gears') && (
                                        <span className="text-[8px] font-black text-amber-400/70 uppercase tracking-widest">Locked · Shop</span>
                                      )}
                                    </div>
                                    <div className="grid grid-cols-4 gap-1.5">
                                      {(Object.keys(GEAR_MATERIALS) as GearMaterialKey[]).map(mk => {
                                        const enabled = mk === 'steel' || hasUpgrade('premium_gears');
                                        const active = (gear.material ?? 'steel') === mk;
                                        const m = GEAR_MATERIALS[mk];
                                        return (
                                          <button
                                            key={mk}
                                            disabled={!enabled}
                                            onClick={(e) => { e.stopPropagation(); if (enabled) setGearMaterial(gear.id, mk); }}
                                            title={m.label}
                                            className={`relative px-1 py-1.5 rounded-lg text-[8px] font-black transition-all uppercase tracking-widest border ${
                                              active ? 'border-white/60 scale-105' : 'border-white/5 hover:border-white/20'
                                            } ${enabled ? '' : 'opacity-30 cursor-not-allowed'}`}
                                            style={{ background: `linear-gradient(135deg, ${m.body} 0%, ${m.edge} 100%)`, color: '#0a0a0a' }}
                                          >
                                            {m.label.slice(0, 4)}
                                          </button>
                                        );
                                      })}
                                    </div>
                                  </div>
                                  <div className="mt-4 pt-3 border-t border-white/10">
                                    <button
                                      onClick={(e) => { e.stopPropagation(); removeGear(gear.id); setSelectedGearId(null); }}
                                      className="w-full py-2 text-[10px] font-black text-red-500 hover:bg-red-500/10 rounded-lg transition-all uppercase italic"
                                    >
                                      Detach Gear
                                    </button>
                                  </div>
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </div>
                        );
                      })}
                      </div>
                    </div>

                    <WheelVisual className="shrink-0" />
                  </div>

                  <div className="mt-8 grid grid-cols-2 md:grid-cols-5 gap-4">
                    <div className="bg-white/5 rounded-2xl p-4 border border-white/10">
                      <p className="text-[10px] text-white/40 uppercase font-black mb-1 italic">Gear Ratio</p>
                      <p className="text-2xl font-mono font-black text-rose-500">{gearRatio.toFixed(2)}</p>
                    </div>
                    <div className="bg-white/5 rounded-2xl p-4 border border-white/10">
                      <p className="text-[10px] text-white/40 uppercase font-black mb-1 italic">Efficiency</p>
                      <p className="text-2xl font-mono font-black text-green-400">{(Math.max(0.5, 1 - (connectedGears.length * 0.02)) * 100).toFixed(0)}%</p>
                    </div>
                    <div className="bg-white/5 rounded-2xl p-4 border border-white/10">
                      <p className="text-[10px] text-white/40 uppercase font-black mb-1 italic">Torque</p>
                      <p className="text-2xl font-mono font-black text-amber-500">
                        {gearRatio > 0 ? ((150 * Math.max(0.5, 1 - (connectedGears.length * 0.02)) * (hasUpgrade('nitro_system') ? 1.25 : 1)) / Math.max(0.3, Math.pow(gearRatio, 0.7))).toFixed(0) : 0}
                      </p>
                    </div>
                    <div className="bg-white/5 rounded-2xl p-4 border border-white/10 col-span-2">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-[10px] text-white/40 uppercase font-black italic">Setup Presets</p>
                        <span className="text-[9px] text-white/30 italic">Click to load · Save overwrites slot</span>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        {presets.map((p, idx) => (
                          <div key={idx} className="flex items-center gap-1.5">
                            <button
                              onClick={() => { audioBus.playSfx('click'); setGears(p.gears.map(g => ({ ...g }))); }}
                              disabled={p.gears.length === 0}
                              className={`flex-1 px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest border transition-all text-left flex items-center justify-between ${
                                p.gears.length === 0
                                  ? 'bg-white/3 border-white/5 text-white/20 cursor-not-allowed'
                                  : 'bg-rose-600/20 text-rose-400 border-rose-500/30 hover:bg-rose-600/30'
                              }`}
                            >
                              <span>{p.name}</span>
                              <span className="text-[9px] opacity-60 ml-2">{p.gears.length}g</span>
                            </button>
                            <button
                              onClick={() => {
                                audioBus.playSfx('click');
                                setPresets(presets.map((pp, j) => j === idx ? { ...pp, gears: gears.map(g => ({ ...g })) } : pp));
                              }}
                              title={`Save current build into "${p.name}"`}
                              className="px-2 py-1.5 bg-white/5 hover:bg-white/15 border border-white/10 rounded-lg text-[9px] font-black uppercase tracking-widest text-white/60"
                            >
                              Save
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Mechanical Tuning */}
                  <div className="mt-8 bg-gradient-to-br from-emerald-500/5 to-blue-500/5 border border-emerald-500/20 rounded-2xl p-5">
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <h3 className="text-sm font-black italic uppercase tracking-tighter text-emerald-400">Mechanical Tuning</h3>
                        <p className="text-[10px] text-white/40 uppercase tracking-widest mt-0.5">Dial in the chassis · 5 systems · stock = 3</p>
                      </div>
                      <button
                        onClick={() => { setTuning({ ...DEFAULT_TUNING }); audioBus.playSfx('click'); }}
                        className="px-3 py-1.5 text-[10px] font-black uppercase rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 text-white/60"
                      >
                        Reset
                      </button>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {([
                        { key: 'tires',   label: 'Tires (Grip)',     desc: 'Sharper steering · softer crashes',  tone: 'text-emerald-400', bar: 'bg-emerald-400', icon: '🛞' },
                        { key: 'brakes',  label: 'Brakes',           desc: 'Stronger stopping · less heat',       tone: 'text-rose-400',    bar: 'bg-rose-400',    icon: '🛑' },
                        { key: 'cooling', label: 'Cooling',          desc: 'Slower engine heat buildup',          tone: 'text-blue-400',    bar: 'bg-blue-400',    icon: '❄️' },
                        { key: 'turbo',   label: 'Turbo',            desc: 'Higher top speed · longer boosts',    tone: 'text-amber-400',   bar: 'bg-amber-400',   icon: '💨' },
                        { key: 'chassis', label: 'Chassis (Weight)', desc: 'Light: faster accel · Heavy: hills',  tone: 'text-purple-400',  bar: 'bg-purple-400',  icon: '⚙️' },
                      ] as const).map(({ key, label, desc, tone, bar, icon }) => {
                        const val = tuning[key];
                        const dec = () => { setTuning({ ...tuning, [key]: Math.max(1, val - 1) }); audioBus.playSfx('click'); };
                        const inc = () => { setTuning({ ...tuning, [key]: Math.min(5, val + 1) }); audioBus.playSfx('click'); };
                        return (
                          <div key={key} className="bg-black/40 border border-white/10 rounded-xl p-3">
                            <div className="flex items-center justify-between mb-2">
                              <div>
                                <p className={`text-[11px] font-black uppercase tracking-widest ${tone}`}>{icon} {label}</p>
                                <p className="text-[9px] text-white/30 italic">{desc}</p>
                              </div>
                              <div className="flex items-center gap-1.5">
                                <button onClick={dec} className="w-7 h-7 rounded-md bg-white/5 hover:bg-white/15 text-white/70 font-black text-sm border border-white/10">−</button>
                                <span className={`font-mono font-black text-sm w-6 text-center ${tone}`}>{val}</span>
                                <button onClick={inc} className="w-7 h-7 rounded-md bg-white/5 hover:bg-white/15 text-white/70 font-black text-sm border border-white/10">+</button>
                              </div>
                            </div>
                            <div className="flex gap-1">
                              {[1,2,3,4,5].map(n => (
                                <div key={n} className={`flex-1 h-1.5 rounded ${n <= val ? bar : 'bg-white/10'}`} />
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* 4-Speed Transmission Configuration */}
                  <div className="mt-8 bg-gradient-to-br from-amber-500/5 to-rose-500/5 border border-amber-500/20 rounded-2xl p-5">
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <h3 className="text-sm font-black italic uppercase tracking-tighter text-amber-400">4-Speed Gearbox</h3>
                        <p className="text-[10px] text-white/40 uppercase tracking-widest mt-0.5">Pick a ratio for each gear · shift in race with Q / E</p>
                      </div>
                      <button
                        onClick={() => { setGearboxRatios([...DEFAULT_GEARBOX]); audioBus.playSfx('click'); }}
                        className="px-3 py-1.5 text-[10px] font-black uppercase rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 text-white/60"
                      >
                        Reset
                      </button>
                    </div>
                    <div className="grid grid-cols-4 gap-3">
                      {gearboxRatios.map((ratio, i) => {
                        const idx = GEARBOX_OPTIONS.indexOf(ratio);
                        const dec = () => {
                          const next = [...gearboxRatios];
                          const j = Math.max(0, (idx === -1 ? 0 : idx) - 1);
                          next[i] = GEARBOX_OPTIONS[j];
                          setGearboxRatios(next); audioBus.playSfx('click');
                        };
                        const inc = () => {
                          const next = [...gearboxRatios];
                          const j = Math.min(GEARBOX_OPTIONS.length - 1, (idx === -1 ? 0 : idx) + 1);
                          next[i] = GEARBOX_OPTIONS[j];
                          setGearboxRatios(next); audioBus.playSfx('click');
                        };
                        const tone = i === 0 ? 'text-rose-400' : i === 1 ? 'text-amber-400' : i === 2 ? 'text-emerald-400' : 'text-blue-400';
                        return (
                          <div key={i} className="bg-black/40 border border-white/10 rounded-xl p-3 flex flex-col items-center">
                            <p className={`text-[10px] font-black uppercase tracking-widest ${tone}`}>Gear {i + 1}</p>
                            <p className="text-[9px] text-white/30 italic mb-2">{i === 0 ? 'High torque' : i === 3 ? 'Top speed' : 'Balanced'}</p>
                            <div className="flex items-center gap-1.5">
                              <button onClick={dec} className="w-7 h-7 rounded-md bg-white/5 hover:bg-white/15 text-white/70 font-black text-sm border border-white/10">−</button>
                              <span className={`font-mono font-black text-lg w-12 text-center ${tone}`}>×{ratio.toFixed(2)}</span>
                              <button onClick={inc} className="w-7 h-7 rounded-md bg-white/5 hover:bg-white/15 text-white/70 font-black text-sm border border-white/10">+</button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="mt-6 flex gap-4 items-start bg-rose-500/5 border border-rose-500/20 p-4 rounded-2xl">
                    <AlertTriangle className="w-5 h-5 text-rose-500 shrink-0" />
                    <p className="text-xs text-rose-200/60 leading-relaxed italic">
                      Tip: Connect <span className="text-blue-400 font-bold">Engine</span> to <span className="text-green-400 font-bold">Wheel</span>. Use <span className="text-rose-400 font-bold">large gears</span> for torque, <span className="text-blue-400 font-bold">small gears</span> for speed. Watch the <span className="text-amber-400 font-bold">slope indicator</span> — uphill heats the engine, downhill cooks the brakes.
                    </p>
                  </div>

                  <button 
                    onClick={() => setIsGarageOpen(false)}
                    className="w-full mt-8 bg-white/5 hover:bg-white/10 border border-white/10 py-4 rounded-2xl font-black text-rose-500 uppercase tracking-widest italic transition-all active:scale-95 flex items-center justify-center gap-2 group"
                  >
                    <ChevronLeft className="w-5 h-5 group-hover:-translate-x-1 transition-transform" />
                    Back to Race Track
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <style>{`
        @keyframes spin-slow {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .animate-spin-slow {
          animation: spin-slow 8s linear infinite;
        }
      `}</style>
    </div>
  );
}
