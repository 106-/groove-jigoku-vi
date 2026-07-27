// Shared constants for the engine, the DENR converter, and the timeline
// tooling.  Pure module: safe to import from Node scripts as well as the app.
import { PAD } from "./replay.js";

export const SET_NAMES = ["ア", "イ", "ウ", "エ", "オ", "カ", "キ", "ク"];
export const TICKS_PER_QUARTER = 48;
export const BAR_TICKS = TICKS_PER_QUARTER * 4;
export const REPLAY_INPUT_LOOKAHEAD_SECONDS = 0.05;
// Wake well before the fill boundary so the retrigger cut lands on its exact
// audio timestamp even when the main thread is busy; 12 ms proved too tight.
export const REPLAY_FILL_TIMER_LEAD_SECONDS = 0.05;
export const CUE_QUANTIZE_TICKS = 24;
export const CUE_IMMEDIATE_WINDOW_TICKS = 7;
export const INTERRUPT_INTERVALS = [48, 24, 12, 8];
// SDED.OX uses a Q7 tempo multiplier: 128 is normal speed, clamped to
// 16..512.  The four BPM TECH variants add these values once per 60 Hz frame.
export const BPM_TECH_STEPS = [-3, -9, 3, 9];
export const BPM_TECH_NORMAL = 128;
export const BPM_TECH_MIN = 16;
export const BPM_TECH_MAX = 512;
export const FILL_PATTERNS = [
  [[48], [24], [12], [6]],
  [[12, 12, 24], [12], [12, 36], [6]],
  [[12, 24], [24, 24, 24, 12], [24], [6]],
  [
    [12, 12, 24, 24, 24, 6, 6, 12, 24, 12, 24, 12],
    [6, 6, 24, 24, 12, 12, 24, 12, 24, 6, 6, 24, 12],
    [24, 24, 6, 6, 24, 24, 12, 24, 12, 12, 12, 12],
    [6],
  ],
];
// The pad dispatcher calls each held direction on frame 0, then every eight
// 30 Hz replay frames.  SQUARE only modifies what that callback does; it does
// not restart the direction's counter.
export const REPLAY_DIRECTION_REPEAT_FRAMES = 8;
export const REPLAY_SHOULDER_BITS = [PAD.L1, PAD.L2, PAD.R1, PAD.R2];
export const ENGINE_TECH_NAMES = ["delay", "mod", "bpm", "reverb", "stb", "arp", "flsh", "mrg", "interrupt", "fill"];
// Exact order of the ten labels in SDED.OX.
export const REPLAY_TECHS = [
  { name: "delay", label: "DLY", selector: ".delay-tech-control" },
  { name: "mod", label: "MOD", selector: ".mod-tech-control" },
  { name: "reverb", label: "REV", selector: ".reverb-tech-control" },
  { name: "bpm", label: "BPM", selector: ".bpm-tech-control" },
  { name: "stb", label: "STB", selector: ".stb-tech-control" },
  { name: "arp", label: "ARP", selector: ".arp-tech-control" },
  { name: "flsh", label: "FLSH", selector: ".flsh-tech-control" },
  { name: "interrupt", label: "INT", selector: ".int-tech-control" },
  { name: "fill", label: "FIL", selector: ".fill-tech-control" },
  { name: "mrg", label: "MRG", selector: ".mrg-tech-control" },
];
export const REPLAY_TECH_DIRECTIONS = [
  { bit: PAD.LEFT, variant: 0 },
  { bit: PAD.DOWN, variant: 1 },
  { bit: PAD.RIGHT, variant: 2 },
  { bit: PAD.UP, variant: 3 },
];
// Callback order in the original pad dispatcher.  The order only matters for
// diagonals that reach a repeat boundary on the same frame.
export const REPLAY_DIRECTION_CALLBACKS = [
  { bit: PAD.UP, selection: "tech", delta: -1 },
  { bit: PAD.DOWN, selection: "tech", delta: 1 },
  { bit: PAD.RIGHT, selection: "change", delta: 1 },
  { bit: PAD.LEFT, selection: "change", delta: -1 },
];
// The six audible lanes, in slot order.
export const LANE_KEYS = ["L1", "L2", "R1A", "R1B", "R2A", "R2B"];
// TECHs whose settings come from a saved per-tech record.
export const TECH_SETTING_NAMES = ["stb", "flsh", "mrg", "fill", "arp"];
