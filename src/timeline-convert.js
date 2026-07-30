// DENR pad-stream -> gj6-timeline converter.
//
// Walks the replay at 60 Hz exactly like the PSX driver: selection cursors
// with the 8-frame repeat, single-slot pending cue/change requests, the fill
// retrigger chain (simulated so the musical origin stays correct, but only
// the hold interval is emitted), and the Q7 BPM-tech tick integration.
// Cue/change execution ticks are quantized with the same formula the engine
// uses and baked into the output; the timeline player never re-quantizes.
// Pure module: importable from Node for verification.
import { PAD, REPLAY_FPS } from "./replay.js";
import {
  BAR_TICKS,
  BPM_TECH_MAX,
  BPM_TECH_MIN,
  BPM_TECH_NORMAL,
  BPM_TECH_STEPS,
  CUE_IMMEDIATE_WINDOW_TICKS,
  CUE_QUANTIZE_TICKS,
  FILL_PATTERNS,
  REPLAY_DIRECTION_CALLBACKS,
  REPLAY_DIRECTION_REPEAT_FRAMES,
  REPLAY_SHOULDER_BITS,
  REPLAY_TECHS,
  REPLAY_TECH_DIRECTIONS,
  TICKS_PER_QUARTER,
} from "./constants.js";
import { createLaneIntervalBuilder, createTimeline, laneFlagsOfSlots, normalizeTimeline } from "./timeline.js";

const STEP_HZ = 60;
const EPSILON = 1e-6;

function cloneSlots(set) {
  return {
    slots: set.slots.map((slot) => (
      slot.type === "single"
        ? { ...slot }
        : { ...slot, itemEnabled: [...slot.itemEnabled], items: [...slot.items] }
    )),
  };
}

function timelineSets(replaySets) {
  return replaySets.map((set) => ({
    L1: { category: set.slots[0].category, item: set.slots[0].item },
    L2: { category: set.slots[1].category, item: set.slots[1].item },
    R1: [...set.slots[2].items],
    R2: [...set.slots[3].items],
  }));
}

