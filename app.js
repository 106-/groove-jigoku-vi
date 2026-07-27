import { REPLAY_DEFINITIONS, parseReplay } from "./replay.js";
import {
  SET_NAMES,
  REPLAY_INPUT_LOOKAHEAD_SECONDS,
  REPLAY_FILL_TIMER_LEAD_SECONDS,
  CUE_QUANTIZE_TICKS,
  CUE_IMMEDIATE_WINDOW_TICKS,
  INTERRUPT_INTERVALS,
  BPM_TECH_STEPS,
  BPM_TECH_NORMAL,
  BPM_TECH_MIN,
  BPM_TECH_MAX,
  FILL_PATTERNS,
  ENGINE_TECH_NAMES,
  REPLAY_TECHS,
} from "./constants.js";
import { convertReplayToTimeline } from "./timeline-convert.js";
import { timelineSetToSlots, validateTimeline } from "./timeline.js";
import { createTimelinePlayer } from "./timeline-player.js";
import { createTimelineRecorder } from "./timeline-recorder.js";
import { createTimelineEditor } from "./timeline-editor.js";

const SLOT_SHORTCUTS = [
  { code: "KeyQ", label: "Q" },
  { code: "KeyW", label: "W" },
  { code: "KeyE", label: "E" },
  { code: "KeyR", label: "R" },
];
const STORAGE_KEY = "groove-desk-v-sets-v1";
const LOOKAHEAD_SECONDS = 0.14;
const SCHEDULER_INTERVAL_MS = 25;
const IMMEDIATE_AUDIO_MARGIN_SECONDS = 0.002;
const INTERRUPT_RELEASE_SECONDS = IMMEDIATE_AUDIO_MARGIN_SECONDS;
// The SPU keys voices off through their ADSR release instead of muting them.
// Forced cuts (chunk change, cue, fill reset, stop) use each voice's own
// VAB release; this constant is only the fallback for voices without one.
const CANCEL_RELEASE_SECONDS = 0.008;
const DELAY_BEAT_RATIOS = [0.25, 0.5, 2 / 3, 1];
const DELAY_WET_LEVELS = [0.46, 0.52, 0.58, 0.64];
const DELAY_FEEDBACK_LEVELS = [0.24, 0.32, 0.4, 0.48];
const REVERB_DEPTHS = [16, 32, 64, 127];
const REVERB_PREDELAYS = [0.025, 0.04, 0.065, 0.09];
// SDED.OX drives a signed 256-sample triangle pitch LFO at 60 Hz.  Its phase
// advances by floor(400 * 1024 / 3600) = 113 of 1024 units per frame.
const MOD_DEPTHS = [48, 72, 96, 127];
const MOD_LFO_FREQUENCY = (60 * 113) / 1024;
const MOD_DEPTH_CENTS = MOD_DEPTHS.map(
  (depth) => (depth * 127 * 200) / (128 * 128),
);
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

class GrooveEngine {
  constructor(data, onPosition) {
    this.data = data;
    this.onPosition = onPosition;
    this.context = null;
    this.initializationPromise = null;
    this.buffers = new Map();
    this.sampleInfo = data.samples;
    // Per-tone SPU release settings extracted from the VAB (ms is the
    // full-scale ramp time for linear mode, the time constant for exp mode).
    this.releases = data.releases ?? [];
    this.items = new Map(data.items.map((item) => [item.id, item]));
    this.ticksPerQuarter = data.meta.ticksPerQuarter;
    this.bpm = data.meta.bpm;
    this.masterLevel = 0.78;
    this.playing = false;
    this.originTime = 0;
    this.originTick = 0;
    this.pausedTick = 0;
    this.scheduledUntilTick = 0;
    this.activeSources = new Set();
    this.previewSources = new Set();
    this.arpSources = new Set();
    this.flshSources = new Set();
    this.stbSource = null;
    this.mrgSource = null;
    this.meterEpoch = 0;
    this.schedulerTimer = null;
    this.animationFrame = null;
    this.cueRequestTimer = null;
    this.cueRequestTime = null;
    // Invoked as onSeek(previousTick, newTick, cutTime) whenever the musical
    // origin jumps (cue execution, fill retrigger).
    this.onSeek = null;
    this.getTracks = () => [];
    this.tech = { delay: false, mod: false, bpm: false, reverb: false, interrupt: false, fill: false, stb: false, arp: false, flsh: false, mrg: false };
    this.techVariant = { delay: 1, mod: 0, bpm: 0, reverb: 2, interrupt: 2, fill: 3, stb: 0, arp: 0, flsh: 0, mrg: 0 };
    this.modOscillator = null;
    this.modDepthGain = null;
    this.bpmTechScale = BPM_TECH_NORMAL;
    this.bpmTechLastTime = null;
    this.bpmTechReturning = false;
    this.bpmTechReleaseStep = 6;
    this.fillSetting = 0;
    this.stbSetting = 0;
    this.arpSetting = 0;
    this.flshSetting = 0;
    this.mrgSetting = 0;
    this.arpScheduledUntilTick = 0;
    this.flshScheduledUntilTick = 0;
    this.arpStartTick = null;
    this.arpReleaseState = null;
    this.interruptStartTick = null;
    this.interruptScheduledUntilTick = 0;
    this.interruptGateOpen = true;
    this.fillState = {
      index: 0,
      targetTick: null,
      targetTime: null,
      endTime: null,
      aligning: true,
      mode: "immediate",
      timer: null,
    };
  }

  async initialize(statusCallback) {
    if (this.initializationPromise) return this.initializationPromise;
    this.initializationPromise = (async () => {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.context = new AudioContextClass({ latencyHint: "interactive" });
      this.buildGraph();
      statusCallback(`単音波形を読込中 0/${Object.keys(this.sampleInfo).length}`);

      let loaded = 0;
      const entries = Object.entries(this.sampleInfo);
      await Promise.all(entries.map(async ([id, info]) => {
        const response = await fetch(info.path);
        if (!response.ok) throw new Error(`${info.path}: HTTP ${response.status}`);
        const buffer = await this.context.decodeAudioData(await response.arrayBuffer());
        this.buffers.set(Number(id), buffer);
        loaded += 1;
        if (loaded % 8 === 0 || loaded === entries.length) {
          statusCallback(`単音波形を読込中 ${loaded}/${entries.length}`);
        }
      }));
      statusCallback("準備完了");
    })();
    try {
      return await this.initializationPromise;
    } catch (error) {
      this.context?.close();
      this.context = null;
      this.buffers.clear();
      this.initializationPromise = null;
      throw error;
    }
  }

  buildGraph() {
    const ctx = this.context;
    this.mixGain = ctx.createGain();
    this.modGain = ctx.createGain();
    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = this.masterLevel;
    this.mixGain.connect(this.modGain);
    this.modGain.connect(this.masterGain);
    this.masterGain.connect(ctx.destination);

    this.delaySend = ctx.createGain();
    this.delayNode = ctx.createDelay(2);
    this.delayTone = ctx.createBiquadFilter();
    this.delayFeedback = ctx.createGain();
    this.delayWet = ctx.createGain();
    this.delaySend.gain.value = this.tech.delay ? 1 : 0;
    this.delayTone.type = "lowpass";
    this.delayTone.frequency.value = 4200;
    this.modGain.connect(this.delaySend).connect(this.delayNode);
    this.delayNode.connect(this.delayTone).connect(this.delayFeedback).connect(this.delayNode);
    this.delayNode.connect(this.delayWet).connect(this.masterGain);

    this.reverbSend = ctx.createGain();
    this.reverbPreDelay = ctx.createDelay(0.5);
    this.convolver = ctx.createConvolver();
    this.convolver.buffer = this.makeTunnelImpulse(5.2);
    this.reverbHighpass = ctx.createBiquadFilter();
    this.reverbHighpass.type = "highpass";
    this.reverbHighpass.frequency.value = 105;
    this.reverbTone = ctx.createBiquadFilter();
    this.reverbTone.type = "lowpass";
    this.reverbTone.frequency.value = 3300;
    this.reverbWet = ctx.createGain();
    this.reverbSend.gain.value = this.tech.reverb ? 1 : 0;
    this.modGain.connect(this.reverbSend).connect(this.reverbPreDelay).connect(this.convolver);
    this.convolver.connect(this.reverbHighpass).connect(this.reverbTone).connect(this.reverbWet).connect(this.masterGain);

    this.updateTempoEffects();
  }

