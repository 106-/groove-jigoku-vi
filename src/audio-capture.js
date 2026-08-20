// Realtime bounce of the engine's master bus: taps masterGain into a
// MediaStreamDestination and records it with MediaRecorder while a timeline
// plays, so the performance can be saved as an audio file.  No browser's
// MediaRecorder emits mp3, so the output is Opus (WebM/Ogg) or AAC (M4A)
// depending on what the browser supports.

// Ordered by preference: AAC/M4A first because it plays in QuickTime, the
// Music app and iOS without a detour; Opus only where MP4 is unavailable
// (Firefox).  audio/mp4;codecs=opus is deliberately skipped — Opus in MP4 is
// poorly supported outside browsers.
const FORMATS = [
  { mime: "audio/mp4;codecs=mp4a.40.2", extension: "m4a", label: "M4A/AAC" },
  { mime: "audio/mp4", extension: "m4a", label: "M4A/AAC" },
  { mime: "audio/webm;codecs=opus", extension: "webm", label: "WebM/Opus" },
  { mime: "audio/ogg;codecs=opus", extension: "ogg", label: "Ogg/Opus" },
  { mime: "audio/webm", extension: "webm", label: "WebM" },
];
const AUDIO_BITS_PER_SECOND = 192000;
// Keep the tap open past the last note so the reverb/delay tail is not cut.
const TAIL_SECONDS = 1.6;

const supportsRecorder = () => typeof window.MediaRecorder === "function";

function pickFormat() {
  if (!supportsRecorder()) return null;
  for (const format of FORMATS) {
    if (window.MediaRecorder.isTypeSupported?.(format.mime)) return format;
  }
  // Unknown browser: let it choose, then read the real type back off the blob.
  return { mime: "", extension: "webm", label: "既定" };
}

function describeType(mimeType, fallback) {
  const base = String(mimeType ?? "").split(";")[0].trim();
  const known = FORMATS.find((format) => format.mime.split(";")[0] === base);
  if (known) return { extension: known.extension, label: known.label };
  if (base === "audio/ogg") return { extension: "ogg", label: "Ogg" };
  return { extension: fallback.extension, label: fallback.label };
}

function stamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

const sanitize = (name) => (
  String(name ?? "").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 48) || "timeline"
);

export function createAudioCapture(engine) {
  const format = pickFormat();
  let armed = false;
  let session = null;
  let finishing = null;
  let lastResult = null;
  // Skips the reverb-tail wait when a new take has to start immediately.
  let cutTail = () => {};

  const capture = {
    onFinished: null,
    get supported() { return supportsRecorder(); },
    get armed() { return armed; },
    get recording() { return Boolean(session); },
    get lastResult() { return lastResult; },

    setArmed(value) {
      armed = Boolean(value) && supportsRecorder();
      return armed;
    },

    // Called by the timeline player right before engine.start(); the audio
    // graph already exists by then.  Disarms itself so one arm means one take.
    async begin(timeline) {
      if (!armed || session || !engine.context || !engine.masterGain) return false;
      armed = false;
      // A previous take may still be capturing its tail — close it out first.
      if (finishing) {
        cutTail();
        await finishing;
      }
      const node = engine.context.createMediaStreamDestination();
      engine.masterGain.connect(node);
      let recorder;
      try {
        const options = { audioBitsPerSecond: AUDIO_BITS_PER_SECOND };
        if (format.mime) options.mimeType = format.mime;
        recorder = new window.MediaRecorder(node.stream, options);
      } catch (error) {
        engine.masterGain.disconnect(node);
        throw error;
      }
      const parts = [];
      recorder.ondataavailable = (event) => {
        if (event.data?.size) parts.push(event.data);
      };
      session = {
        node,
        recorder,
        parts,
        baseName: sanitize(timeline?.meta?.id ?? timeline?.meta?.title),
        startTime: engine.context.currentTime,
      };
      recorder.start();
      return true;
    },

    // Called from the timeline player's teardown.  Resolves once the file is
    // assembled; onFinished fires with the same result.
    finish() {
      if (!session) return Promise.resolve(null);
      const take = session;
      session = null;
      const seconds = Math.max(0, engine.context.currentTime - take.startTime);
      finishing = (async () => {
        await new Promise((resolve) => {
          const timer = window.setTimeout(resolve, TAIL_SECONDS * 1000);
          cutTail = () => { window.clearTimeout(timer); resolve(); };
        });
        cutTail = () => {};
        if (take.recorder.state !== "inactive") {
          await new Promise((resolve) => {
            take.recorder.onstop = resolve;
            take.recorder.stop();
          });
        }
        engine.masterGain.disconnect(take.node);
        const type = take.parts[0]?.type || take.recorder.mimeType || "audio/webm";
        const { extension, label } = describeType(type, format);
        lastResult = {
          blob: new Blob(take.parts, { type }),
          fileName: `${take.baseName}-${stamp(new Date())}.${extension}`,
          seconds,
          label,
        };
        finishing = null;
        capture.onFinished?.(lastResult);
        return lastResult;
      })();
      return finishing;
    },

    save() {
      if (!lastResult) return false;
      const url = URL.createObjectURL(lastResult.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = lastResult.fileName;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
      return true;
    },
  };

  return capture;
}
