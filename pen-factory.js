// ボールペンコウジョウ (バイトのミニゲーム)。
// 右から流れてくるペンにキャップをかぶせる。ペン先が下向きのペンは
// ひっくり返してからでないと成果にならない。出来高制・時給¥0。
// 効果音は専用の軽量 AudioContext で合成し、DJ 再生とは独立して動く。

const MONEY_KEY = "groove-jigoku-vi-money-v1";
const BELT_Y = 190;          // ベルト上面
const PEN_SPEED = 85;        // px/s
const ZONE = { x0: 110, x1: 230 };

export function initPenFactory() {
  const $ = (selector) => document.querySelector(selector);
  const jobButton = $("#jobBtn");
  const dialog = $("#penFactoryDialog");
  const moneyLabel = $("#moneyLabel");
  const factoryMoney = $("#factoryMoney");
  const flipButton = $("#flipBtn");
  const capButton = $("#capBtn");
  const canvas = $("#factoryCanvas");
  const fc = canvas.getContext("2d");

  let money = 0;
  try { money = Number(localStorage.getItem(MONEY_KEY)) || 0; } catch { /* 無視 */ }

  // ---------- 効果音 ----------
  let audio = null;
  let master = null;
  let noiseBuf = null;
  const ensureAudio = () => {
    if (!audio) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      audio = new AudioContextClass({ latencyHint: "interactive" });
      master = audio.createGain();
      master.gain.value = 0.5;
      master.connect(audio.destination);
    }
    audio.resume();
  };
  const noiseBuffer = () => {
    if (!noiseBuf) {
      noiseBuf = audio.createBuffer(1, audio.sampleRate, audio.sampleRate);
      const data = noiseBuf.getChannelData(0);
      for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    }
    return noiseBuf;
  };
  const makeNoise = (t, dur) => {
    const source = audio.createBufferSource();
    source.buffer = noiseBuffer();
    source.start(t);
    source.stop(t + dur);
    return source;
  };
  const makeOsc = (type, freq, t, dur) => {
    const osc = audio.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    osc.start(t);
    osc.stop(t + dur);
    return osc;
  };
  const makeGain = (t, peak, decay) => {
    const gain = audio.createGain();
    gain.gain.setValueAtTime(peak, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + decay);
    return gain;
  };
  const seFlip = () => {
    const t = audio.currentTime;
    const noise = makeNoise(t, 0.09);
    const bp = audio.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 2;
    bp.frequency.setValueAtTime(600, t);
    bp.frequency.exponentialRampToValueAtTime(2400, t + 0.08);
    noise.connect(bp).connect(makeGain(t, 0.25, 0.09)).connect(master);
  };
  const seCap = () => {
    const t = audio.currentTime;
    makeOsc("square", 1400, t, 0.03).connect(makeGain(t, 0.12, 0.03)).connect(master);
  };
  const seCoin = () => {
    const t = audio.currentTime;
    [1318.5, 1760].forEach((freq, i) => {
      makeOsc("triangle", freq, t + i * 0.07, 0.15)
        .connect(makeGain(t + i * 0.07, 0.22, 0.14)).connect(master);
    });
  };
  const seMiss = () => {
    const t = audio.currentTime;
    makeOsc("square", 110, t, 0.18).connect(makeGain(t, 0.18, 0.16)).connect(master);
  };

  // ---------- 状態 ----------
  let open = false;
  let pens = [];       // {x, tipDown, capped, capOnTip, flipping, flip, capAnim}
  let floats = [];     // {x, y, text, color, age}
  let spawnIn = 0;
  let beltOff = 0;
  let raf = 0;
  let lastT = 0;

  const updateMoneyUI = () => {
    moneyLabel.textContent = `所持金 ¥${money}`;
    factoryMoney.textContent = `¥${money}`;
    try { localStorage.setItem(MONEY_KEY, String(money)); } catch { /* 無視 */ }
  };

  // ---------- 進行 ----------
  const penInZone = () => pens.find((pen) => pen.x >= ZONE.x0 && pen.x <= ZONE.x1);

  const loop = (now) => {
    if (!open) return;
    const dt = Math.min((now - lastT) / 1000, 0.05);
    lastT = now;

    spawnIn -= dt;
    if (spawnIn <= 0) {
      pens.push({
        x: canvas.width + 30,
        tipDown: Math.random() < 0.5,
        capped: false,
        capOnTip: false,
        flipping: false,
        flip: 0,
        capAnim: 0,
      });
      spawnIn = 1.3 + Math.random() * 0.7;
    }

    beltOff = (beltOff + PEN_SPEED * dt) % 24;
    for (const pen of pens) {
      pen.x -= PEN_SPEED * dt;
      if (pen.flipping) {
        pen.flip += dt / 0.16;
        if (pen.flip >= 1) { pen.flip = 0; pen.flipping = false; }
      }
      if (pen.capped && pen.capAnim < 1) pen.capAnim = Math.min(1, pen.capAnim + dt / 0.12);
    }
    pens = pens.filter((pen) => pen.x > -40);

    for (const float of floats) { float.age += dt; float.y -= 30 * dt; }
    floats = floats.filter((float) => float.age < 1);

    draw();
    raf = requestAnimationFrame(loop);
  };

  // ---------- 操作 ----------
  const flashButton = (button) => {
    button.classList.add("pressed");
    window.setTimeout(() => button.classList.remove("pressed"), 100);
  };

  const flipAction = () => {
    flashButton(flipButton);
    seFlip();
    const pen = penInZone();
    if (!pen) return; // 空振り(ペナルティなし)
    pen.tipDown = !pen.tipDown;
    pen.flipping = true;
    pen.flip = 0;
  };

  const capAction = () => {
    flashButton(capButton);
    seCap();
    const pen = penInZone();
    if (!pen || pen.capped) return; // 空振り(ペナルティなし)
    pen.capped = true;
    pen.capAnim = 0;
    pen.capOnTip = !pen.tipDown; // 下向きのままだとキャップは尻側に乗る=失敗
    if (pen.capOnTip) {
      const gain = 1 + Math.floor(Math.random() * 5); // 数円(出来高制)
      money += gain;
      updateMoneyUI();
      seCoin();
      floats.push({ x: pen.x, y: BELT_Y - 120, text: `+¥${gain}`, color: "#39ff14", age: 0 });
    } else {
      seMiss();
      floats.push({ x: pen.x, y: BELT_Y - 120, text: "ダメ", color: "#ff5577", age: 0 });
    }
  };

  // ---------- 描画 ----------
  const roundRectFill = (c, x, y, w, h, r) => {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
    c.fill();
  };

  const drawPen = (pen) => {
    fc.save();
    fc.translate(pen.x, BELT_Y - 50);
    let rot = 0;
    if (pen.flipping) rot += Math.PI * (1 - Math.min(pen.flip, 1));
    if (pen.tipDown) rot += Math.PI;
    fc.rotate(rot);

    // ここからペン先が上向きのローカル座標
    fc.fillStyle = "#ece9f4"; // 本体
    fc.fillRect(-7, -26, 14, 60);
    fc.fillStyle = "#2d7ef7"; // インク窓
    fc.fillRect(-3, -18, 6, 40);
    fc.fillStyle = "#b9b4c9"; // 先端コーン
    fc.beginPath();
    fc.moveTo(-7, -26); fc.lineTo(7, -26); fc.lineTo(1.5, -40); fc.lineTo(-1.5, -40);
    fc.closePath();
    fc.fill();
    fc.fillStyle = "#222";    // ペン先
    fc.fillRect(-1.5, -45, 3, 6);
    fc.fillStyle = "#9a93b3"; // 尻ボタン
    fc.fillRect(-5, 34, 10, 7);

    if (pen.capped) {
      const slide = (1 - pen.capAnim) * 26;
      fc.fillStyle = "#ff2ee6";
      if (pen.capOnTip) {
        roundRectFill(fc, -9, -48 - slide, 18, 30, 4);
        fc.fillRect(7, -46 - slide, 3, 22); // クリップ
      } else {
        roundRectFill(fc, -9, 18 + slide, 18, 30, 4);
        fc.fillRect(7, 26 + slide, 3, 22);
      }
    }
    fc.restore();
  };

  const draw = () => {
    const W = canvas.width;
    const H = canvas.height;

    fc.fillStyle = "#171028";
    fc.fillRect(0, 0, W, H);
    fc.fillStyle = "#1c1332"; // 壁
    for (let i = 0; i < W; i += 40) fc.fillRect(i, 0, 20, H);

    // 作業エリア
    fc.fillStyle = "rgba(255,230,0,0.07)";
    fc.fillRect(ZONE.x0, 24, ZONE.x1 - ZONE.x0, BELT_Y - 10);
    fc.strokeStyle = "rgba(255,230,0,0.6)";
    fc.setLineDash([6, 5]);
    fc.strokeRect(ZONE.x0, 24, ZONE.x1 - ZONE.x0, BELT_Y - 10);
    fc.setLineDash([]);
    fc.textAlign = "center";
    fc.font = "bold 12px sans-serif";
    fc.fillStyle = "rgba(255,230,0,0.85)";
    fc.fillText("作業エリア", (ZONE.x0 + ZONE.x1) / 2, 42);

    // ベルトコンベア
    fc.fillStyle = "#0d0a18";
    fc.fillRect(0, BELT_Y, W, 28);
    fc.fillStyle = "#2c2152";
    for (let x = -24; x < W + 24; x += 24) fc.fillRect(x - beltOff, BELT_Y + 3, 12, 22);
    fc.fillStyle = "#3a2868";
    fc.fillRect(0, BELT_Y, W, 3);

    // ゾーン内の未処理ペンを光らせる
    const active = penInZone();
    if (active && !active.capped) {
      fc.fillStyle = "rgba(57,255,20,0.25)";
      fc.beginPath();
      fc.ellipse(active.x, BELT_Y + 8, 26, 7, 0, 0, Math.PI * 2);
      fc.fill();
    }

    for (const pen of pens) drawPen(pen);

    // フロートテキスト
    fc.font = "bold 18px sans-serif";
    for (const float of floats) {
      fc.globalAlpha = Math.max(0, 1 - float.age);
      fc.fillStyle = float.color;
      fc.fillText(float.text, float.x, float.y);
    }
    fc.globalAlpha = 1;
    fc.textAlign = "left";
  };

  // ---------- 開閉 ----------
  const openFactory = () => {
    ensureAudio();
    open = true;
    pens = [];
    floats = [];
    spawnIn = 0.6;
    updateMoneyUI();
    dialog.showModal();
    lastT = performance.now();
    raf = requestAnimationFrame(loop);
  };

  const closeFactory = () => {
    open = false;
    cancelAnimationFrame(raf);
    if (dialog.open) dialog.close();
  };

  jobButton.addEventListener("click", openFactory);
  $("#jobAdClose").addEventListener("click", () => {
    $("#jobAd").remove(); // 貼り紙を剥がす(リロードで復活)
  });
  $("#factoryClose").addEventListener("click", closeFactory);
  dialog.addEventListener("close", () => {
    open = false;
    cancelAnimationFrame(raf);
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeFactory();
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key.toLowerCase() === "z") { event.preventDefault(); flipAction(); }
    if (event.key.toLowerCase() === "x") { event.preventDefault(); capAction(); }
    if (event.code === "Space") event.preventDefault(); // DJ側の再生停止を誤爆させない
  });
  flipButton.addEventListener("click", flipAction);
  capButton.addEventListener("click", capAction);

  updateMoneyUI();
}
