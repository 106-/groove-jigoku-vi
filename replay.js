export const REPLAY_DEFINITIONS = [
  { id: "FMY", path: "data/replays/FMY.DENR" },
  { id: "PIG", path: "data/replays/PIG.DENR" },
  { id: "SEX", path: "data/replays/SEX.DENR" },
];

export const PAD = Object.freeze({
  L2: 0x0001,
  R2: 0x0002,
  L1: 0x0004,
  R1: 0x0008,
  TRIANGLE: 0x0010,
  CIRCLE: 0x0020,
  CROSS: 0x0040,
  SQUARE: 0x0080,
  SELECT: 0x0100,
  START: 0x0800,
  UP: 0x1000,
  RIGHT: 0x2000,
  DOWN: 0x4000,
  LEFT: 0x8000,
});

const HEADER_SIZE = 0x1800;
const SNAPSHOT_OFFSET = 0x208;
const SETS_OFFSET = 0x310;
const SET_SIZE = 0x58;
const TRACK_SIZE = 12;
const SET_HEADER_SIZE = 4;
const MASTER_TRACK_SIZE = 12;
const PLAYBACK_CHUNK_OFFSET = 0x5d0;
const PLAYBACK_STATE_OFFSET = PLAYBACK_CHUNK_OFFSET + 8;
const INPUT_STATE_OFFSET = 0x5e0;
const INPUT_STREAM_OFFSET = 0x7f0;
const INPUT_STREAM_CAPACITY = 0xc00;
export const REPLAY_FPS = 30;
const TECH_SETTING_RECORDS = Object.freeze({
  stb: 0,
  flsh: 1,
  mrg: 2,
  fill: 5,
  arp: 6,
});

const readU32 = (view, offset) => view.getUint32(offset, true);
const clampSetIndex = (value) => Math.max(0, Math.min(7, value));

function readFixedText(bytes, offset, length) {
  const end = offset + length;
  let textEnd = offset;
  while (textEnd < end && bytes[textEnd] !== 0) textEnd += 1;
  return new TextDecoder("shift_jis").decode(bytes.subarray(offset, textEnd)).trim();
}

function cloneSlot(slot) {
  if (slot.type === "single") return { ...slot };
  return { ...slot, itemEnabled: [...slot.itemEnabled], items: [...slot.items] };
}

export function cloneReplaySet(set) {
  return { slots: set.slots.map(cloneSlot) };
}