  makeImpulse(seconds, decay) {
    const length = Math.floor(this.context.sampleRate * seconds);
    const impulse = this.context.createBuffer(2, length, this.context.sampleRate);
    for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
      const out = impulse.getChannelData(channel);
      for (let i = 0; i < length; i += 1) {
        out[i] = (Math.random() * 2 - 1) * ((1 - i / length) ** decay);
      }
    }
    return impulse;
  }

  makeTunnelImpulse(seconds) {
    const sampleRate = this.context.sampleRate;
    const length = Math.floor(sampleRate * seconds);
    const impulse = this.context.createBuffer(2, length, sampleRate);
    const reflections = [
      [0.043, 0.72], [0.089, 0.56], [0.151, 0.43],
      [0.238, 0.34], [0.361, 0.27], [0.514, 0.2],
    ];
    for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
      const out = impulse.getChannelData(channel);
      let seed = channel ? 0x51f15e : 0x31a7d3;
      for (let i = 0; i < length; i += 1) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const noise = seed / 0x80000000 - 1;
        const time = i / sampleRate;
        const envelope = Math.min(1, time / 0.018) * Math.exp(-4.25 * time / seconds);
        const modes = (
          Math.sin(2 * Math.PI * (79 + channel * 7) * time)
          + 0.62 * Math.sin(2 * Math.PI * (137 - channel * 5) * time)
          + 0.38 * Math.sin(2 * Math.PI * 211 * time)
        );
        out[i] = (noise * 0.62 + modes * 0.12) * envelope;
      }
      for (const [time, level] of reflections) {
        const offset = Math.floor((time + channel * 0.004) * sampleRate);
        for (let tap = 0; tap < 96 && offset + tap < length; tap += 1) {
          out[offset + tap] += level * Math.exp(-tap / 18) * (tap % 2 ? -0.35 : 1);
        }
      }
    }
    return impulse;
  }

  ticksPerSecond() {
    return (this.effectiveBpm() / 60) * this.ticksPerQuarter;
  }

  effectiveBpm() {
    return this.bpm * (this.bpmTechScale / BPM_TECH_NORMAL);
  }

  advanceBpmTech(time) {
    if (this.bpmTechLastTime == null) {
      this.bpmTechLastTime = time;
      return;
    }
    const elapsedFrames = Math.min(6, Math.max(0, time - this.bpmTechLastTime) * 60);
    this.bpmTechLastTime = time;
    if (!elapsedFrames || (!this.tech.bpm && !this.bpmTechReturning)) return;

    const oldScale = this.bpmTechScale;
    let nextScale = oldScale;
    if (this.tech.bpm) {
      nextScale += BPM_TECH_STEPS[this.techVariant.bpm] * elapsedFrames;
      nextScale = Math.max(BPM_TECH_MIN, Math.min(BPM_TECH_MAX, nextScale));
    } else {
      const amount = this.bpmTechReleaseStep * elapsedFrames;
      if (nextScale < BPM_TECH_NORMAL) nextScale = Math.min(BPM_TECH_NORMAL, nextScale + amount);
      if (nextScale > BPM_TECH_NORMAL) nextScale = Math.max(BPM_TECH_NORMAL, nextScale - amount);
      if (Math.abs(nextScale - BPM_TECH_NORMAL) < 1e-6) {
        nextScale = BPM_TECH_NORMAL;
        this.bpmTechReturning = false;
      }
    }
    if (Math.abs(nextScale - oldScale) < 1e-6) return;

    // Preserve the current musical position while changing the clock rate.
    if (this.playing && time >= this.originTime) {
      this.originTick += (time - this.originTime)
        * (this.bpm / 60)
        * this.ticksPerQuarter
        * (oldScale / BPM_TECH_NORMAL);
      this.originTime = time;
    }
    this.bpmTechScale = nextScale;
    this.applyBpmTechPitch(time);
    if (this.context) this.updateTempoEffects();
  }

  applyBpmTechPitch(time) {
    if (!this.context) return;
    const scale = this.bpmTechScale / BPM_TECH_NORMAL;
    const sourceSets = [this.activeSources, this.arpSources, this.flshSources];
    for (const sourceSet of sourceSets) {
      for (const record of sourceSet) {
        if (record.basePlaybackRate == null) continue;
        const rate = record.source.playbackRate;
        rate.cancelScheduledValues(time);
        rate.setTargetAtTime(record.basePlaybackRate * scale, time, 0.018);
      }
    }
    if (this.mrgSource?.basePlaybackRate != null) {
      const rate = this.mrgSource.source.playbackRate;
      rate.cancelScheduledValues(time);
      rate.setTargetAtTime(this.mrgSource.basePlaybackRate * scale, time, 0.018);
    }
    if (this.stbSource?.basePlaybackRate != null) {
      const rate = this.stbSource.source.playbackRate;
      rate.cancelScheduledValues(time);
      rate.setTargetAtTime(this.stbSource.basePlaybackRate * scale, time, 0.018);
    }
  }

  connectModToSource(record) {
    if (!this.modDepthGain || !record?.source?.detune) return;
    if (record.modDepthGain === this.modDepthGain) return;
    this.modDepthGain.connect(record.source.detune);
    record.modDepthGain = this.modDepthGain;
  }

  startMod(time) {
    if (!this.context) return;
    const startTime = Math.max(Number(time), this.context.currentTime);
    if (!this.modOscillator) {
      const oscillator = this.context.createOscillator();
      const depthGain = this.context.createGain();
      oscillator.type = "triangle";
      oscillator.frequency.setValueAtTime(MOD_LFO_FREQUENCY, startTime);
      depthGain.gain.setValueAtTime(
        MOD_DEPTH_CENTS[this.techVariant.mod],
        startTime,
      );
      oscillator.connect(depthGain);
      oscillator.start(startTime);
      this.modOscillator = oscillator;
      this.modDepthGain = depthGain;
      for (const record of this.activeSources) this.connectModToSource(record);
      return;
    }
    this.setModDepth(startTime);
  }

  setModDepth(time) {
    if (!this.modDepthGain) return;
    const depth = MOD_DEPTH_CENTS[this.techVariant.mod];
    this.modDepthGain.gain.cancelScheduledValues(time);
    this.modDepthGain.gain.setValueAtTime(depth, time);
  }

  stopMod(time) {
    if (!this.modOscillator || !this.modDepthGain) return;
    const oscillator = this.modOscillator;
    const depthGain = this.modDepthGain;
    this.modOscillator = null;
    this.modDepthGain = null;
    depthGain.gain.cancelScheduledValues(time);
    depthGain.gain.setValueAtTime(0, time);
    try { oscillator.stop(time); } catch { /* already stopped */ }
    oscillator.addEventListener("ended", () => {
      oscillator.disconnect();
      depthGain.disconnect();
    }, { once: true });
  }

  tickAtTime(time) {
    return this.originTick + (time - this.originTime) * this.ticksPerSecond();
  }

  timeAtTick(tick) {
    return this.originTime + (tick - this.originTick) / this.ticksPerSecond();
  }

  async start() {
    await this.context.resume();
    if (this.playing) return;
    this.cancelPreviewSources(this.context.currentTime + 0.01);
    this.playing = true;
    this.bpmTechLastTime = this.context.currentTime;
    this.originTick = this.pausedTick;
    this.originTime = this.context.currentTime + 0.05;
    this.scheduledUntilTick = this.originTick;
    this.arpScheduledUntilTick = this.originTick;
    this.flshScheduledUntilTick = this.originTick;
    if (this.tech.arp) this.armArp(this.originTick);
    this.resetInterruptState(this.originTick, false);
    if (this.tech.fill) this.prepareFillTrigger(this.originTick);
    if (this.tech.mod && !this.modOscillator) this.startMod(this.originTime);
    this.schedulerTimer = window.setInterval(() => this.schedule(), SCHEDULER_INTERVAL_MS);
    this.schedule();
    if (this.tech.stb) this.startStb();
    if (this.tech.mrg) this.startMrg();
    this.drawPosition();
  }

  stop() {
    if (!this.playing) return;
    this.pausedTick = Math.max(0, this.tickAtTime(this.context.currentTime));
    this.playing = false;
    window.clearInterval(this.schedulerTimer);
    this.clearFillTimer();
    if (this.cueRequestTimer !== null) window.clearTimeout(this.cueRequestTimer);
    this.cueRequestTimer = null;
    this.cueRequestTime = null;
    cancelAnimationFrame(this.animationFrame);
    this.cancelSources(this.context.currentTime + 0.01);
    this.cancelPreviewSources(this.context.currentTime + 0.01);
    this.cancelSourceSet(this.arpSources, this.context.currentTime + 0.01);
    this.cancelSourceSet(this.flshSources, this.context.currentTime + 0.01);
    this.arpReleaseState = null;
    this.stopStb(this.context.currentTime);
    this.stopMrg(this.context.currentTime);
    this.onPosition(this.pausedTick);
  }

  cue(requestTime = null) {
    this.pausedTick = 0;
    if (!this.context) {
      this.onPosition(0);
      return;
    }
    if (!this.playing) {
      this.onPosition(0);
      return;
    }

    // SDED.OX does not seek on the button callback itself. It keeps one
    // pending request and executes it in the first seven ticks of each
    // 24-tick period. Preserve that behavior while using the exact replay
    // frame time when one is available.
    if (this.cueRequestTime !== null) return;
    const now = this.context.currentTime;
    const inputTime = Math.max(this.originTime, Number(requestTime ?? now));
    const inputTick = Math.max(0, this.tickAtTime(inputTime));
    // The driver honors a pending request only on integer ticks 0..6 of a
    // 24-tick period, so quantize to the next driver tick before the window
    // test: a request arriving between ticks 6 and 7 waits a full period.
    const requestTick = Math.ceil(inputTick - 1e-9);
    const phase = requestTick % CUE_QUANTIZE_TICKS;
    const targetTick = phase < CUE_IMMEDIATE_WINDOW_TICKS
      ? requestTick
      : requestTick + CUE_QUANTIZE_TICKS - phase;
    this.cueRequestTime = this.timeAtTick(targetTick);
    // Wake before the quantized boundary so WebAudio can place tick 0 on the
    // exact audio timestamp instead of reacting after a JavaScript timer.
    const wait = Math.max(
      0,
      (this.cueRequestTime - now - REPLAY_INPUT_LOOKAHEAD_SECONDS) * 1000,
    );
    this.cueRequestTimer = window.setTimeout(() => this.applyCueRequest(), wait);
  }

  applyCueRequest() {
    if (this.cueRequestTime === null || !this.context || !this.playing) return;
    const requestedTime = this.cueRequestTime;
    this.cueRequestTime = null;
    this.cueRequestTimer = null;
    const cutTime = Math.max(
      requestedTime,
      this.context.currentTime + IMMEDIATE_AUDIO_MARGIN_SECONDS,
    );
    const previousTick = this.tickAtTime(cutTime);
    this.cancelSources(cutTime);
    this.cancelPreviewSources(cutTime);
    this.cancelSourceSet(this.arpSources, cutTime);
    this.cancelSourceSet(this.flshSources, cutTime);
    this.originTick = 0;
    this.originTime = cutTime;
    this.onSeek?.(previousTick, 0, cutTime);
    this.scheduledUntilTick = 0;
    this.arpScheduledUntilTick = 0;
    this.flshScheduledUntilTick = 0;
    if (this.tech.arp) this.armArp(0);
    else {
      this.arpReleaseState = null;
      this.arpStartTick = null;
    }
    this.resetInterruptState(0, true);
    if (this.tech.fill) this.prepareFillTrigger(0);
    this.schedule();
    this.onPosition(0);
  }

  // Timeline playback hands over exec-exact cue times; no re-quantization.
  cueExactAt(time) {
    if (!this.context || !this.playing) return;
    if (this.cueRequestTimer !== null) window.clearTimeout(this.cueRequestTimer);
    this.pausedTick = 0;
    this.cueRequestTime = Number(time);
    const wait = Math.max(
      0,
      (this.cueRequestTime - this.context.currentTime - REPLAY_INPUT_LOOKAHEAD_SECONDS) * 1000,
    );
    this.cueRequestTimer = window.setTimeout(() => this.applyCueRequest(), wait);
  }

  preserveClockReschedule(delaySeconds = 0.015) {
    const transitionTime = this.context
      ? this.context.currentTime + Math.max(
        IMMEDIATE_AUDIO_MARGIN_SECONDS,
        Number(delaySeconds),
      )
      : null;
    this.preserveClockRescheduleAt(transitionTime);
  }

  preserveClockRescheduleAt(transitionTime) {
    if (!this.context || !this.playing) {
      if (this.context) this.cancelPreviewSources(this.context.currentTime + 0.01);
      this.onPosition(this.pausedTick);
      return;
    }
    const cutTime = Math.max(
      Number(transitionTime),
      this.context.currentTime + IMMEDIATE_AUDIO_MARGIN_SECONDS,
    );
    const tick = Math.max(0, this.tickAtTime(cutTime));
    this.cancelSources(cutTime);
    this.cancelPreviewSources(cutTime);
    this.scheduledUntilTick = tick;
    this.interruptScheduledUntilTick = tick;
    this.schedule();
    this.onPosition(tick);
  }

  setBpm(nextBpm) {
    nextBpm = Number(nextBpm);
    if (this.context) this.advanceBpmTech(this.context.currentTime);
    if (!this.context || !this.playing) {
      this.bpm = nextBpm;
      if (this.context) {
        this.cancelPreviewSources(this.context.currentTime + 0.01);
        this.updateTempoEffects();
      }
      return;
    }
    const now = this.context.currentTime;
    const tick = this.tickAtTime(now);
    this.cancelSources(now + 0.01);
    this.cancelPreviewSources(now + 0.01);
    this.cancelSourceSet(this.arpSources, now + 0.01);
    this.cancelSourceSet(this.flshSources, now + 0.01);
    this.originTick = tick;
    this.originTime = now;
    this.bpm = nextBpm;
    this.scheduledUntilTick = tick;
    this.arpScheduledUntilTick = tick;
    this.flshScheduledUntilTick = tick;
    if (!this.tech.arp) {
      this.arpReleaseState = null;
      this.arpStartTick = null;
    }
    this.interruptScheduledUntilTick = tick;
    this.updateTempoEffects();
    this.schedule();
  }

  setMaster(value) {
    this.masterLevel = value;
    if (this.masterGain) {
      this.masterGain.gain.setTargetAtTime(value, this.context.currentTime, 0.02);
    }
  }

  setTech(name, enabled, effectiveTime = null, options = null) {
    const wasEnabled = this.tech[name];
    if (name === "bpm" && this.context) this.advanceBpmTech(this.context.currentTime);
    const now = this.context
      ? Number(effectiveTime ?? this.context.currentTime)
      : 0;
    this.tech[name] = enabled;
    if (name === "fill") {
      if (enabled) {
        if (options?.replay && this.context && this.playing) {
          this.prepareReplayFillTrigger(now, options.endTime);
        } else {
          const tick = this.context && this.playing
            ? Math.max(0, this.tickAtTime(now))
            : this.pausedTick;
          this.prepareFillTrigger(tick);
          if (this.context && this.playing && this.maybeApplyFillRetrigger(now)) {
            this.schedule();
          }
        }
      } else {
        this.clearFillTimer();
        this.fillState.targetTick = null;
        this.fillState.targetTime = null;
        this.fillState.endTime = null;
      }
    }
    if (name === "interrupt") {
      const tick = this.context && this.playing ? Math.max(0, this.tickAtTime(now)) : this.pausedTick;
      if (enabled && !wasEnabled) {
        this.interruptGateOpen = true;
        this.armInterrupt(tick);
        if (this.context && this.playing) this.rescheduleForInterruptChange(now);
      } else if (!enabled && wasEnabled) {
        this.interruptStartTick = null;
        this.interruptGateOpen = true;
        this.interruptScheduledUntilTick = tick;
        if (this.context && this.playing) this.rescheduleForInterruptChange(now);
      }
    }
    if (name === "arp") {
      const tick = this.context && this.playing ? Math.max(0, this.tickAtTime(now)) : this.pausedTick;
      this.arpScheduledUntilTick = tick;
      if (enabled && !wasEnabled) {
        this.armArp(tick);
        if (this.context && this.playing) this.rescheduleArpFuture(now, false);
      } else if (!enabled && wasEnabled) {
        if (this.context && this.playing) {
          this.beginArpRelease(now, tick);
        } else {
          this.arpReleaseState = null;
          this.arpStartTick = null;
        }
      }
    }
    if (name === "flsh") {
      const tick = this.context && this.playing ? Math.max(0, this.tickAtTime(now)) : this.pausedTick;
      this.flshScheduledUntilTick = tick;
      if (this.context && this.playing) {
        this.rescheduleFlshFuture(now);
      }
    }
    if (name === "stb") {
      if (enabled && !wasEnabled) this.startStb(now);
      if (!enabled && wasEnabled) this.stopStb(now);
    }
    if (name === "mrg") {
      if (enabled && !wasEnabled) this.startMrg(now);
      if (!enabled && wasEnabled) this.stopMrg(now);
    }
    if (name === "mod") {
      if (enabled && !wasEnabled) this.startMod(now);
      if (!enabled && wasEnabled) this.stopMod(now);
    }
    if (name === "bpm") {
      if (enabled) {
        this.bpmTechReturning = false;
        this.bpmTechReleaseStep = Math.abs(BPM_TECH_STEPS[this.techVariant.bpm]) * 2;
      } else if (wasEnabled) {
        this.bpmTechReturning = this.bpmTechScale !== BPM_TECH_NORMAL;
      }
      this.bpmTechLastTime = this.context ? now : null;
    }
    if (!this.context) return;
    if (name === "delay") this.delaySend.gain.setTargetAtTime(enabled ? 1 : 0, now, enabled ? 0.008 : 0.025);
    if (name === "reverb") this.reverbSend.gain.setTargetAtTime(enabled ? 1 : 0, now, enabled ? 0.008 : 0.025);
  }

  setTechVariant(name, variant, effectiveTime = null) {
    if (name === "bpm" && this.context) this.advanceBpmTech(this.context.currentTime);
    const interruptNow = this.context
      ? Number(effectiveTime ?? this.context.currentTime)
      : 0;
    const interruptTick = this.context && this.playing
      ? Math.max(0, this.tickAtTime(interruptNow))
      : this.pausedTick;
    const interruptWasOpen = name === "interrupt" && this.tech.interrupt
      ? this.isInterruptOpen(interruptTick)
      : true;
    this.techVariant[name] = Math.max(0, Math.min(3, Number(variant)));
    if (name === "fill" && this.tech.fill) {
      const tick = this.context && this.playing
        ? Math.max(0, this.tickAtTime(interruptNow))
        : this.pausedTick;
      this.prepareFillTrigger(tick);
    }
    if (name === "interrupt" && this.tech.interrupt) {
      // The original only replaces the interval here. Its six track mute
      // flags remain as they are until the first boundary of the new interval.
      this.interruptGateOpen = interruptWasOpen;
      this.armInterrupt(interruptTick);
      if (this.context && this.playing) this.rescheduleForInterruptChange(interruptNow);
    }
    if ((name === "delay" || name === "reverb") && this.context) {
      this.updateTempoEffects(interruptNow);
    }
    if (name === "bpm") {
      this.bpmTechReleaseStep = Math.abs(BPM_TECH_STEPS[this.techVariant.bpm]) * 2;
    }
    if (name === "mod" && this.tech.mod) {
      this.setModDepth(interruptNow);
    }
  }

  setFillPattern(setting, variant, effectiveTime = null, replayEndTime = null) {
    this.fillSetting = Math.max(0, Math.min(3, Number(setting)));
    this.techVariant.fill = Math.max(0, Math.min(3, Number(variant)));
    if (
      this.tech.fill
      && this.fillState.mode === "replay"
      && this.context
      && this.playing
      && effectiveTime != null
    ) {
      this.prepareReplayFillTrigger(
        Number(effectiveTime),
        replayEndTime ?? this.fillState.endTime,
      );
    }
  }

  setStbPattern(setting, variant, effectiveTime = null) {
    this.stbSetting = Math.max(
      0,
      Math.min((this.data.stb?.settings.length ?? 1) - 1, Number(setting)),
    );
    this.techVariant.stb = Math.max(0, Math.min(3, Number(variant)));
    if (this.tech.stb) this.startStb(effectiveTime);
  }

  startStb(effectiveTime = null) {
    if (!this.context || !this.tech.stb || !this.data.stb) return;
    const setting = this.data.stb.settings[this.stbSetting];
    const voice = setting?.voices[this.techVariant.stb];
    const buffer = this.buffers.get(voice?.sampleId);
    if (!voice || !buffer) return;

    const now = effectiveTime == null
      ? this.context.currentTime + IMMEDIATE_AUDIO_MARGIN_SECONDS
      : Math.max(Number(effectiveTime), this.context.currentTime + IMMEDIATE_AUDIO_MARGIN_SECONDS);
    this.stopStb(now);
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    const info = this.sampleInfo[String(voice.sampleId)];
    source.buffer = buffer;
    const basePlaybackRate = voice.ratio;
    source.playbackRate.value = basePlaybackRate * (this.bpmTechScale / BPM_TECH_NORMAL);
    if (info.loop && info.loopStart != null && info.loopEnd != null) {
      source.loop = true;
      source.loopStart = info.loopStart / this.data.meta.sampleRate;
      source.loopEnd = info.loopEnd / this.data.meta.sampleRate;
    }
    gain.gain.setValueAtTime(Math.max(0.0001, voice.level), now);
    source.connect(gain).connect(this.mixGain);
    source.start(now);

    const record = { source, gain, basePlaybackRate };
    this.stbSource = record;
    source.addEventListener("ended", () => {
      if (this.stbSource === record) this.stbSource = null;
    }, { once: true });
  }

  stopStb(time) {
    const record = this.stbSource;
    if (!record || !this.context) return;
    this.stbSource = null;
    const gain = record.gain.gain;
    if (typeof gain.cancelAndHoldAtTime === "function") {
      gain.cancelAndHoldAtTime(time);
    } else {
      gain.cancelScheduledValues(time);
      gain.setValueAtTime(Math.max(0.0001, gain.value), time);
    }
    gain.linearRampToValueAtTime(0.0001, time + 0.012);
    try { record.source.stop(time + 0.02); } catch { /* already stopped */ }
  }

  setArpPattern(setting, variant, effectiveTime = null) {
    this.arpSetting = Math.max(
      0,
      Math.min((this.data.arp?.patterns.length ?? 1) - 1, Number(setting)),
    );
    this.techVariant.arp = Math.max(0, Math.min(3, Number(variant)));
    if (this.tech.arp && this.context && this.playing) {
      this.rescheduleArpFuture(Number(effectiveTime ?? this.context.currentTime));
    }
  }

  armArp(tick) {
    const syncTicks = this.data.arp?.syncTicks ?? this.ticksPerQuarter;
    this.arpStartTick = Math.ceil(Math.max(0, tick) / syncTicks - 1e-9) * syncTicks;
    this.arpScheduledUntilTick = tick;
    this.arpReleaseState = null;
  }

  arpEventCountAtTick(tick, pattern) {
    if (this.arpStartTick == null || tick < this.arpStartTick - 1e-6) return 0;
    const elapsed = Math.max(0, tick - this.arpStartTick);
    const cycles = Math.floor(elapsed / pattern.ticks);
    const withinCycle = elapsed - cycles * pattern.ticks;
    const inCycle = pattern.events.filter((event) => event[0] <= withinCycle + 1e-6).length;
    return cycles * pattern.events.length + inCycle;
  }

  arpTickForOrdinal(ordinal, pattern) {
    const zeroBased = Math.max(0, ordinal - 1);
    const cycle = Math.floor(zeroBased / pattern.events.length);
    const index = zeroBased % pattern.events.length;
    return this.arpStartTick + cycle * pattern.ticks + pattern.events[index][0];
  }

  beginArpRelease(now, tick) {
    if (this.arpStartTick == null || !this.data.arp) return;
    const pattern = this.data.arp.patterns[this.arpSetting];
    const releaseOrdinal = this.arpEventCountAtTick(tick, pattern);
    const level = Math.min(127, releaseOrdinal * this.data.arp.attackStep);
    const cutTime = now + 0.001;
    for (const record of this.arpSources) {
      if (record.startTime < now + 1e-4) continue;
      try { record.source.stop(cutTime); } catch { /* already stopped */ }
      this.arpSources.delete(record);
    }
    if (level <= 0) {
      this.arpReleaseState = null;
      this.arpStartTick = null;
      return;
    }
    const eventCount = Math.floor((level - 1) / this.data.arp.releaseStep);
    const stopOrdinal = releaseOrdinal + eventCount + 1;
    this.arpReleaseState = {
      ordinal: releaseOrdinal,
      level,
      eventCount,
      endTick: this.arpTickForOrdinal(stopOrdinal, pattern),
    };
    this.arpScheduledUntilTick = tick;
    this.scheduleArp(tick, Math.max(tick, this.scheduledUntilTick));
  }

  rescheduleArpFuture(now, restart = true) {
    const cutTime = now + 0.001;
    this.cancelSourceSet(this.arpSources, cutTime);
    const tick = Math.max(0, this.tickAtTime(cutTime));
    if (restart) this.armArp(tick);
    if (this.tech.arp) this.scheduleArp(tick, Math.max(tick, this.scheduledUntilTick));
  }

  scheduleArp(fromTick, toTick) {
    if ((!this.tech.arp && !this.arpReleaseState) || !this.data.arp || this.arpStartTick == null) return;
    const pattern = this.data.arp.patterns[this.arpSetting];
    const programOffset = this.data.arp.directionProgramOffsets?.[this.techVariant.arp]
      ?? this.techVariant.arp;
    const variant = this.data.arp.variants[pattern.programGroup * 4 + programOffset];
    const arpFrom = Math.max(fromTick, this.arpScheduledUntilTick, this.arpStartTick);
    const firstCycle = Math.max(0, Math.floor((arpFrom - this.arpStartTick) / pattern.ticks) - 1);
    const lastCycle = Math.floor((toTick - this.arpStartTick) / pattern.ticks) + 1;
    for (let cycle = firstCycle; cycle <= lastCycle; cycle += 1) {
      const baseTick = this.arpStartTick + cycle * pattern.ticks;
      for (let index = 0; index < pattern.events.length; index += 1) {
        const [offset, note, velocity, duration] = pattern.events[index];
        const eventTick = baseTick + offset;
        if (eventTick < arpFrom - 1e-6 || eventTick >= toTick - 1e-6) continue;
        const voice = variant.notes[String(note)];
        if (!voice) continue;
        const ordinal = cycle * pattern.events.length + index + 1;
        let envelope = Math.min(127, ordinal * this.data.arp.attackStep);
        if (this.arpReleaseState) {
          const releaseIndex = ordinal - this.arpReleaseState.ordinal;
          if (releaseIndex <= 0 || releaseIndex > this.arpReleaseState.eventCount) continue;
          envelope = Math.max(0, this.arpReleaseState.level - releaseIndex * this.data.arp.releaseStep);
        }
        const attack = envelope / 127;
        const level = voice.level * (velocity / 127) * attack;
        this.scheduleNoteAtTime(
          [0, voice.sampleId, voice.ratio, level, voice.pan, duration, voice.release],
          this.timeAtTick(eventTick),
          null,
          this.arpSources,
          false,
        );
      }
    }
    this.arpScheduledUntilTick = Math.max(this.arpScheduledUntilTick, toTick);
    if (this.arpReleaseState && toTick >= this.arpReleaseState.endTick - 1e-6) {
      this.arpReleaseState = null;
      this.arpStartTick = null;
    }
  }

  setFlshPattern(setting, variant, effectiveTime = null) {
    this.flshSetting = Math.max(
      0,
      Math.min((this.data.flsh?.settings.length ?? 1) - 1, Number(setting)),
    );
    this.techVariant.flsh = Math.max(0, Math.min(3, Number(variant)));
    if (this.tech.flsh && this.context && this.playing) {
      this.rescheduleFlshFuture(Number(effectiveTime ?? this.context.currentTime));
    }
  }

  rescheduleFlshFuture(now) {
    this.restorePendingFlshReleases(now);
    const cutTime = now + 0.001;
    for (const record of this.flshSources) {
      if (record.startTime < now + 1e-4) continue;
      try { record.source.stop(cutTime); } catch { /* already stopped */ }
      this.flshSources.delete(record);
    }
    const tick = Math.max(0, this.tickAtTime(cutTime));
    this.flshScheduledUntilTick = tick;
    if (this.tech.flsh) this.scheduleFlsh(tick, Math.max(tick, this.scheduledUntilTick));
  }

  restorePendingFlshReleases(now) {
    for (const record of this.flshSources) {
      if (record.flshReleaseTime == null || record.flshReleaseTime <= now + 1e-4) continue;
      if (record.naturalReleaseEndTime <= now) {
        record.flshReleaseTime = null;
        continue;
      }
      const gain = record.gain.gain;
      gain.cancelScheduledValues(now);
      if (now < record.durationEndTime) {
        gain.setValueAtTime(Math.max(0.0001, record.level), now);
        gain.setValueAtTime(Math.max(0.0001, record.level), record.durationEndTime);
      } else {
        const remaining = Math.max(0, record.naturalReleaseEndTime - now);
        const releaseLevel = Math.max(0.0001, record.level * (remaining / record.releaseDuration));
        gain.setValueAtTime(releaseLevel, now);
      }
      gain.linearRampToValueAtTime(0.0001, record.naturalReleaseEndTime);
      try { record.source.stop(record.naturalStopTime); } catch { /* already stopped */ }
      record.flshReleaseTime = null;
    }
  }

  scheduleFlsh(fromTick, toTick) {
    if (!this.tech.flsh || !this.data.flsh) return;
    const interval = this.data.flsh.intervals[this.techVariant.flsh];
    const flshFrom = Math.max(fromTick, this.flshScheduledUntilTick);
    let boundary = (Math.floor(flshFrom / interval) + 1) * interval;
    const setting = this.data.flsh.settings[this.flshSetting];
    while (boundary < toTick + 1e-6) {
      const startTime = this.timeAtTick(boundary);
      this.releaseFlshSourcesAt(startTime);
      this.scheduleNoteAtTime(
        [0, setting.sampleId, setting.ratio, setting.level, 0, interval, setting.release],
        startTime,
        null,
        this.flshSources,
        false,
      );
      boundary += interval;
    }
    this.flshScheduledUntilTick = Math.max(this.flshScheduledUntilTick, toTick);
  }

  releaseFlshSourcesAt(time) {
    for (const record of this.flshSources) {
      if (record.startTime >= time - 1e-5 || record.naturalReleaseEndTime <= time) continue;
      if (record.flshReleaseTime != null && record.flshReleaseTime <= time) continue;
      const gain = record.gain.gain;
      if (typeof gain.cancelAndHoldAtTime === "function") {
        gain.cancelAndHoldAtTime(time);
      } else {
        gain.cancelScheduledValues(time);
        gain.setValueAtTime(Math.max(0.0001, record.level), time);
      }
      gain.linearRampToValueAtTime(0.0001, time + 0.025);
      try { record.source.stop(time + 0.03); } catch { /* already stopped */ }
      record.flshReleaseTime = time;
    }
  }

  setMrgPattern(setting, variant, effectiveTime = null) {
    this.mrgSetting = Math.max(
      0,
      Math.min((this.data.mrg?.settings.length ?? 1) - 1, Number(setting)),
    );
    this.techVariant.mrg = Math.max(0, Math.min(3, Number(variant)));
    if (this.tech.mrg) this.startMrg(effectiveTime);
  }

  startMrg(effectiveTime = null) {
    if (!this.context || !this.tech.mrg || !this.data.mrg) return;
    const setting = this.data.mrg.settings[this.mrgSetting];
    const buffer = this.buffers.get(setting.sampleId);
    if (!buffer) return;

    const now = effectiveTime == null
      ? this.context.currentTime + 0.004
      : Math.max(Number(effectiveTime), this.context.currentTime + IMMEDIATE_AUDIO_MARGIN_SECONDS);
    this.stopMrg(now);
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    const panner = this.context.createStereoPanner();
    const info = this.sampleInfo[String(setting.sampleId)];
    source.buffer = buffer;
    const basePlaybackRate = setting.ratios[this.techVariant.mrg];
    source.playbackRate.value = basePlaybackRate * (this.bpmTechScale / BPM_TECH_NORMAL);
    if (info.loop && info.loopStart != null && info.loopEnd != null) {
      source.loop = true;
      source.loopStart = info.loopStart / this.data.meta.sampleRate;
      source.loopEnd = info.loopEnd / this.data.meta.sampleRate;
    }

    const level = setting.level;
    // The original keys the MRG voice on immediately.  The 24/48-frame
    // parameter changes are not an attack delay, so do not hold the WebAudio
    // gain at zero until the first update.
    gain.gain.setValueAtTime(Math.max(0.0001, level), now);
    panner.pan.value = 0;
    source.connect(gain).connect(panner).connect(this.mixGain);
    source.start(now);

    const record = { source, gain, basePlaybackRate };
    this.mrgSource = record;
    source.addEventListener("ended", () => {
      if (this.mrgSource === record) this.mrgSource = null;
    }, { once: true });
  }

  stopMrg(time) {
    const record = this.mrgSource;
    if (!record || !this.context) return;
    this.mrgSource = null;
    const gain = record.gain.gain;
    if (typeof gain.cancelAndHoldAtTime === "function") {
      gain.cancelAndHoldAtTime(time);
    } else {
      gain.cancelScheduledValues(time);
      gain.setValueAtTime(Math.max(0.0001, gain.value), time);
    }
    gain.linearRampToValueAtTime(0.0001, time + 0.012);
    const release = this.data.mrg.releaseFrames / this.data.mrg.framesPerSecond;
    try { record.source.stop(time + release); } catch { /* already stopped */ }
  }

  isInterruptOpen(tick) {
    if (!this.tech.interrupt) return true;
    if (this.interruptStartTick != null && tick < this.interruptStartTick - 1e-6) {
      return this.interruptGateOpen;
    }
    const interval = INTERRUPT_INTERVALS[this.techVariant.interrupt];
    return Math.floor(Math.max(0, tick) / interval) % 2 === 0;
  }

  armInterrupt(tick) {
    const interval = INTERRUPT_INTERVALS[this.techVariant.interrupt];
    this.interruptStartTick = (Math.floor(Math.max(0, tick) / interval) + 1) * interval;
    this.interruptScheduledUntilTick = tick;
  }

  resetInterruptState(tick, alignNow) {
    this.interruptScheduledUntilTick = tick;
    if (!this.tech.interrupt) {
      this.interruptStartTick = null;
      this.interruptGateOpen = true;
    } else if (alignNow) {
      this.interruptStartTick = tick;
      this.interruptGateOpen = true;
    } else {
      this.interruptGateOpen = true;
      this.armInterrupt(tick);
    }
  }

  restorePendingInterruptReleases(now) {
    for (const record of this.activeSources) {
      if (record.interruptReleaseTime == null || record.interruptReleaseTime <= now + 1e-4) continue;
      if (record.naturalReleaseEndTime <= now) {
        record.interruptReleaseTime = null;
        continue;
      }
      const gain = record.gain.gain;
      gain.cancelScheduledValues(now);
      if (now < record.durationEndTime) {
        gain.setValueAtTime(Math.max(0.0001, record.level), now);
        gain.setValueAtTime(Math.max(0.0001, record.level), record.durationEndTime);
      } else {
        const remaining = Math.max(0, record.naturalReleaseEndTime - now);
        const releaseLevel = Math.max(0.0001, record.level * (remaining / record.releaseDuration));
        gain.setValueAtTime(releaseLevel, now);
      }
      gain.linearRampToValueAtTime(0.0001, record.naturalReleaseEndTime);
      try { record.source.stop(record.naturalStopTime); } catch { /* already stopped */ }
      record.interruptReleaseTime = null;
    }
  }

  rescheduleForInterruptChange(now) {
    if (this.interruptGateOpen || !this.tech.interrupt) {
      this.restorePendingInterruptReleases(now);
    }
    const transitionFromTick = this.interruptScheduledUntilTick;
    const cutTime = now + 0.001;
    for (const record of this.activeSources) {
      if (record.startTime < now + 1e-4) continue;
      try { record.source.stop(cutTime); } catch { /* already stopped */ }
      this.activeSources.delete(record);
    }
    const tick = Math.max(0, this.tickAtTime(cutTime));
    this.scheduleInterruptTransitions(transitionFromTick, tick);
    this.scheduledUntilTick = tick;
    this.interruptScheduledUntilTick = tick;
    this.schedule();
  }

  releaseActiveSourcesAt(time) {
    for (const record of this.activeSources) {
      if (record.startTime >= time - 1e-5 || record.naturalReleaseEndTime <= time) continue;
      if (record.interruptReleaseTime != null && record.interruptReleaseTime <= time) continue;
      const gain = record.gain.gain;
      if (typeof gain.cancelAndHoldAtTime === "function") {
        gain.cancelAndHoldAtTime(time);
      } else {
        gain.cancelScheduledValues(time);
        gain.setValueAtTime(Math.max(0.0001, record.level), time);
      }
      gain.linearRampToValueAtTime(0.0001, time + INTERRUPT_RELEASE_SECONDS);
      try { record.source.stop(time + INTERRUPT_RELEASE_SECONDS + 0.005); } catch { /* already stopped */ }
      record.interruptReleaseTime = time;
    }
  }

  scheduleInterruptTransitions(fromTick, toTick) {
    if (!this.tech.interrupt) return;
    const interval = INTERRUPT_INTERVALS[this.techVariant.interrupt];
    const gateFrom = Math.max(fromTick, this.interruptScheduledUntilTick);
    let boundary = (Math.floor(gateFrom / interval) + 1) * interval;
    if (this.interruptStartTick != null) boundary = Math.max(boundary, this.interruptStartTick);
    while (boundary < toTick + 1e-6) {
      if (!this.isInterruptOpen(boundary + 1e-6)) {
        this.releaseActiveSourcesAt(this.timeAtTick(boundary));
      }
      boundary += interval;
    }
    this.interruptScheduledUntilTick = Math.max(this.interruptScheduledUntilTick, toTick);
  }

  prepareFillTrigger(tick) {
    this.clearFillTimer();
    this.fillState = {
      index: 0,
      targetTick: Math.max(0, tick),
      targetTime: null,
      endTime: null,
      aligning: true,
      mode: "immediate",
      timer: null,
    };
  }

  clearFillTimer() {
    if (this.fillState?.timer !== null && this.fillState?.timer !== undefined) {
      window.clearTimeout(this.fillState.timer);
      this.fillState.timer = null;
    }
  }

  prepareReplayFillTrigger(inputTime, endTime = Number.POSITIVE_INFINITY) {
    this.clearFillTimer();
    const inputTick = Math.max(0, this.tickAtTime(inputTime));
    // SDED.OX (FUN_800b317c) arms the first retrigger with a plain
    // `tick % 24 == 0` test: the fill waits for the next exact 24-tick
    // boundary; the seven-tick immediate window belongs to cue/change only.
    const targetTick = Math.ceil((inputTick - 1e-9) / CUE_QUANTIZE_TICKS)
      * CUE_QUANTIZE_TICKS;
    const barTicks = this.ticksPerQuarter * 4;
    this.fillState = {
      index: 0,
      targetTick,
      // Every retrigger seeks (current bar, tick 0), so the loop-bar
      // registration at the moment the fill lands stays frozen.
      barStartTick: Math.floor(targetTick / barTicks) * barTicks,
      targetTime: this.timeAtTick(targetTick),
      endTime: Number(endTime ?? Number.POSITIVE_INFINITY),
      aligning: true,
      mode: "replay",
      timer: null,
    };
    this.scheduleReplayFillTrigger();
  }

  // Seed the replay-mode fill chain mid-hold (timeline playback starting
  // inside a fill interval).  The caller must already have tech.fill on.
  resumeReplayFill(state) {
    this.clearFillTimer();
    this.fillState = {
      index: state.index,
      targetTick: 0,
      barStartTick: state.barStartTick,
      targetTime: Number(state.targetTime),
      endTime: Number(state.endTime ?? Number.POSITIVE_INFINITY),
      aligning: Boolean(state.aligning),
      mode: "replay",
      timer: null,
    };
    this.scheduleReplayFillTrigger();
  }

  scheduleReplayFillTrigger() {
    if (
      !this.context
      || !this.playing
      || !this.tech.fill
      || this.fillState.mode !== "replay"
      || this.fillState.targetTime == null
      || this.fillState.targetTime >= this.fillState.endTime - 1e-6
    ) return;
    this.clearFillTimer();
    const wait = Math.max(
      0,
      (
        this.fillState.targetTime
        - this.context.currentTime
        - REPLAY_FILL_TIMER_LEAD_SECONDS
      ) * 1000,
    );
    this.fillState.timer = window.setTimeout(() => {
      this.fillState.timer = null;
      this.applyReplayFillRetrigger();
    }, wait);
  }

  advanceFillPattern() {
    const pattern = FILL_PATTERNS[this.fillSetting][this.techVariant.fill];
    if (this.fillState.aligning) {
      this.fillState.aligning = false;
      this.fillState.index = 0;
    } else {
      this.fillState.index = (this.fillState.index + 1) % pattern.length;
    }
    return pattern[this.fillState.index];
  }

  resetSequenceForFill(cutTime, originTick) {
    const previousTick = this.tickAtTime(cutTime);
    this.cancelSources(cutTime);
    this.cancelSourceSet(this.arpSources, cutTime);
    this.cancelSourceSet(this.flshSources, cutTime);
    this.originTick = originTick;
    this.originTime = cutTime;
    this.onSeek?.(previousTick, originTick, cutTime);
    this.pausedTick = originTick;
    this.scheduledUntilTick = originTick;
    this.arpScheduledUntilTick = originTick;
    this.flshScheduledUntilTick = originTick;
    if (this.tech.arp) this.armArp(originTick);
    else {
      this.arpReleaseState = null;
      this.arpStartTick = null;
    }
    this.resetInterruptState(originTick, true);
    this.onPosition(originTick);
  }

  applyReplayFillRetrigger() {
    if (
      !this.context
      || !this.playing
      || !this.tech.fill
      || this.fillState.mode !== "replay"
      || this.fillState.targetTime == null
      || this.fillState.targetTime >= this.fillState.endTime - 1e-6
    ) return;

    const targetTime = this.fillState.targetTime;
    const cutTime = Math.max(
      targetTime,
      this.context.currentTime + IMMEDIATE_AUDIO_MARGIN_SECONDS,
    );
    // SDED.OX's fill seeks to (current bar, tick 0), keeping the loop-bar
    // registration, instead of rewinding the whole sequence.
    this.resetSequenceForFill(cutTime, this.fillState.barStartTick ?? 0);
    // Chain the next boundary from the theoretical target, not from the
    // possibly late cutTime, so timer lateness cannot accumulate into the
    // musical grid.  Boundaries a long stall already passed are skipped.
    let interval = this.advanceFillPattern();
    let nextTargetTime = targetTime + interval / this.ticksPerSecond();
    while (nextTargetTime < this.context.currentTime) {
      interval = this.advanceFillPattern();
      nextTargetTime += interval / this.ticksPerSecond();
    }
    this.fillState.targetTick = interval;
    this.fillState.targetTime = nextTargetTime;
    this.schedule();
    this.scheduleReplayFillTrigger();
  }

  maybeApplyFillRetrigger(now) {
    if (
      !this.tech.fill
      || this.fillState.mode === "replay"
      || this.fillState.targetTick == null
    ) return false;
    const tick = Math.max(0, this.tickAtTime(now));
    if (tick + 0.5 < this.fillState.targetTick) return false;

    const barTicks = this.ticksPerQuarter * 4;
    const barStart = Math.floor(this.fillState.targetTick / barTicks) * barTicks;
    const cutTime = now + 0.006;
    this.resetSequenceForFill(cutTime, barStart);
    this.fillState.targetTick = barStart + this.advanceFillPattern();
    return true;
  }

  updateTempoEffects(effectiveTime = null) {
    if (!this.context) return;
    const now = Number(effectiveTime ?? this.context.currentTime);
    const delayVariant = this.techVariant.delay;
    this.delayNode.delayTime.setTargetAtTime(
      (60 / this.effectiveBpm()) * DELAY_BEAT_RATIOS[delayVariant],
      now,
      0.02,
    );
    this.delayWet.gain.setTargetAtTime(DELAY_WET_LEVELS[delayVariant], now, 0.02);
    this.delayFeedback.gain.setTargetAtTime(DELAY_FEEDBACK_LEVELS[delayVariant], now, 0.02);
    this.delayTone.frequency.setTargetAtTime(4800 - delayVariant * 650, now, 0.02);

    const reverbVariant = this.techVariant.reverb;
    const depth = REVERB_DEPTHS[reverbVariant] / 127;
    this.reverbPreDelay.delayTime.setTargetAtTime(REVERB_PREDELAYS[reverbVariant], now, 0.02);
    this.reverbWet.gain.setTargetAtTime(0.18 + Math.sqrt(depth) * 0.68, now, 0.02);
    this.reverbTone.frequency.setTargetAtTime(3800 - reverbVariant * 350, now, 0.02);
  }

  schedule() {
    if (!this.playing || !this.context) return;
    const now = this.context.currentTime;
    this.advanceBpmTech(now);
    if (this.maybeApplyFillRetrigger(now)) {
      this.schedule();
      return;
    }
    const fromTick = Math.max(this.scheduledUntilTick, this.tickAtTime(now));
    const toTick = this.tickAtTime(now + LOOKAHEAD_SECONDS);
    if (toTick <= fromTick) return;
    for (const track of this.getTracks()) {
      if (!track.enabled) continue;
      const item = this.items.get(track.itemId);
      if (!item) continue;
      this.schedulePattern(item, track, fromTick, toTick);
    }
    this.scheduleArp(fromTick, toTick);
    this.scheduleFlsh(fromTick, toTick);
    this.scheduleInterruptTransitions(fromTick, toTick);
    this.scheduledUntilTick = toTick;
  }

  schedulePattern(item, track, fromTick, toTick) {
    const loopTicks = item.ticks;
    if (!loopTicks) return;
    const firstCycle = Math.floor(fromTick / loopTicks) - 1;
    const lastCycle = Math.floor(toTick / loopTicks) + 1;
    for (let cycle = firstCycle; cycle <= lastCycle; cycle += 1) {
      const baseTick = cycle * loopTicks;
      if (baseTick + loopTicks < 0) continue;
      let barOffset = 0;
      for (const bar of item.bars) {
        for (const event of bar.events) {
          const eventTick = baseTick + barOffset + event[0];
          if (eventTick < fromTick - 1e-6 || eventTick >= toTick - 1e-6) continue;
          this.scheduleNote(event, eventTick, track.meter);
        }
        barOffset += bar.ticks;
      }
    }
  }

  scheduleNote(event, tick, meter) {
    if (!this.isInterruptOpen(tick)) return;
    this.scheduleNoteAtTime(
      event,
      this.timeAtTick(tick),
      meter,
      this.activeSources,
      true,
    );
  }

  releaseInfoFor(index) {
    const info = this.releases[index];
    if (!info) return { seconds: 0.025, exp: false, tail: 0.025 };
    const seconds = info.ms / 1000;
    const exp = Boolean(info.exp);
    // An exponential release is audible for roughly seven time constants.
    return { seconds, exp, tail: exp ? seconds * 7 : seconds };
  }

  scheduleNoteAtTime(event, startTime, meter, sourceSet, pulse = true) {
    const [/* tick */, sampleId, ratio, level, pan, durationTicks] = event;
    const buffer = this.buffers.get(sampleId);
    if (!buffer) return;
    const duration = durationTicks / this.ticksPerSecond();
    const releaseInfo = this.releaseInfoFor(event[6]);
    const release = releaseInfo.tail;
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    const panner = this.context.createStereoPanner();
    const info = this.sampleInfo[String(sampleId)];

    source.buffer = buffer;
    source.playbackRate.value = ratio * (this.bpmTechScale / BPM_TECH_NORMAL);
    if (info.loop && info.loopStart != null && info.loopEnd != null) {
      source.loop = true;
      source.loopStart = info.loopStart / this.data.meta.sampleRate;
      source.loopEnd = info.loopEnd / this.data.meta.sampleRate;
    }
    gain.gain.setValueAtTime(Math.max(0.0001, level), startTime);
    gain.gain.setValueAtTime(Math.max(0.0001, level), startTime + duration);
    if (releaseInfo.exp) {
      gain.gain.setTargetAtTime(0, startTime + duration, releaseInfo.seconds);
    } else {
      gain.gain.linearRampToValueAtTime(0.0001, startTime + duration + release);
    }
    panner.pan.value = pan;
    source.connect(gain).connect(panner).connect(this.mixGain);
    source.start(startTime);
    const durationEndTime = startTime + duration;
    const naturalReleaseEndTime = durationEndTime + release;
    const naturalStopTime = naturalReleaseEndTime + 0.005;
    source.stop(naturalStopTime);

    const record = {
      source,
      gain,
      basePlaybackRate: ratio,
      startTime,
      level,
      releaseDuration: release,
      releaseSeconds: releaseInfo.seconds,
      releaseExp: releaseInfo.exp,
      durationEndTime,
      naturalReleaseEndTime,
      naturalStopTime,
      interruptReleaseTime: null,
    };
    if (sourceSet === this.activeSources) this.connectModToSource(record);
    sourceSet.add(record);
    source.addEventListener("ended", () => sourceSet.delete(record), { once: true });
    if (pulse) this.pulseMeter(meter, startTime, level);
  }

  async previewItem(item, statusCallback, shouldPlay = () => true) {
    await this.initialize(statusCallback);
    if (!shouldPlay()) return { delay: 0, duration: 0 };
    await this.context.resume();
    const previewBar = item.bars.find((bar) => bar.events.length) ?? item.bars[0];
    let startTime = this.context.currentTime + 0.035;
    if (this.playing) {
      const barTicks = this.ticksPerQuarter * 4;
      const currentTick = Math.max(0, this.tickAtTime(this.context.currentTime));
      const nextBarTick = (Math.floor(currentTick / barTicks) + 1) * barTicks;
      startTime = this.timeAtTick(nextBarTick);
    }
    const delay = Math.max(0, startTime - this.context.currentTime);
    this.cancelPreviewSources(this.context.currentTime + 0.01);
    for (const event of previewBar.events) {
      this.scheduleNoteAtTime(
        event,
        startTime + event[0] / this.ticksPerSecond(),
        null,
        this.previewSources,
      );
    }
    return { delay, duration: previewBar.ticks / this.ticksPerSecond() };
  }

  pulseMeter(meter, startTime, level) {
    if (!meter) return;
    const epoch = this.meterEpoch;
    const wait = Math.max(0, (startTime - this.context.currentTime) * 1000);
    window.setTimeout(() => {
      if (epoch !== this.meterEpoch) return;
      meter.style.width = `${Math.max(18, Math.min(100, level * 120))}%`;
      window.setTimeout(() => {
        if (epoch === this.meterEpoch) meter.style.width = "0";
      }, 70);
    }, wait);
  }

  cancelSources(time) {
    this.cancelSourceSet(this.activeSources, time);
    this.resetMeters();
  }

  resetMeters() {
    this.meterEpoch += 1;
    $$(".slot-meter i").forEach((meter) => { meter.style.width = "0"; });
  }

  cancelPreviewSources(time) {
    this.cancelSourceSet(this.previewSources, time);
  }

  cancelSourceSet(sourceSet, time) {
    for (const record of sourceSet) {
      const gain = record.gain?.gain;
      if (!gain || (record.startTime != null && record.startTime >= time - 1e-5)) {
        // Not keyed on yet by the cut time: it never sounds, stop silently.
        try { record.source.stop(time); } catch { /* already stopped */ }
        continue;
      }
      if (typeof gain.cancelAndHoldAtTime === "function") {
        gain.cancelAndHoldAtTime(time);
      } else {
        gain.cancelScheduledValues(time);
        gain.setValueAtTime(Math.max(0.0001, record.level ?? 0.0001), time);
      }
      // Key-off like the SPU: the voice decays along its own VAB-programmed
      // release curve rather than a fixed fade.
      const releaseSeconds = record.releaseSeconds ?? CANCEL_RELEASE_SECONDS;
      const tail = record.releaseExp ? releaseSeconds * 7 : releaseSeconds;
      if (record.releaseExp) {
        gain.setTargetAtTime(0, time, releaseSeconds);
      } else {
        gain.linearRampToValueAtTime(0.0001, time + tail);
      }
      try {
        record.source.stop(time + tail + 0.005);
      } catch { /* already stopped */ }
    }
    sourceSet.clear();
  }

  drawPosition() {
    if (!this.playing) return;
    this.advanceBpmTech(this.context.currentTime);
    this.onPosition(Math.max(0, this.tickAtTime(this.context.currentTime)));
    this.animationFrame = requestAnimationFrame(() => this.drawPosition());
  }
}

