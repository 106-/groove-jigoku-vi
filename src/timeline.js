// Stateless replay timeline (gj6-timeline v1): schema helpers, the
// performance-tick <-> musical-tick seek map, state derivation at an
// arbitrary tick, and the flattened dispatch list for the player.
//
// The timeline axis is "performance ticks": cumulative driver ticks since
// the performance start.  The engine's musical tick rewinds on cue (to 0)
// and on each fill retrigger (to the frozen bar start); the seek map
// captures those rewinds as piecewise offsets (offset = perf - musical).
// Pure module: no DOM, importable from Node.
import {
  BAR_TICKS,
  CUE_QUANTIZE_TICKS,
  FILL_PATTERNS,
  LANE_KEYS,
  REPLAY_TECHS,
  TECH_SETTING_NAMES,
} from "./constants.js";

export const TIMELINE_FORMAT = "gj6-timeline";
export const TIMELINE_VERSION = 1;

const EPSILON = 1e-6;
const TECH_NAME_SET = new Set(REPLAY_TECHS.map((tech) => tech.name));

export function resolveTechSetting(timeline, interval) {
  return interval.setting
    ?? timeline.meta?.techSettings?.[interval.name]
    ?? 0;
}

export function laneFlagsOfSlots(slots) {
  // slots: the app's 4-slot set state -> six audible lane booleans.
  return [
    slots[0].enabled,
    slots[1].enabled,
    slots[2].enabled && slots[2].itemEnabled[0],
    slots[2].enabled && slots[2].itemEnabled[1],
    slots[3].enabled && slots[3].itemEnabled[0],
    slots[3].enabled && slots[3].itemEnabled[1],
  ];
}

export function timelineSetToSlots(setDefinition, laneFlags) {
  // Build the app's slot-state shape from a timeline set + lane booleans.
  return {
    slots: [
      {
        key: "L1", type: "single", enabled: Boolean(laneFlags[0]),
        category: setDefinition.L1.category, item: setDefinition.L1.item,
      },
      {
        key: "L2", type: "single", enabled: Boolean(laneFlags[1]),
        category: setDefinition.L2.category, item: setDefinition.L2.item,
      },
      {
        key: "R1", type: "pair",
        enabled: Boolean(laneFlags[2] || laneFlags[3]),
        itemEnabled: [Boolean(laneFlags[2]), Boolean(laneFlags[3])],
        items: [...setDefinition.R1],
      },
      {
        key: "R2", type: "pair",
        enabled: Boolean(laneFlags[4] || laneFlags[5]),
        itemEnabled: [Boolean(laneFlags[4]), Boolean(laneFlags[5])],
        items: [...setDefinition.R2],
      },
    ],
  };
}

export function createLaneIntervalBuilder(initialFlags, startTick = 0) {
  const lanes = Object.fromEntries(LANE_KEYS.map((key) => [key, []]));
  const openSince = new Map();
  LANE_KEYS.forEach((key, index) => {
    if (initialFlags[index]) openSince.set(key, startTick);
  });
  return {
    update(tick, flags) {
      LANE_KEYS.forEach((key, index) => {
        const on = Boolean(flags[index]);
        if (on && !openSince.has(key)) openSince.set(key, tick);
        if (!on && openSince.has(key)) {
          const from = openSince.get(key);
          openSince.delete(key);
          if (tick - from > EPSILON) lanes[key].push([from, tick]);
        }
      });
    },
    finish(tick) {
      for (const [key, from] of openSince) {
        if (tick - from > EPSILON) lanes[key].push([from, tick]);
      }
      openSince.clear();
      return lanes;
    },
  };
}

export function createTimeline(meta, sets) {
  return {
    format: TIMELINE_FORMAT,
    version: TIMELINE_VERSION,
    meta,
    sets,
    chunks: [{ at: 0, set: 0 }],
    lanes: Object.fromEntries(LANE_KEYS.map((key) => [key, []])),
    cues: [],
    techs: [],
  };
}

