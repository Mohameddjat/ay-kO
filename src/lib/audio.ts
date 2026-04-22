import menuUrl from '../assets/audio/music/menu.mp3';
import raceUrl from '../assets/audio/music/race.mp3';
import race2Url from '../assets/audio/music/race2.mp3';
import victoryMusicUrl from '../assets/audio/music/victory.mp3';

import clickUrl from '../assets/audio/sfx/click.mp3';
import coinUrl from '../assets/audio/sfx/coin.mp3';
import boostUrl from '../assets/audio/sfx/boost.mp3';
import crashUrl from '../assets/audio/sfx/crash.mp3';
import levelupUrl from '../assets/audio/sfx/levelup.mp3';
import victoryUrl from '../assets/audio/sfx/victory.mp3';
import defeatUrl from '../assets/audio/sfx/defeat.mp3';
import countdownUrl from '../assets/audio/sfx/countdown.mp3';

export type SfxName = 'click' | 'coin' | 'boost' | 'crash' | 'levelup' | 'victory' | 'defeat' | 'countdown';
export type TrackName = 'menu' | 'race' | 'race2' | 'victoryMusic';

const SFX_MAP: Record<SfxName, string> = {
  click: clickUrl,
  coin: coinUrl,
  boost: boostUrl,
  crash: crashUrl,
  levelup: levelupUrl,
  victory: victoryUrl,
  defeat: defeatUrl,
  countdown: countdownUrl,
};

const MUSIC_MAP: Record<TrackName, string> = {
  menu: menuUrl,
  race: raceUrl,
  race2: race2Url,
  victoryMusic: victoryMusicUrl,
};

const SFX_VOLUME: Partial<Record<SfxName, number>> = {
  click: 0.35,
  coin: 0.5,
  boost: 0.55,
  crash: 0.7,
  levelup: 0.6,
  victory: 0.7,
  defeat: 0.6,
  countdown: 0.55,
};

class AudioBus {
  private sfxBuffers: Partial<Record<SfxName, AudioBuffer>> = {};
  private ctx: AudioContext | null = null;
  private sfxGain: GainNode | null = null;
  private musicEl: HTMLAudioElement | null = null;
  private currentTrack: TrackName | null = null;
  private musicVolume = 0.35;
  private sfxMuted = false;
  private musicMuted = false;
  private fadeRaf: number | null = null;

  init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = 0.8;
    this.sfxGain.connect(this.ctx.destination);
    // Preload SFX in background
    (Object.keys(SFX_MAP) as SfxName[]).forEach(name => this.loadSfx(name));
  }

  private async loadSfx(name: SfxName) {
    if (!this.ctx || this.sfxBuffers[name]) return;
    try {
      const res = await fetch(SFX_MAP[name]);
      const arr = await res.arrayBuffer();
      const buf = await this.ctx.decodeAudioData(arr);
      this.sfxBuffers[name] = buf;
    } catch {}
  }

  playSfx(name: SfxName) {
    if (this.sfxMuted || !this.ctx || !this.sfxGain) return;
    const buf = this.sfxBuffers[name];
    if (!buf) {
      // Fallback: HTMLAudio one-shot if buffer not yet decoded
      const a = new Audio(SFX_MAP[name]);
      a.volume = SFX_VOLUME[name] ?? 0.5;
      a.play().catch(() => {});
      return;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = SFX_VOLUME[name] ?? 0.5;
    src.connect(g);
    g.connect(this.sfxGain);
    src.start(0);
  }

  playMusic(track: TrackName, opts: { loop?: boolean; fadeMs?: number } = {}) {
    const { loop = true, fadeMs = 600 } = opts;
    if (this.currentTrack === track && this.musicEl && !this.musicEl.paused) return;
    this.currentTrack = track;
    const next = new Audio(MUSIC_MAP[track]);
    next.loop = loop;
    next.volume = 0;
    next.play().catch(() => {});
    const prev = this.musicEl;
    this.musicEl = next;
    const target = this.musicMuted ? 0 : this.musicVolume;
    this.fadeTo(next, target, fadeMs);
    if (prev) {
      this.fadeTo(prev, 0, fadeMs, () => {
        try { prev.pause(); } catch {}
      });
    }
  }

  stopMusic(fadeMs = 400) {
    if (!this.musicEl) return;
    const el = this.musicEl;
    this.musicEl = null;
    this.currentTrack = null;
    this.fadeTo(el, 0, fadeMs, () => {
      try { el.pause(); } catch {}
    });
  }

  private fadeTo(el: HTMLAudioElement, target: number, ms: number, done?: () => void) {
    const start = el.volume;
    const startTime = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - startTime) / ms);
      el.volume = start + (target - start) * t;
      if (t < 1) requestAnimationFrame(tick);
      else if (done) done();
    };
    requestAnimationFrame(tick);
  }

  setMusicMuted(m: boolean) {
    this.musicMuted = m;
    if (this.musicEl) this.fadeTo(this.musicEl, m ? 0 : this.musicVolume, 200);
  }
  setSfxMuted(m: boolean) {
    this.sfxMuted = m;
  }
  setMusicVolume(v: number) {
    this.musicVolume = Math.max(0, Math.min(1, v));
    if (this.musicEl && !this.musicMuted) this.musicEl.volume = this.musicVolume;
  }
  isMusicMuted() { return this.musicMuted; }
  isSfxMuted() { return this.sfxMuted; }
}

export const audioBus = new AudioBus();