function makeDefaultSets() {
  return SET_NAMES.map((_, index) => {
    const sBase = index * 4 + 1;
    return {
      slots: [
        { key: "L1", type: "single", enabled: true, category: "B", item: `B${String(index * 2 + 1).padStart(2, "0")}` },
        { key: "L2", type: "single", enabled: true, category: "H", item: `H${String(index * 2 + 1).padStart(2, "0")}` },
        { key: "R1", type: "pair", enabled: true, itemEnabled: [true, true], items: [`S${String(sBase).padStart(3, "0")}`, `S${String(sBase + 1).padStart(3, "0")}`] },
        { key: "R2", type: "pair", enabled: true, itemEnabled: [true, true], items: [`S${String(sBase + 2).padStart(3, "0")}`, `S${String(sBase + 3).padStart(3, "0")}`] },
      ],
    };
  });
}

function loadSets() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (Array.isArray(saved) && saved.length === 8) return saved;
  } catch { /* use defaults */ }
  return makeDefaultSets();
}

const data = await fetch("data/catalog.json").then((response) => {
  if (!response.ok) throw new Error(`catalog.json: HTTP ${response.status}`);
  return response.json();
});

const byCategory = {
  B: data.items.filter((item) => item.category === "B"),
  H: data.items.filter((item) => item.category === "H"),
  S: data.items.filter((item) => item.category === "S"),
};
const itemMap = new Map(data.items.map((item) => [item.id, item]));
let sets = loadSets();
let activeSet = 0;
let heldSetOrigin = null;
let heldSetButton = null;
const slotElements = [];
let renderedSequenceKey = "";

