// Timeline playback: walks a gj6-timeline's flattened event list with a
// ~50 ms lookahead and drives the GrooveEngine through its public methods.
// No pad-state simulation: every event carries its exec-exact tick.
import {
  ENGINE_TECH_NAMES,
  REPLAY_INPUT_LOOKAHEAD_SECONDS,
} from "./constants.js";
import {
  compileEventList,
  compileSeekMap,
  resolveTechSetting,
  stateAtTick,
  timelineSetToSlots,
} from "./timeline.js";

const EPSILON = 1e-6;
// Timeline ticks sitting exactly on a quantize boundary must not slip to the
// next boundary through float noise when the engine re-derives them.
const TICK_GUARD = 1e-4;

export function createTimelinePlayer(engine, ui) {
  let session = null;

  const timeAtPerf = (perf) => engine.timeAtTick(perf - session.offset);
  const perfNow = () => session.offset + engine.tickAtTime(engine.context.currentTime);

  const configureTech = (name, setting, variant, execTime, fillEndTime) => {
    if (name === "stb") engine.setStbPattern(setting, variant, execTime);
    else if (name === "fill") engine.setFillPattern(setting, variant, execTime, fillEndTime);
    else if (name === "arp") engine.setArpPattern(setting, variant, execTime);
    else if (name === "flsh") engine.setFlshPattern(setting, variant, execTime);
    else if (name === "mrg") engine.setMrgPattern(setting, variant, execTime);
    else engine.setTechVariant(name, variant, execTime);
  };

  const deferToWall = (execTime, action) => {
    const wait = Math.max(0, (execTime - engine.context.currentTime) * 1000);
    const timer = window.setTimeout(() => {
      session?.techTimers.delete(timer);
      if (session?.running) action();
    }, wait);
    session.techTimers.add(timer);
  };

  const dispatch = (event) => {
    if (event.type === "cue") {
      engine.cueExactAt(timeAtPerf(event.tick));
      return;
    }
    if (event.type === "tech-on" || event.type === "tech-variant") {
      const { name, setting, variant } = event;
      if (name === "bpm") {
        deferToWall(timeAtPerf(event.tick), () => {
          engine.setTechVariant("bpm", variant, null);
          if (event.type === "tech-on") engine.setTech("bpm", true, null);
        });
        return;
      }
      if (name === "fill") {
        const execTime = timeAtPerf(event.tick - TICK_GUARD);
        const endTime = timeAtPerf(event.end);
        configureTech(name, setting, variant, execTime, endTime);
        if (event.type === "tech-on") {
          engine.setTech("fill", true, execTime, { replay: true, endTime });
        }
        return;
      }
      const execTime = timeAtPerf(event.tick);
      configureTech(name, setting, variant, execTime);
      if (event.type === "tech-on") engine.setTech(name, true, execTime);
      return;
    }
    if (event.type === "tech-off") {
      const execTime = timeAtPerf(event.tick);
      if (event.name === "bpm" || event.name === "fill") {
        deferToWall(execTime, () => {
          engine.setTech(event.name, false, event.name === "fill" ? execTime : null);
        });
      } else {
        engine.setTech(event.name, false, execTime);
      }
    }
  };

  const pump = () => {
    if (!session?.running) return;
    const now = engine.context.currentTime;
    const horizon = now + REPLAY_INPUT_LOOKAHEAD_SECONDS;
    const { events } = session;
    while (session.nextIndex < events.length) {
      const event = events[session.nextIndex];
      if (event.tick >= session.timeline.meta.durationTicks - EPSILON) {
        // End-of-timeline closers are handled by teardown.
        session.nextIndex += 1;
        continue;
      }
      const execTime = timeAtPerf(event.tick);
      if (execTime > horizon) break;
      if (event.type === "chunk" || event.type === "lane") {
        // Batch all chunk/lane changes sharing this tick into one reschedule.
        let index = session.nextIndex;
        while (index < events.length) {
          const candidate = events[index];
          if (
            (candidate.type !== "chunk" && candidate.type !== "lane")
            || Math.abs(candidate.tick - event.tick) > EPSILON
          ) break;
          if (candidate.type === "chunk") session.audioSetIndex = candidate.set;
          else session.audioLaneFlags[candidate.laneIndex] = candidate.on;
          candidate.resolvedTime = execTime;
          index += 1;
        }
        session.nextIndex = index;
        engine.preserveClockRescheduleAt(execTime);
        continue;
      }
      dispatch(event);
      event.resolvedTime = execTime;
      session.nextIndex += 1;
    }
    const endTime = timeAtPerf(session.timeline.meta.durationTicks);
    if (now >= endTime) {
      finish();
      return;
    }
    let wake = endTime - now;
    if (session.nextIndex < events.length) {
      wake = Math.min(wake, timeAtPerf(events[session.nextIndex].tick) - now - REPLAY_INPUT_LOOKAHEAD_SECONDS);
    }
    // Cap the sleep so BPM-ramp-induced time drift gets re-evaluated.
    session.pumpTimer = window.setTimeout(pump, Math.max(1, Math.min(100, wake * 1000)));
  };

  const advanceDisplay = () => {
    const now = engine.context.currentTime;
    let changed = false;
    while (session.displayIndex < session.nextIndex) {
      const event = session.events[session.displayIndex];
      if (event.resolvedTime == null || event.resolvedTime > now) break;
      if (event.type === "chunk") { session.displaySetIndex = event.set; changed = true; }
      else if (event.type === "lane") { session.displayLaneFlags[event.laneIndex] = event.on; changed = true; }
      else if (event.type === "tech-on" || event.type === "tech-variant") {
        session.activeTech = { name: event.name, variant: event.variant };
        changed = true;
      } else if (event.type === "tech-off") {
        if (session.activeTech?.name === event.name) session.activeTech = null;
        changed = true;
      }
      session.displayIndex += 1;
    }
    if (changed) {
      session.displaySlots = timelineSetToSlots(
        session.timeline.sets[session.displaySetIndex],
        session.displayLaneFlags,
      );
      ui.onStateChange();
    }
  };

  const drawLoop = () => {
    if (!session?.running) return;
    const perf = Math.max(0, perfNow());
    if (perf >= session.timeline.meta.durationTicks - EPSILON) {
      finish();
      return;
    }
    advanceDisplay();
    ui.onProgress?.(perf);
    session.raf = requestAnimationFrame(drawLoop);
  };

  function teardown() {
    if (!session) return;
    session.running = false;
    if (session.pumpTimer !== null) window.clearTimeout(session.pumpTimer);
    for (const timer of session.techTimers) window.clearTimeout(timer);
    session.techTimers.clear();
    cancelAnimationFrame(session.raf);
    engine.onSeek = null;
    for (const name of ENGINE_TECH_NAMES) {
      if (engine.tech[name]) engine.setTech(name, false);
    }
    if (engine.playing) engine.stop();
    session = null;
    ui.lockUi(false);
  }

  function finish() {
    const title = session?.timeline.meta.title ?? "";
    teardown();
    ui.onEnd(`${title} リプレイ終了`);
  }

  async function play(timeline, fromTick = 0) {
    teardown();
    await engine.initialize((message) => ui.setStatus(message));
    if (engine.playing) engine.stop();
    for (const name of ENGINE_TECH_NAMES) {
      if (engine.tech[name]) engine.setTech(name, false);
    }
    engine.setBpm(timeline.meta.bpm);
    ui.applyBpm(timeline.meta.bpm);

    const seekMap = compileSeekMap(timeline);
    const events = compileEventList(timeline);
    const startTick = Math.max(0, Math.min(fromTick, timeline.meta.durationTicks - 1));
    const state = stateAtTick(timeline, seekMap, startTick);
    let nextIndex = 0;
    while (nextIndex < events.length && events[nextIndex].tick <= startTick + EPSILON) nextIndex += 1;

    session = {
      running: true,
      timeline,
      seekMap,
      events,
      fromTick: startTick,
      offset: 0,
      nextIndex,
      displayIndex: nextIndex,
      audioSetIndex: state.setIndex,
      audioLaneFlags: [...state.laneEnabled],
      displaySetIndex: state.setIndex,
      displayLaneFlags: [...state.laneEnabled],
      displaySlots: timelineSetToSlots(timeline.sets[state.setIndex], state.laneEnabled),
      activeTech: null,
      techTimers: new Set(),
      pumpTimer: null,
      raf: 0,
      startWall: 0,
    };

    engine.pausedTick = Math.max(0, state.musicalTick);
    engine.onSeek = (previousTick, newTick) => {
      if (session?.running) session.offset += previousTick - newTick;
    };
    ui.lockUi(true);
    ui.onStateChange();
    await engine.start();
    session.offset = startTick - state.musicalTick;
    session.startWall = engine.originTime;

    for (const tech of state.activeTechs) {
      const setting = resolveTechSetting(timeline, tech);
      session.activeTech = { name: tech.name, variant: tech.variant };
      if (tech.name === "fill" && state.fillResume) {
        const endTime = timeAtPerf(state.fillResume.endPerf);
        engine.setFillPattern(setting, tech.variant, null, endTime);
        engine.setTech("fill", true, engine.originTime, { replay: true, endTime });
        engine.resumeReplayFill({
          barStartTick: state.fillResume.barStart,
          index: state.fillResume.index,
          aligning: state.fillResume.aligning,
          targetTime: timeAtPerf(state.fillResume.nextRetrigPerf),
          endTime,
        });
      } else if (tech.name === "bpm") {
        engine.setTechVariant("bpm", tech.variant, null);
        engine.setTech("bpm", true, null);
      } else {
        configureTech(tech.name, setting, tech.variant, engine.originTime);
        engine.setTech(tech.name, true, engine.originTime);
      }
    }
    pump();
    session.raf = requestAnimationFrame(drawLoop);
  }

  function stop(message = "リプレイを停止しました") {
    if (!session) return;
    teardown();
    if (message) ui.onEnd(message);
  }

  return {
    play,
    stop,
    get running() { return Boolean(session?.running); },
    get timeline() { return session?.timeline ?? null; },
    currentPerfTick() { return session?.running ? Math.max(0, perfNow()) : 0; },
    displaySlots() { return session?.running ? session.displaySlots : null; },
    displaySetIndex() { return session?.running ? session.displaySetIndex : null; },
    activeTech() { return session?.running ? session.activeTech : null; },
    audioTracks(meterForLane) {
      if (!session?.running) return null;
      const set = session.timeline.sets[session.audioSetIndex];
      const items = [set.L1.item, set.L2.item, set.R1[0], set.R1[1], set.R2[0], set.R2[1]];
      return items.map((itemId, laneIndex) => ({
        enabled: Boolean(session.audioLaneFlags[laneIndex]),
        itemId,
        meter: meterForLane(laneIndex),
      }));
    },
  };
}