function makeCatalogIndex(catalog) {
  const index = new Map();
  for (const item of catalog.items) {
    const key = `${item.source}:${item.category}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(item);
  }
  for (const items of index.values()) items.sort((left, right) => left.number - right.number);
  return index;
}

function resolveTrack(bytes, offset, category, sourceNames, catalogIndex) {
  const packed = (
    bytes[offset + 8]
    | (bytes[offset + 9] << 8)
    | (bytes[offset + 10] << 16)
    | (bytes[offset + 11] << 24)
  ) >>> 0;
  const sourceIndex = packed & 0x3f;
  const sequenceIndex = (packed >>> 6) & 0x3f;
  const memberIndex = (packed >>> 12) & 0x3f;
  const enabled = ((packed >>> 22) & 1) === 0;
  const source = sourceNames[sourceIndex];
  const candidates = catalogIndex.get(`${source}:${category}`) ?? [];
  const item = candidates[memberIndex];
  if (!item) {
    throw new Error(
      `音ネタ参照を解決できません: ${category}`
      + ` source=${sourceIndex} sequence=${sequenceIndex} member=${memberIndex}`,
    );
  }
  return {
    itemId: item.id,
    source,
    sourceIndex,
    sequenceIndex,
    memberIndex,
    enabled,
    packed,
    raw: [...bytes.subarray(offset, offset + TRACK_SIZE)],
  };
}

function parseSets(bytes, catalog) {
  const sourceNames = Array.from({ length: 32 }, (_, index) => (
    readFixedText(bytes, SNAPSHOT_OFFSET + 8 + index * 8, 8)
  ));
  const catalogIndex = makeCatalogIndex(catalog);
  const sets = [];
  const trackDetails = [];

  for (let setIndex = 0; setIndex < 8; setIndex += 1) {
    const base = SETS_OFFSET + setIndex * SET_SIZE;
    const tracks = ["B", "H", "S", "S", "S", "S"].map((category, trackIndex) => {
      const offset = base + SET_HEADER_SIZE + MASTER_TRACK_SIZE + trackIndex * TRACK_SIZE;
      return resolveTrack(bytes, offset, category, sourceNames, catalogIndex);
    });
    const r1Enabled = tracks[2].enabled || tracks[3].enabled;
    const r2Enabled = tracks[4].enabled || tracks[5].enabled;
    sets.push({
      slots: [
        { key: "L1", type: "single", enabled: tracks[1].enabled, category: "H", item: tracks[1].itemId },
        { key: "L2", type: "single", enabled: tracks[0].enabled, category: "B", item: tracks[0].itemId },
        {
          key: "R1",
          type: "pair",
          enabled: r1Enabled,
          itemEnabled: [tracks[2].enabled, tracks[3].enabled],
          items: [tracks[2].itemId, tracks[3].itemId],
        },
        {
          key: "R2",
          type: "pair",
          enabled: r2Enabled,
          itemEnabled: [tracks[4].enabled, tracks[5].enabled],
          items: [tracks[4].itemId, tracks[5].itemId],
        },
      ],
    });
    trackDetails.push(tracks);
  }
  return { sets, sourceNames, trackDetails };
}

function parseInputStream(bytes, view) {
  const byteLength = readU32(view, INPUT_STREAM_OFFSET);
  if (byteLength > INPUT_STREAM_CAPACITY || byteLength % 3 !== 0) {
    throw new Error(`不正な入力ストリーム長です: ${byteLength}`);
  }

  const records = [];
  let frameCount = 0;
  let previousMask = 0;
  const spans = [];
  // Each record is (delay, next-pad-mask), not a run of the mask stored in
  // that same record.  The game records this stream on its 30 Hz update.
  for (let offset = 0; offset < byteLength; offset += 3) {
    const recordOffset = INPUT_STREAM_OFFSET + 4 + offset;
    const duration = bytes[recordOffset];
    const mask = (bytes[recordOffset + 1] << 8) | bytes[recordOffset + 2];
    if (duration > 0) {
      spans.push({ startFrame: frameCount, duration, mask: previousMask });
      frameCount += duration;
      records.push({ frame: frameCount, duration, mask });
      previousMask = mask;
    }
  }

  const frames = new Uint16Array(frameCount);
  for (const span of spans) {
    frames.fill(span.mask, span.startFrame, span.startFrame + span.duration);
  }

  return { byteLength, records, frames, frameCount, durationSeconds: frameCount / REPLAY_FPS };
}

export function parseReplay(arrayBuffer, catalog, fallbackId = "REPLAY") {
  if (arrayBuffer.byteLength !== HEADER_SIZE) {
    throw new Error(`DENRサイズが不正です: ${arrayBuffer.byteLength} bytes`);
  }
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  if (bytes[0] !== 0x53 || bytes[1] !== 0x43) throw new Error("SCセーブヘッダがありません");
  if (readFixedText(bytes, 0x200, 4) !== "USER") throw new Error("USERチャンクがありません");
  if (readFixedText(bytes, SNAPSHOT_OFFSET, 4) !== "HSNP") throw new Error("HSNPチャンクがありません");
  if (
    readFixedText(bytes, PLAYBACK_CHUNK_OFFSET, 4) !== "PVPF"
    || readU32(view, PLAYBACK_CHUNK_OFFSET + 4) !== 8
  ) throw new Error("PVPFチャンクがありません");

  const parsedSets = parseSets(bytes, catalog);
  const input = parseInputStream(bytes, view);
  const title = readFixedText(bytes, 4, 64) || fallbackId;
  const chunkSelector = bytes[PLAYBACK_STATE_OFFSET] & 1;
  const chunkSlots = [
    clampSetIndex(bytes[PLAYBACK_STATE_OFFSET + 1]),
    clampSetIndex(bytes[PLAYBACK_STATE_OFFSET + 2]),
  ];
  const activeSet = chunkSlots[chunkSelector];
  const targetSet = chunkSlots[chunkSelector ^ 1];
  const selectedTech = Math.max(0, Math.min(9, bytes[PLAYBACK_STATE_OFFSET + 3] - 1));
  const readSetting = (record) => readU32(view, INPUT_STATE_OFFSET + record * 12 + 8);
  const techSettings = Object.fromEntries(
    Object.entries(TECH_SETTING_RECORDS).map(([name, record]) => [name, readSetting(record)]),
  );
  const bpm = readSetting(7) + 1;

  return {
    id: fallbackId,
    title,
    bpm,
    activeSet,
    targetSet,
    chunkSelector,
    chunkSlots,
    selectedTech,
    techSettings,
    ...parsedSets,
    ...input,
  };
}