const engine = new GrooveEngine(data, updatePosition);
engine.getTracks = getActiveTracks;

const LANE_SLOT_INDEX = [0, 1, 2, 2, 3, 3];
const timelinePlayer = createTimelinePlayer(engine, {
  setStatus: (message) => setStatus(message, false),
  applyBpm: (bpm) => {
    $("#bpmInput").value = String(bpm);
    $("#bpmOutput").textContent = String(bpm);
  },
  lockUi: (locked) => {
    setReplayUiLocked(locked);
    $("#playButton").textContent = locked ? "■ STOP" : "▶ PLAY";
    $("#playButton").classList.toggle("stop", locked);
  },
  onEnd: (message) => {
    renderedSequenceKey = "";
    renderSlots();
    renderReplayIndicators();
    updatePosition(engine.pausedTick);
    setStatus(message, false);
  },
  onStateChange: () => {
    renderedSequenceKey = "";
    renderSlots();
    renderReplayIndicators();
  },
});

const timelineRecorder = createTimelineRecorder(engine);
let onRecordingFinished = null;

function currentTechSetting(name) {
  return {
    stb: engine.stbSetting,
    flsh: engine.flshSetting,
    mrg: engine.mrgSetting,
    fill: engine.fillSetting,
    arp: engine.arpSetting,
  }[name] ?? 0;
}

