// Timeline editor panel: renders a gj6-timeline as draggable blocks on a
// bar/beat board, supports move/resize with snapping, an inspector, cursor
// audition through the timeline player, JSON import/export, and a recording
// arm.  The editor starts empty and resets on reload; persistence is only
// the explicit export/import.
import { BAR_TICKS, LANE_KEYS, REPLAY_TECHS, SET_NAMES } from "./constants.js";
import { normalizeTimeline, validateTimeline } from "./timeline.js";

const ZOOMS = [0.05, 0.1, 0.2, 0.4, 0.8, 1.6];
const ROW_HEIGHT = 26;
const EDGE_PX = 6;
const TECH_ROWS = REPLAY_TECHS.map((tech) => ({ key: `tech:${tech.name}`, tech }));
const ROWS = [
  { key: "chunks", label: "CHUNK" },
  ...LANE_KEYS.map((lane) => ({ key: `lane:${lane}`, label: lane })),
  ...TECH_ROWS.map((row) => ({ key: row.key, label: row.tech.label })),
  { key: "cues", label: "CUE" },
];

const $ = (selector, root = document) => root.querySelector(selector);
const deepCopy = (value) => JSON.parse(JSON.stringify(value));

export function createTimelineEditor(options) {
  const { player, recorder, itemMap, presetIds, getPresetTimeline, getOriginalDenrTimeline, convertDenrBuffer, onLoaded, setStatus } = options;

  const body = $("#editorBody");
  const board = $("#editorBoard");
  const scroll = $("#editorScroll");
  const rowLabels = $("#editorRowLabels");
  const inspector = $("#editorInspector");

  let timeline = null;
  let pxPerTick = 0.2;
  let snapTicks = 24;
  let cursorTick = 0;
  let selection = null;   // {kind, ref, laneKey?}
  let drag = null;
  let playheadRaf = 0;
  let auditionRef = null;

  const snap = (tick, bypass = false) => {
    if (bypass || !snapTicks) return Math.max(0, tick);
    return Math.max(0, Math.round(tick / snapTicks) * snapTicks);
  };
  const clampTick = (tick) => Math.max(0, Math.min(timeline.meta.durationTicks, tick));

  const selectionAlive = () => {
    if (!selection) return false;
    if (selection.kind === "chunk") return timeline.chunks.includes(selection.ref);
    if (selection.kind === "lane") return timeline.lanes[selection.laneKey]?.includes(selection.ref);
    if (selection.kind === "tech") return timeline.techs.includes(selection.ref);
    if (selection.kind === "cue") return selection.index < timeline.cues.length;
    return false;
  };

  const commit = () => {
    if (player.running) player.stop("編集のため停止しました");
    normalizeTimeline(timeline);
    if (!selectionAlive()) selection = null;
    renderBoard();
    renderInspector();
  };

  // ---------- rendering ----------
  const barLabelStep = () => (pxPerTick >= 0.4 ? 1 : pxPerTick >= 0.1 ? 4 : 8);

  function renderRowLabels() {
    const labelRows = [{ key: "ruler", label: "" }, { key: "spacer", label: "" }, ...ROWS];
    rowLabels.replaceChildren(
      ...labelRows.map((row) => {
        const label = document.createElement("div");
        label.className = row.key === "spacer" ? "editor-row-label editor-spacer" : "editor-row-label";
        label.textContent = row.label ?? "";
        return label;
      }),
    );
  }

  function blockElement(kind, text, from, to, className = "") {
    const block = document.createElement("button");
    block.type = "button";
    block.className = `editor-block ${className}`;
    block.style.left = `${from * pxPerTick}px`;
    block.style.width = `${Math.max(6, (to - from) * pxPerTick)}px`;
    block.textContent = text;
    block.dataset.kind = kind;
    return block;
  }

  function renderBoard() {
    if (!timeline) return;
    const duration = timeline.meta.durationTicks;
    const width = Math.ceil(duration * pxPerTick) + 40;
    board.style.width = `${width}px`;
    board.style.setProperty("--bar-px", `${BAR_TICKS * pxPerTick}px`);
    board.style.setProperty("--beat-px", `${48 * pxPerTick}px`);

    const grid = document.createElement("div");
    grid.className = "editor-grid";
    const cueBounds = [0, ...(timeline.cues ?? []).filter((c) => c > 0)].sort((a, b) => a - b);
    for (let s = 0; s < cueBounds.length; s++) {
      const start = cueBounds[s];
      const end = cueBounds[s + 1] ?? duration;
      const sec = document.createElement("div");
      sec.className = "editor-grid-section";
      sec.style.left = `${start * pxPerTick}px`;
      sec.style.width = `${(end - start) * pxPerTick}px`;
      grid.append(sec);
    }

    const ruler = document.createElement("div");
    ruler.className = "editor-ruler editor-track";
    ruler.dataset.row = "ruler";
    const step = barLabelStep();
    for (let bar = 0; bar * BAR_TICKS < duration; bar += step) {
      const mark = document.createElement("span");
      mark.className = "editor-bar-label";
      mark.style.left = `${bar * BAR_TICKS * pxPerTick}px`;
      mark.textContent = String(bar + 1);
      ruler.append(mark);
    }

    const spacer = document.createElement("div");
    spacer.className = "editor-track editor-spacer";
    const rows = [ruler, spacer];
    for (const row of ROWS) {
      const track = document.createElement("div");
      track.className = "editor-track editor-row";
      track.dataset.row = row.key;

      if (row.key === "chunks") {
        timeline.chunks.forEach((chunk, index) => {
          const to = timeline.chunks[index + 1]?.at ?? duration;
          const block = blockElement("chunk", SET_NAMES[chunk.set], chunk.at, to, `chunk-color-${chunk.set}`);
          block.dataset.index = String(index);
          if (selection?.kind === "chunk" && selection.ref === chunk) block.classList.add("selected");
          track.append(block);
        });
      } else if (row.key.startsWith("lane:")) {
        const lane = row.key.slice(5);
        (timeline.lanes[lane] ?? []).forEach((interval, index) => {
          const block = blockElement("lane", "", interval[0], interval[1], "lane-block");
          block.dataset.lane = lane;
          block.dataset.index = String(index);
          if (selection?.kind === "lane" && selection.ref === interval) block.classList.add("selected");
          track.append(block);
        });
      } else if (row.key.startsWith("tech:")) {
        const name = row.key.slice(5);
        timeline.techs.forEach((tech, index) => {
          if (tech.name !== name) return;
          const arrows = ["←", "↓", "→", "↑"];
          const block = blockElement("tech", `${arrows[tech.variant] ?? ""}${tech.setting != null ? tech.setting + 1 : ""}`, tech.start, tech.end, "tech-block");
          block.dataset.index = String(index);
          if (selection?.kind === "tech" && selection.ref === tech) block.classList.add("selected");
          track.append(block);
        });
      } else if (row.key === "cues") {
        timeline.cues.forEach((tick, index) => {
          const block = document.createElement("button");
          block.type = "button";
          block.className = "editor-cue";
          block.style.left = `${tick * pxPerTick}px`;
          block.dataset.kind = "cue";
          block.dataset.index = String(index);
          block.title = `頭出し @ tick ${Math.round(tick)}`;
          if (selection?.kind === "cue" && selection.index === index) block.classList.add("selected");
          track.append(block);
        });
      }
      rows.push(track);
    }

    const cursor = document.createElement("i");
    cursor.className = "editor-cursor";
    cursor.style.left = `${cursorTick * pxPerTick}px`;
    const playhead = document.createElement("i");
    playhead.className = "editor-playhead";
    playhead.id = "editorPlayhead";
    playhead.style.left = "-9999px";

    board.replaceChildren(grid, ...rows, cursor, playhead);
    renderRowLabels();
    $("#editorTitle").textContent = timeline
      ? `${timeline.meta.title ?? timeline.meta.id ?? ""} · ${Math.ceil(timeline.meta.durationTicks / BAR_TICKS)}小節`
      : "";
  }

  // ---------- inspector ----------
  function inspectorField(labelText, input) {
    const label = document.createElement("label");
    label.className = "editor-field";
    label.append(labelText, input);
    return label;
  }

  function numberInput(value, onChange) {
    const input = document.createElement("input");
    input.type = "number";
    input.step = "1";
    input.value = String(Math.round(value * 100) / 100);
    input.addEventListener("change", () => onChange(Number(input.value)));
    return input;
  }

  function renderInspector() {
    if (!timeline || !selection) {
      inspector.replaceChildren(Object.assign(document.createElement("span"), {
        className: "editor-inspector-empty",
        textContent: timeline
          ? "ブロックを選択すると編集できます。ダブルクリックで追加、Deleteで削除。"
          : "プリセット読込・読み込み・収録でタイムラインを開いてください。",
      }));
      return;
    }
    const fragment = document.createDocumentFragment();
    const kindLabel = document.createElement("strong");

    if (selection.kind === "chunk") {
      const chunk = selection.ref;
      kindLabel.textContent = "CHUNK切替";
      fragment.append(kindLabel);
      fragment.append(inspectorField("tick", numberInput(chunk.at, (value) => {
        if (timeline.chunks.indexOf(chunk) === 0) return;
        chunk.at = clampTick(value);
        commit();
      })));
      const select = document.createElement("select");
      SET_NAMES.forEach((name, index) => {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = `${name} (SET ${index + 1})`;
        option.selected = index === chunk.set;
        select.append(option);
      });
      select.addEventListener("change", () => { chunk.set = Number(select.value); commit(); });
      fragment.append(inspectorField("セット", select));
    } else if (selection.kind === "lane") {
      const interval = selection.ref;
      kindLabel.textContent = `LANE ${selection.laneKey}`;
      fragment.append(kindLabel);
      fragment.append(inspectorField("開始", numberInput(interval[0], (value) => { interval[0] = clampTick(value); commit(); })));
      fragment.append(inspectorField("終了", numberInput(interval[1], (value) => { interval[1] = clampTick(value); commit(); })));
    } else if (selection.kind === "tech") {
      const tech = selection.ref;
      kindLabel.textContent = `TECH ${REPLAY_TECHS.find((entry) => entry.name === tech.name)?.label ?? tech.name}`;
      fragment.append(kindLabel);
      fragment.append(inspectorField("開始", numberInput(tech.start, (value) => { tech.start = clampTick(value); commit(); })));
      fragment.append(inspectorField("終了", numberInput(tech.end, (value) => { tech.end = clampTick(value); commit(); })));
      const variant = document.createElement("select");
      ["← (1)", "↓ (2)", "→ (3)", "↑ (4)"].forEach((text, index) => {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = text;
        option.selected = index === tech.variant;
        variant.append(option);
      });
      variant.addEventListener("change", () => { tech.variant = Number(variant.value); commit(); });
      fragment.append(inspectorField("方向", variant));
      fragment.append(inspectorField("設定番号", numberInput((tech.setting ?? 0) + 1, (value) => {
        tech.setting = Math.max(0, Math.round(value) - 1);
        commit();
      })));
    } else if (selection.kind === "cue") {
      kindLabel.textContent = "頭出し";
      fragment.append(kindLabel);
      fragment.append(inspectorField("tick", numberInput(timeline.cues[selection.index], (value) => {
        timeline.cues[selection.index] = clampTick(value);
        commit();
      })));
    }

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "削除";
    remove.className = "editor-delete";
    remove.addEventListener("click", deleteSelection);
    fragment.append(remove);
    inspector.replaceChildren(fragment);
  }

  function deleteSelection() {
    if (!timeline || !selection) return;
    if (selection.kind === "chunk") {
      const index = timeline.chunks.indexOf(selection.ref);
      if (index > 0) timeline.chunks.splice(index, 1);
    } else if (selection.kind === "lane") {
      const list = timeline.lanes[selection.laneKey];
      const index = list.indexOf(selection.ref);
      if (index >= 0) list.splice(index, 1);
    } else if (selection.kind === "tech") {
      const index = timeline.techs.indexOf(selection.ref);
      if (index >= 0) timeline.techs.splice(index, 1);
    } else if (selection.kind === "cue") {
      timeline.cues.splice(selection.index, 1);
    }
    selection = null;
    commit();
  }

  // ---------- pointer interactions ----------
  function hitInfo(event) {
    const track = event.target.closest(".editor-track");
    if (!track || !timeline) return null;
    const rect = track.getBoundingClientRect();
    const tick = (event.clientX - rect.left) / pxPerTick;
    return { rowKey: track.dataset.row, tick, track };
  }

  board.addEventListener("pointerdown", (event) => {
    if (!timeline || event.button !== 0) return;
    const info = hitInfo(event);
    if (!info) return;
    const blockEl = event.target.closest(".editor-block, .editor-cue");

    if (!blockEl) {
      if (info.rowKey === "ruler") {
        cursorTick = snap(clampTick(info.tick), event.altKey);
        renderBoard();
      }
      return;
    }

    // Measure before re-rendering: renderBoard() replaces the element and a
    // detached rect would break the edge/move mode detection.
    const rect = blockEl.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;

    // resolve selection
    const index = Number(blockEl.dataset.index);
    if (blockEl.dataset.kind === "chunk") selection = { kind: "chunk", ref: timeline.chunks[index] };
    else if (blockEl.dataset.kind === "lane") {
      const lane = blockEl.dataset.lane;
      selection = { kind: "lane", laneKey: lane, ref: timeline.lanes[lane][index] };
    } else if (blockEl.dataset.kind === "tech") selection = { kind: "tech", ref: timeline.techs[index] };
    else if (blockEl.dataset.kind === "cue") selection = { kind: "cue", index };
    renderInspector();
    renderBoard();
    let mode = "move";
    if (selection.kind === "lane" || selection.kind === "tech") {
      if (offsetX < EDGE_PX) mode = "resize-start";
      else if (offsetX > rect.width - EDGE_PX) mode = "resize-end";
    }
    const origin = (() => {
      if (selection.kind === "chunk") return { at: selection.ref.at };
      if (selection.kind === "cue") return { at: timeline.cues[selection.index] };
      if (selection.kind === "lane") return { start: selection.ref[0], end: selection.ref[1] };
      return { start: selection.ref.start, end: selection.ref.end };
    })();
    drag = { mode, startX: event.clientX, origin, moved: false };
    board.setPointerCapture(event.pointerId);
  });

  board.addEventListener("pointermove", (event) => {
    if (!drag || !timeline || !selection) return;
    const deltaTicks = (event.clientX - drag.startX) / pxPerTick;
    if (Math.abs(deltaTicks) > 0.5) drag.moved = true;
    const bypass = event.altKey;

    if (selection.kind === "chunk") {
      if (timeline.chunks.indexOf(selection.ref) === 0) return;
      selection.ref.at = snap(clampTick(drag.origin.at + deltaTicks), bypass);
    } else if (selection.kind === "cue") {
      timeline.cues[selection.index] = snap(clampTick(drag.origin.at + deltaTicks), bypass);
    } else {
      const target = selection.kind === "lane"
        ? { get s() { return selection.ref[0]; }, set s(v) { selection.ref[0] = v; },
            get e() { return selection.ref[1]; }, set e(v) { selection.ref[1] = v; } }
        : { get s() { return selection.ref.start; }, set s(v) { selection.ref.start = v; },
            get e() { return selection.ref.end; }, set e(v) { selection.ref.end = v; } };
      const length = drag.origin.end - drag.origin.start;
      if (drag.mode === "move") {
        const start = snap(clampTick(drag.origin.start + deltaTicks), bypass);
        target.s = start;
        target.e = Math.min(timeline.meta.durationTicks, start + length);
      } else if (drag.mode === "resize-start") {
        target.s = Math.min(snap(clampTick(drag.origin.start + deltaTicks), bypass), target.e - 1);
      } else {
        target.e = Math.max(snap(clampTick(drag.origin.end + deltaTicks), bypass), target.s + 1);
      }
    }
    renderBoard();
  });

  const endDrag = () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (moved) commit();
    else renderInspector();
  };
  board.addEventListener("pointerup", endDrag);
  board.addEventListener("pointercancel", endDrag);

  board.addEventListener("dblclick", (event) => {
    if (!timeline) return;
    if (event.target.closest(".editor-block, .editor-cue")) return;
    const info = hitInfo(event);
    if (!info || info.rowKey === "ruler") return;
    const tick = snap(clampTick(info.tick), event.altKey);
    if (info.rowKey === "chunks") {
      timeline.chunks.push({ at: tick, set: 0 });
      selection = { kind: "chunk", ref: timeline.chunks[timeline.chunks.length - 1] };
    } else if (info.rowKey.startsWith("lane:")) {
      const lane = info.rowKey.slice(5);
      const interval = [tick, Math.min(timeline.meta.durationTicks, tick + BAR_TICKS)];
      timeline.lanes[lane].push(interval);
      selection = { kind: "lane", laneKey: lane, ref: interval };
    } else if (info.rowKey.startsWith("tech:")) {
      const name = info.rowKey.slice(5);
      const tech = { name, variant: 0, setting: timeline.meta.techSettings?.[name] ?? 0, start: tick, end: Math.min(timeline.meta.durationTicks, tick + 48) };
      timeline.techs.push(tech);
      selection = { kind: "tech", ref: tech };
    } else if (info.rowKey === "cues") {
      timeline.cues.push(tick);
      selection = { kind: "cue", index: timeline.cues.length - 1 };
    }
    commit();
  });

  window.addEventListener("keydown", (event) => {
    if (!timeline || !selection) return;
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    const activeTag = document.activeElement?.tagName;
    if (["INPUT", "SELECT", "TEXTAREA"].includes(activeTag)) return;
    if (!body || body.hidden) return;
    event.preventDefault();
    deleteSelection();
  });

  // ---------- playhead ----------
  function trackPlayhead() {
    cancelAnimationFrame(playheadRaf);
    const loop = () => {
      const playhead = $("#editorPlayhead");
      if (playhead) {
        if (player.running && player.timeline === auditionRef) {
          const x = player.currentPerfTick() * pxPerTick;
          playhead.style.left = `${x}px`;
          const view = scroll.getBoundingClientRect();
          if (x < scroll.scrollLeft || x > scroll.scrollLeft + view.width - 60) {
            scroll.scrollLeft = Math.max(0, x - 80);
          }
        } else {
          playhead.style.left = "-9999px";
        }
      }
      playheadRaf = requestAnimationFrame(loop);
    };
    loop();
  }

  // ---------- toolbar ----------
  $("#editorCollapse").addEventListener("click", () => {
    const expanded = body.hidden;
    body.hidden = !expanded;
    $("#editorCollapse").textContent = expanded ? "閉じる" : "開く";
    $("#editorCollapse").setAttribute("aria-expanded", String(expanded));
    if (expanded) renderBoard();
  });

  async function audition(fromTick = cursorTick) {
    if (!timeline) return;
    const { ok, errors } = validateTimeline(timeline, itemMap);
    if (!ok) {
      setStatus(`タイムライン不正: ${errors[0]}`, false);
      return;
    }
    const copy = deepCopy(timeline);
    auditionRef = copy;
    await player.play(copy, fromTick);
  }

  $("#editorPlayCursor").addEventListener("click", async () => {
    await audition(cursorTick);
    if (player.running) setStatus("タイムライン試聴中", true);
  });

  $("#editorStopButton").addEventListener("click", () => {
    if (player.running) player.stop("停止しました");
  });

  $("#editorArmRecord").addEventListener("click", () => {
    if (recorder.recording) {
      setStatus("収録中です。PLAYの■で終了します", true);
      return;
    }
    recorder.setArmed(!recorder.armed);
    $("#editorArmRecord").classList.toggle("armed", recorder.armed);
    setStatus(recorder.armed ? "REC待機: ▶ PLAYで収録開始" : "REC待機を解除しました", false);
  });

  const presetSelect = $("#editorPresetSelect");
  presetSelect.replaceChildren(...presetIds.map((id) => {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = id;
    return option;
  }));

  $("#editorPresetLoad").addEventListener("click", async () => {
    try {
      const loaded = await getPresetTimeline(presetSelect.value);
      load(deepCopy(loaded));
      setStatus(`プリセット ${presetSelect.value} を読み込みました`, false);
    } catch (error) {
      console.error(error);
      setStatus(`プリセット読込エラー: ${error.message}`, false);
    }
  });

  $("#editorLoadReplay").addEventListener("click", async () => {
    try {
      const loaded = await getOriginalDenrTimeline(presetSelect.value);
      load(deepCopy(loaded));
      setStatus(`${presetSelect.value} の原本DENRを変換して読み込みました`, false);
    } catch (error) {
      console.error(error);
      setStatus(`取込エラー: ${error.message}`, false);
    }
  });

  $("#editorZoomIn").addEventListener("click", () => zoom(1));
  $("#editorZoomOut").addEventListener("click", () => zoom(-1));
  function zoom(direction) {
    const index = ZOOMS.indexOf(pxPerTick);
    const next = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, index + direction))];
    if (next !== pxPerTick) {
      pxPerTick = next;
      renderBoard();
    }
  }

  $("#editorSnap").addEventListener("change", (event) => {
    snapTicks = Number(event.target.value);
  });

  $("#editorExport").addEventListener("click", () => {
    if (!timeline) return;
    const blob = new Blob([JSON.stringify(timeline)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${timeline.meta.id ?? "timeline"}.gj6.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
    setStatus("タイムラインを書き出しました", false);
  });

  $("#editorImport").addEventListener("click", () => $("#editorImportFile").click());
  $("#editorImportFile").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      if (/\.denr$/i.test(file.name)) {
        // A raw pad-stream save file: run it through the DENR converter.
        load(convertDenrBuffer(await file.arrayBuffer(), file.name.replace(/\.denr$/i, "")));
        setStatus(`DENRを変換して読み込みました: ${file.name}`, false);
        return;
      }
      const parsed = JSON.parse(await file.text());
      const { ok, errors } = validateTimeline(parsed, itemMap);
      if (!ok) throw new Error(errors[0]);
      load(parsed);
      setStatus(`読み込みました: ${file.name}`, false);
    } catch (error) {
      setStatus(`読み込みエラー: ${error.message}`, false);
    }
  });

  // ---------- public ----------
  function load(nextTimeline) {
    if (recorder.recording) {
      setStatus("収録中は読み込みできません", true);
      return;
    }
    timeline = normalizeTimeline(nextTimeline);
    selection = null;
    cursorTick = 0;
    if (body.hidden) $("#editorCollapse").click();
    renderBoard();
    renderInspector();
    onLoaded?.(timeline);
  }

  renderRowLabels();
  trackPlayhead();

  return { load, audition, get timeline() { return timeline; } };
}