export function validateTimeline(timeline, itemMap = null) {
  const errors = [];
  const push = (message) => errors.push(message);
  if (timeline?.format !== TIMELINE_FORMAT) push(`format が ${TIMELINE_FORMAT} ではありません`);
  if (timeline?.version !== TIMELINE_VERSION) push(`version が ${TIMELINE_VERSION} ではありません`);
  const meta = timeline?.meta;
  if (!meta || !Number.isFinite(meta.bpm) || meta.bpm <= 0) push("meta.bpm が不正です");
  if (!Number.isFinite(meta?.durationTicks) || meta.durationTicks <= 0) push("meta.durationTicks が不正です");
  const duration = meta?.durationTicks ?? 0;
  const tickOk = (value) => Number.isFinite(value) && value >= 0 && value <= duration + EPSILON;

  if (!Array.isArray(timeline?.sets) || timeline.sets.length !== 8) {
    push("sets は8要素の配列である必要があります");
  } else {
    timeline.sets.forEach((set, index) => {
      const single = (slot) => slot && typeof slot.item === "string" && typeof slot.category === "string";
      const pair = (items) => Array.isArray(items) && items.length === 2 && items.every((id) => typeof id === "string");
      if (!single(set?.L1) || !single(set?.L2) || !pair(set?.R1) || !pair(set?.R2)) {
        push(`sets[${index}] の形式が不正です`);
        return;
      }
      if (itemMap) {
        for (const id of [set.L1.item, set.L2.item, ...set.R1, ...set.R2]) {
          if (!itemMap.has(id)) push(`sets[${index}] の音ネタ ${id} がカタログにありません`);
        }
      }
    });
  }

  if (!Array.isArray(timeline?.chunks) || timeline.chunks.length === 0) {
    push("chunks が空です");
  } else {
    if (Math.abs(timeline.chunks[0].at) > EPSILON) push("chunks の先頭は at:0 である必要があります");
    timeline.chunks.forEach((chunk, index) => {
      if (!tickOk(chunk.at) || !Number.isInteger(chunk.set) || chunk.set < 0 || chunk.set > 7) {
        push(`chunks[${index}] が不正です`);
      }
    });
  }

  for (const key of LANE_KEYS) {
    const intervals = timeline?.lanes?.[key];
    if (!Array.isArray(intervals)) { push(`lanes.${key} がありません`); continue; }
    intervals.forEach(([from, to], index) => {
      if (!tickOk(from) || !tickOk(to) || to - from <= EPSILON) push(`lanes.${key}[${index}] が不正です`);
    });
  }

  if (!Array.isArray(timeline?.cues)) push("cues がありません");
  else timeline.cues.forEach((tick, index) => { if (!tickOk(tick)) push(`cues[${index}] が不正です`); });

  if (!Array.isArray(timeline?.techs)) push("techs がありません");
  else {
    timeline.techs.forEach((tech, index) => {
      if (!TECH_NAME_SET.has(tech?.name)) push(`techs[${index}].name が不正です`);
      if (!Number.isInteger(tech?.variant) || tech.variant < 0 || tech.variant > 3) push(`techs[${index}].variant が不正です`);
      if (!tickOk(tech?.start) || !tickOk(tech?.end) || tech.end - tech.start <= EPSILON) push(`techs[${index}] の区間が不正です`);
    });
  }
  return { ok: errors.length === 0, errors };
}