function finishRecordingIfActive() {
  if (!timelineRecorder.recording) return;
  const recorded = timelineRecorder.stop();
  setStatus("収録を終了しました", engine.playing);
  if (recorded) onRecordingFinished?.(recorded);
}

function performanceSet() {
  return timelinePlayer.displaySlots() ?? sets[activeSet];
}

function replayLocked() {
  return timelinePlayer.running;
}

function normalizeSet(set) {
  const defaults = makeDefaultSets()[activeSet];
  if (!set?.slots || set.slots.length !== 4) return defaults;
  set.slots.forEach((slot, index) => {
    if (defaults.slots[index].type === "pair" && (!Array.isArray(slot.itemEnabled) || slot.itemEnabled.length !== 2)) {
      slot.itemEnabled = [true, true];
    }
  });
  return set;
}

function saveSets() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sets));
}

function setItemButton(button, category, selected) {
  const items = byCategory[category];
  const item = items.find((candidate) => candidate.id === selected) ?? items[0];
  const name = document.createElement("strong");
  name.textContent = item.id;
  const detail = document.createElement("small");
  detail.textContent = item.source;
  button.replaceChildren(name, detail);
  button.dataset.itemId = item.id;
  button.title = "クリックで一覧／ホイール上下で前後送り／ホイール押し込み中はSOLO";
  return item.id;
}

function enableWheelSelection(button, getCategory, onSelect) {
  let lastStepTime = -Infinity;
  button.addEventListener("wheel", (event) => {
    if (timelineRecorder.recording) return;
    const items = byCategory[getCategory()];
    if (event.ctrlKey || event.deltaY === 0 || items.length < 2) return;
    event.preventDefault();
    const now = performance.now();
    if (now - lastStepTime < 85) return;
    lastStepTime = now;
    const direction = event.deltaY > 0 ? 1 : -1;
    const currentIndex = Math.max(0, items.findIndex((item) => item.id === button.dataset.itemId));
    const nextItem = items[(currentIndex + direction + items.length) % items.length];
    onSelect(nextItem.id);
  }, { passive: false });
}

let heldSoloItemIds = null;
let heldSoloLaneKeys = null;
let heldSoloElement = null;
let heldSoloMeter = null;

