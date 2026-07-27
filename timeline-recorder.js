// Live-performance recorder: captures manual operations (set switches, lane
// toggles, tech holds, cues) as a gj6-timeline while the engine plays.
import { TICKS_PER_QUARTER } from "./constants.js";
import {
  createLaneIntervalBuilder,
  createTimeline,
  laneFlagsOfSlots,
  normalizeTimeline,
} from "./timeline.js";

const slotsToTimelineSet = (set) => ({
  L1: { category: set.slots[0].category, item: set.slots[0].item },
  L2: { category: set.slots[1].category, item: set.slots[1].item },
  R1: [...set.slots[2].items],
  R2: [...set.slots[3].items],
});

export function createTimelineRecorder(engine) {
  let armed = false;
  let recording = null;

  const perfNow = () => (
    recording.offset + engine.tickAtTime(engine.context.currentTime)
  );

  return {
    get armed() { return armed; },
    get recording() { return Boolean(recording); },
    setArmed(value) { armed = Boolean(value); },

    // Called right after engine.start() while armed.
    begin({ sets, activeSet, techSettings, bpm }) {
      if (!armed || recording) return;
      const timeline = createTimeline(
        {
          id: "REC",
          title: `収録 ${new Date().toLocaleString("ja-JP")}`,
          bpm,
          ticksPerQuarter: TICKS_PER_QUARTER,
          durationTicks: 0,
          durationSeconds: 0,
          techSettings: { ...techSettings },
        },
        sets.map(slotsToTimelineSet),
      );
      timeline.chunks = [{ at: 0, set: activeSet }];
      recording = {
        timeline,
        offset: -engine.originTick,
        startWall: engine.originTime,
        laneBuilder: createLaneIntervalBuilder(
          laneFlagsOfSlots(sets[activeSet].slots), 0,
        ),
        openTechs: new Map(),
        previousSeekHandler: engine.onSeek,
      };
      engine.onSeek = (previousTick, newTick, cutTime) => {
        recording.previousSeekHandler?.(previousTick, newTick, cutTime);
        const at = recording.offset + previousTick;
        recording.offset += previousTick - newTick;
        // A seek to musical 0 outside a fill hold is a cue.
        if (newTick === 0 && !recording.openTechs.has("fill")) {
          recording.timeline.cues.push(Math.max(0, at));
        }
      };
    },

    chunk(setIndex, slots) {
      if (!recording) return;
      const at = Math.max(0, perfNow());
      recording.timeline.chunks.push({ at, set: setIndex });
      recording.laneBuilder.update(at, laneFlagsOfSlots(slots));
    },

    lanes(slots) {
      if (!recording) return;
      recording.laneBuilder.update(Math.max(0, perfNow()), laneFlagsOfSlots(slots));
    },

    techHold(name, setting, variant, on) {
      if (!recording) return;
      const at = Math.max(0, perfNow());
      const open = recording.openTechs.get(name);
      if (open) {
        recording.timeline.techs.push({ ...open, end: at });
        recording.openTechs.delete(name);
      }
      if (on) {
        recording.openTechs.set(name, {
          name,
          variant: Number(variant) || 0,
          setting: Number(setting) || 0,
          start: at,
        });
      }
    },

    stop() {
      if (!recording) return null;
      const at = Math.max(1, perfNow());
      const { timeline } = recording;
      for (const open of recording.openTechs.values()) {
        timeline.techs.push({ ...open, end: at });
      }
      timeline.lanes = recording.laneBuilder.finish(at);
      timeline.meta.durationTicks = at;
      timeline.meta.durationSeconds = Math.max(
        0.1,
        engine.context.currentTime - recording.startWall,
      );
      engine.onSeek = recording.previousSeekHandler ?? null;
      recording = null;
      armed = false;
      return normalizeTimeline(timeline);
    },
  };
}