export function normalizeTimeline(timeline) {
  // Mutates entries in place (preserving object identity so an editor's
  // selection can survive a normalize pass), then rebuilds the arrays.
  const duration = timeline.meta.durationTicks;
  const clamp = (value) => Math.max(0, Math.min(duration, value));

  const chunkByTick = new Map();
  for (const chunk of [...timeline.chunks].sort((a, b) => a.at - b.at)) {
    chunk.at = clamp(chunk.at);
    chunkByTick.set(Math.round(chunk.at * 1e6), chunk);
  }
  timeline.chunks = [...chunkByTick.values()].sort((a, b) => a.at - b.at);
  if (!timeline.chunks.length || timeline.chunks[0].at > EPSILON) {
    timeline.chunks.unshift({ at: 0, set: timeline.chunks[0]?.set ?? 0 });
  } else {
    timeline.chunks[0].at = 0;
  }

  for (const key of LANE_KEYS) {
    const merged = [];
    const sorted = (timeline.lanes[key] ?? [])
      .map((interval) => {
        const from = clamp(Math.min(interval[0], interval[1]));
        const to = clamp(Math.max(interval[0], interval[1]));
        interval[0] = from;
        interval[1] = to;
        return interval;
      })
      .filter((interval) => interval[1] - interval[0] > EPSILON)
      .sort((a, b) => a[0] - b[0]);
    for (const interval of sorted) {
      const last = merged[merged.length - 1];
      if (last && interval[0] <= last[1] + EPSILON) last[1] = Math.max(last[1], interval[1]);
      else merged.push(interval);
    }
    timeline.lanes[key] = merged;
  }

  timeline.cues = [...new Set(timeline.cues.map((tick) => Math.round(clamp(tick) * 1e6) / 1e6))]
    .sort((a, b) => a - b);

  for (const tech of timeline.techs) {
    tech.start = clamp(tech.start);
    tech.end = clamp(tech.end);
  }
  timeline.techs = timeline.techs
    .filter((tech) => tech.end - tech.start > EPSILON)
    .sort((a, b) => a.start - b.start || (a.name < b.name ? -1 : 1));
  // Same-name intervals must never overlap: truncate the earlier one.
  const lastByName = new Map();
  for (const tech of timeline.techs) {
    const previous = lastByName.get(tech.name);
    if (previous && previous.end > tech.start + EPSILON) previous.end = tech.start;
    lastByName.set(tech.name, tech);
  }
  timeline.techs = timeline.techs.filter((tech) => tech.end - tech.start > EPSILON);
  return timeline;
}

export function compileSeekMap(timeline) {
  const segments = [{ fromPerf: 0, offset: 0 }];
  const fillChains = [];
  let offset = 0;
  const cues = [...timeline.cues].sort((a, b) => a - b);
  const fills = timeline.techs
    .filter((tech) => tech.name === "fill")
    .sort((a, b) => a.start - b.start);
  let cueIndex = 0;
  const applyCuesThrough = (perf) => {
    while (cueIndex < cues.length && cues[cueIndex] <= perf + EPSILON) {
      offset = cues[cueIndex];
      segments.push({ fromPerf: cues[cueIndex], offset });
      cueIndex += 1;
    }
  };

  for (const fill of fills) {
    applyCuesThrough(fill.start - EPSILON);
    const setting = resolveTechSetting(timeline, fill);
    const pattern = FILL_PATTERNS[Math.max(0, Math.min(3, setting))][fill.variant] ?? [24];
    const musicalAtStart = fill.start - offset;
    const firstMusical = Math.ceil((musicalAtStart - 1e-9) / CUE_QUANTIZE_TICKS) * CUE_QUANTIZE_TICKS;
    const barStart = Math.floor(firstMusical / BAR_TICKS) * BAR_TICKS;
    const chain = {
      start: fill.start,
      end: fill.end,
      barStart,
      pattern,
      retrigs: [],
    };
    let retrigPerf = fill.start + (firstMusical - musicalAtStart);
    let index = 0;
    let aligning = true;
    while (retrigPerf < fill.end - EPSILON) {
      applyCuesThrough(retrigPerf - EPSILON);
      offset = retrigPerf - barStart;
      segments.push({ fromPerf: retrigPerf, offset });
      if (aligning) { index = 0; aligning = false; } else index = (index + 1) % pattern.length;
      chain.retrigs.push({ perf: retrigPerf, index });
      retrigPerf += pattern[index];
    }
    chain.nextAfterEnd = retrigPerf;
    fillChains.push(chain);
  }
  applyCuesThrough(Number.POSITIVE_INFINITY);
  segments.sort((a, b) => a.fromPerf - b.fromPerf);
  return { segments, fillChains };
}