function endItemSoloHold() {
  if (!heldSoloItemIds) return;
  heldSoloItemIds = null;
  heldSoloLaneKeys = null;
  heldSoloElement?.classList.remove("solo-held");
  heldSoloElement = null;
  heldSoloMeter = null;
  engine.preserveClockReschedule();
  setStatus(engine.playing ? "演奏中" : "停止中", engine.playing);
}

function enableItemSoloHold(element, getItemIds, getLaneKeys = null) {
  element.addEventListener("mousedown", (event) => {
    if (event.button !== 1) return;
    if (timelineRecorder.recording) return;
    event.preventDefault();
    event.stopPropagation();
    endItemSoloHold();
    previewRequest += 1;
    const itemIds = getItemIds();
    heldSoloItemIds = (Array.isArray(itemIds) ? itemIds : [itemIds]).filter(Boolean);
    const laneKeys = getLaneKeys?.();
    heldSoloLaneKeys = laneKeys == null
      ? null
      : (Array.isArray(laneKeys) ? laneKeys : [laneKeys]).filter(Boolean);
    if (!heldSoloItemIds.length) {
      heldSoloItemIds = null;
      heldSoloLaneKeys = null;
      return;
    }
    heldSoloElement = element;
    const slotCard = element.closest(".slot-card");
    heldSoloMeter = slotCard ? $(".slot-meter i", slotCard) : null;
    element.classList.add("solo-held");
    engine.preserveClockReschedule();
    setStatus(
      engine.playing ? `SOLO HOLD: ${heldSoloItemIds.join(" + ")}` : "SOLO HOLDはPLAY中に使用できます",
      engine.playing,
    );
  });
  element.addEventListener("auxclick", (event) => {
    if (event.button === 1) {
      event.preventDefault();
      event.stopPropagation();
    }
  });
}

function itemTimbres(item) {
  return [...new Set(item.bars.flatMap((bar) => bar.events.map((event) => event[1])))].sort((a, b) => a - b);
}

function timbreText(item) {
  return itemTimbres(item).map((sampleId) => String(sampleId).padStart(2, "0")).join("+");
}

let itemPickerState = null;
let previewRequest = 0;

function renderTimbreFilters() {
  const samples = [...new Set(byCategory[itemPickerState.category].flatMap(itemTimbres))].sort((a, b) => a - b);
  const filters = [{ id: null, label: "すべて" }, ...samples.map((sampleId) => ({
    id: sampleId,
    label: `音色 ${String(sampleId).padStart(2, "0")}`,
  }))];
  $("#itemTimbreFilters").replaceChildren(...filters.map((filter) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `timbre-filter${itemPickerState.timbre === filter.id ? " active" : ""}`;
    button.textContent = filter.label;
    button.addEventListener("click", () => {
      itemPickerState.timbre = filter.id;
      renderTimbreFilters();
      renderItemPickerItems();
    });
    return button;
  }));
}

async function previewPickerItem(item, button) {
  const request = ++previewRequest;
  $$(".item-preview-button").forEach((candidate) => candidate.classList.remove("playing"));
  button.classList.add("playing");
  button.disabled = true;
  try {
    const timing = await engine.previewItem(
      item,
      (message) => setStatus(message, false),
      () => request === previewRequest && $("#itemPickerDialog").open,
    );
    if (request !== previewRequest) return;
    setStatus(engine.playing ? `次小節から試聴: ${item.id}` : `試聴中: ${item.id}`, engine.playing);
    window.setTimeout(() => {
      if (request !== previewRequest) return;
      button.classList.remove("playing");
      setStatus(engine.playing ? "演奏中" : "停止中", engine.playing);
    }, (timing.delay + timing.duration) * 1000 + 120);
  } catch (error) {
    console.error(error);
    setStatus(`試聴エラー: ${error.message}`, engine.playing);
  } finally {
    button.disabled = false;
  }
}

function renderItemPickerItems() {
  const query = itemPickerState.query.trim().toUpperCase();
  const items = byCategory[itemPickerState.category].filter((item) => {
    const matchesTimbre = itemPickerState.timbre == null || itemTimbres(item).includes(itemPickerState.timbre);
    const searchable = `${item.id} ${item.source} P${item.program} ${timbreText(item)}`.toUpperCase();
    return matchesTimbre && (!query || searchable.includes(query));
  });
  $("#itemPickerCount").textContent = `${items.length} ITEMS`;

  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "item-picker-empty";
    empty.textContent = "該当する音ネタがありません";
    $("#itemPickerItems").replaceChildren(empty);
    return;
  }

  $("#itemPickerItems").replaceChildren(...items.map((item) => {
    const card = document.createElement("article");
    card.className = `item-choice-card${item.id === itemPickerState.selectedId ? " selected" : ""}`;
    const choose = document.createElement("button");
    choose.type = "button";
    choose.className = "item-choice-main";
    choose.title = `${item.id}を選択／ホイール押し込み中はSOLO`;
    const name = document.createElement("strong");
    name.textContent = item.id;
    const timbre = document.createElement("span");
    timbre.textContent = `音色 ${timbreText(item)}`;
    const detail = document.createElement("small");
    detail.textContent = `${item.source} · P${String(item.program).padStart(2, "0")} · ${item.bars.length} BARS`;
    choose.append(name, timbre, detail);
    choose.addEventListener("click", () => {
      itemPickerState.onSelect(item.id);
      $("#itemPickerDialog").close();
    });
    enableItemSoloHold(choose, () => item.id);
    const preview = document.createElement("button");
    preview.type = "button";
    preview.className = "item-preview-button";
    preview.textContent = "🔊";
    preview.title = `${item.id}の発音を含む先頭1小節を試聴`;
    preview.addEventListener("click", () => previewPickerItem(item, preview));
    card.append(choose, preview);
    return card;
  }));
}

function openItemPicker(category, selectedId, onSelect) {
  if (timelineRecorder.recording) {
    setStatus("収録中は音ネタを変更できません", true);
    return;
  }
  itemPickerState = { category, selectedId, onSelect, timbre: null, query: "" };
  const categoryName = { B: "BASS", H: "HI-HAT", S: "SAMPLING" }[category];
  $("#itemPickerTitle").textContent = `${categoryName} 音ネタを選択`;
  $("#itemPickerSearch").value = "";
  renderTimbreFilters();
  renderItemPickerItems();
  $("#itemPickerDialog").showModal();
  window.requestAnimationFrame(() => {
    $(".item-choice-card.selected")?.scrollIntoView({ block: "center" });
  });
}

function buildSetButtons() {
  const container = $("#setButtons");
  SET_NAMES.forEach((name, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "set-button";
    button.innerHTML = `${name}<small>SET ${index + 1}</small>`;
    button.title = "左クリックで切り替え／ホイール押し込み中は一時切り替え";
    button.addEventListener("click", () => switchSet(index));
    button.addEventListener("mousedown", (event) => {
      if (event.button !== 1) return;
      event.preventDefault();
      beginTemporarySetSwitch(index, button);
    });
    button.addEventListener("auxclick", (event) => {
      if (event.button === 1) event.preventDefault();
    });
    container.append(button);
  });
}

function toggleSlotEnabled(index) {
  if (replayLocked()) return;
  const slot = sets[activeSet].slots[index];
  if (!slot) return;
  slot.enabled = !slot.enabled;
  timelineRecorder.lanes(sets[activeSet].slots);
  saveSets();
  renderSlots();
  engine.preserveClockReschedule();
  const scope = slot.type === "pair" ? "ALL" : "SEQ";
  setStatus(`${slot.key} ${scope} ${slot.enabled ? "ON" : "OFF"}`, engine.playing);
}

function buildSlots() {
  const grid = $("#slotGrid");
  ["L1", "L2", "R1", "R2"].forEach((key, index) => {
    const pair = index >= 2;
    const template = pair ? $("#pairSlotTemplate") : $("#singleSlotTemplate");
    const card = template.content.firstElementChild.cloneNode(true);
    $(".slot-key", card).textContent = `${key} / ${SLOT_SHORTCUTS[index].label}`;
    $(".slot-title", card).textContent = pair ? "SEQUENCE PAIR" : "BASS / HI-HAT CHANNEL";
    const toggle = $(".slot-toggle", card);
    toggle.addEventListener("click", () => toggleSlotEnabled(index));

    if (!pair) {
      const category = $(".category-select", card);
      const itemButton = $(".item-picker-button", card);
      const chooseItem = (itemId) => {
        const slot = sets[activeSet].slots[index];
        slot.item = setItemButton(itemButton, slot.category, itemId);
        saveSets();
        engine.preserveClockReschedule();
      };
      category.addEventListener("change", () => {
        if (timelineRecorder.recording) {
          category.value = sets[activeSet].slots[index].category;
          return;
        }
        const slot = sets[activeSet].slots[index];
        slot.category = category.value;
        chooseItem(slot.item);
      });
      itemButton.addEventListener("click", () => {
        const slot = sets[activeSet].slots[index];
        openItemPicker(slot.category, slot.item, chooseItem);
      });
      enableWheelSelection(itemButton, () => sets[activeSet].slots[index].category, chooseItem);
      enableItemSoloHold(itemButton, () => itemButton.dataset.itemId, () => key);
      category.title = "BASS / HI-HATの選択／ホイール押し込み中はこのパートをSOLO";
      enableItemSoloHold(category, () => itemButton.dataset.itemId, () => key);
      const slotTitle = $(".slot-title", card);
      slotTitle.title = "ホイール押し込み中はこのパートをSOLO";
      enableItemSoloHold(slotTitle, () => itemButton.dataset.itemId, () => key);
    } else {
      $$(".pair-row", card).forEach((row, pairIndex) => {
        const itemButton = $(".item-picker-button", row);
        const sequenceToggle = $(".sequence-toggle", row);
        const chooseItem = (itemId) => {
          const slot = sets[activeSet].slots[index];
          slot.items[pairIndex] = setItemButton(itemButton, "S", itemId);
          saveSets();
          engine.preserveClockReschedule();
        };
        itemButton.addEventListener("click", () => {
          const slot = sets[activeSet].slots[index];
          openItemPicker("S", slot.items[pairIndex], chooseItem);
        });
        enableWheelSelection(itemButton, () => "S", chooseItem);
        enableItemSoloHold(
          itemButton,
          () => itemButton.dataset.itemId,
          () => `${key}-${pairIndex === 0 ? "A" : "B"}`,
        );
        sequenceToggle.addEventListener("click", () => {
          const slot = sets[activeSet].slots[index];
          slot.itemEnabled[pairIndex] = !slot.itemEnabled[pairIndex];
          timelineRecorder.lanes(sets[activeSet].slots);
          saveSets();
          renderSlots();
          engine.preserveClockReschedule();
        });
      });
    }
    card.title = pair
      ? "カード全体のホイール押し込み中はS-A＋S-BをペアSOLO"
      : "カード全体のホイール押し込み中はこのパートをSOLO";
    enableItemSoloHold(
      card,
      () => {
        const slot = sets[activeSet].slots[index];
        return slot.type === "pair" ? [...slot.items] : slot.item;
      },
      () => pair ? [`${key}-A`, `${key}-B`] : key,
    );
    grid.append(card);
    slotElements.push(card);
  });
}

function renderSlots() {
  if (!timelinePlayer.running) sets[activeSet] = normalizeSet(sets[activeSet]);
  performanceSet().slots.forEach((slot, index) => {
    const card = slotElements[index];
    const toggle = $(".slot-toggle", card);
    const togglePrefix = slot.type === "single" ? "SEQ" : "ALL";
    toggle.textContent = `${togglePrefix} ${slot.enabled ? "ON" : "OFF"}`;
    toggle.classList.toggle("off", !slot.enabled);
    toggle.setAttribute("aria-checked", String(slot.enabled));
    card.classList.toggle("disabled", !slot.enabled);

    if (slot.type === "single") {
      const category = $(".category-select", card);
      const itemButton = $(".item-picker-button", card);
      category.value = slot.category;
      slot.item = setItemButton(itemButton, slot.category, slot.item);
    } else {
      $$(".pair-row", card).forEach((row, pairIndex) => {
        const itemButton = $(".item-picker-button", row);
        const sequenceToggle = $(".sequence-toggle", row);
        slot.items[pairIndex] = setItemButton(itemButton, "S", slot.items[pairIndex]);
        sequenceToggle.textContent = `SEQ ${slot.itemEnabled[pairIndex] ? "ON" : "OFF"}`;
        sequenceToggle.classList.toggle("off", !slot.itemEnabled[pairIndex]);
        sequenceToggle.setAttribute("aria-checked", String(slot.itemEnabled[pairIndex]));
      });
    }
  });
}

function getActiveTracks() {
  if (heldSoloItemIds) {
    return heldSoloItemIds.map((itemId) => ({ enabled: true, itemId, meter: heldSoloMeter }));
  }
  const timelineTracks = timelinePlayer.audioTracks(
    (laneIndex) => $(".slot-meter i", slotElements[LANE_SLOT_INDEX[laneIndex]]),
  );
  if (timelineTracks) return timelineTracks;
  const set = sets[activeSet];
  const tracks = [];
  set.slots.forEach((slot, index) => {
    const meter = $(".slot-meter i", slotElements[index]);
    if (slot.type === "single") {
      tracks.push({ enabled: slot.enabled, itemId: slot.item, meter });
    } else {
      slot.items.forEach((itemId, pairIndex) => {
        tracks.push({ enabled: slot.enabled && slot.itemEnabled[pairIndex], itemId, meter });
      });
    }
  });
  return tracks;
}

