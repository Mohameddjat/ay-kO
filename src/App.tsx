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
  X
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

// ── New systems ──────────────────────────────────────────────────────────────

// Tracks / themes
type TrackTheme = 'highway' | 'desert' | 'city' | 'mountain';
const TRACK_THEMES: Record<TrackTheme, {
  name: string;
  emoji: string;
  desc: string;
  skyTop: string;
  skyBottom: string;
  ground: string;
  roadColor: string;
  mountainColor: string;
}> = {
  highway:  { name: 'Highway',  emoji: '🛣️', desc: 'Classic asphalt at sunset',     skyTop: '#1e3a8a', skyBottom: '#60a5fa', ground: '#064e3b', roadColor: '#1a1a1a', mountainColor: '#1e293b' },
  desert:   { name: 'Desert',   emoji: '🏜️', desc: 'Dusty dunes and red rocks',     skyTop: '#c2410c', skyBottom: '#fbbf24', ground: '#a16207', roadColor: '#3f3f46', mountainColor: '#7c2d12' },
  city:     { name: 'City',     emoji: '🌃', desc: 'Neon-lit night highway',        skyTop: '#0f0f1e', skyBottom: '#581c87', ground: '#1f2937', roadColor: '#0a0a0a', mountainColor: '#1e1b4b' },
  mountain: { name: 'Mountain', emoji: '🏔️', desc: 'Snowy alpine pass',              skyTop: '#1e293b', skyBottom: '#94a3b8', ground: '#e2e8f0', roadColor: '#374151', mountainColor: '#475569' },
};

// Weather
type Weather = 'clear' | 'rain' | 'fog' | 'night';
const WEATHER_OPTS: Record<Weather, { name: string; emoji: string; gripMult: number; visMult: number }> = {
  clear: { name: 'Clear',  emoji: '☀️', gripMult: 1.0,  visMult: 1.0 },
  rain:  { name: 'Rain',   emoji: '🌧️', gripMult: 0.75, visMult: 0.85 },
  fog:   { name: 'Fog',    emoji: '🌫️', gripMult: 0.95, visMult: 0.55 },
  night: { name: 'Night',  emoji: '🌙', gripMult: 0.9,  visMult: 0.7 },
};

// Tire compound
type TireCompound = 'soft' | 'medium' | 'hard';
const TIRE_COMPOUNDS: Record<TireCompound, { name: string; emoji: string; grip: number; heat: number; wear: number; desc: string }> = {
  soft:   { name: 'Soft',   emoji: '🔴', grip: 1.20, heat: 1.30, wear: 1.6, desc: 'Faster + more grip · wears quickly' },
  medium: { name: 'Medium', emoji: '🟡', grip: 1.00, heat: 1.00, wear: 1.0, desc: 'Balanced choice · default' },
  hard:   { name: 'Hard',   emoji: '⚪', grip: 0.85, heat: 0.75, wear: 0.5, desc: 'Slower but durable · cool running' },
};

// Particle system (used for sparks / smoke / dust)
type Particle = {
  x: number; y: number; vx: number; vy: number; life: number; maxLife: number;
  color: string; size: number; gravity?: number; kind?: 'spark' | 'smoke' | 'dust' | 'rain';
};

// Damage state per system
type Damage = {
  engine: number;   // 0 (perfect) → 1 (broken)
  brakes: number;
  tires: number;    // tire wear
};
const ZERO_DAMAGE: Damage = { engine: 0, brakes: 0, tires: 0 };

// Player car palette
const CAR_COLORS = [
  { id: 'rose',   name: 'Rose',   body: '#e11d48', roof: '#f43f5e', glow: '#f43f5e' },
  { id: 'azure',  name: 'Azure',  body: '#2563eb', roof: '#3b82f6', glow: '#60a5fa' },
  { id: 'lime',   name: 'Lime',   body: '#16a34a', roof: '#22c55e', glow: '#4ade80' },
  { id: 'amber',  name: 'Amber',  body: '#d97706', roof: '#f59e0b', glow: '#fbbf24' },
  { id: 'violet', name: 'Violet', body: '#7c3aed', roof: '#8b5cf6', glow: '#a78bfa' },
  { id: 'noir',   name: 'Noir',   body: '#171717', roof: '#262626', glow: '#a3a3a3' },
];

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

const GearIcon = ({ teeth, color, className, rotation = 0 }: { teeth: number, color: string, className?: string, rotation?: number }) => {
  const points = [];
  const innerRadius = 30;
  const outerRadius = 45;
  const toothCount = teeth;
  
  for (let i = 0; i < toothCount * 2; i++) {
    const angle = (i * Math.PI) / toothCount;
    const r = i % 2 === 0 ? outerRadius : innerRadius;
    points.push(`${Math.cos(angle) * r},${Math.sin(angle) * r}`);
  }
  
  return (
    <svg viewBox="-50 -50 100 100" className={className} style={{ transform: `rotate(${rotation}deg)` }}>
      <defs>
        <radialGradient id="gearGradient" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="rgba(255,255,255,0.2)" />
          <stop offset="100%" stopColor="rgba(0,0,0,0.2)" />
        </radialGradient>
      </defs>
      <polygon
        points={points.join(' ')}
        fill={color}
        stroke="currentColor"
        strokeWidth="2"
        className="transition-all duration-300"
      />
      <circle cx="0" cy="0" r="15" fill="url(#gearGradient)" />
      <circle cx="0" cy="0" r="5" fill="white" />
      {/* Mechanical details */}
      <circle cx="0" cy="0" r="25" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="1" strokeDasharray="2 4" />
    </svg>
  );
};

const EngineVisual = ({ className }: { className?: string }) => (
  <div className={`flex flex-col items-center gap-2 ${className}`}>
    <div className="relative">
      <div className="absolute -inset-4 bg-blue-500/20 blur-xl rounded-full animate-pulse" />
      <div className="relative bg-[#1a1a1a] p-4 rounded-2xl border border-blue-500/30 shadow-lg shadow-blue-500/10">
        <Zap className="w-8 h-8 text-blue-400" />
      </div>
    </div>
    <span className="text-[10px] font-black text-blue-400/60 uppercase tracking-tighter">V8 ENGINE</span>
  </div>
);