export function offsetAtPerf(seekMap, perf) {
  const { segments } = seekMap;
  let low = 0;
  let high = segments.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (segments[mid].fromPerf <= perf + EPSILON) low = mid;
    else high = mid - 1;
  }
  return segments[low].offset;
}

export function musicalAtPerf(seekMap, perf) {
  return perf - offsetAtPerf(seekMap, perf);
}

export function stateAtTick(timeline, seekMap, tick) {
  let setIndex = timeline.chunks[0]?.set ?? 0;
  for (const chunk of timeline.chunks) {
    if (chunk.at <= tick + EPSILON) setIndex = chunk.set;
    else break;
  }
  const laneEnabled = LANE_KEYS.map((key) => (
    (timeline.lanes[key] ?? []).some(([from, to]) => from <= tick + EPSILON && tick < to - EPSILON)
  ));
  const activeTechs = timeline.techs.filter((tech) => (
    tech.start <= tick + EPSILON && tick < tech.end - EPSILON
  ));
  let fillResume = null;
  const activeFill = activeTechs.find((tech) => tech.name === "fill");
  if (activeFill) {
    const chain = seekMap.fillChains.find((candidate) => (
      Math.abs(candidate.start - activeFill.start) < EPSILON
    ));
    if (chain) {
      let lastIndex = -1;
      let next = null;
      for (let i = 0; i < chain.retrigs.length; i += 1) {
        if (chain.retrigs[i].perf <= tick + EPSILON) lastIndex = i;
        else { next = chain.retrigs[i]; break; }
      }
      fillResume = {
        barStart: chain.barStart,
        index: lastIndex >= 0 ? chain.retrigs[lastIndex].index : 0,
        aligning: lastIndex < 0,
        nextRetrigPerf: next ? next.perf : chain.nextAfterEnd,
        endPerf: chain.end,
      };
    }
  }
  return {
    setIndex,
    laneEnabled,
    musicalTick: musicalAtPerf(seekMap, tick),
    activeTechs,
    fillResume,
  };
}

const EVENT_ORDER = { "tech-off": 0, chunk: 1, lane: 2, cue: 3, "tech-variant": 4, "tech-on": 5 };

export function compileEventList(timeline) {
  const events = [];
  for (const chunk of timeline.chunks) {
    events.push({ tick: chunk.at, type: "chunk", set: chunk.set });
  }
  LANE_KEYS.forEach((key, laneIndex) => {
    for (const [from, to] of timeline.lanes[key] ?? []) {
      events.push({ tick: from, type: "lane", laneIndex, on: true });
      events.push({ tick: to, type: "lane", laneIndex, on: false });
    }
  });
  for (const tick of timeline.cues) events.push({ tick, type: "cue" });

  const sortedTechs = [...timeline.techs].sort((a, b) => a.start - b.start);
  const openEnd = new Map();
  for (const tech of sortedTechs) {
    const previous = openEnd.get(tech.name);
    const payload = {
      name: tech.name,
      variant: tech.variant,
      setting: resolveTechSetting(timeline, tech),
      end: tech.end,
    };
    if (previous && Math.abs(previous.end - tech.start) < EPSILON) {
      // Variant/setting change while held: reconfigure, no off/on.
      events.push({ tick: tech.start, type: "tech-variant", ...payload });
    } else {
      if (previous) events.push({ tick: previous.end, type: "tech-off", name: tech.name });
      events.push({ tick: tech.start, type: "tech-on", ...payload });
    }
    openEnd.set(tech.name, { end: tech.end, event: payload });
  }
  for (const [name, record] of openEnd) {
    events.push({ tick: record.end, type: "tech-off", name });
  }

  events.sort((a, b) => (
    a.tick - b.tick || EVENT_ORDER[a.type] - EVENT_ORDER[b.type]
  ));
  return events;
}