function getSequenceTracks() {
  const tracks = [];
  const soloItemIds = heldSoloItemIds ? new Set(heldSoloItemIds) : null;
  const soloLaneKeys = heldSoloLaneKeys ? new Set(heldSoloLaneKeys) : null;
  performanceSet().slots.forEach((slot) => {
    if (slot.type === "single") {
      tracks.push({
        lane: slot.key,
        enabled: soloLaneKeys
          ? soloLaneKeys.has(slot.key)
          : soloItemIds ? soloItemIds.has(slot.item) : slot.enabled,
        itemId: slot.item,
      });
    } else {
      slot.items.forEach((itemId, pairIndex) => {
        const lane = `${slot.key}-${pairIndex === 0 ? "A" : "B"}`;
        tracks.push({
          lane,
          enabled: soloLaneKeys
            ? soloLaneKeys.has(lane)
            : soloItemIds ? soloItemIds.has(itemId) : slot.enabled && slot.itemEnabled[pairIndex],
          itemId,
        });
      });
    }
  });
  return tracks;
}

function buildSequenceRuler() {
  const steps = $("#sequenceSteps");
  steps.replaceChildren(...Array.from({ length: 16 }, (_, index) => {
    const step = document.createElement("span");
    step.className = `sequence-step${index % 4 === 0 ? " downbeat" : ""}`;
    step.textContent = String(index + 1).padStart(2, "0");
    return step;
  }));
}

function makeSequenceNote(event, barTicks, collisionIndex, interrupted = false) {
  const [tick, sampleId, ratio, level, , duration] = event;
  const stepTicks = barTicks / 16;
  const stepIndex = Math.min(15, Math.floor(tick / stepTicks));
  const microTick = tick - stepIndex * stepTicks;
  const left = (tick / barTicks) * 100;
  const width = Math.max(0.45, Math.min(100 - left, (duration / barTicks) * 100));
  const verticalOffsets = [0, -17, 17, -29, 29];
  const note = document.createElement("i");
  note.className = `sequence-note${interrupted ? " interrupted" : ""}`;
  note.style.left = `${left}%`;
  note.style.width = `${width}%`;
  note.style.top = `${50 + verticalOffsets[collisionIndex % verticalOffsets.length]}%`;
  note.style.setProperty("--note-size", `${6 + Math.min(1, level) * 8}px`);
  const offsetLabel = microTick ? ` +${microTick}tick` : "";
  note.title = `STEP ${stepIndex + 1}${offsetLabel} / tick ${tick} / VAG ${sampleId} / pitch ${ratio.toFixed(3)} / level ${level.toFixed(3)} / length ${duration}tick${interrupted ? " / INT CUT" : ""}`;
  note.setAttribute("aria-label", note.title);
  return note;
}

function renderSequence(tick) {
  const barTicks = data.meta.ticksPerQuarter * 4;
  const globalBar = Math.floor(tick / barTicks);
  const tracks = getSequenceTracks();
  const interruptKey = engine.tech.interrupt
    ? `${engine.techVariant.interrupt}@${Math.round(engine.interruptStartTick ?? -1)}`
    : "off";
  const sequenceKey = `${activeSet}:replay=${timelinePlayer.running ? "tl" : "off"}:${globalBar}:int=${interruptKey}:${tracks.map((track) => `${track.lane},${track.itemId},${track.enabled}`).join("|")}`;

  if (sequenceKey !== renderedSequenceKey) {
    const lanes = tracks.map((track) => {
      const item = itemMap.get(track.itemId);
      const barIndex = globalBar % item.bars.length;
      const bar = item.bars[barIndex];
      const lane = document.createElement("div");
      lane.className = `sequence-lane${item.category === "S" ? " s-lane" : ""}${track.enabled ? "" : " disabled"}`;

      const label = document.createElement("div");
      label.className = "sequence-label";
      const channelName = document.createElement("strong");
      channelName.textContent = track.lane;
      const itemName = document.createElement("span");
      itemName.textContent = `${item.id} · BAR ${barIndex + 1}/${item.bars.length}`;
      label.append(channelName, itemName);

      const sequenceTrack = document.createElement("div");
      sequenceTrack.className = "sequence-track";
      const collisions = new Map();
      for (const event of bar.events) {
        const tickKey = event[0];
        const collisionIndex = collisions.get(tickKey) ?? 0;
        collisions.set(tickKey, collisionIndex + 1);
        const eventTick = globalBar * barTicks + event[0];
        const interrupted = engine.tech.interrupt && !engine.isInterruptOpen(eventTick);
        sequenceTrack.append(makeSequenceNote(event, bar.ticks, collisionIndex, interrupted));
      }
      const playhead = document.createElement("i");
      playhead.className = "sequence-playhead";
      sequenceTrack.append(playhead);
      lane.append(label, sequenceTrack);
      return lane;
    });
    $("#sequenceGrid").replaceChildren(...lanes);
    renderedSequenceKey = sequenceKey;
  }

  const tickInBar = ((tick % barTicks) + barTicks) % barTicks;
  const progress = (tickInBar / barTicks) * 100;
  $$(".sequence-playhead").forEach((playhead) => { playhead.style.left = `${progress}%`; });
  const currentStep = Math.min(15, Math.floor(tickInBar / (barTicks / 16)));
  $$(".sequence-step").forEach((step, index) => step.classList.toggle("current", index === currentStep));
  $("#sequencePosition").textContent = `BAR ${String(globalBar + 1).padStart(3, "0")} · STEP ${String(currentStep + 1).padStart(2, "0")}`;
}

function switchSet(index) {
  if (replayLocked()) return;
  if (index === activeSet) return;
  activeSet = index;
  timelineRecorder.chunk(index, sets[index].slots);
  $$(".set-button").forEach((button, buttonIndex) => button.classList.toggle("active", buttonIndex === index));
  renderSlots();
  saveSets();
  engine.preserveClockReschedule();
}

function beginTemporarySetSwitch(index, button) {
  if (heldSetOrigin != null || timelineRecorder.recording) return;
  endItemSoloHold();
  heldSetOrigin = activeSet;
  heldSetButton = button;
  button.classList.add("temporary-held");
  switchSet(index);
  setStatus(`SET HOLD: ${SET_NAMES[index]}`, engine.playing);
}

function endTemporarySetSwitch() {
  if (heldSetOrigin == null) return;
  const restoreSet = heldSetOrigin;
  heldSetOrigin = null;
  heldSetButton?.classList.remove("temporary-held");
  heldSetButton = null;
  switchSet(restoreSet);
  setStatus(engine.playing ? "演奏中" : "停止中", engine.playing);
}

function resetSets() {
  if (replayLocked() || timelineRecorder.recording) return;
  const confirmed = window.confirm("ア～クの8セットを初期設定に戻します。現在の登録内容は上書きされます。よろしいですか？");
  if (!confirmed) return;
  sets = makeDefaultSets();
  renderSlots();
  saveSets();
  engine.preserveClockReschedule();
  setStatus("8セットを初期設定に戻しました");
}

function randomizeActiveSet() {
  if (replayLocked() || timelineRecorder.recording) return;
  const set = sets[activeSet];
  for (const slot of set.slots) {
    if (slot.type === "single") {
      slot.category = Math.random() < 0.5 ? "B" : "H";
      const candidates = byCategory[slot.category];
      slot.item = candidates[Math.floor(Math.random() * candidates.length)].id;
    }
  }
  const shuffledS = [...byCategory.S];
  for (let index = shuffledS.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffledS[index], shuffledS[swapIndex]] = [shuffledS[swapIndex], shuffledS[index]];
  }
  set.slots[2].items = [shuffledS[0].id, shuffledS[1].id];
  set.slots[3].items = [shuffledS[2].id, shuffledS[3].id];
  renderSlots();
  saveSets();
  engine.preserveClockReschedule();
  setStatus(`セット「${SET_NAMES[activeSet]}」をランダム化しました`);
}

function updatePosition(tick) {
  const quarter = data.meta.ticksPerQuarter;
  const barTicks = quarter * 4;
  $("#barDisplay").textContent = String(Math.floor(tick / barTicks) + 1).padStart(3, "0");
  $("#beatDisplay").textContent = (1 + (tick % barTicks) / quarter).toFixed(2);
  const scale = engine.bpmTechScale / BPM_TECH_NORMAL;
  $("#bpmTechReadout").textContent = `×${scale.toFixed(2)} · ${Math.round(engine.effectiveBpm())} BPM`;
  renderSequence(tick);
}

function setStatus(text, playing = engine.playing) {
  $("#statusText").textContent = text;
  $("#statusLamp").classList.toggle("playing", playing);
}

function setReplayUiLocked(locked) {
  document.body.classList.toggle("replay-running", locked);
  $$(".set-section button, .set-section select, .slots-section button, .slots-section select, .tech-section button")
    .forEach((control) => { control.disabled = locked; });
  $$(".replay-choice").forEach((button) => { button.disabled = locked; });
}

function renderReplayIndicators() {
  if (timelinePlayer.running) {
    const setIndex = timelinePlayer.displaySetIndex();
    const active = timelinePlayer.activeTech();
    $$(".set-button").forEach((button, index) => {
      button.classList.toggle("active", index === setIndex);
      button.classList.remove("replay-target");
    });
    for (const tech of REPLAY_TECHS) {
      const control = tech.selector ? $(tech.selector) : null;
      control?.classList.toggle("replay-selected", tech.name === active?.name);
      control?.classList.toggle("replay-active", tech.name === active?.name);
    }
    return;
  }
  $$(".set-button").forEach((button, index) => {
    button.classList.toggle("active", index === activeSet);
    button.classList.remove("replay-target");
  });
  for (const tech of REPLAY_TECHS) {
    const control = tech.selector ? $(tech.selector) : null;
    control?.classList.remove("replay-selected", "replay-active");
  }
}

async function loadReplayDefinition(definition) {
  const response = await fetch(definition.path);
  if (!response.ok) throw new Error(`${definition.path}: HTTP ${response.status}`);
  return parseReplay(await response.arrayBuffer(), data, definition.id);
}

const bundledTimelines = new Map();
const convertedTimelines = new Map();

// Playback uses the bundled, hand-adjusted gj6-timeline files.
async function loadReplayTimeline(definition) {
  if (!bundledTimelines.has(definition.id)) {
    const response = await fetch(definition.timelinePath);
    if (!response.ok) throw new Error(`${definition.timelinePath}: HTTP ${response.status}`);
    const timeline = await response.json();
    const { ok, errors } = validateTimeline(timeline, itemMap);
    if (!ok) throw new Error(errors[0]);
    bundledTimelines.set(definition.id, {
      replayTitle: timeline.meta.title ?? definition.id,
      timeline,
    });
  }
  return bundledTimelines.get(definition.id);
}

// The original DENR pad stream stays available as a conversion source
// (also used for user save files imported through the editor).
async function loadConvertedReplayTimeline(definition) {
  if (!convertedTimelines.has(definition.id)) {
    const replay = await loadReplayDefinition(definition);
    convertedTimelines.set(definition.id, {
      replayTitle: replay.title,
      timeline: convertReplayToTimeline(replay),
    });
  }
  return convertedTimelines.get(definition.id);
}

async function togglePlay() {
  if (timelinePlayer.running) {
    timelinePlayer.stop("リプレイを停止しました");
    return;
  }
  const button = $("#playButton");
  if (engine.playing) {
    const wasRecording = timelineRecorder.recording;
    finishRecordingIfActive();
    engine.stop();
    button.textContent = "▶ PLAY";
    button.classList.remove("stop");
    setStatus(wasRecording ? "収録を終了し、エディタに展開しました" : "停止中", false);
    return;
  }
  button.disabled = true;
  try {
    await engine.initialize((message) => setStatus(message, false));
    if (timelineRecorder.armed) engine.pausedTick = 0;
    await engine.start();
    if (timelineRecorder.armed) {
      timelineRecorder.begin({
        sets,
        activeSet,
        bpm: engine.bpm,
        techSettings: {
          stb: engine.stbSetting,
          flsh: engine.flshSetting,
          mrg: engine.mrgSetting,
          fill: engine.fillSetting,
          arp: engine.arpSetting,
        },
      });
      setStatus("収録中…", true);
    }
    button.textContent = "■ STOP";
    button.classList.add("stop");
    if (!timelineRecorder.recording) setStatus("演奏中", true);
  } catch (error) {
    console.error(error);
    setStatus(`読込エラー: ${error.message}`, false);
  } finally {
    button.disabled = false;
  }
}

const timelineEditor = createTimelineEditor({
  player: timelinePlayer,
  recorder: timelineRecorder,
  itemMap,
  setStatus,
  presetIds: REPLAY_DEFINITIONS.map((definition) => definition.id),
  getPresetTimeline: async (id) => {
    const definition = REPLAY_DEFINITIONS.find((candidate) => candidate.id === id);
    const { timeline } = await loadReplayTimeline(definition);
    return timeline;
  },
  getOriginalDenrTimeline: async (id) => {
    const definition = REPLAY_DEFINITIONS.find((candidate) => candidate.id === id);
    const { timeline } = await loadConvertedReplayTimeline(definition);
    return timeline;
  },
  convertDenrBuffer: (arrayBuffer, name) => (
    convertReplayToTimeline(parseReplay(arrayBuffer, data, name))
  ),
  onLoaded: (timeline) => {
    // Overwrite the 8-set chunk bank with the loaded timeline's sets so the
    // slot UI / manual performance match the loaded data.
    sets = timeline.sets.map((definition) => (
      timelineSetToSlots(definition, [true, true, true, true, true, true])
    ));
    saveSets();
    renderSlots();
    renderReplayIndicators();
    if (engine.playing && !timelinePlayer.running) engine.preserveClockReschedule();
  },
});
onRecordingFinished = (recorded) => timelineEditor.load(recorded);