const WheelVisual = ({ className }: { className?: string }) => (
  <div className={`flex flex-col items-center gap-2 ${className}`}>
    <div className="relative">
      <div className="absolute -inset-4 bg-green-500/20 blur-xl rounded-full animate-pulse" />
      <div className="relative bg-[#1a1a1a] p-4 rounded-2xl border border-green-500/30 shadow-lg shadow-green-500/10">
        <RotateCcw className="w-8 h-8 text-green-400" />
      </div>
    </div>
    <span className="text-[10px] font-black text-green-400/60 uppercase tracking-tighter">DRIVE WHEEL</span>
  </div>
);

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

  // ── New persistent settings ───────────────────────────────────────────────
  const [trackTheme, setTrackTheme] = useState<TrackTheme>(() => (localStorage.getItem('gear_race_track') as TrackTheme) || 'highway');
  useEffect(() => { localStorage.setItem('gear_race_track', trackTheme); }, [trackTheme]);
  const trackThemeRef = useRef(trackTheme);
  useEffect(() => { trackThemeRef.current = trackTheme; }, [trackTheme]);

  const [weather, setWeather] = useState<Weather>(() => (localStorage.getItem('gear_race_weather') as Weather) || 'clear');
  useEffect(() => { localStorage.setItem('gear_race_weather', weather); }, [weather]);
  const weatherRef = useRef(weather);
  useEffect(() => { weatherRef.current = weather; }, [weather]);

  const [tireCompound, setTireCompound] = useState<TireCompound>(() => (localStorage.getItem('gear_race_tire') as TireCompound) || 'medium');
  useEffect(() => { localStorage.setItem('gear_race_tire', tireCompound); }, [tireCompound]);
  const tireCompoundRef = useRef(tireCompound);
  useEffect(() => { tireCompoundRef.current = tireCompound; }, [tireCompound]);

  const [carColorId, setCarColorId] = useState<string>(() => localStorage.getItem('gear_race_carcolor') || 'rose');
  useEffect(() => { localStorage.setItem('gear_race_carcolor', carColorId); }, [carColorId]);
  const carColorIdRef = useRef(carColorId);
  useEffect(() => { carColorIdRef.current = carColorId; }, [carColorId]);

  const [practiceMode, setPracticeMode] = useState<boolean>(() => localStorage.getItem('gear_race_practice') === '1');
  useEffect(() => { localStorage.setItem('gear_race_practice', practiceMode ? '1' : '0'); }, [practiceMode]);
  const practiceModeRef = useRef(practiceMode);
  useEffect(() => { practiceModeRef.current = practiceMode; }, [practiceMode]);

  const [voiceEnabled, setVoiceEnabled] = useState<boolean>(() => localStorage.getItem('gear_race_voice') !== '0');
  useEffect(() => { localStorage.setItem('gear_race_voice', voiceEnabled ? '1' : '0'); }, [voiceEnabled]);

  // Damage (cumulative across crashes during a race). Persists between races
  // unless repaired in garage (cost: credits).
  const [damage, setDamage] = useState<Damage>(() => {
    try { const raw = localStorage.getItem('gear_race_damage'); if (raw) return { ...ZERO_DAMAGE, ...JSON.parse(raw) }; } catch {}
    return { ...ZERO_DAMAGE };
  });
  useEffect(() => { localStorage.setItem('gear_race_damage', JSON.stringify(damage)); }, [damage]);
  const damageRef = useRef(damage);
  useEffect(() => { damageRef.current = damage; }, [damage]);

  // Tuning presets (3 slots)
  type TuningPreset = { name: string; tuning: Tuning; gearbox: number[]; tire: TireCompound };
  const [tuningPresets, setTuningPresets] = useState<(TuningPreset | null)[]>(() => {
    try {
      const raw = localStorage.getItem('gear_race_tuning_presets');
      if (raw) return JSON.parse(raw);
    } catch {}
    return [null, null, null];
  });
  useEffect(() => { localStorage.setItem('gear_race_tuning_presets', JSON.stringify(tuningPresets)); }, [tuningPresets]);

  // Particles (mutable ref, updated every frame)
  const particlesRef = useRef<Particle[]>([]);

  // Per-race telemetry (resets on race start)
  type RaceStats = {
    startTime: number;
    endTime: number;
    distanceCovered: number;
    topSpeed: number;
    speedSamples: number[];
    crashes: number;
    nearMisses: number;
    boostsUsed: number;
    timeInGear: number[]; // 4 entries
    lastGearChangeTime: number;
    maxEngineTemp: number;
    drafts: number;
  };
  const raceStatsRef = useRef<RaceStats>({
    startTime: 0, endTime: 0, distanceCovered: 0, topSpeed: 0, speedSamples: [],
    crashes: 0, nearMisses: 0, boostsUsed: 0, timeInGear: [0,0,0,0], lastGearChangeTime: 0,
    maxEngineTemp: 20, drafts: 0,
  });
  const [lastRaceStats, setLastRaceStats] = useState<RaceStats | null>(null);

  // Daily challenge — randomized seed-based per local day
  const todayKey = new Date().toISOString().slice(0, 10);
  const dailyChallenge = useMemo(() => {
    // Deterministic per-day pseudo-random (no Math.random, so it stays consistent)
    let h = 0;
    for (let i = 0; i < todayKey.length; i++) h = (h * 31 + todayKey.charCodeAt(i)) | 0;
    const themes: TrackTheme[] = ['highway', 'desert', 'city', 'mountain'];
    const weathers: Weather[] = ['clear', 'rain', 'fog', 'night'];
    const tires: TireCompound[] = ['soft', 'medium', 'hard'];
    return {
      key: todayKey,
      theme: themes[Math.abs(h) % 4],
      weather: weathers[Math.abs(h >> 3) % 4],
      tire: tires[Math.abs(h >> 6) % 3],
      goalSec: 90 + (Math.abs(h >> 9) % 60), // 90-150s target
      reward: 500,
    };
  }, [todayKey]);
  const [dailyDone, setDailyDone] = useState<boolean>(() => localStorage.getItem('gear_race_daily_' + todayKey) === '1');

  // Best ghost run (records ~600 samples of position vs distance)
  type GhostSample = { d: number; lane: number };
  const [ghostBest, setGhostBest] = useState<{ time: number; samples: GhostSample[] } | null>(() => {
    try { const raw = localStorage.getItem('gear_race_ghost'); if (raw) return JSON.parse(raw); } catch {}
    return null;
  });
  useEffect(() => {
    if (ghostBest) localStorage.setItem('gear_race_ghost', JSON.stringify(ghostBest));
  }, [ghostBest]);
  const ghostBestRef = useRef(ghostBest);
  useEffect(() => { ghostBestRef.current = ghostBest; }, [ghostBest]);
  const ghostRecordingRef = useRef<GhostSample[]>([]);

  // Police chase — spawns when speed sustained > threshold
  type Police = { z: number; lane: number; siren: number };
  const policeRef = useRef<Police | null>(null);
  const policeCooldownRef = useRef(0);

  // Drafting tracker
  const draftTimerRef = useRef(0);

  // Speech synthesizer for commentary (browser API, no external dependency)
  const speak = (text: string) => {
    if (!voiceEnabled) return;
    if (!('speechSynthesis' in window)) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.15;
      u.pitch = 0.9;
      u.volume = 0.6;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch {}
  };
  const speakRef = useRef(speak);
  useEffect(() => { speakRef.current = speak; }, [voiceEnabled]);
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
  const [obstacles, setObstacles] = useState<{ id: string, lane: number, z: number, type: string, processed?: boolean, vx?: number, targetLane?: number }[]>([]);

  useEffect(() => {
    if (targetLane !== targetLaneRef.current) {
      lastLaneChangeZRef.current = distance;
      targetLaneRef.current = targetLane;
    }
  }, [targetLane]);
  const [distance, setDistance] = useState(0);
  const [showInstructions, setShowInstructions] = useState(true);
  const [connectedGears, setConnectedGears] = useState<string[]>([]);
  const [selectedGearId, setSelectedGearId] = useState<string | null>(null);
  const [presets, setPresets] = useState<{ name: string, gears: Gear[] }[]>([]);
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
    setMissions(prev => prev.map(m => {
      if (m.id === id && m.completed && !m.claimed) {
        addCredits(m.reward);
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

  const SHOP_ITEMS = [
    { id: 'titanium_gears', name: 'Titanium Gears', description: 'Removes efficiency penalty from gear chains.', price: 500, icon: <Settings className="w-5 h-5" /> },
    { id: 'super_cooler', name: 'Super Cooler', description: 'Reduces engine heat generation by 40%.', price: 300, icon: <Zap className="w-5 h-5" /> },
    { id: 'nitro_system', name: 'Nitro System', description: 'Increases base torque by 25%.', price: 450, icon: <Flame className="w-5 h-5" /> },
    { id: 'aero_chassis', name: 'Aero Chassis', description: 'Reduces air resistance at high speeds.', price: 600, icon: <Wind className="w-5 h-5" /> },
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

  // Gear Connectivity Logic (BFS)
  useEffect(() => {
    if (gears.length === 0) {
      setGearRatio(0);
      setIsConnected(false);
      setConnectedGears([]);
      return;
    }

    const gearMap = new Map<string, Gear>(gears.map(g => [g.id, g]));
    const visited = new Set<string>();
    const queue: string[] = [];

    // Start with gears in column 0
    gears.filter(g => g.x === 0).forEach(g => {
      queue.push(g.id);
      visited.add(g.id);
    });

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const current = gearMap.get(currentId) as Gear;
      if (!current) continue;

      // Check neighbors (8 directions)
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const nx = current.x + dx;
          const ny = current.y + dy;
          const neighborId = `${nx}-${ny}`;
          
          if (gearMap.has(neighborId) && !visited.has(neighborId)) {
            visited.add(neighborId);
            queue.push(neighborId);
          }
        }
      }
    }

    const connectedList = Array.from(visited);
    setConnectedGears(connectedList);

    const reachableEndGears = gears.filter(g => g.x === GRID_COLS - 1 && visited.has(g.id));
    const startGears = gears.filter(g => g.x === 0 && visited.has(g.id));

    if (reachableEndGears.length > 0) {
      // Calculate ratio: Average end teeth / Average start teeth
      const avgEnd = reachableEndGears.reduce((acc, g) => acc + g.teeth, 0) / reachableEndGears.length;
      const avgStart = startGears.reduce((acc, g) => acc + g.teeth, 0) / startGears.length;
      
      // We want: Small start + Large end = High Speed (High Ratio)
      // Large start + Small end = High Torque (Low Ratio)
      setGearRatio(avgEnd / avgStart);
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

    // ── Reset per-race state at race start ────────────────────────────
    raceStatsRef.current = {
      startTime: performance.now(),
      endTime: 0,
      distanceCovered: 0,
      topSpeed: 0,
      speedSamples: [],
      crashes: 0,
      nearMisses: 0,
      boostsUsed: 0,
      timeInGear: [0,0,0,0],
      lastGearChangeTime: 0,
      maxEngineTemp: 20,
      drafts: 0,
    };
    particlesRef.current = [];
    policeRef.current = null;
    policeCooldownRef.current = 0;
    draftTimerRef.current = 0;
    ghostRecordingRef.current = [];

    let animFrame: number;
    let lastTime = performance.now();
    let localDistance = distance;
    let localSpeed = currentSpeed;
    let localPlayerLane = playerLane;
    let localObstacles: { id: string, lane: number, z: number, type: string, processed?: boolean, oldLane?: number, vx?: number, targetLane?: number }[] = [];
    let localEngineTemp = engineTemp;
    let screenShake = 0;
    let localBoostTimer = 0;
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
      const efficiency = hasUpgrade('titanium_gears') ? 1 : Math.max(0.5, 1 - (connectedGears.length * 0.02));
      const gboxMult = gearboxRatiosRef.current[currentGearRef.current - 1] ?? 1;
      const effectiveRatio = Math.max(0.05, gearRatio * gboxMult);
      let topSpeed = (200 + (effectiveRatio * 300 * efficiency)) * turboTopMult;
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

      const drag = 0.5; // Air resistance
      const friction = 20; // Ground friction

      // ── New: pull live values for tires / weather / damage ─────────────
      const tireSpec = TIRE_COMPOUNDS[tireCompoundRef.current];
      const wx = WEATHER_OPTS[weatherRef.current];
      const dmg = damageRef.current;
      // Engine damage caps top speed and acceleration
      const engineHealth = 1 - dmg.engine * 0.45; // up to -45% top speed
      const brakeHealth  = 1 - dmg.brakes * 0.50; // up to -50% brake power
      // Tire wear erodes grip
      const tireGripScale = (1 - dmg.tires * 0.40) * tireSpec.grip * wx.gripMult;

      // Brake power scales with brake tuning (level 1 = 70%, level 5 = 130%).
      const brakePower = 600 * (1 + (tn.brakes - 3) * 0.15) * brakeHealth;
      const adjAcceleration = acceleration * engineHealth;
      const adjTopSpeed = topSpeed * engineHealth;
      if (activeAcceleration) {
        localSpeed = Math.min(adjTopSpeed, localSpeed + adjAcceleration * dt);
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
      const tireResponse = 10 * (1 + (tn.tires - 3) * 0.15);
      const diff = targetLaneRef.current - localPlayerLane;
      if (Math.abs(diff) < 0.01) localPlayerLane = targetLaneRef.current;
      else localPlayerLane += diff * tireResponse * dt;
      setPlayerLane(localPlayerLane);

      // Heat management — uphill stresses the engine, downhill braking cooks brakes.
      // Wrong gear (too low for current speed) over-revs and adds heat too.
      const overRev = Math.max(0, (localSpeed / Math.max(50, topSpeed)) - 0.95) * 8;
      // Cooling tuning: level 1 = +50% heat, level 5 = -40% heat. Stacks with super_cooler.
      const coolMult = (1 - (tn.cooling - 3) * 0.18) * (hasUpgrade('super_cooler') ? 0.6 : 1);
      const coolDecay = 5 * (1 + (tn.cooling - 3) * 0.25); // off-throttle cool-down
      if (activeAcceleration) {
        const slopeHeat = Math.max(0, slope) * 18; // uphill burst
        const heatGen = (effectiveRatio * 0.5 + localSpeed * 0.01 + slopeHeat + overRev) * coolMult;
        localEngineTemp = Math.min(100, localEngineTemp + heatGen * dt);
      } else {
        // Engine still warms a bit going uphill even off-throttle
        const idleHeat = Math.max(0, slope) * 4 + overRev * 0.4;
        localEngineTemp = Math.max(20, localEngineTemp + (idleHeat - coolDecay) * dt);
      }
      setEngineTemp(localEngineTemp);

      // Brake heat: better brakes shed less heat per unit work but apply harder.
      const brakeHeatMult = 1 - (tn.brakes - 3) * 0.10;
      if (brake) {
        const downhillBoost = Math.max(0, -slope) * 60;
        setBrakeTemp(prev => Math.min(100, prev + (20 + downhillBoost) * brakeHeatMult * dt));
      } else {
        setBrakeTemp(prev => Math.max(20, prev - 10 * dt));
      }

      if (localEngineTemp >= 90) {
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

        // Finalize per-race telemetry
        const rsFinal = raceStatsRef.current;
        rsFinal.endTime = performance.now();
        rsFinal.distanceCovered = localDistance;
        setLastRaceStats({ ...rsFinal });
        const elapsedSec = (rsFinal.endTime - rsFinal.startTime) / 1000;
        speakRef.current('Race complete!');

        // Save best ghost (single-player only — track is shared geometry)
        if (gameMode === 'single' && ghostRecordingRef.current.length > 4) {
          const cur = ghostBestRef.current;
          if (!cur || elapsedSec < cur.time) {
            const samples: GhostSample[] = ghostRecordingRef.current.slice();
            setGhostBest({ time: elapsedSec, samples });
            speakRef.current('New record!');
          }
        }

        // Daily challenge: did we satisfy it today?
        if (
          !dailyDone
          && trackThemeRef.current === dailyChallenge.theme
          && weatherRef.current === dailyChallenge.weather
          && tireCompoundRef.current === dailyChallenge.tire
          && elapsedSec <= dailyChallenge.goalSec
        ) {
          addCredits(dailyChallenge.reward);
          localStorage.setItem('gear_race_daily_' + todayKey, '1');
          setDailyDone(true);
          speakRef.current('Daily challenge complete!');
        }
        
        // Rewards and Missions
        const reward = gameMode === 'multi' ? 300 : 100;
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

      // ── Obstacle generation (extended types) ──────────────────────────
      // Practice mode: spawn far fewer hazards so the player can focus on driving.
      if (!practiceModeRef.current && localDistance > nextObstacleZRef.current) {
        const r = Math.random();
        // Extended distribution: vehicles 60%, hazards 40%.
        // Vehicles: truck/car/van/bike/bus
        // Hazards: pothole (static), oil_slick (static), ramp (static)
        const type = r < 0.18 ? 'truck'
                   : r < 0.34 ? 'car'
                   : r < 0.46 ? 'van'
                   : r < 0.54 ? 'bike'
                   : r < 0.60 ? 'bus'
                   : r < 0.74 ? 'pothole'
                   : r < 0.88 ? 'oil_slick'
                   : 'ramp';
        const lane = Math.floor(Math.random() * 3) - 1;
        // Some vehicles drift between lanes — moving obstacles!
        const isMoving = (type === 'car' || type === 'van' || type === 'bike') && Math.random() < 0.35;
        localObstacles.push({
          id: Math.random().toString(36).slice(2, 11),
          lane,
          z: localDistance + 2500,
          type,
          vx: isMoving ? (Math.random() < 0.5 ? -0.35 : 0.35) : 0,
          targetLane: isMoving ? (lane === 1 ? 0 : lane === -1 ? 0 : (Math.random() < 0.5 ? 1 : -1)) : lane,
        });
        // Practice mode would have ducked above, but if disabled spacing tightens slightly with theme.
        const themeMult = trackThemeRef.current === 'city' ? 0.85 : 1;
        nextObstacleZRef.current = localDistance + (400 + Math.random() * 600) * themeMult;
      }

      // ── Police chase ──────────────────────────────────────────────────
      // After 12s of consistent high speed, a police unit spawns behind & chases.
      if (!practiceModeRef.current && policeRef.current === null && policeCooldownRef.current <= 0) {
        if (localSpeed > adjTopSpeed * 0.78) {
          policeCooldownRef.current = (policeCooldownRef.current || 0) + dt;
        }
        // Use a hidden accumulator on the ref via a numeric trick: store negative as accumulator
        // (simpler: just spawn with low probability while at top speed)
        if (localSpeed > adjTopSpeed * 0.85 && Math.random() < dt * 0.04) {
          policeRef.current = { z: localDistance - 800, lane: 0, siren: 0 };
          speakRef.current('Police on your tail!');
        }
      }
      if (policeRef.current) {
        const p = policeRef.current;
        // Police speed: matches yours + small bonus, but if very far behind catches up faster.
        const gap = localDistance - p.z;
        const policeSpeed = localSpeed + (gap > 600 ? 80 : 20) - (Math.random() * 10);
        p.z += policeSpeed * dt;
        p.siren += dt;
        // Lane tracking: try to match player's lane gradually.
        const laneErr = localPlayerLane - p.lane;
        p.lane += Math.sign(laneErr) * Math.min(Math.abs(laneErr), 0.7 * dt);
        // If they overtake you while in the same lane → bust (small explosion / heavy damage).
        if (p.z > localDistance - 60 && Math.abs(p.lane - localPlayerLane) < 0.5) {
          // Major hit
          localSpeed *= 0.3;
          localEngineTemp += 25;
          screenShake = 28;
          setDamage(d => ({ ...d, engine: Math.min(1, d.engine + 0.15), brakes: Math.min(1, d.brakes + 0.10) }));
          policeRef.current = null;
          policeCooldownRef.current = 12; // 12s before another can spawn
          sounds.playCrash();
          audioBus.playSfx('crash');
          speakRef.current('Busted!');
          for (let i = 0; i < 30; i++) {
            particlesRef.current.push({
              x: (Math.random() - 0.5) * 200, y: -50 - Math.random() * 100,
              vx: (Math.random() - 0.5) * 400, vy: -100 - Math.random() * 200,
              life: 1.2, maxLife: 1.2, color: i % 2 ? '#3b82f6' : '#ef4444',
              size: 3 + Math.random() * 4, gravity: 600, kind: 'spark',
            });
          }
          raceStatsRef.current.crashes += 1;
        }
        // Despawn if very far behind
        if (gap > 2500) policeRef.current = null;
      }
      if (policeCooldownRef.current > 0) policeCooldownRef.current = Math.max(0, policeCooldownRef.current - dt);

      // Filter and collision
      let nearestAheadGap = Infinity; let nearestAheadLane = 99;
      localObstacles = localObstacles.filter(obs => {
        // Move dynamic obstacles
        if (obs.vx && obs.targetLane !== undefined && obs.targetLane !== obs.lane) {
          const step = obs.vx * dt;
          if (Math.abs(obs.targetLane - obs.lane) < Math.abs(step)) {
            obs.lane = obs.targetLane;
            // Pick a new target every now and then
            if (Math.random() < 0.4) {
              obs.targetLane = Math.floor(Math.random() * 3) - 1;
              obs.vx = obs.targetLane > obs.lane ? Math.abs(obs.vx!) : -Math.abs(obs.vx!);
            }
          } else {
            obs.lane += step;
          }
        }

        const relativeZ = obs.z - localDistance;

        // Track nearest vehicle ahead in our lane (used for drafting)
        if (relativeZ > 80 && relativeZ < 600 && Math.abs(obs.lane - localPlayerLane) < 0.4) {
          if (['truck','car','van','bike','bus'].includes(obs.type) && relativeZ < nearestAheadGap) {
            nearestAheadGap = relativeZ;
            nearestAheadLane = obs.lane;
          }
        }

        // Collision detection
        if (relativeZ < 50 && relativeZ > -50 && Math.abs(obs.lane - targetLaneRef.current) < 0.5) {
          if (obs.type === 'oil_slick') {
            // Oil: don't lose speed but lose grip — sharp lateral wobble + tire wear
            screenShake = 8;
            setDamage(d => ({ ...d, tires: Math.min(1, d.tires + 0.05) }));
            const wobble = (Math.random() < 0.5 ? -1 : 1) * 0.6;
            setTargetLane(prev => Math.max(-1, Math.min(1, prev + wobble)));
            audioBus.playSfx('crash');
            // Smoke particles
            for (let i = 0; i < 14; i++) {
              particlesRef.current.push({
                x: (Math.random() - 0.5) * 80, y: -20 - Math.random() * 20,
                vx: (Math.random() - 0.5) * 60, vy: -30 - Math.random() * 40,
                life: 1.2, maxLife: 1.2, color: '#1f2937',
                size: 6 + Math.random() * 8, gravity: 0, kind: 'smoke',
              });
            }
            return false;
          }
          if (obs.type === 'pothole') {
            // Pothole: heavy speed loss + tire damage + brake damage
            const grip = 1 + (tn.tires - 3) * 0.15;
            localSpeed *= 0.55;
            screenShake = 18;
            setDamage(d => ({
              ...d,
              tires: Math.min(1, d.tires + 0.10 / grip),
              brakes: Math.min(1, d.brakes + 0.05),
            }));
            sounds.playCrash();
            audioBus.playSfx('crash');
            // Spark + smoke burst
            for (let i = 0; i < 18; i++) {
              particlesRef.current.push({
                x: (Math.random() - 0.5) * 60, y: -10 - Math.random() * 30,
                vx: (Math.random() - 0.5) * 250, vy: -100 - Math.random() * 200,
                life: 0.9, maxLife: 0.9, color: i % 2 ? '#fbbf24' : '#9ca3af',
                size: 2 + Math.random() * 3, gravity: 800, kind: 'spark',
              });
            }
            raceStatsRef.current.crashes += 1;
            return false;
          }
          if (obs.type === 'ramp') {
            // Ramp: launch! Big speed boost, no damage, high score moment
            localBoostTimer = Math.max(localBoostTimer, 2.5);
            setBoostTime(localBoostTimer);
            setLastBoostType('RAMP JUMP');
            screenShake = 14;
            localSpeed = Math.min(adjTopSpeed * 1.2, localSpeed * 1.15 + 80);
            audioBus.playSfx('boost');
            speakRef.current('Big air!');
            for (let i = 0; i < 22; i++) {
              particlesRef.current.push({
                x: (Math.random() - 0.5) * 100, y: -30 - Math.random() * 60,
                vx: (Math.random() - 0.5) * 200, vy: -250 - Math.random() * 150,
                life: 1.4, maxLife: 1.4, color: '#fbbf24',
                size: 3 + Math.random() * 4, gravity: 500, kind: 'spark',
              });
            }
            return false;
          }
          // Default vehicle collision (truck/car/van/bike/bus)
          // Better tires soften the crash. Worse weather amplifies it.
          const grip = 1 + (tn.tires - 3) * 0.15;
          const wxPenalty = 1 / wx.gripMult;
          localEngineTemp += (15 / grip) * wxPenalty;
          localSpeed *= Math.min(0.7, 0.4 * grip); // less speed lost with better tires
          screenShake = 22; // Trigger screen shake
          localBoostTimer = 0; // Cancel boost on hit
          // Cumulative damage
          setDamage(d => ({
            engine: Math.min(1, d.engine + 0.10 * wxPenalty),
            brakes: Math.min(1, d.brakes + 0.06),
            tires:  Math.min(1, d.tires  + 0.08 / grip),
          }));
          raceStatsRef.current.crashes += 1;
          sounds.playCrash();
          audioBus.playSfx('crash');
          // Spark burst on impact
          for (let i = 0; i < 24; i++) {
            particlesRef.current.push({
              x: (Math.random() - 0.5) * 80, y: -30 - Math.random() * 40,
              vx: (Math.random() - 0.5) * 350, vy: -200 - Math.random() * 250,
              life: 1, maxLife: 1, color: i % 3 ? '#fbbf24' : '#ef4444',
              size: 2 + Math.random() * 3, gravity: 700, kind: 'spark',
            });
          }
          if (raceStatsRef.current.crashes === 1) speakRef.current('Watch out!');
          return false;
        }

        // Near Miss Detection (Trigger when approaching closely)
        if (relativeZ > 0 && relativeZ < 150 && !obs.processed && !['pothole','oil_slick','ramp'].includes(obs.type)) {
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
              boost *= turboDur;
              localBoostTimer = Math.max(localBoostTimer, boost); // Calculate the latest best boost, don't stack
              setBoostTime(localBoostTimer);
              setLastBoostType('NEAR MISS');
              nearMissTextRef.current = { text: msg, x: 0, y: 0, opacity: 1 };
              sounds.playBoost();
              audioBus.playSfx('boost');
              raceStatsRef.current.nearMisses += 1;
              raceStatsRef.current.boostsUsed += 1;
            }
          }
        }
        
        return relativeZ > -100;
      });
      setObstacles([...localObstacles]);

      // ── Drafting ────────────────────────────────────────────────────────
      // If you spend > 1s tucked behind a vehicle in the same lane (gap 80–250),
      // earn a small slingshot speed bonus.
      void nearestAheadLane; // (kept for clarity / future targeting)
      if (nearestAheadGap < 250 && nearestAheadGap > 80) {
        draftTimerRef.current += dt;
        if (draftTimerRef.current > 1.0) {
          // Sustained draft: small continuous top-speed bonus + small heat shed
          localSpeed = Math.min(adjTopSpeed * 1.05, localSpeed + 35 * dt);
          localEngineTemp = Math.max(20, localEngineTemp - 2 * dt);
        }
        if (draftTimerRef.current > 2.0 && !((draftTimerRef.current * 10) | 0 % 30)) {
          // periodic micro-particle as visual hint
          particlesRef.current.push({
            x: (Math.random() - 0.5) * 30, y: -10 - Math.random() * 10,
            vx: (Math.random() - 0.5) * 30, vy: -20,
            life: 0.4, maxLife: 0.4, color: '#7dd3fc',
            size: 2, gravity: 0, kind: 'smoke',
          });
        }
      } else {
        if (draftTimerRef.current > 1.0) raceStatsRef.current.drafts += 1;
        draftTimerRef.current = 0;
      }

      // ── Tire wear over time (faster with soft compound, harder driving) ─
      const wearRate = tireSpec.wear * (activeAcceleration ? 0.0007 : 0.0002) * (1 + Math.abs(diff) * 0.5);
      if (Math.random() < 0.5) setDamage(d => ({ ...d, tires: Math.min(1, d.tires + wearRate * dt) }));

      // ── Particles update ────────────────────────────────────────────────
      const ps = particlesRef.current;
      for (let i = ps.length - 1; i >= 0; i--) {
        const p = ps[i];
        p.life -= dt;
        if (p.life <= 0) { ps.splice(i, 1); continue; }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.gravity) p.vy += p.gravity * dt;
        if (p.kind === 'smoke') { p.vy -= 30 * dt; p.size += 8 * dt; }
      }
      // Cap pool size (defensive)
      if (ps.length > 400) ps.splice(0, ps.length - 400);

      // ── Telemetry ───────────────────────────────────────────────────────
      const rs = raceStatsRef.current;
      if (rs.startTime === 0) rs.startTime = performance.now();
      rs.distanceCovered = localDistance;
      if (localSpeed > rs.topSpeed) rs.topSpeed = localSpeed;
      if (localEngineTemp > rs.maxEngineTemp) rs.maxEngineTemp = localEngineTemp;
      if (Math.random() < 0.05) rs.speedSamples.push(localSpeed);
      rs.timeInGear[currentGearRef.current] = (rs.timeInGear[currentGearRef.current] || 0) + dt;

      // ── Ghost recording (every ~50m) ────────────────────────────────────
      if (gameMode === 'single' && (ghostRecordingRef.current.length === 0 ||
          localDistance - ghostRecordingRef.current[ghostRecordingRef.current.length - 1].d > 50)) {
        ghostRecordingRef.current.push({ d: localDistance, lane: localPlayerLane });
      }

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

      // ── Theme-aware sky / horizon ──────────────────────────────────────
      const theme = TRACK_THEMES[trackThemeRef.current];
      const wxNow = WEATHER_OPTS[weatherRef.current];
      const isNight = weatherRef.current === 'night';
      const isRain = weatherRef.current === 'rain';
      const isFog = weatherRef.current === 'fog';
      const skyGrad = ctx.createLinearGradient(0, 0, 0, horizon);
      const topCol = isNight ? '#020617' : isRain ? '#334155' : isFog ? '#475569' : theme.skyTop;
      const botCol = isNight ? '#1e1b4b' : isRain ? '#64748b' : isFog ? '#94a3b8' : theme.skyBottom;
      skyGrad.addColorStop(0, topCol);
      skyGrad.addColorStop(1, botCol);
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, w, horizon);

      // Sun / Moon
      if (isNight) {
        // Moon
        ctx.fillStyle = '#f8fafc';
        ctx.shadowBlur = 30;
        ctx.shadowColor = '#cbd5e1';
        ctx.beginPath();
        ctx.arc(w * 0.78, h * 0.12, 24, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        // Stars
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        for (let i = 0; i < 30; i++) {
          const sx = (i * 137.5) % w;
          const sy = ((i * 73.3) % horizon) * 0.7;
          ctx.fillRect(sx, sy, 1.5, 1.5);
        }
      } else if (!isFog && !isRain) {
        ctx.fillStyle = '#fef08a';
        ctx.shadowBlur = 40;
        ctx.shadowColor = '#facc15';
        ctx.beginPath();
        ctx.arc(w * 0.8, h * 0.15, 30, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      // Clouds (denser on rain/fog)
      if (!isNight) {
        ctx.fillStyle = isRain ? 'rgba(30, 41, 59, 0.6)' : isFog ? 'rgba(226,232,240,0.45)' : 'rgba(255, 255, 255, 0.3)';
        const drawCloud = (cx: number, cy: number, size: number) => {
          ctx.beginPath();
          ctx.arc(cx, cy, size, 0, Math.PI * 2);
          ctx.arc(cx + size * 0.6, cy - size * 0.2, size * 0.8, 0, Math.PI * 2);
          ctx.arc(cx + size * 1.2, cy, size * 0.7, 0, Math.PI * 2);
          ctx.fill();
        };
        drawCloud(w * 0.2, h * 0.1, 20);
        drawCloud(w * 0.5, h * 0.05, 15);
        drawCloud(w * 0.7, h * 0.12, 25);
        if (isRain) {
          drawCloud(w * 0.35, h * 0.08, 28);
          drawCloud(w * 0.85, h * 0.06, 22);
        }
      }

      // City skyline silhouette for the city theme
      if (trackThemeRef.current === 'city') {
        ctx.fillStyle = '#0a0a14';
        const buildings = 24;
        for (let i = 0; i < buildings; i++) {
          const bx = (i / buildings) * w;
          const bw = w / buildings * 1.05;
          const bh = 25 + ((i * 41) % 60);
          ctx.fillRect(bx, horizon - bh, bw, bh);
          // Lit windows
          ctx.fillStyle = '#fde047';
          for (let r = 0; r < bh / 12; r++) {
            for (let c = 0; c < 3; c++) {
              if (((i * 3 + r * 7 + c * 11) % 5) === 0) {
                ctx.fillRect(bx + 3 + c * (bw / 4), horizon - bh + 3 + r * 12, 2, 2);
              }
            }
          }
          ctx.fillStyle = '#0a0a14';
        }
      } else {
        // Distant mountain silhouette
        ctx.fillStyle = theme.mountainColor;
        ctx.beginPath();
        ctx.moveTo(0, horizon);
        ctx.lineTo(w * 0.1, horizon - 20);
        ctx.lineTo(w * 0.2, horizon - 40);
        ctx.lineTo(w * 0.3, horizon - 10);
        ctx.lineTo(w * 0.4, horizon - 30);
        ctx.lineTo(w * 0.6, horizon - 50);
        ctx.lineTo(w * 0.8, horizon - 20);
        ctx.lineTo(w, horizon);
        ctx.fill();
      }

      // Ground (grass / sand / snow)
      ctx.fillStyle = theme.ground;
      ctx.fillRect(0, horizon, w, h - horizon);

      // Draw Road as N vertical strips, each bent by slope ahead → road climbs/dips visually.
      const ROAD_STRIPS = 36;
      ctx.fillStyle = isRain ? '#0f0f1a' : theme.roadColor;
      for (let i = 0; i < ROAD_STRIPS; i++) {
        const s1 = i / ROAD_STRIPS;
        const s2 = (i + 1) / ROAD_STRIPS;
        const y1 = yAt(s1);
        const y2 = yAt(s2);
        ctx.beginPath();
        ctx.moveTo(getX(-1.8, s1), y1);
        ctx.lineTo(getX(1.8, s1), y1);
        ctx.lineTo(getX(1.8, s2), y2);
        ctx.lineTo(getX(-1.8, s2), y2);
        ctx.closePath();
        ctx.fill();
      }
      // Grass on the SIDES of the bent road. Each polygon traces the road's
      // outer edge from horizon down to foreground, then closes along the
      // screen edge — covering everything between the road and screen edge.
      ctx.fillStyle = '#064e3b';
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

      // Rumble Strips (Side of road)
      const stripCount = 20;
      for (let i = 0; i < stripCount; i++) {
        const zPos = ((localDistance / 100) + i) % stripCount;
        const s1 = 1 - (zPos / stripCount);
        const s2 = 1 - ((zPos + 0.5) / stripCount);
        
        ctx.fillStyle = Math.floor(zPos) % 2 === 0 ? '#fff' : '#e11d48';
        
        const ry1 = yAt(s1);
        const ry2 = yAt(s2);

        // Left Strip
        ctx.beginPath();
        ctx.moveTo(getX(-1.8, s1), ry1);
        ctx.lineTo(getX(-1.6, s1), ry1);
        ctx.lineTo(getX(-1.6, s2), ry2);
        ctx.lineTo(getX(-1.8, s2), ry2);
        ctx.fill();

        // Right Strip
        ctx.beginPath();
        ctx.moveTo(getX(1.6, s1), ry1);
        ctx.lineTo(getX(1.8, s1), ry1);
        ctx.lineTo(getX(1.8, s2), ry2);
        ctx.lineTo(getX(1.6, s2), ry2);
        ctx.fill();
      }

      // Lane Lines — drawn as bent dashed segments so they follow the hills.
      ctx.strokeStyle = localBoostTimer > 0 ? '#fbbf24' : 'rgba(255,255,255,0.3)';
      ctx.lineWidth = 2;
      const LANE_SEGMENTS = 18;
      const dashPeriod = 60;
      const dashOff = (localDistance % dashPeriod) / dashPeriod;
      for (let lane = -0.5; lane <= 0.5; lane += 1) {
        for (let k = 0; k < LANE_SEGMENTS; k++) {
          // Alternate dash on/off using k + dashOff for forward motion illusion
          const phase = (k + dashOff) % 2;
          if (phase >= 1) continue;
          const s1 = k / LANE_SEGMENTS;
          const s2 = Math.min(1, (k + 0.5) / LANE_SEGMENTS);
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
        } else if (obs.type === 'pothole') {
          // Dark elliptical hole on the road
          ctx.fillStyle = '#000';
          ctx.beginPath();
          ctx.ellipse(x, y - size * 0.04, size * 0.55, size * 0.18, 0, 0, Math.PI * 2);
          ctx.fill();
          // Inner darker ring
          ctx.fillStyle = '#0a0a0a';
          ctx.beginPath();
          ctx.ellipse(x, y - size * 0.04, size * 0.42, size * 0.13, 0, 0, Math.PI * 2);
          ctx.fill();
          // Cracked edge highlight
          ctx.strokeStyle = 'rgba(180,180,180,0.35)';
          ctx.lineWidth = Math.max(1, 1.4 * scale);
          ctx.beginPath();
          ctx.ellipse(x, y - size * 0.04, size * 0.55, size * 0.18, 0, 0, Math.PI * 2);
          ctx.stroke();
        } else if (obs.type === 'oil_slick') {
          // Iridescent dark blob
          const oGrad = ctx.createRadialGradient(x, y - size * 0.05, 2, x, y - size * 0.05, size * 0.55);
          oGrad.addColorStop(0, '#7c3aed');
          oGrad.addColorStop(0.4, '#1e1b4b');
          oGrad.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = oGrad;
          ctx.beginPath();
          ctx.ellipse(x, y - size * 0.05, size * 0.6, size * 0.2, 0, 0, Math.PI * 2);
          ctx.fill();
          // Glossy reflection
          ctx.fillStyle = 'rgba(167, 139, 250, 0.5)';
          ctx.beginPath();
          ctx.ellipse(x - size * 0.15, y - size * 0.08, size * 0.18, size * 0.05, 0, 0, Math.PI * 2);
          ctx.fill();
        } else if (obs.type === 'ramp') {
          // Yellow / black wedge ramp
          const rampW = size * 1.0;
          const rampH = size * 0.55;
          const grad = ctx.createLinearGradient(x, y - rampH, x, y);
          grad.addColorStop(0, '#fbbf24');
          grad.addColorStop(1, '#b45309');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.moveTo(x - rampW/2, y);
          ctx.lineTo(x + rampW/2, y);
          ctx.lineTo(x + rampW * 0.35, y - rampH);
          ctx.lineTo(x - rampW * 0.35, y - rampH);
          ctx.closePath();
          ctx.fill();
          // Hazard stripes
          ctx.fillStyle = '#0f172a';
          for (let s2 = 0; s2 < 4; s2++) {
            ctx.fillRect(x - rampW/2 + (rampW/4) * s2 + 4 * scale, y - 4 * scale, rampW/8, 4 * scale);
          }
          // Top edge
          ctx.fillStyle = '#fde68a';
          ctx.fillRect(x - rampW * 0.35, y - rampH - 2 * scale, rampW * 0.7, 2 * scale);
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

      // ── Ghost replay (single-player only, when a best run exists) ─────
      if (gameMode === 'single' && ghostBestRef.current && ghostBestRef.current.samples.length > 0) {
        const samples = ghostBestRef.current.samples;
        // Find ghost's current lane via interpolation by distance.
        // Ghost moves on a virtual time-based pace = bestTime / TRACK_LENGTH.
        const elapsed = (performance.now() - raceStatsRef.current.startTime) / 1000;
        const ghostD = (elapsed / Math.max(1, ghostBestRef.current.time)) * TRACK_LENGTH;
        // Find the two surrounding samples
        let lo = 0, hi = samples.length - 1;
        while (lo < hi - 1) {
          const mid = (lo + hi) >> 1;
          if (samples[mid].d < ghostD) lo = mid; else hi = mid;
        }
        const a = samples[lo], b = samples[hi] || a;
        const t = (ghostD - a.d) / Math.max(1, (b.d - a.d));
        const gLane = a.lane + (b.lane - a.lane) * Math.max(0, Math.min(1, t));
        const relZ = ghostD - localDistance;
        if (relZ > -300 && relZ < 4000) {
          const gScale = 800 / (relZ + 800);
          const gx = getX(gLane, gScale);
          const gy = yAt(gScale);
          ctx.save();
          ctx.globalAlpha = 0.45;
          ctx.shadowBlur = 18;
          ctx.shadowColor = '#a78bfa';
          ctx.fillStyle = '#a78bfa';
          const gSize = 60 * gScale;
          ctx.beginPath();
          ctx.roundRect(gx - gSize/2, gy - gSize/2, gSize, gSize/2, 6 * gScale);
          ctx.fill();
          ctx.fillStyle = '#ddd6fe';
          ctx.font = `bold ${Math.max(8, 12 * gScale)}px Inter`;
          ctx.textAlign = 'center';
          ctx.fillText('GHOST', gx, gy - gSize/2 - 4);
          ctx.restore();
        }
      }

      // ── Police chase rendering ────────────────────────────────────────
      if (policeRef.current) {
        const p = policeRef.current;
        const relZ = p.z - localDistance;
        if (relZ > -200 && relZ < 4000) {
          const scale = 800 / (relZ + 800);
          const x = getX(p.lane, scale);
          const y = yAt(scale);
          const size = 78 * scale;
          // Shadow
          ctx.fillStyle = 'rgba(0,0,0,0.45)';
          ctx.beginPath(); ctx.ellipse(x, y + size * 0.04, size * 0.55, size * 0.12, 0, 0, Math.PI * 2); ctx.fill();
          // Body — black-and-white
          const carW = size * 0.95;
          const carH = size * 0.75;
          const grad = ctx.createLinearGradient(x, y - carH, x, y);
          grad.addColorStop(0, '#171717');
          grad.addColorStop(0.5, '#f8fafc');
          grad.addColorStop(1, '#171717');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.roundRect(x - carW/2, y - carH * 0.55, carW, carH * 0.45, 5 * scale);
          ctx.fill();
          // Roof
          ctx.fillStyle = '#171717';
          ctx.beginPath();
          ctx.moveTo(x - carW * 0.32, y - carH * 0.55);
          ctx.lineTo(x - carW * 0.26, y - carH);
          ctx.lineTo(x + carW * 0.26, y - carH);
          ctx.lineTo(x + carW * 0.32, y - carH * 0.55);
          ctx.closePath();
          ctx.fill();
          // Sirens — alternating red / blue based on siren timer
          const flash = Math.floor(p.siren * 10) % 2;
          ctx.shadowBlur = 22 * scale;
          ctx.fillStyle = flash ? '#ef4444' : '#3b82f6';
          ctx.shadowColor = flash ? '#ef4444' : '#3b82f6';
          ctx.fillRect(x - size * 0.18, y - carH - 4 * scale, size * 0.16, size * 0.06);
          ctx.fillStyle = flash ? '#3b82f6' : '#ef4444';
          ctx.shadowColor = flash ? '#3b82f6' : '#ef4444';
          ctx.fillRect(x + size * 0.02, y - carH - 4 * scale, size * 0.16, size * 0.06);
          ctx.shadowBlur = 0;
          // Windshield
          ctx.fillStyle = 'rgba(15,23,42,0.85)';
          ctx.beginPath();
          ctx.moveTo(x - carW * 0.28, y - carH * 0.58);
          ctx.lineTo(x - carW * 0.22, y - carH * 0.95);
          ctx.lineTo(x + carW * 0.22, y - carH * 0.95);
          ctx.lineTo(x + carW * 0.28, y - carH * 0.58);
          ctx.closePath();
          ctx.fill();
          // POLICE text
          ctx.fillStyle = '#0a0a0a';
          ctx.font = `bold ${Math.max(8, 10 * scale)}px Inter`;
          ctx.textAlign = 'center';
          ctx.fillText('POLICE', x, y - carH * 0.30);
        }
      }

      // Draw Player Car (Improved 3D-ish model and positioning, customizable color)
      const playerCol = CAR_COLORS.find(c => c.id === carColorIdRef.current) || CAR_COLORS[0];
      const carX = getX(localPlayerLane, 0.9); // Positioned slightly further up for better view
      const carY = h - 30; 
      
      // Car Shadow
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath();
      ctx.ellipse(carX, carY + 8, 35, 12, 0, 0, Math.PI * 2);
      ctx.fill();

      // Car Body
      ctx.fillStyle = localBoostTimer > 0 ? '#fbbf24' : playerCol.body;
      ctx.shadowBlur = localBoostTimer > 0 ? 30 : (isNight ? 18 : 0);
      ctx.shadowColor = localBoostTimer > 0 ? '#fbbf24' : playerCol.glow;
      ctx.beginPath();
      ctx.roundRect(carX - 30, carY - 15, 60, 30, 6);
      ctx.fill();
      
      // Car Roof
      ctx.fillStyle = localBoostTimer > 0 ? '#fef3c7' : playerCol.roof;
      ctx.beginPath();
      ctx.roundRect(carX - 22, carY - 26, 44, 18, 4);
      ctx.fill();

      // Windows
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(carX - 18, carY - 24, 36, 11);

      // Tire wear visual: when tires are worn, show a faint yellow rim
      if (damageRef.current.tires > 0.5) {
        ctx.strokeStyle = `rgba(250,204,21,${(damageRef.current.tires - 0.5) * 1.5})`;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.roundRect(carX - 30, carY - 15, 60, 30, 6); ctx.stroke();
      }
      
      // Tail Lights
      ctx.fillStyle = isBraking ? '#ff0000' : '#991b1b';
      ctx.shadowBlur = isBraking ? 15 : 0;
      ctx.shadowColor = '#ff0000';
      ctx.fillRect(carX - 26, carY - 4, 11, 6);
      ctx.fillRect(carX + 15, carY - 4, 11, 6);
      ctx.shadowBlur = 0;

      // ── Particles render ──────────────────────────────────────────────
      const psR = particlesRef.current;
      for (let i = 0; i < psR.length; i++) {
        const p = psR[i];
        const a = Math.max(0, Math.min(1, p.life / p.maxLife));
        ctx.globalAlpha = a;
        ctx.fillStyle = p.color;
        // Anchor to player car (sparks/smoke originate at the rear bumper)
        const px = carX + p.x;
        const py = carY + p.y;
        if (p.kind === 'smoke') {
          ctx.beginPath();
          ctx.arc(px, py, p.size, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillRect(px - p.size/2, py - p.size/2, p.size, p.size);
        }
      }
      ctx.globalAlpha = 1;

      // ── Weather overlays ──────────────────────────────────────────────
      if (isRain) {
        // Rain streaks
        ctx.strokeStyle = 'rgba(186, 230, 253, 0.5)';
        ctx.lineWidth = 1;
        const rainCount = 90;
        const drift = (performance.now() / 50) % 18;
        for (let i = 0; i < rainCount; i++) {
          const rx = ((i * 137.7) % w + drift * (i % 3)) % w;
          const ry = ((i * 91.3 + drift * 30) % h);
          ctx.beginPath();
          ctx.moveTo(rx, ry);
          ctx.lineTo(rx - 4, ry + 18);
          ctx.stroke();
        }
        // Wet road sheen
        ctx.fillStyle = 'rgba(56, 189, 248, 0.06)';
        ctx.fillRect(0, horizon, w, h - horizon);
      }
      if (isFog) {
        // Fog overlay — denser at distance (top of road), lighter at bottom
        const fogGrad = ctx.createLinearGradient(0, horizon, 0, h);
        fogGrad.addColorStop(0, 'rgba(226,232,240,0.85)');
        fogGrad.addColorStop(0.5, 'rgba(203,213,225,0.45)');
        fogGrad.addColorStop(1, 'rgba(226,232,240,0.0)');
        ctx.fillStyle = fogGrad;
        ctx.fillRect(0, horizon - 20, w, h - horizon + 20);
      }
      if (isNight) {
        // Night vignette — darker at edges, slight headlight cone in front
        const nGrad = ctx.createRadialGradient(w/2, h * 0.85, 100, w/2, h * 0.85, w * 0.7);
        nGrad.addColorStop(0, 'rgba(0,0,0,0)');
        nGrad.addColorStop(1, 'rgba(0,0,0,0.55)');
        ctx.fillStyle = nGrad;
        ctx.fillRect(0, 0, w, h);
        // Headlight cone (subtle yellow wedge)
        ctx.fillStyle = 'rgba(254, 240, 138, 0.07)';
        ctx.beginPath();
        ctx.moveTo(carX - 12, carY - 8);
        ctx.lineTo(carX - 280, horizon + 30);
        ctx.lineTo(carX + 280, horizon + 30);
        ctx.lineTo(carX + 12, carY - 8);
        ctx.closePath();
        ctx.fill();
      }
      // Generic visibility dim from weather
      if (wxNow.visMult < 1) {
        ctx.fillStyle = `rgba(0,0,0,${(1 - wxNow.visMult) * 0.25})`;
        ctx.fillRect(0, 0, w, h);
      }

      // ── Motion blur (CSS filter on the canvas itself) ─────────────────
      // Subtle blur kicks in above 350 km/h-ish, capped at 2.2px so the UI
      // still reads. Boost adds a touch more for a punchier feel.
      const motionBlurPx = Math.min(2.2,
        Math.max(0, (localSpeed - 350) / 220) + (localBoostTimer > 0 ? 0.4 : 0)
      );
      canvas.style.filter = motionBlurPx > 0.05 ? `blur(${motionBlurPx.toFixed(2)}px)` : '';

      // ── Smart camera shake: extra wobble at very high speed / overheat ─
      if (localSpeed > 420) screenShake = Math.max(screenShake, (localSpeed - 420) * 0.02);
      if (localEngineTemp > 80) screenShake = Math.max(screenShake, (localEngineTemp - 80) * 0.4);
      
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
      setGears([...gears, { id, x, y, teeth: 16, type: 'intermediate' }]);
      setSelectedGearId(id); // Open menu for the new gear
    }
  };

  const setTeeth = (id: string, teeth: number) => {
    setGears(gears.map(g => g.id === id ? { ...g, teeth } : g));
    setSelectedGearId(null);
  };

  const removeGear = (id: string) => {
    setGears(gears.filter(g => g.id !== id));
    setSelectedGearId(null);
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
                  className={`p-2 rounded-full transition-all border ${isGarageOpen ? 'bg-rose-600 border-rose-400 shadow-lg shadow-rose-600/20' : 'bg-white/5 border-white/10 hover:bg-white/10'}`}
                >
                  <Settings className={`w-4 h-4 ${isGarageOpen ? 'animate-spin-slow' : ''}`} />
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
                  <div className="absolute left-3 top-1/2 -translate-y-1/2 z-30 pointer-events-none hidden sm:flex flex-col items-center bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl px-3 py-4 shadow-xl">
                    <p className="text-[9px] text-white/50 uppercase font-black tracking-widest mb-2">Speed</p>
                    <div className="relative w-4 h-48 bg-white/5 rounded-full overflow-hidden border border-white/10">
                      <motion.div
                        className="absolute bottom-0 left-0 right-0 rounded-full"
                        style={{
                          background: 'linear-gradient(to top, #f43f5e, #fb923c, #fbbf24)'
                        }}
                        animate={{ height: `${speedPct * 100}%` }}
                        transition={{ duration: 0.15 }}
                      />
                      {[0.25, 0.5, 0.75].map(t => (
                        <div key={t} className="absolute left-0 right-0 h-px bg-white/10" style={{ bottom: `${t * 100}%` }} />
                      ))}
                    </div>
                    <p className="mt-3 text-2xl font-mono font-black text-rose-500 italic leading-none">
                      {speedKmh.toFixed(0)}
                    </p>
                    <p className="text-[9px] text-white/40 font-black tracking-widest mt-0.5">KM/H</p>
                  </div>

                  {/* Vertical Torque Gauge - Right Side */}
                  <div className="absolute right-3 top-1/2 -translate-y-1/2 z-30 pointer-events-none hidden sm:flex flex-col items-center bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl px-3 py-4 shadow-xl">
                    <p className="text-[9px] text-white/50 uppercase font-black tracking-widest mb-2">Torque</p>
                    <div className="relative w-4 h-48 bg-white/5 rounded-full overflow-hidden border border-white/10">
                      <motion.div
                        className="absolute bottom-0 left-0 right-0 rounded-full"
                        style={{
                          background: 'linear-gradient(to top, #92400e, #f59e0b, #fde68a)'
                        }}
                        animate={{ height: `${torquePct * 100}%` }}
                        transition={{ duration: 0.15 }}
                      />
                      {[0.25, 0.5, 0.75].map(t => (
                        <div key={t} className="absolute left-0 right-0 h-px bg-white/10" style={{ bottom: `${t * 100}%` }} />
                      ))}
                    </div>
                    <p className="mt-3 text-2xl font-mono font-black text-amber-500 italic leading-none">
                      {torqueVal.toFixed(0)}
                    </p>
                    <p className="text-[9px] text-white/40 font-black tracking-widest mt-0.5">Nm</p>
                  </div>
                </>
              );
            })()}

            {/* Bottom Dashboard - Auxiliary indicators (only during racing) */}
            {gameState === 'racing' && (
            <div className="absolute bottom-36 sm:bottom-32 left-0 right-0 sm:right-auto sm:left-4 z-30 pointer-events-none px-4 sm:px-0">
              <div className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl p-2 sm:p-3 flex justify-between sm:justify-start gap-2 sm:gap-12 shadow-xl overflow-x-auto">
                {/* Speed shown only on mobile here (vertical gauge is desktop-only) */}
                <div className="text-center min-w-[60px] sm:hidden">
                  <p className="text-[8px] text-white/40 uppercase font-black tracking-widest mb-1">Speed</p>
                  <p className="text-2xl font-mono font-black text-rose-500 italic">
                    {(currentSpeed / 10).toFixed(0)}
                    <span className="text-[8px] ml-0.5 opacity-60 text-white">KM/H</span>
                  </p>
                </div>
                <div className="text-center min-w-[60px]">
                  <p className="text-[8px] sm:text-[10px] text-white/40 uppercase font-black tracking-widest mb-1">Efficiency</p>
                  <p className="text-xl sm:text-4xl font-mono font-black text-blue-400 italic">
                    {(Math.max(0.5, 1 - (connectedGears.length * 0.02)) * 100).toFixed(0)}%
                  </p>
                </div>
                <div className="w-[1px] bg-white/10 hidden sm:block" />
                {/* Torque shown only on mobile here */}
                <div className="text-center min-w-[60px] sm:hidden">
                  <p className="text-[8px] text-white/40 uppercase font-black tracking-widest mb-1">Torque</p>
                  <p className="text-xl font-mono font-black text-amber-500 italic">
                    {gearRatio > 0 ? ((150 * Math.max(0.5, 1 - (connectedGears.length * 0.02)) * (hasUpgrade('nitro_system') ? 1.25 : 1)) / Math.max(0.3, Math.pow(gearRatio, 0.7))).toFixed(0) : 0}
                  </p>
                </div>
                <div className="w-[1px] bg-white/10 hidden sm:block" />
                <div className="text-center min-w-[64px]">
                  <p className="text-[8px] sm:text-[10px] text-white/40 uppercase font-black tracking-widest mb-1">Gear</p>
                  <div className="flex items-center justify-center gap-1.5 mt-1">
                    {[1, 2, 3, 4].map(g => (
                      <button
                        key={g}
                        onClick={() => { setCurrentGear(g); audioBus.playSfx('click'); }}
                        className={`pointer-events-auto w-5 h-7 sm:w-6 sm:h-9 rounded-md text-[10px] sm:text-sm font-mono font-black transition-all border ${
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
                  <p className="text-[8px] text-white/40 font-mono mt-0.5">×{gearboxRatios[currentGear - 1].toFixed(2)}</p>
                </div>
                <div className="w-[1px] bg-white/10 hidden sm:block" />
                <div className="text-center min-w-[64px]">
                  <p className="text-[8px] sm:text-[10px] text-white/40 uppercase font-black tracking-widest mb-1">Slope</p>
                  <div className="flex items-center justify-center h-[36px] sm:h-[44px]">
                    <svg width="48" height="36" viewBox="-24 -18 48 36" className="overflow-visible">
                      <line x1="-22" y1="0" x2="22" y2="0" stroke="rgba(255,255,255,0.08)" strokeWidth="1.5" strokeDasharray="2 3" />
                      <g transform={`rotate(${(-currentSlope * 180 / Math.PI).toFixed(2)})`}>
                        <line x1="-20" y1="0" x2="20" y2="0" stroke={Math.abs(currentSlope) > 0.12 ? '#f43f5e' : currentSlope > 0.04 ? '#f59e0b' : currentSlope < -0.04 ? '#3b82f6' : '#10b981'} strokeWidth="3" strokeLinecap="round" />
                        <polygon points="20,0 14,-4 14,4" fill={Math.abs(currentSlope) > 0.12 ? '#f43f5e' : currentSlope > 0.04 ? '#f59e0b' : currentSlope < -0.04 ? '#3b82f6' : '#10b981'} />
                      </g>
                    </svg>
                  </div>
                  <p className={`text-[10px] sm:text-xs font-mono font-black ${Math.abs(currentSlope) > 0.12 ? 'text-rose-500' : currentSlope > 0.04 ? 'text-amber-400' : currentSlope < -0.04 ? 'text-blue-400' : 'text-emerald-400'}`}>
                    {(currentSlope * 180 / Math.PI).toFixed(0)}°
                  </p>
                </div>
                {gameMode === 'multi' && Object.values(otherPlayers).length > 0 && (
                  <>
                    <div className="w-[1px] bg-white/10 hidden sm:block" />
                    <div className="text-center min-w-[60px]">
                      <p className="text-[8px] sm:text-[10px] text-white/40 uppercase font-black tracking-widest mb-1">Gap</p>
                      <p className={`text-xl sm:text-4xl font-mono font-black ${(distance - (Object.values(otherPlayers)[0] as PlayerState).y) > 0 ? 'text-green-400' : 'text-rose-500'}`}>
                        {((distance - (Object.values(otherPlayers)[0] as PlayerState).y) / 10).toFixed(1)}
                          <span className="text-[8px] sm:text-xs ml-0.5 opacity-40 text-white font-black italic">M</span>
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

                      {/* Race Settings */}
                      <div className="w-full mt-4 p-4 bg-white/5 border border-white/10 rounded-2xl space-y-4">
                        <div className="flex items-center justify-between">
                          <p className="text-xs font-black text-white uppercase tracking-widest">Race Settings</p>
                          <button
                            onClick={() => setPracticeMode(p => !p)}
                            className={`px-3 py-1 rounded-lg text-[10px] font-black uppercase border transition-all ${practiceMode ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' : 'bg-white/5 text-white/50 border-white/10'}`}
                          >
                            {practiceMode ? 'Practice ✓' : 'Practice'}
                          </button>
                        </div>

                        <div className="space-y-2 text-left">
                          <p className="text-[9px] font-black text-white/40 uppercase tracking-widest">Track</p>
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                            {(Object.keys(TRACK_THEMES) as TrackTheme[]).map(k => (
                              <button
                                key={k}
                                onClick={() => { setTrackTheme(k); audioBus.playSfx('click'); }}
                                className={`px-2 py-2 rounded-xl text-[10px] font-black uppercase transition-all border ${trackTheme === k ? 'bg-rose-600 text-white border-rose-400 shadow-lg shadow-rose-600/20' : 'bg-white/5 text-white/60 border-white/10 hover:bg-white/10'}`}
                              >
                                <div className="text-base">{TRACK_THEMES[k].emoji}</div>
                                <div>{TRACK_THEMES[k].name}</div>
                              </button>
                            ))}
                          </div>
                        </div>

                        <div className="space-y-2 text-left">
                          <p className="text-[9px] font-black text-white/40 uppercase tracking-widest">Weather</p>
                          <div className="grid grid-cols-4 gap-2">
                            {(Object.keys(WEATHER_OPTS) as Weather[]).map(k => (
                              <button
                                key={k}
                                onClick={() => { setWeather(k); audioBus.playSfx('click'); }}
                                className={`px-2 py-2 rounded-xl text-[10px] font-black uppercase transition-all border ${weather === k ? 'bg-blue-600 text-white border-blue-400 shadow-lg shadow-blue-600/20' : 'bg-white/5 text-white/60 border-white/10 hover:bg-white/10'}`}
                              >
                                <div className="text-base">{WEATHER_OPTS[k].emoji}</div>
                                <div>{WEATHER_OPTS[k].name}</div>
                              </button>
                            ))}
                          </div>
                        </div>

                        <div className="space-y-2 text-left">
                          <p className="text-[9px] font-black text-white/40 uppercase tracking-widest">Tires</p>
                          <div className="grid grid-cols-3 gap-2">
                            {(Object.keys(TIRE_COMPOUNDS) as TireCompound[]).map(k => (
                              <button
                                key={k}
                                onClick={() => { setTireCompound(k); audioBus.playSfx('click'); }}
                                className={`px-2 py-2 rounded-xl text-[10px] font-black uppercase transition-all border text-left ${tireCompound === k ? 'bg-amber-500 text-black border-amber-300 shadow-lg shadow-amber-500/20' : 'bg-white/5 text-white/60 border-white/10 hover:bg-white/10'}`}
                              >
                                <div className="flex items-center gap-1.5"><span className="text-base">{TIRE_COMPOUNDS[k].emoji}</span><span>{TIRE_COMPOUNDS[k].name}</span></div>
                                <div className={`text-[8px] font-bold normal-case mt-0.5 ${tireCompound === k ? 'text-black/70' : 'text-white/40'}`}>{TIRE_COMPOUNDS[k].desc}</div>
                              </button>
                            ))}
                          </div>
                        </div>

                        <div className="flex items-center justify-between pt-2 border-t border-white/10">
                          <span className="text-[10px] font-black text-white/40 uppercase tracking-widest">Voice Commentary</span>
                          <button
                            onClick={() => setVoiceEnabled(v => !v)}
                            className={`px-3 py-1 rounded-lg text-[10px] font-black uppercase border transition-all ${voiceEnabled ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' : 'bg-white/5 text-white/40 border-white/10'}`}
                          >
                            {voiceEnabled ? 'On' : 'Off'}
                          </button>
                        </div>

                        {(damage.engine + damage.brakes + damage.tires) > 0.05 && (
                          <div className="pt-2 border-t border-white/10">
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-[10px] font-black text-rose-400 uppercase tracking-widest">Vehicle Damage</span>
                              <span className="text-[9px] font-mono text-white/40">repair in garage</span>
                            </div>
                            <div className="grid grid-cols-3 gap-1 text-[9px] font-mono">
                              <div className="bg-black/30 rounded p-1 text-center"><div className="text-white/40 uppercase font-black text-[8px]">Engine</div><div className={damage.engine > 0.5 ? 'text-rose-400' : 'text-white/70'}>{(damage.engine * 100).toFixed(0)}%</div></div>
                              <div className="bg-black/30 rounded p-1 text-center"><div className="text-white/40 uppercase font-black text-[8px]">Brakes</div><div className={damage.brakes > 0.5 ? 'text-rose-400' : 'text-white/70'}>{(damage.brakes * 100).toFixed(0)}%</div></div>
                              <div className="bg-black/30 rounded p-1 text-center"><div className="text-white/40 uppercase font-black text-[8px]">Tires</div><div className={damage.tires > 0.5 ? 'text-rose-400' : 'text-white/70'}>{(damage.tires * 100).toFixed(0)}%</div></div>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Daily Challenge */}
                      <div className={`w-full mt-3 p-4 rounded-2xl border ${dailyDone ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-gradient-to-r from-purple-500/10 to-fuchsia-500/10 border-purple-500/20'}`}>
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <Trophy className={`w-4 h-4 ${dailyDone ? 'text-emerald-400' : 'text-purple-400'}`} />
                            <p className={`text-xs font-black uppercase tracking-widest ${dailyDone ? 'text-emerald-400' : 'text-purple-400'}`}>Daily Challenge {dailyDone && '· Cleared'}</p>
                          </div>
                          <span className="text-[10px] font-mono text-white/40">+{dailyChallenge.reward} cr</span>
                        </div>
                        <p className="text-left text-[10px] font-mono text-white/60">
                          {TRACK_THEMES[dailyChallenge.theme].emoji} {TRACK_THEMES[dailyChallenge.theme].name}
                          · {WEATHER_OPTS[dailyChallenge.weather].emoji} {WEATHER_OPTS[dailyChallenge.weather].name}
                          · {TIRE_COMPOUNDS[dailyChallenge.tire].emoji} {TIRE_COMPOUNDS[dailyChallenge.tire].name}
                          · finish in {dailyChallenge.goalSec}s
                        </p>
                        {!dailyDone && (
                          <button
                            onClick={() => {
                              setTrackTheme(dailyChallenge.theme);
                              setWeather(dailyChallenge.weather);
                              setTireCompound(dailyChallenge.tire);
                              audioBus.playSfx('click');
                            }}
                            className="mt-2 px-3 py-1 bg-purple-500/20 text-purple-300 border border-purple-500/30 rounded-lg text-[10px] font-black uppercase hover:bg-purple-500/30"
                          >
                            Apply Challenge Settings
                          </button>
                        )}
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
                            <Settings className="w-4 h-4 text-rose-500 group-hover:animate-spin-slow" />
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
                  <div className="flex justify-center">
                    <div className="bg-black/40 backdrop-blur-sm px-4 py-1.5 rounded-full border border-white/10 flex items-center gap-2">
                       <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
                       <p className="text-[10px] font-black text-rose-500 uppercase tracking-widest italic">
                        Manual Drive Active
                      </p>
                    </div>
                  </div>

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

                    <div className="max-w-md w-full mb-4 grid grid-cols-3 gap-3">
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

                    {/* Detailed Race Telemetry */}
                    {lastRaceStats && (
                      <div className="max-w-md w-full mb-8 bg-black/40 border border-white/10 rounded-2xl p-5 backdrop-blur-md text-left">
                        <p className="text-[10px] font-black text-white/40 uppercase tracking-widest mb-3">Race Telemetry</p>
                        <div className="grid grid-cols-3 gap-2 text-[10px] font-mono">
                          <div className="bg-white/5 rounded p-2">
                            <div className="text-white/40 uppercase font-black text-[8px]">Time</div>
                            <div className="text-white text-base font-bold">{((lastRaceStats.endTime - lastRaceStats.startTime) / 1000).toFixed(1)}s</div>
                          </div>
                          <div className="bg-white/5 rounded p-2">
                            <div className="text-white/40 uppercase font-black text-[8px]">Top Speed</div>
                            <div className="text-rose-400 text-base font-bold">{(lastRaceStats.topSpeed / 10).toFixed(0)} <span className="text-white/40 text-[8px]">km/h</span></div>
                          </div>
                          <div className="bg-white/5 rounded p-2">
                            <div className="text-white/40 uppercase font-black text-[8px]">Avg Speed</div>
                            <div className="text-amber-400 text-base font-bold">{lastRaceStats.speedSamples.length ? ((lastRaceStats.speedSamples.reduce((a,b)=>a+b,0) / lastRaceStats.speedSamples.length) / 10).toFixed(0) : '0'} <span className="text-white/40 text-[8px]">km/h</span></div>
                          </div>
                          <div className="bg-white/5 rounded p-2">
                            <div className="text-white/40 uppercase font-black text-[8px]">Crashes</div>
                            <div className="text-rose-400 text-base font-bold">{lastRaceStats.crashes}</div>
                          </div>
                          <div className="bg-white/5 rounded p-2">
                            <div className="text-white/40 uppercase font-black text-[8px]">Near Misses</div>
                            <div className="text-emerald-400 text-base font-bold">{lastRaceStats.nearMisses}</div>
                          </div>
                          <div className="bg-white/5 rounded p-2">
                            <div className="text-white/40 uppercase font-black text-[8px]">Boosts</div>
                            <div className="text-yellow-400 text-base font-bold">{lastRaceStats.boostsUsed}</div>
                          </div>
                          <div className="bg-white/5 rounded p-2">
                            <div className="text-white/40 uppercase font-black text-[8px]">Drafts</div>
                            <div className="text-sky-400 text-base font-bold">{lastRaceStats.drafts}</div>
                          </div>
                          <div className="bg-white/5 rounded p-2">
                            <div className="text-white/40 uppercase font-black text-[8px]">Max Engine</div>
                            <div className={`text-base font-bold ${lastRaceStats.maxEngineTemp > 80 ? 'text-rose-400' : 'text-white'}`}>{lastRaceStats.maxEngineTemp.toFixed(0)}°C</div>
                          </div>
                          <div className="bg-white/5 rounded p-2">
                            <div className="text-white/40 uppercase font-black text-[8px]">Distance</div>
                            <div className="text-white text-base font-bold">{(lastRaceStats.distanceCovered / 1000).toFixed(1)}<span className="text-white/40 text-[8px]"> km</span></div>
                          </div>
                        </div>
                        <div className="mt-3 pt-3 border-t border-white/10 text-[9px] font-mono text-white/40 flex flex-wrap gap-3">
                          <span>Gear time:</span>
                          {lastRaceStats.timeInGear.map((t, i) => (
                            <span key={i}>G{i+1}: <span className="text-white/70">{t.toFixed(1)}s</span></span>
                          ))}
                        </div>
                        {ghostBest && gameMode === 'single' && (
                          <div className="mt-2 text-[10px] font-mono text-purple-300">
                            👻 Ghost best: <span className="font-bold">{ghostBest.time.toFixed(1)}s</span>
                            {((lastRaceStats.endTime - lastRaceStats.startTime) / 1000) <= ghostBest.time && (
                              <span className="text-emerald-400 ml-2">— NEW RECORD!</span>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                    
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
                              {gear && (
                                <div className="relative flex items-center justify-center w-full h-full p-1">
                                  <GearIcon 
                                    teeth={Math.min(gear.teeth, 32)} 
                                    color={connectedGears.includes(gear.id) ? '#fff' : 'rgba(255,255,255,0.2)'} 
                                    className="w-full h-full"
                                  />
                                  <span className="absolute text-[9px] font-black text-white bg-black/80 px-1 rounded-sm">{gear.teeth}T</span>
                                </div>
                              )}
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
                                  className={`absolute z-[500] ${y < 2 ? 'top-full mt-2' : 'bottom-full mb-2'} left-1/2 -translate-x-1/2 bg-neutral-900 border border-white/20 rounded-2xl p-4 shadow-2xl min-w-[200px]`}
                                >
                                  <div className="flex justify-between items-center mb-3">
                                    <p className="text-[10px] font-black text-white/40 uppercase tracking-widest italic">Tooth Count</p>
                                    <X className="w-3 h-3 cursor-pointer" onClick={() => setSelectedGearId(null)} />
                                  </div>
                                  <div className="grid grid-cols-4 gap-1.5">
                                    {GEAR_TYPES.map(t => (
                                      <button
                                        key={t}
                                        onClick={(e) => { e.stopPropagation(); setTeeth(gear.id, t); }}
                                        className={`px-1 py-2 rounded-lg text-[10px] font-black transition-all ${
                                          gear.teeth === t ? 'bg-rose-600 text-white scale-110' : 'bg-white/5 hover:bg-white/10 text-white/60'
                                        }`}
                                      >
                                        {t}T
                                      </button>
                                    ))}
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
                        <p className="text-[10px] text-white/40 uppercase font-black italic">Gear Presets</p>
                        <button
                          onClick={() => { const n = prompt('Preset name:'); if (n) setPresets([...presets, { name: n.slice(0, 12), gears: [...gears] }]); }}
                          className="px-3 py-1 bg-white/10 border border-white/10 rounded-lg text-[10px] font-black uppercase hover:bg-white/15"
                        >
                          + Save Current
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {presets.map((p, idx) => (
                          <div key={idx} className="flex items-center gap-1 bg-rose-600/20 border border-rose-500/30 rounded-lg overflow-hidden">
                            <button onClick={() => { setGears(p.gears); audioBus.playSfx('click'); }} className="px-3 py-1 text-rose-400 text-[10px] font-black uppercase hover:bg-rose-600/30">
                              {p.name}
                            </button>
                            {idx >= 3 && (
                              <button onClick={() => setPresets(presets.filter((_, i) => i !== idx))} className="px-1.5 py-1 text-rose-400/60 hover:text-rose-300 hover:bg-rose-600/30 text-[10px]" title="Delete">×</button>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Vehicle Customization */}
                  <div className="mt-8 bg-gradient-to-br from-fuchsia-500/5 to-rose-500/5 border border-fuchsia-500/20 rounded-2xl p-5">
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <h3 className="text-sm font-black italic uppercase tracking-tighter text-fuchsia-400">Vehicle Customization</h3>
                        <p className="text-[10px] text-white/40 uppercase tracking-widest mt-0.5">Color · Tires · Repair</p>
                      </div>
                    </div>

                    <div className="space-y-4">
                      {/* Car color */}
                      <div>
                        <p className="text-[10px] text-white/40 uppercase font-black mb-2 italic">Paint Color</p>
                        <div className="flex flex-wrap gap-2">
                          {CAR_COLORS.map(c => (
                            <button
                              key={c.id}
                              onClick={() => { setCarColorId(c.id); audioBus.playSfx('click'); }}
                              className={`w-10 h-10 rounded-xl border-2 transition-all ${carColorId === c.id ? 'border-white scale-110 shadow-lg' : 'border-white/20 hover:border-white/50'}`}
                              style={{ background: `linear-gradient(135deg, ${c.body}, ${c.roof})` }}
                              title={c.name}
                            />
                          ))}
                        </div>
                        <p className="text-[9px] text-white/40 mt-1 font-mono">{CAR_COLORS.find(c => c.id === carColorId)?.name}</p>
                      </div>

                      {/* Tire compound */}
                      <div>
                        <p className="text-[10px] text-white/40 uppercase font-black mb-2 italic">Tire Compound</p>
                        <div className="grid grid-cols-3 gap-2">
                          {(Object.keys(TIRE_COMPOUNDS) as TireCompound[]).map(k => (
                            <button
                              key={k}
                              onClick={() => { setTireCompound(k); audioBus.playSfx('click'); }}
                              className={`px-2 py-2 rounded-xl text-[10px] font-black uppercase transition-all border text-left ${tireCompound === k ? 'bg-amber-500 text-black border-amber-300' : 'bg-white/5 text-white/60 border-white/10 hover:bg-white/10'}`}
                            >
                              <div className="flex items-center gap-1.5"><span className="text-base">{TIRE_COMPOUNDS[k].emoji}</span><span>{TIRE_COMPOUNDS[k].name}</span></div>
                              <div className={`text-[8px] font-bold normal-case mt-0.5 ${tireCompound === k ? 'text-black/70' : 'text-white/40'}`}>{TIRE_COMPOUNDS[k].desc}</div>
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Repair */}
                      <div className="pt-3 border-t border-white/10">
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-[10px] text-white/40 uppercase font-black italic">Vehicle Damage</p>
                          {(() => {
                            const totalDmg = damage.engine + damage.brakes + damage.tires;
                            const cost = Math.ceil(totalDmg * 250);
                            return (
                              <button
                                onClick={() => {
                                  if (totalDmg < 0.01) return;
                                  if (credits < cost) { speak('Not enough credits'); return; }
                                  setCredits(prev => Math.max(0, prev - cost));
                                  setDamage({ engine: 0, brakes: 0, tires: 0 });
                                  audioBus.playSfx('coin');
                                  speak('Vehicle fully repaired');
                                }}
                                disabled={totalDmg < 0.01 || credits < cost}
                                className="px-3 py-1.5 bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded-lg text-[10px] font-black uppercase hover:bg-emerald-500/30 disabled:opacity-30 disabled:cursor-not-allowed"
                              >
                                {totalDmg < 0.01 ? 'No Damage' : `Repair · ${cost} cr`}
                              </button>
                            );
                          })()}
                        </div>
                        <div className="grid grid-cols-3 gap-2 text-[10px] font-mono">
                          {[
                            { key: 'engine', label: 'Engine', val: damage.engine, color: 'text-rose-400' },
                            { key: 'brakes', label: 'Brakes', val: damage.brakes, color: 'text-amber-400' },
                            { key: 'tires',  label: 'Tires',  val: damage.tires,  color: 'text-yellow-400' },
                          ].map(d => (
                            <div key={d.key} className="bg-black/30 rounded-lg p-2">
                              <div className="text-white/40 uppercase font-black text-[8px] mb-1">{d.label}</div>
                              <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                                <div className={`h-full ${d.val > 0.5 ? 'bg-rose-500' : d.val > 0.2 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${Math.min(100, d.val * 100)}%` }} />
                              </div>
                              <div className={`text-right text-[9px] mt-1 ${d.color}`}>{(d.val * 100).toFixed(0)}%</div>
                            </div>
                          ))}
                        </div>
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