export function convertReplayToTimeline(replay) {
  const tpsBase = (replay.bpm / 60) * TICKS_PER_QUARTER;
  const frameCount = replay.frameCount;
  const totalSteps = Math.round((frameCount / REPLAY_FPS) * STEP_HZ);

  const setStates = replay.sets.map(cloneSlots);
  const chunkSlots = [...replay.chunkSlots];
  let chunkSelector = replay.chunkSelector;
  let liveSetIndex = chunkSlots[chunkSelector];
  let selectedTech = replay.selectedTech;
  const counters = { [PAD.UP]: 0, [PAD.DOWN]: 0, [PAD.RIGHT]: 0, [PAD.LEFT]: 0 };

  let T = 0;                 // cumulative performance ticks
  let originT = 0;           // T at last seek
  let originTick = 0;        // musical tick at last seek
  let scale = BPM_TECH_NORMAL;
  let bpmStep = null;
  let bpmLastMagnitude = 3;

  const musicalNow = () => originTick + (T - originT);
  const quantizeRequest = () => {
    const inputTick = Math.max(0, musicalNow());
    const requestTick = Math.ceil(inputTick - 1e-9);
    const phase = requestTick % CUE_QUANTIZE_TICKS;
    const targetTick = phase < CUE_IMMEDIATE_WINDOW_TICKS
      ? requestTick
      : requestTick + CUE_QUANTIZE_TICKS - phase;
    return T + (targetTick - inputTick);   // perf tick of execution
  };

  let pendingCue = null;     // perf tick
  let pendingSwap = null;    // perf tick
  let fill = null;           // {barStart, next, pattern, index, aligning}
  let openHold = null;       // {name, variant, setting, startT}

  const timeline = createTimeline(
    {
      id: replay.id,
      title: replay.title,
      bpm: replay.bpm,
      ticksPerQuarter: TICKS_PER_QUARTER,
      durationTicks: 0,
      durationSeconds: frameCount / REPLAY_FPS,
      techSettings: { ...replay.techSettings },
    },
    timelineSets(replay.sets),
  );
  timeline.chunks = [{ at: 0, set: liveSetIndex }];
  const laneBuilder = createLaneIntervalBuilder(
    laneFlagsOfSlots(setStates[liveSetIndex].slots),
    0,
  );

  const settingFor = (name) => replay.techSettings?.[name] ?? 0;
  const closeHold = () => {
    if (!openHold) return;
    timeline.techs.push({
      name: openHold.name,
      variant: openHold.variant,
      setting: openHold.setting,
      start: openHold.startT,
      end: T,
    });
    if (openHold.name === "fill") fill = null;
    if (openHold.name === "bpm") bpmStep = null;
    openHold = null;
  };

  const processDueSeeks = () => {
    // Execute pending requests / fill retrigs whose perf tick has passed,
    // in perf order, exactly as the driver would.
    for (;;) {
      const candidates = [];
      if (pendingSwap != null && pendingSwap <= T + EPSILON) candidates.push(["swap", pendingSwap]);
      if (pendingCue != null && pendingCue <= T + EPSILON) candidates.push(["cue", pendingCue]);
      if (fill?.next != null && fill.next <= T + EPSILON) candidates.push(["fill", fill.next]);
      if (!candidates.length) return;
      candidates.sort((a, b) => a[1] - b[1]);
      const [kind, at] = candidates[0];
      if (kind === "swap") {
        pendingSwap = null;
        if (chunkSlots[0] !== chunkSlots[1]) {
          chunkSelector ^= 1;
          liveSetIndex = chunkSlots[chunkSelector];
          timeline.chunks.push({ at, set: liveSetIndex });
          laneBuilder.update(at, laneFlagsOfSlots(setStates[liveSetIndex].slots));
        }
      } else if (kind === "cue") {
        pendingCue = null;
        timeline.cues.push(at);
        originT = at;
        originTick = 0;
      } else {
        originT = at;
        originTick = fill.barStart;
        if (fill.aligning) { fill.index = 0; fill.aligning = false; }
        else fill.index = (fill.index + 1) % fill.pattern.length;
        fill.next = at + fill.pattern[fill.index];
      }
    }
  };

  let prevMask = 0;
  let lastFrame = -1;
  for (let step = 0; step < totalSteps; step += 1) {
    processDueSeeks();
    const frame = Math.min(frameCount - 1, Math.floor((step / STEP_HZ) * REPLAY_FPS));
    if (frame !== lastFrame) {
      lastFrame = frame;
      const mask = replay.frames[frame];
      const rising = (bit) => (mask & bit) && !(prevMask & bit);

      let lanesChanged = false;
      REPLAY_SHOULDER_BITS.forEach((bit, slotIndex) => {
        if (!rising(bit)) return;
        const slot = setStates[liveSetIndex].slots[slotIndex];
        if (slot.type === "single") slot.enabled = !slot.enabled;
        else {
          slot.itemEnabled = slot.itemEnabled.map((enabled) => !enabled);
          slot.enabled = slot.itemEnabled.some(Boolean);
        }
        lanesChanged = true;
      });
      if (lanesChanged) {
        laneBuilder.update(T, laneFlagsOfSlots(setStates[liveSetIndex].slots));
      }

      const fired = [];
      for (const direction of REPLAY_DIRECTION_CALLBACKS) {
        if (mask & direction.bit) {
          if (counters[direction.bit] % REPLAY_DIRECTION_REPEAT_FRAMES === 0) fired.push(direction);
          counters[direction.bit] += 1;
        } else counters[direction.bit] = 0;
      }
      if (mask & PAD.SQUARE) {
        for (const { selection, delta } of fired) {
          if (selection === "tech") selectedTech = (selectedTech + delta + 10) % 10;
          else chunkSlots[chunkSelector ^ 1] = (chunkSlots[chunkSelector ^ 1] + delta + 8) % 8;
        }
      }
      if (rising(PAD.CIRCLE) && pendingCue == null) pendingCue = quantizeRequest();
      if (rising(PAD.CROSS) && pendingSwap == null) pendingSwap = quantizeRequest();

      const squareHeld = Boolean(mask & PAD.SQUARE);
      const activeDirections = squareHeld
        ? []
        : REPLAY_TECH_DIRECTIONS.filter(({ bit }) => mask & bit);
      if (activeDirections.length === 0) {
        closeHold();
      } else {
        const newly = activeDirections.filter(({ bit }) => !(prevMask & bit));
        if (newly.length > 0) {
          const variant = newly.at(-1).variant;
          const name = REPLAY_TECHS[selectedTech].name;
          if (openHold && (openHold.name !== name || openHold.variant !== variant)) closeHold();
          if (!openHold) {
            openHold = { name, variant, setting: settingFor(name), startT: T };
            if (name === "fill") {
              const musical = Math.max(0, musicalNow());
              const firstMusical = Math.ceil((musical - 1e-9) / CUE_QUANTIZE_TICKS) * CUE_QUANTIZE_TICKS;
              fill = {
                barStart: Math.floor(firstMusical / BAR_TICKS) * BAR_TICKS,
                next: T + (firstMusical - musical),
                pattern: FILL_PATTERNS[Math.max(0, Math.min(3, settingFor("fill")))][variant],
                index: 0,
                aligning: true,
              };
            }
            if (name === "bpm") {
              bpmStep = BPM_TECH_STEPS[variant];
              bpmLastMagnitude = Math.abs(BPM_TECH_STEPS[variant]);
            }
          }
        }
      }
      prevMask = mask;
    }

    if (bpmStep != null) {
      scale = Math.max(BPM_TECH_MIN, Math.min(BPM_TECH_MAX, scale + bpmStep));
    } else if (scale !== BPM_TECH_NORMAL) {
      const rate = bpmLastMagnitude * 2;
      scale = scale < BPM_TECH_NORMAL
        ? Math.min(BPM_TECH_NORMAL, scale + rate)
        : Math.max(BPM_TECH_NORMAL, scale - rate);
    }
    T += (tpsBase * (scale / BPM_TECH_NORMAL)) / STEP_HZ;
  }
  processDueSeeks();
  closeHold();

  timeline.meta.durationTicks = T;
  timeline.lanes = laneBuilder.finish(T);
  return normalizeTimeline(timeline);
}