buildSetButtons();
buildSlots();
buildSequenceRuler();
switchSet(0);
$(".set-button").classList.add("active");
renderSlots();
updatePosition(0);
setStatus("停止中", false);

$("#playButton").addEventListener("click", togglePlay);
$("#cueButton").addEventListener("click", () => engine.cue());
$("#resetSetsButton").addEventListener("click", resetSets);
$("#randomizeSetButton").addEventListener("click", randomizeActiveSet);
$("#closeItemPicker").addEventListener("click", () => $("#itemPickerDialog").close());
$("#itemPickerSearch").addEventListener("input", (event) => {
  if (!itemPickerState) return;
  itemPickerState.query = event.target.value;
  renderItemPickerItems();
});
$("#itemPickerDialog").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});
$("#itemPickerDialog").addEventListener("close", () => {
  endItemSoloHold();
  previewRequest += 1;
  if (engine.context) engine.cancelPreviewSources(engine.context.currentTime + 0.01);
  setStatus(engine.playing ? "演奏中" : "停止中", engine.playing);
  itemPickerState = null;
});
window.addEventListener("mouseup", (event) => {
  if (event.button !== 1) return;
  endItemSoloHold();
  endTemporarySetSwitch();
});
window.addEventListener("blur", () => {
  endItemSoloHold();
  endTemporarySetSwitch();
});
$("#bpmInput").addEventListener("input", (event) => {
  if (timelineRecorder.recording) {
    event.target.value = String(engine.bpm);
    setStatus("収録中はBPMを変更できません", true);
    return;
  }
  $("#bpmOutput").textContent = event.target.value;
  engine.setBpm(event.target.value);
});
$("#masterVolume").addEventListener("input", (event) => engine.setMaster(Number(event.target.value) / 100));

const TECH_DIRECTION_LABELS = ["←", "↓", "→", "↑"];
const ORIGINAL_TECH_CONTROL_ORDER = [
  ".delay-tech-control",
  ".mod-tech-control",
  ".reverb-tech-control",
  ".bpm-tech-control",
  ".stb-tech-control",
  ".arp-tech-control",
  ".flsh-tech-control",
  ".int-tech-control",
  ".fill-tech-control",
  ".mrg-tech-control",
];

const techControlGrid = $(".tech-buttons");
for (const selector of ORIGINAL_TECH_CONTROL_ORDER) {
  const control = $(selector, techControlGrid);
  if (control) techControlGrid.append(control);
}

function buildTechSettingMatrix(name, settingCount, titleFor) {
  const matrix = $(`.${name}-pattern-matrix`);
  if (!matrix) return;
  const fragment = document.createDocumentFragment();
  for (let setting = 0; setting < settingCount; setting += 1) {
    for (let variant = 0; variant < TECH_DIRECTION_LABELS.length; variant += 1) {
      const direction = TECH_DIRECTION_LABELS[variant];
      const button = document.createElement("button");
      button.className = `${name}-trigger-button`;
      button.type = "button";
      button.dataset[`${name}Setting`] = String(setting);
      button.dataset[`${name}Variant`] = String(variant);
      button.textContent = `${String(setting + 1).padStart(2, "0")}${direction}`;
      button.title = titleFor(setting, variant, direction);
      button.setAttribute("aria-pressed", "false");
      fragment.append(button);
    }
  }
  matrix.replaceChildren(fragment);
  matrix.setAttribute(
    "aria-label",
    `${name.toUpperCase()} ${settingCount} settings × 4 directions`,
  );
}

buildTechSettingMatrix("stb", data.stb.settings.length, (setting, variant, direction) => {
  const row = data.stb.settings[setting];
  return `STB ${setting + 1}${direction}: Program ${row.program} / Note ${row.voices[variant].note}`;
});

buildTechSettingMatrix("arp", data.arp.patterns.length, (setting, variant, direction) => {
  const pattern = data.arp.patterns[setting];
  const programOffset = data.arp.directionProgramOffsets[variant];
  const program = data.arp.variants[pattern.programGroup * 4 + programOffset].program;
  return `ARP ${setting + 1}${direction}: Program ${program} / ${pattern.events.length} notes / ${pattern.ticks} ticks`;
});

buildTechSettingMatrix("flsh", data.flsh.settings.length, (setting, variant, direction) => (
  `FLSH ${setting + 1}${direction}: Program ${data.flsh.settings[setting].program} / ${data.flsh.intervals[variant]} ticks`
));

buildTechSettingMatrix("mrg", data.mrg.settings.length, (setting, variant, direction) => (
  `MRG ${setting + 1}${direction}: Program ${data.mrg.settings[setting].program} / Note ${data.mrg.notes[variant]}`
));

$$('.tech-button').forEach((button) => {
  const name = button.dataset.tech;
  const momentary = button.closest(".tech-control")?.classList.contains("momentary");
  if (!momentary) {
    button.addEventListener("click", () => {
      const enabled = !engine.tech[name];
      engine.setTech(name, enabled);
      timelineRecorder.techHold(name, currentTechSetting(name), engine.techVariant[name], enabled);
      button.classList.toggle("active", enabled);
      button.setAttribute("aria-pressed", String(enabled));
    });
    return;
  }

  let held = false;
  const setHeld = (enabled) => {
    if (held === enabled) return;
    held = enabled;
    engine.setTech(name, enabled);
    timelineRecorder.techHold(name, currentTechSetting(name), engine.techVariant[name], enabled);
    button.classList.toggle("active", enabled);
    button.setAttribute("aria-pressed", String(enabled));
    setStatus(enabled ? `TECH ${name.toUpperCase()} 発動中` : (engine.playing ? "演奏中" : "停止中"), enabled || engine.playing);
  };

  button.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    setHeld(true);
  });
  const releasePointer = (event) => {
    if (event.pointerId != null && button.hasPointerCapture(event.pointerId)) {
      button.releasePointerCapture(event.pointerId);
    }
    setHeld(false);
  };
  button.addEventListener("pointerup", releasePointer);
  button.addEventListener("pointercancel", releasePointer);
  button.addEventListener("lostpointercapture", () => setHeld(false));
  button.addEventListener("keydown", (event) => {
    if (!["Space", "Enter"].includes(event.code)) return;
    event.preventDefault();
    if (!event.repeat) setHeld(true);
  });
  button.addEventListener("keyup", (event) => {
    if (!["Space", "Enter"].includes(event.code)) return;
    event.preventDefault();
    setHeld(false);
  });
  button.addEventListener("blur", () => setHeld(false));
  button.addEventListener("click", (event) => event.preventDefault());
});

function bindDirectTechButtons(selector, techName, configure, statusText) {
  let activeButton = null;
  const datasetPrefix = techName === "interrupt" ? "int" : techName;
  const recordHold = (button, enabled) => {
    timelineRecorder.techHold(
      techName,
      Number(button.dataset[`${datasetPrefix}Setting`] ?? currentTechSetting(techName)),
      Number(button.dataset[`${datasetPrefix}Variant`] ?? 0),
      enabled,
    );
  };
  $$(selector).forEach((button) => {
    let held = false;
    const setHeld = (enabled) => {
      if (held === enabled) return;
      held = enabled;
      if (enabled) {
        if (activeButton && activeButton !== button) {
          activeButton.classList.remove("active");
          activeButton.setAttribute("aria-pressed", "false");
        }
        activeButton = button;
        configure(button);
        engine.setTech(techName, true);
        recordHold(button, true);
        updatePosition(engine.context && engine.playing
          ? Math.max(0, engine.tickAtTime(engine.context.currentTime))
          : engine.pausedTick);
        button.classList.add("active");
        button.setAttribute("aria-pressed", "true");
        setStatus(statusText(button), true);
      } else {
        button.classList.remove("active");
        button.setAttribute("aria-pressed", "false");
        if (activeButton === button) {
          activeButton = null;
          engine.setTech(techName, false);
          recordHold(button, false);
          updatePosition(engine.context && engine.playing
            ? Math.max(0, engine.tickAtTime(engine.context.currentTime))
            : engine.pausedTick);
          setStatus(engine.playing ? "演奏中" : "停止中", engine.playing);
        }
      }
    };

    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      setHeld(true);
    });
    const releasePointer = (event) => {
      if (event.pointerId != null && button.hasPointerCapture(event.pointerId)) {
        button.releasePointerCapture(event.pointerId);
      }
      setHeld(false);
    };
    button.addEventListener("pointerup", releasePointer);
    button.addEventListener("pointercancel", releasePointer);
    button.addEventListener("lostpointercapture", () => setHeld(false));
    button.addEventListener("keydown", (event) => {
      if (!["Space", "Enter"].includes(event.code)) return;
      event.preventDefault();
      if (!event.repeat) setHeld(true);
    });
    button.addEventListener("keyup", (event) => {
      if (!["Space", "Enter"].includes(event.code)) return;
      event.preventDefault();
      setHeld(false);
    });
    button.addEventListener("blur", () => setHeld(false));
    button.addEventListener("click", (event) => event.preventDefault());
  });
}

bindDirectTechButtons(
  ".delay-trigger-button",
  "delay",
  (button) => engine.setTechVariant("delay", button.dataset.delayVariant),
  (button) => `DLY ${Number(button.dataset.delayVariant) + 1} 発動中`,
);

bindDirectTechButtons(
  ".mod-trigger-button",
  "mod",
  (button) => engine.setTechVariant("mod", button.dataset.modVariant),
  (button) => `MOD ${TECH_DIRECTION_LABELS[Number(button.dataset.modVariant)]} 発動中`,
);

bindDirectTechButtons(
  ".bpm-trigger-button",
  "bpm",
  (button) => engine.setTechVariant("bpm", button.dataset.bpmVariant),
  (button) => `BPM ${BPM_TECH_STEPS[Number(button.dataset.bpmVariant)] > 0 ? "FAST" : "SLOW"} ${Math.abs(BPM_TECH_STEPS[Number(button.dataset.bpmVariant)])} 発動中`,
);

bindDirectTechButtons(
  ".reverb-trigger-button",
  "reverb",
  (button) => engine.setTechVariant("reverb", button.dataset.reverbVariant),
  (button) => `REV ${Number(button.dataset.reverbVariant) + 1} 発動中`,
);

bindDirectTechButtons(
  ".int-trigger-button",
  "interrupt",
  (button) => engine.setTechVariant("interrupt", button.dataset.intVariant),
  (button) => `INT ${Number(button.dataset.intVariant) + 1} 発動中`,
);

bindDirectTechButtons(
  ".stb-trigger-button",
  "stb",
  (button) => engine.setStbPattern(button.dataset.stbSetting, button.dataset.stbVariant),
  (button) => `STB ${Number(button.dataset.stbSetting) + 1}-${Number(button.dataset.stbVariant) + 1} 発動中`,
);

bindDirectTechButtons(
  ".arp-trigger-button",
  "arp",
  (button) => engine.setArpPattern(button.dataset.arpSetting, button.dataset.arpVariant),
  (button) => `ARP ${Number(button.dataset.arpSetting) + 1}-${Number(button.dataset.arpVariant) + 1} 発動中`,
);

bindDirectTechButtons(
  ".flsh-trigger-button",
  "flsh",
  (button) => engine.setFlshPattern(button.dataset.flshSetting, button.dataset.flshVariant),
  (button) => `FLSH ${Number(button.dataset.flshSetting) + 1}-${Number(button.dataset.flshVariant) + 1} 発動中`,
);

bindDirectTechButtons(
  ".mrg-trigger-button",
  "mrg",
  (button) => engine.setMrgPattern(button.dataset.mrgSetting, button.dataset.mrgVariant),
  (button) => `MRG ${Number(button.dataset.mrgSetting) + 1}-${Number(button.dataset.mrgVariant) + 1} 発動中`,
);

bindDirectTechButtons(
  ".fill-trigger-button",
  "fill",
  (button) => engine.setFillPattern(button.dataset.fillSetting, button.dataset.fillVariant),
  (button) => `FIL ${Number(button.dataset.fillSetting) + 1}-${Number(button.dataset.fillVariant) + 1} 発動中`,
);

window.addEventListener("keydown", (event) => {
  if (event.defaultPrevented) return;
  if ($("#itemPickerDialog").open) return;
  const activeElement = document.activeElement;
  if (["SELECT", "INPUT", "TEXTAREA"].includes(activeElement?.tagName)) return;
  if (activeElement?.isContentEditable || event.isComposing) return;
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;

  const slotIndex = SLOT_SHORTCUTS.findIndex((shortcut) => shortcut.code === event.code);
  if (slotIndex >= 0) {
    event.preventDefault();
    toggleSlotEnabled(slotIndex);
  } else if (activeElement?.tagName === "BUTTON") {
    return;
  } else if (event.code === "Space") {
    event.preventDefault();
    togglePlay();
  } else if (event.key === "0") {
    engine.cue();
  } else if (/^[1-8]$/.test(event.key)) {
    switchSet(Number(event.key) - 1);
  }
});
