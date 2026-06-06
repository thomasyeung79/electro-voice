// ═══════════════════════════════════════════════════════════════════
//  Electro Voice — 实时电音变声器 (Merged)
//  融合 5 种电音模式 + 音阶量化修音 + 失真/比特压缩
// ═══════════════════════════════════════════════════════════════════

// ─── AudioWorklet 内联 DSP ───────────────────────────────────────
const WORKLET_CODE = `
const SCALE_MAP = {
  chromatic:  [0,1,2,3,4,5,6,7,8,9,10,11],
  major:      [0,2,4,5,7,9,11],
  minor:      [0,2,3,5,7,8,10],
  pentatonic: [0,2,4,7,9]
};
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

// ── 自相关音高检测（带抛物线插值） ──
function detectPitch(buf, sr) {
  const len = buf.length;
  const minF = 65, maxF = 900;
  const minT = Math.floor(sr / maxF) + 1;
  const maxT = Math.floor(sr / minF);
  if (minT >= maxT) return -1;
  let bestT = 0, bestR = -1;
  for (let t = minT; t <= maxT; t++) {
    const n = len - t;
    let corr = 0, e1 = 0;
    for (let i = 0; i < n; i++) { const s = buf[i]; corr += s * buf[i + t]; e1 += s * s; }
    let e2 = 0; for (let i = t; i < len; i++) e2 += buf[i] * buf[i];
    const norm = 0.5 * (e1 + e2);
    const r = norm > 1e-10 ? corr / norm : 0;
    if (r > bestR) { bestR = r; bestT = t; }
  }
  if (bestR < 0.08 || bestT === 0) return -1;
  // 抛物线插值，三个点用同一归一化方式
  function normCorrAt(t) {
    if (t < 1 || t >= len) return 0;
    const n = len - t; let corr = 0, e1 = 0, e2 = 0;
    for (let i = 0; i < n; i++) { const s = buf[i]; corr += s * buf[i + t]; e1 += s * s; }
    for (let i = t; i < len; i++) e2 += buf[i] * buf[i];
    const norm = 0.5 * (e1 + e2); return norm > 1e-10 ? corr / norm : 0;
  }
  if (bestT > minT && bestT < maxT) {
    const r1 = normCorrAt(bestT - 1), r2 = bestR, r3 = normCorrAt(bestT + 1);
    const a = (r1 + r3 - 2 * r2) * 0.5;
    if (Math.abs(a) > 1e-15) { const d = (r1 - r3) / (2 * a); if (Math.abs(d) < 1) bestT += d; }
  }
  return sr / bestT;
}

// ── 频率 → 最近音阶音高 ──
function quantizePitch(freq, intervals, rootNote) {
  if (freq <= 0) return -1;
  const midi = 12 * Math.log2(freq / 440) + 69;
  const octave = Math.floor((midi - rootNote) / 12);
  const noteInOctave = ((midi - rootNote) % 12 + 12) % 12;
  let bestDist = 12, bestNote = 0;
  for (const iv of intervals) {
    let d = Math.abs(noteInOctave - iv);
    if (d > 6) d = 12 - d;
    if (d < bestDist) { bestDist = d; bestNote = iv; }
  }
  const targetMidi = rootNote + octave * 12 + bestNote;
  return 440 * Math.pow(2, (targetMidi - 69) / 12);
}

// ── 简单音高锁定（回到 12 平均律最近音） ──
function snapToEqualTemperament(freq) {
  if (freq <= 0) return -1;
  const midi = 12 * Math.log2(freq / 440) + 69;
  const snapped = Math.round(midi);
  return 440 * Math.pow(2, (snapped - 69) / 12);
}

// ── 处理器 ──
class ElectroVoiceWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(4096);
    this.wp = 0;
    this.sr = sampleRate;
    this.detectEvery = 256;
    this.sampleCount = 0;

    this.rawPitch = [-1, -1, -1, -1, -1];
    this.pitchIdx = 0;
    this.smoothedFreq = -1;
    this.phase = 0; this.phase2 = 0;

    // 参数
    this.mode = 'autoTune';
    this.mix = 1;
    this.strength = 0.85;
    this.formant = 0.5;
    this.distortion = 0;
    this.bitcrush = 0;
    this.warmth = 0.6;
    this.scale = 'chromatic';
    this.intervals = SCALE_MAP.chromatic;
    this.rootNote = 60;
    this.tuneMix = 1;

    // 平滑包络（消除爆音）
    this.smoothAmp = 0;        // 平滑后的振幅
    this.attack = 0.002;       // 起音时间（系数）
    this.release = 0.0005;     // 释音时间

    // DC blocker
    this.dcIn1 = 0; this.dcIn2 = 0; this.dcOut1 = 0; this.dcOut2 = 0;
    const R = 0.995;
    this.dcR = R;

    // 共振峰（一阶低通/高通）
    this.fpPrev = 0;

    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.mode !== undefined) this.mode = d.mode;
      if (d.mix !== undefined) this.mix = Math.max(0, Math.min(1, d.mix));
      if (d.strength !== undefined) this.strength = Math.max(0, Math.min(1, d.strength));
      if (d.formant !== undefined) this.formant = Math.max(0, Math.min(1, d.formant));
      if (d.distortion !== undefined) this.distortion = Math.max(0, Math.min(1, d.distortion));
      if (d.bitcrush !== undefined) this.bitcrush = Math.max(0, Math.min(1, d.bitcrush));
      if (d.warmth !== undefined) this.warmth = Math.max(0, Math.min(1, d.warmth));
      if (d.tuneMix !== undefined) this.tuneMix = Math.max(0, Math.min(1, d.tuneMix));
      if (d.scale && SCALE_MAP[d.scale]) { this.scale = d.scale; this.intervals = SCALE_MAP[d.scale]; }
    };
  }

  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    if (!inp || !inp[0] || !out || !out[0]) return true;

    const ch = inp[0], och = out[0], len = ch.length;

    // 写环形缓冲
    for (let i = 0; i < len; i++) {
      this.buf[this.wp] = ch[i];
      this.wp = (this.wp + 1) % this.buf.length;
    }

    // ── 音高检测 ──
    this.sampleCount += len;
    let detectedFreq = this.smoothedFreq;
    if (this.sampleCount >= this.detectEvery) {
      this.sampleCount = 0;
      const dbuf = new Float32Array(2048);
      let rp = this.wp - 2048;
      if (rp < 0) rp += this.buf.length;
      for (let i = 0; i < 2048; i++) dbuf[i] = this.buf[(rp + i) % this.buf.length];

      const p = detectPitch(dbuf, this.sr);
      this.rawPitch[this.pitchIdx % 5] = p;
      this.pitchIdx++;
      const valid = this.rawPitch.filter(x => x > 0);
      if (valid.length >= 2) {
        const sorted = [...valid].sort((a, b) => a - b);
        detectedFreq = sorted[Math.floor(sorted.length / 2)];
      } else if (valid.length === 1) {
        detectedFreq = valid[0];
      } else {
        detectedFreq = -1;
      }

      // 音阶量化
      if (detectedFreq > 0) {
        if (this.mode === 'autoTune' || this.mode === 'ethereal') {
          const q = quantizePitch(detectedFreq, this.intervals, this.rootNote);
          if (q > 0) detectedFreq = detectedFreq + (q - detectedFreq) * this.strength;
        } else if (this.mode === 'robot' || this.mode === 'hardcore') {
          const sn = snapToEqualTemperament(detectedFreq);
          if (sn > 0) detectedFreq = sn;
        }
      }

      // 平滑
      if (detectedFreq > 0) {
        if (this.smoothedFreq < 0) {
          this.smoothedFreq = detectedFreq;
        } else {
          this.smoothedFreq += (detectedFreq - this.smoothedFreq) * 0.35;
        }
      } else {
        if (this.smoothedFreq > 0) { this.smoothedFreq *= 0.98; if (this.smoothedFreq < 50) this.smoothedFreq = -1; }
      }

      // 上报
      if (this.smoothedFreq > 0) {
        const midi = Math.round(12 * Math.log2(this.smoothedFreq / 440) + 69);
        const n = midi % 12, oct = Math.floor(midi / 12) - 1;
        this.port.postMessage({ type: 'pitch', freq: Math.round(this.smoothedFreq * 10) / 10,
          note: NOTE_NAMES[((n % 12) + 12) % 12] + oct, midi, active: true });
      } else {
        this.port.postMessage({ type: 'pitch', active: false });
      }
    }

    // ── 逐样本处理 ──
    for (let i = 0; i < len; i++) {
      const s = ch[i];

      // 包络跟随（平滑 attack/release，避免硬开关爆音）
      const abs = Math.abs(s);
      const envTarget = abs;
      if (envTarget > this.smoothAmp) {
        this.smoothAmp += (envTarget - this.smoothAmp) * this.attack;
      } else {
        this.smoothAmp += (envTarget - this.smoothAmp) * this.release;
      }

      let processed = 0;
      const sp = this.smoothedFreq;
      const amp = Math.sqrt(Math.max(0.0001, this.smoothAmp));

      // 只有在信号够强且有音高时才合成（但不要硬切，用振幅渐变）
      const hasSignal = sp > 0 && this.smoothAmp > 0.002;

      if (hasSignal) {
        // ── 确定目标频率 ──
        let targetFreq = sp;
        switch (this.mode) {
          case 'autoTune': targetFreq = sp; break;
          case 'robot':
            targetFreq = snapToEqualTemperament(sp);
            if (targetFreq < 0) targetFreq = sp;
            break;
          case 'alien':
            targetFreq = sp * (0.5 + this.formant * 1.5);
            break;
          case 'ethereal': targetFreq = sp; break;
          case 'hardcore':
            targetFreq = snapToEqualTemperament(sp);
            if (targetFreq < 0) targetFreq = sp;
            break;
          default: targetFreq = sp;
        }
        targetFreq = Math.max(50, Math.min(2000, targetFreq));

        // ── 相位递进（永不重置，避免相位跳跃爆音） ──
        this.phase += 2 * Math.PI * targetFreq / this.sr;
        if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;

        // ── 软波形合成（消除方波硬切导致的混叠） ──
        let sig;
        const p = this.phase;
        switch (this.mode) {
          case 'autoTune':
          case 'ethereal':
            sig = Math.sin(p) * 0.65 +
                  Math.sin(p * 2) * 0.25 +
                  Math.sin(p * 3) * 0.1;
            break;
          case 'alien':
            sig = Math.sin(p) * 0.75 +
                  Math.sin(p * 3) * 0.25;
            break;
          case 'robot':
            // 软方波：tanh(sin * gain)
            sig = Math.tanh(Math.sin(p) * 3.0) * 0.5 +
                  Math.sin(p) * 0.25 +
                  Math.sin(p * 2) * 0.15 +
                  Math.sin(p * 3) * 0.1;
            break;
          case 'hardcore':
            // 软方波 + 更多失真
            sig = Math.tanh(Math.sin(p) * 4.0) * 0.55 +
                  Math.sin(p) * 0.35;
            break;
          default:
            sig = Math.sin(p);
        }

        // ethereal: 微量失谐第二声部
        if (this.mode === 'ethereal') {
          this.phase2 += 2 * Math.PI * targetFreq * 1.005 / this.sr;
          if (this.phase2 > 2 * Math.PI) this.phase2 -= 2 * Math.PI;
          sig = sig * 0.6 + Math.sin(this.phase2) * 0.4;
        }

        // 温暖度混合
        if (this.mode === 'autoTune' || this.mode === 'ethereal') {
          sig *= (0.7 + this.warmth * 0.3);
        }

        // 用平滑振幅包络（消除爆音）
        processed = sig * amp;

        // 共振峰（一阶滤波器，避免 prevDry 混入未处理信号）
        if (this.mode !== 'autoTune' && this.mode !== 'ethereal') {
          const tilt = (this.formant - 0.5) * 2;  // -1 ~ 1
          // 简单一阶 shelving
          const a = 0.15;
          this.fpPrev = this.fpPrev * (1 - a) + processed * a;
          processed = processed + this.fpPrev * tilt * 0.3;
        }
      }

      // ── 失真（用 soft clip 代替 tanh/tanh 除法，避免除零爆音） ──
      let wet = processed;
      if (this.distortion > 0.01) {
        const drive = 1 + this.distortion * 6;
        // soft clip: atan 比 tanh 更温和
        let x = wet * drive;
        const clip = Math.atan(x) / Math.atan(drive);
        wet = wet * (1 - this.distortion * 0.3) + clip * (this.distortion * 0.3);
      }

      // ── 比特压缩 ──
      if (this.bitcrush > 0.01) {
        const steps = Math.max(2, Math.round(256 * (1 - this.bitcrush)));
        const stepSize = 2 / steps;
        wet = Math.round(wet / stepSize) * stepSize;
      }

      // ── 干湿混合 ──
      const outMix = this.mix;
      let result = s * (1 - outMix) + wet * outMix;

      // ── DC blocker ──
      this.dcIn1 = this.dcIn2; this.dcIn2 = result;
      result = this.dcIn2 - this.dcIn1 + this.dcR * this.dcOut1;
      this.dcOut1 = result;

      // ── 削波保护 ──
      och[i] = Math.max(-1, Math.min(1, result));
    }
    return true;
  }
}
registerProcessor('electro-voice-worklet', ElectroVoiceWorklet);
`;

// ═══════════════════════════════════════════════════════════════════
//  Main Thread
// ═══════════════════════════════════════════════════════════════════

const els = {
  scope: document.querySelector("#scope"),
  status: document.querySelector("#status"),
  inlineStatus: document.querySelector("#inlineStatus"),
  startLive: document.querySelector("#startLive"),
  liveRecord: document.querySelector("#liveRecord"),
  stopLive: document.querySelector("#stopLive"),
  startRecord: document.querySelector("#startRecord"),
  stopRecord: document.querySelector("#stopRecord"),
  scanMic: document.querySelector("#scanMic"),
  micState: document.querySelector("#micState"),
  micDevice: document.querySelector("#micDevice"),
  outputTray: document.querySelector("#outputTray"),
  outputName: document.querySelector("#outputName"),
  downloadLink: document.querySelector("#downloadLink"),
  saveFile: document.querySelector("#saveFile"),
  fileInput: document.querySelector("#fileInput"),
  fileName: document.querySelector("#fileName"),
  playFile: document.querySelector("#playFile"),
  exportFile: document.querySelector("#exportFile"),
  stopFile: document.querySelector("#stopFile"),
  lowLatency: document.querySelector("#lowLatency"),
  monitor: document.querySelector("#monitor"),
  pitchOn: document.querySelector("#pitchOn"),
  pitchMix: document.querySelector("#pitchMix"),
  scale: document.querySelector("#scale"),
  synthOn: document.querySelector("#synthOn"),
  synthMix: document.querySelector("#synthMix"),
  carrier: document.querySelector("#carrier"),
  crushOn: document.querySelector("#crushOn"),
  crush: document.querySelector("#crush"),
  spaceOn: document.querySelector("#spaceOn"),
  space: document.querySelector("#space"),
  // — 新增元素 —
  noteDisplay: document.querySelector("#noteDisplay"),
  freqDisplay: document.querySelector("#freqDisplay"),
  autoTuneMix: document.querySelector("#autoTuneMix"),
  presetLoad: document.querySelector("#presetLoad"),
  presetSave: document.querySelector("#presetSave"),
  presetDelete: document.querySelector("#presetDelete"),
  spectrumToggle: document.querySelector("#spectrumToggle"),
  warm: document.querySelector("#warm"),
  // — 来自 electro-voice.html 的模式元素 —
  modeBtns: document.querySelectorAll('.voice-mode-btn'),
  modeInfo: document.querySelector("#modeInfo"),
  modeLabel: document.querySelector("#modeLabel"),
  strength: document.querySelector("#strength"),
  formant: document.querySelector("#formant"),
  distortionRange: document.querySelector("#distortion"),
  bitcrushRange: document.querySelector("#bitcrush"),
};

const outs = {
  monitor: document.querySelector("#monitorOut"),
  pitchMix: document.querySelector("#pitchMixOut"),
  synthMix: document.querySelector("#synthMixOut"),
  carrier: document.querySelector("#carrierOut"),
  crush: document.querySelector("#crushOut"),
  space: document.querySelector("#spaceOut"),
  autoTuneMix: document.querySelector("#autoTuneMixOut"),
  warm: document.querySelector("#warmOut"),
  strength: document.querySelector("#strengthOut"),
  formant: document.querySelector("#formantOut"),
  distortion: document.querySelector("#distortionOut"),
  bitcrush: document.querySelector("#bitcrushOut"),
};

let audio;
let chain;
let liveStream;
let liveSource;
let fileBuffer;
let fileSource;
let drawId;
let lfo;
let wavRecording = false;
let wavLeft = [];
let wavRight = [];
let wavLength = 0;
let captureSampleRate = 44100;
let lastDownloadUrl = "";
let lastDownloadBlob = null;
let lastDownloadName = "electro-voice.wav";
let autoTuneNode = null;
let useSpectrum = false;

const scales = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  pentatonic: [0, 3, 5, 7, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
};

// 模式信息
const MODE_INFO = {
  autoTune: { label: '经典电音', desc: '将声音自动修正到最近音阶，产生标志性电音效果，适合唱歌和说话' },
  robot:    { label: '机器人',   desc: '用方波重新合成人声，打造机械感十足的机器人嗓音' },
  alien:    { label: '外星人',   desc: '改变共振峰频率，制造非人类的外星生物声线' },
  ethereal: { label: '空灵',     desc: '电音修音 + 双声部合唱，营造空灵缥缈的氛围感' },
  hardcore: { label: '电子核',   desc: '暴力电音 + 失真 + 比特压缩，极致电子工业风' },
};

function setStatus(text) {
  if (els.status) els.status.textContent = text;
  if (els.inlineStatus) els.inlineStatus.textContent = text;
}
function setMicInfo(state, detail) {
  if (els.micState) els.micState.textContent = state;
  if (els.micDevice) els.micDevice.textContent = detail;
}

// ─── 麦克风 ───
async function getMicPermissionState() {
  if (!navigator.permissions?.query) return "unknown";
  try { const p = await navigator.permissions.query({ name: "microphone" }); p.onchange = () => detectMicrophones(); return p.state; } catch { return "unknown"; }
}
async function requestTemporaryMicStream() {
  const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  s.getTracks().forEach(t => t.stop());
}
async function detectMicrophones(options = {}) {
  const { requestPermission = false } = options;
  if (!navigator.mediaDevices?.enumerateDevices) { setMicInfo("浏览器不支持", "无麦克风设备列表"); return; }
  try {
    const state = await getMicPermissionState();
    if (requestPermission && state !== "granted") { setMicInfo("等待授权", "请在浏览器弹窗允许麦克风"); await requestTemporaryMicStream(); }
    const devs = await navigator.mediaDevices.enumerateDevices();
    const mics = devs.filter(d => d.kind === "audioinput");
    if (!mics.length) { setMicInfo("⚠️ 未检测到麦克风", "检查设备连接或重新插拔"); return; }
    const named = mics.map(d => d.label).filter(Boolean);
    if (!named.length) {
      if (state === "denied") { setMicInfo("🚫 权限已拒绝", "请修改浏览器权限后刷新"); setStatus("麦克风权限被拒绝，请在地址栏权限设置中允许麦克风。"); return; }
      // 有设备但没名字 = 需要先授权
      setMicInfo("🔄 检测到 " + mics.length + " 个输入设备", "点击「实时传声」授权麦克风后显示名称");
      return;
    }
    setMicInfo("✅ 麦克风已就绪", named.slice(0, 2).join(" / ") + (named.length > 2 ? " 等 " + named.length + " 个" : ""));
  } catch (err) { setMicInfo("无法读取麦克风", err.name === "NotAllowedError" ? "权限被拒绝" : err.message); }
}
function showActiveInput(stream) {
  const [track] = stream.getAudioTracks();
  if (!track) { setMicInfo("无输入轨道", ""); return; }
  const s = track.getSettings?.() || {};
  setMicInfo("正在使用麦克风", track.label + (s.sampleRate ? " · " + s.sampleRate + " Hz" : ""));
}

// ─── AudioWorklet ───
async function loadWorklet(ctx) {
  const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
}

// ─── 创建效果链 ───
async function ensureAudio() {
  if (audio) { await audio.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error("浏览器不支持 Web Audio");
  audio = new AC({ latencyHint: "interactive", sampleRate: 48000 });
  await loadWorklet(audio);

  autoTuneNode = new AudioWorkletNode(audio, 'electro-voice-worklet');
  autoTuneNode.port.onmessage = (e) => {
    const d = e.data;
    if (d.type === 'pitch') updatePitchDisplay(d);
  };

  chain = createEffectChain(audio);
  updateEffectValues();
  drawScope();
}

function createEffectChain(ctx) {
  const input = ctx.createGain();
  const dry = ctx.createGain();
  const tuned = ctx.createDelay(0.045);
  const tuneFeedback = ctx.createGain();
  const tuneWet = ctx.createGain();
  const synthIn = ctx.createGain();
  const synthWet = ctx.createGain();
  const crusher = ctx.createWaveShaper();
  const crusherWet = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  const delay = ctx.createDelay(0.7);
  const delayFeedback = ctx.createGain();
  const delayWet = ctx.createGain();
  const convolver = ctx.createConvolver();
  const reverbWet = ctx.createGain();
  const output = ctx.createGain();
  const analyser = ctx.createAnalyser();
  const capture = ctx.createScriptProcessor(4096, 2, 2);
  const captureMute = ctx.createGain();
  // 反馈抑制：限制器 + 低频切除
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 6;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.1;

  lfo = ctx.createOscillator();
  const lfoGain = ctx.createGain();
  lfo.type = "square"; lfo.frequency.value = 7.5; lfoGain.gain.value = 0.012;
  lfo.connect(lfoGain); lfoGain.connect(tuned.delayTime); lfo.start();

  const carrier = ctx.createOscillator();
  const carrierGain = ctx.createGain();
  const ring = ctx.createGain();
  const maskHigh = ctx.createBiquadFilter();
  const maskBand = ctx.createBiquadFilter();
  const maskPeak = ctx.createBiquadFilter();
  carrier.type = "sawtooth"; carrier.frequency.value = 96; carrierGain.gain.value = 0;
  carrier.connect(carrierGain); carrierGain.connect(ring.gain); carrier.start();

  // 信号流: input → autoTuneNode → 效果链 → output
  input.connect(autoTuneNode);
  autoTuneNode.connect(dry);
  autoTuneNode.connect(tuned); tuned.connect(tuneFeedback); tuneFeedback.connect(tuned); tuned.connect(tuneWet);
  autoTuneNode.connect(synthIn); synthIn.connect(ring); ring.connect(maskHigh); maskHigh.connect(maskBand); maskBand.connect(maskPeak); maskPeak.connect(synthWet);
  autoTuneNode.connect(crusher); crusher.connect(filter); filter.connect(crusherWet);
  autoTuneNode.connect(delay); delay.connect(delayFeedback); delayFeedback.connect(delay); delay.connect(delayWet);
  autoTuneNode.connect(convolver); convolver.connect(reverbWet);
  dry.connect(output); tuneWet.connect(output); synthWet.connect(output); crusherWet.connect(output); delayWet.connect(output); reverbWet.connect(output);
  output.connect(limiter); limiter.connect(analyser); limiter.connect(capture); capture.connect(captureMute); captureMute.connect(ctx.destination); analyser.connect(ctx.destination);

  analyser.fftSize = 2048;
  filter.type = "lowpass";
  maskHigh.type = "highpass"; maskHigh.frequency.value = 180;
  maskBand.type = "bandpass"; maskBand.frequency.value = 1150; maskBand.Q.value = 1.8;
  maskPeak.type = "peaking"; maskPeak.frequency.value = 2600; maskPeak.Q.value = 1.1; maskPeak.gain.value = 8;
  convolver.buffer = makeImpulse(ctx, 1.8);
  crusher.curve = makeCrusherCurve(0.28);
  output.gain.value = 0.65;
  captureMute.gain.value = 0;
  capture.onaudioprocess = (event) => {
    if (!wavRecording) return;
    const l = event.inputBuffer.getChannelData(0);
    const r = event.inputBuffer.numberOfChannels > 1 ? event.inputBuffer.getChannelData(1) : l;
    wavLeft.push(new Float32Array(l)); wavRight.push(new Float32Array(r)); wavLength += l.length;
  };
  return { input, dry, tuned, tuneFeedback, tuneWet, carrier, carrierGain, maskHigh, maskBand, maskPeak, synthWet, crusher, crusherWet, filter, delay, delayFeedback, delayWet, convolver, reverbWet, output, analyser, capture };
}

function updatePitchDisplay(d) {
  if (!els.noteDisplay || !els.freqDisplay) return;
  if (d.active && d.note) {
    els.noteDisplay.textContent = d.note;
    els.freqDisplay.textContent = d.freq + ' Hz';
    els.noteDisplay.style.opacity = '1';
  } else {
    els.noteDisplay.style.opacity = '0.3';
    els.noteDisplay.textContent = '--';
    els.freqDisplay.textContent = '-- Hz';
  }
}

function getEffectSettings() {
  return {
    pitchOn: els.pitchOn.checked, pitchMix: Number(els.pitchMix.value) / 100, scale: els.scale.value,
    synthOn: els.synthOn.checked, synthMix: Number(els.synthMix.value) / 100, carrier: Number(els.carrier.value),
    crushOn: els.crushOn.checked, crush: Number(els.crush.value) / 100, tone: 7200,
    spaceOn: els.spaceOn.checked, delay: Number(els.space.value) / 100, reverb: Number(els.space.value) / 100,
    lowLatency: els.lowLatency.checked, monitor: Number(els.monitor.value) / 100,
    autoTuneMix: els.autoTuneMix ? Number(els.autoTuneMix.value) / 100 : 1,
    warm: els.warm ? Number(els.warm.value) / 100 : 0.6,
    mode: document.querySelector('.voice-mode-btn.active')?.dataset?.mode || 'autoTune',
    strength: els.strength ? Number(els.strength.value) / 100 : 0.85,
    formant: els.formant ? Number(els.formant.value) / 100 : 0.5,
    distortion: els.distortionRange ? Number(els.distortionRange.value) / 100 : 0,
    bitcrush: els.bitcrushRange ? Number(els.bitcrushRange.value) / 100 : 0,
  };
}

function makeImpulse(ctx, seconds) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6); }
  return buf;
}
function makeCrusherCurve(amount) {
  const n = 4096, c = new Float32Array(n), steps = Math.max(5, Math.round(80 - amount * 72));
  for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; c[i] = Math.round(x * steps) / steps; }
  return c;
}

// ─── 更新效果参数 ───
function updateEffectValues() {
  const pitch = Number(els.pitchMix.value) / 100;
  const synth = Number(els.synthMix.value) / 100;
  const crush = Number(els.crush.value) / 100;
  const space = Number(els.space?.value ?? 16) / 100;
  const monitor = Number(els.monitor.value) / 100;
  const low = els.lowLatency.checked;
  const atMix = els.autoTuneMix ? Number(els.autoTuneMix.value) / 100 : 1;
  const warmth = els.warm ? Number(els.warm.value) / 100 : 0.6;
  const strength = els.strength ? Number(els.strength.value) / 100 : 0.85;
  const distortion = els.distortionRange ? Number(els.distortionRange.value) / 100 : 0;
  const bitcrush = els.bitcrushRange ? Number(els.bitcrushRange.value) / 100 : 0;
  const mode = document.querySelector('.voice-mode-btn.active')?.dataset?.mode || 'autoTune';

  // 显示值
  if (outs.monitor) outs.monitor.textContent = els.monitor.value + '%';
  if (outs.pitchMix) outs.pitchMix.textContent = els.pitchMix.value + '%';
  if (outs.synthMix) outs.synthMix.textContent = els.synthMix.value + '%';
  if (outs.carrier) outs.carrier.textContent = els.carrier.value + ' Hz';
  if (outs.crush) outs.crush.textContent = els.crush.value + '%';
  if (outs.space) outs.space.textContent = Math.round(space * 100) + '%';
  if (outs.autoTuneMix) outs.autoTuneMix.textContent = Math.round(atMix * 100) + '%';
  if (outs.warm) outs.warm.textContent = Math.round(warmth * 100) + '%';
  if (outs.strength) outs.strength.textContent = Math.round(strength * 100) + '%';
  if (outs.formant) outs.formant.textContent = Math.round(Number(els.formant?.value ?? 50)) + '%';
  if (outs.distortion) outs.distortion.textContent = Math.round(distortion * 100) + '%';
  if (outs.bitcrush) outs.bitcrush.textContent = Math.round(bitcrush * 100) + '%';

  // 发送到 AudioWorklet
  if (autoTuneNode) {
    autoTuneNode.port.postMessage({
      mode: mode,
      mix: els.pitchOn.checked ? atMix : 0,
      scale: els.scale.value,
      strength: strength,
      formant: Number(els.formant?.value ?? 50) / 100,
      distortion: distortion,
      bitcrush: bitcrush,
      warmth: els.warm ? warmth : 0.6,
      tuneMix: atMix,
    });
  }

  if (!chain || !audio) return;
  const now = audio.currentTime;

  const maskMode = synth > 0.85 && pitch > 0.88;
  const dryLevel = maskMode ? 0 : Math.max(0.02, 0.42 - pitch * 0.28 - synth * 0.36);
  const tuneLevel = els.pitchOn.checked ? (maskMode ? 0.04 : 0.32 + pitch * 0.42) : 0;
  const synthLevel = els.synthOn.checked ? (maskMode ? 1.45 : synth * 0.98) : 0;
  const crushLevel = els.crushOn.checked ? crush * (maskMode ? 0.08 : 0.16) : 0;

  chain.dry.gain.setTargetAtTime(dryLevel, now, 0.02);
  chain.output.gain.setTargetAtTime(monitor * 1.05, now, 0.02);
  chain.tuned.delayTime.setTargetAtTime(els.pitchOn.checked ? quantizedDelayTime() * (low ? 0.45 : 1) : 0.001, now, 0.02);
  chain.tuneFeedback.gain.setTargetAtTime(els.pitchOn.checked ? (0.11 + pitch * 0.18) * (low ? 0.55 : 1) : 0, now, 0.02);
  chain.tuneWet.gain.setTargetAtTime(tuneLevel, now, 0.02);
  chain.carrier.frequency.setTargetAtTime(Number(els.carrier.value), now, 0.02);
  chain.carrierGain.gain.setTargetAtTime(els.synthOn.checked ? 0.65 + synth * 0.65 : 0, now, 0.02);
  chain.maskBand.frequency.setTargetAtTime(maskMode ? 1120 : 1500, now, 0.02);
  chain.maskBand.Q.setTargetAtTime(maskMode ? 2.2 : 1.2, now, 0.02);
  chain.maskPeak.gain.setTargetAtTime(maskMode ? 10 : 4, now, 0.02);
  chain.synthWet.gain.setTargetAtTime(synthLevel, now, 0.02);
  chain.crusher.curve = makeCrusherCurve(crush);
  chain.crusherWet.gain.setTargetAtTime(crushLevel, now, 0.02);
  chain.filter.frequency.setTargetAtTime(7200, now, 0.02);
  chain.filter.Q.setTargetAtTime(0.65 + crush * 5, now, 0.02);
  chain.delay.delayTime.setTargetAtTime(0.12 + space * 0.38, now, 0.02);
  chain.delayFeedback.gain.setTargetAtTime(els.spaceOn.checked ? space * 0.48 * (low ? 0.45 : 1) : 0, now, 0.02);
  chain.delayWet.gain.setTargetAtTime(els.spaceOn.checked ? space * 0.36 * (low ? 0.4 : 1) : 0, now, 0.02);
  chain.reverbWet.gain.setTargetAtTime(els.spaceOn.checked ? space * 0.42 * (low ? 0.55 : 1) : 0, now, 0.02);
}

function quantizedDelayTime() {
  const s = scales[els.scale.value] || scales.chromatic;
  const a = Number(els.pitchMix.value) / 100;
  const n = s.includes(0) ? 0 : s[0] / 1200;
  return 0.004 + a * (0.008 + n);
}

// ─── 离线渲染 ───
function createRenderGraph(ctx, destination, settings, monitorOverride, preNode) {
  const input = ctx.createGain(); const dry = ctx.createGain(); const tuned = ctx.createDelay(0.045);
  const tuneFeedback = ctx.createGain(); const tuneWet = ctx.createGain(); const synthIn = ctx.createGain();
  const synthWet = ctx.createGain(); const crusher = ctx.createWaveShaper(); const crusherWet = ctx.createGain();
  const filter = ctx.createBiquadFilter(); const delay = ctx.createDelay(0.7); const delayFeedback = ctx.createGain();
  const delayWet = ctx.createGain(); const convolver = ctx.createConvolver(); const reverbWet = ctx.createGain();
  const output = ctx.createGain(); const lfoNode = ctx.createOscillator(); const lfoGain = ctx.createGain();
  const carrier = ctx.createOscillator(); const carrierGain = ctx.createGain(); const ring = ctx.createGain();
  const maskHigh = ctx.createBiquadFilter(); const maskBand = ctx.createBiquadFilter(); const maskPeak = ctx.createBiquadFilter();

  lfoNode.type = "square"; lfoNode.frequency.value = 7.5; lfoGain.gain.value = 0.012;
  lfoNode.connect(lfoGain); lfoGain.connect(tuned.delayTime);
  carrier.type = "sawtooth"; carrier.frequency.value = settings.carrier;
  carrierGain.gain.value = settings.synthOn ? 0.65 + settings.synthMix * 0.65 : 0;
  carrier.connect(carrierGain); carrierGain.connect(ring.gain);

  // 如果传入了 preNode（如 AudioWorkletNode），将其插入 input 和效果链之间
  const chainInput = preNode || input;
  if (preNode) input.connect(preNode);

  chainInput.connect(dry); chainInput.connect(tuned);
  tuned.connect(tuneFeedback); tuneFeedback.connect(tuned); tuned.connect(tuneWet);
  chainInput.connect(synthIn); synthIn.connect(ring);
  ring.connect(maskHigh); maskHigh.connect(maskBand); maskBand.connect(maskPeak); maskPeak.connect(synthWet);
  chainInput.connect(crusher); crusher.connect(filter); filter.connect(crusherWet);
  chainInput.connect(delay); delay.connect(delayFeedback); delayFeedback.connect(delay); delay.connect(delayWet);
  chainInput.connect(convolver); convolver.connect(reverbWet);
  dry.connect(output); tuneWet.connect(output); synthWet.connect(output);
  crusherWet.connect(output); delayWet.connect(output); reverbWet.connect(output);
  output.connect(destination);
  filter.type = "lowpass"; filter.frequency.value = settings.tone || 7200; filter.Q.value = 0.65 + settings.crush * 5;
  maskHigh.type = "highpass"; maskHigh.frequency.value = 180;
  maskBand.type = "bandpass"; const mm = settings.synthMix > 0.85; maskBand.frequency.value = mm ? 1120 : 1500; maskBand.Q.value = mm ? 2.2 : 1.2;
  maskPeak.type = "peaking"; maskPeak.frequency.value = 2600; maskPeak.Q.value = 1.1; maskPeak.gain.value = mm ? 10 : 4;
  convolver.buffer = makeImpulse(ctx, 1.8); crusher.curve = makeCrusherCurve(settings.crush);
  const maskMode = mm && settings.pitchMix > 0.88;
  const dryLevel = maskMode ? 0 : Math.max(0.02, 0.42 - settings.pitchMix * 0.28 - settings.synthMix * 0.36);
  const tuneLevel = settings.pitchOn ? (maskMode ? 0.04 : 0.32 + settings.pitchMix * 0.42) : 0;
  const synthLevel = settings.synthOn ? (maskMode ? 1.45 : settings.synthMix * 0.98) : 0;
  const crushLevel = settings.crushOn ? settings.crush * (maskMode ? 0.08 : 0.16) : 0;
  dry.gain.value = dryLevel; output.gain.value = monitorOverride;
  tuned.delayTime.value = settings.pitchOn ? 0.004 + settings.pitchMix * (0.008 + (scales[settings.scale]?.includes(0) ? 0 : (scales[settings.scale]?.[0] || 0) / 1200)) * (settings.lowLatency ? 0.45 : 1) : 0.001;
  tuneFeedback.gain.value = settings.pitchOn ? (0.11 + settings.pitchMix * 0.18) * (settings.lowLatency ? 0.55 : 1) : 0;
  tuneWet.gain.value = tuneLevel; synthWet.gain.value = synthLevel; crusherWet.gain.value = crushLevel;
  delay.delayTime.value = 0.12 + settings.delay * 0.38;
  delayFeedback.gain.value = settings.spaceOn ? settings.delay * 0.48 * (settings.lowLatency ? 0.45 : 1) : 0;
  delayWet.gain.value = settings.spaceOn ? settings.delay * 0.36 * (settings.lowLatency ? 0.4 : 1) : 0;
  reverbWet.gain.value = settings.spaceOn ? settings.reverb * 0.42 * (settings.lowLatency ? 0.55 : 1) : 0;
  lfoNode.start(0); carrier.start(0);
  return input;
}

// ─── 实时传声 ───
async function startLive() {
  try {
    // 防止快速点击重复创建
    if (liveStream) { liveStream.getTracks().forEach(t => t.stop()); liveStream = null; }
    if (liveSource) { try { liveSource.disconnect(); } catch {} liveSource = null; }

    await ensureAudio(); stopFile();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("浏览器无麦克风接口");
    liveStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    showActiveInput(liveStream);
    liveSource = audio.createMediaStreamSource(liveStream);
    liveSource.connect(chain.input);
    // 授权后重新检测，显示设备名称
    setTimeout(() => detectMicrophones(), 500);
    setStatus("实时传声已开启。说话或唱歌时会输出电音效果。");
    // 更新状态栏绿点
    const dot = document.querySelector('.bottom-status .dot');
    if (dot) dot.style.background = '#48efc1';
  } catch (err) { stopLive(); detectMicrophones(); setStatus("无法开启麦克风：" + err.message); }
}
function stopLive() {
  if (!liveSource && !liveStream && !wavRecording) { setStatus("实时传声已停止。"); return; }
  if (wavRecording) stopRecording();
  if (liveSource) { liveSource.disconnect(); liveSource = null; }
  if (liveStream) { liveStream.getTracks().forEach(t => t.stop()); liveStream = null; }
  const dot = document.querySelector('.bottom-status .dot');
  if (dot) dot.style.background = '#7d7f69';
  setStatus("实时传声已停止。");
}

// ─── 文件 ───
async function loadFile(file) { await ensureAudio(); stopLive(); const bytes = await file.arrayBuffer(); fileBuffer = await audio.decodeAudioData(bytes); if (els.fileName) els.fileName.textContent = file.name; setStatus("已加载：" + file.name); }
async function playFile() {
  if (!fileBuffer) { setStatus("请先选择音频文件。"); els.fileInput?.click(); return; }
  await ensureAudio(); stopFile();
  fileSource = audio.createBufferSource(); fileSource.buffer = fileBuffer; fileSource.connect(chain.input);
  fileSource.onended = () => { fileSource = null; }; fileSource.start();
  setStatus("正在播放电音版。");
}
function stopFile() { if (fileSource) { try { fileSource.stop(); } catch {} fileSource.disconnect(); fileSource = null; } }

// ─── 录制 ───
function startRecording(label) {
  if (!chain || !liveSource) { setStatus("请先开启实时传声再录制。"); return false; }
  wavRecording = true; wavLeft = []; wavRight = []; wavLength = 0; captureSampleRate = audio.sampleRate; hideDownload();
  setStatus(label + "录制中..."); return true;
}
function stopRecording() {
  if (!wavRecording) { setStatus("当前没有录制。"); return; }
  wavRecording = false;
  if (!wavLength) { setStatus("未录到声音。"); return; }
  const blob = encodeWavBlob(wavLeft, wavRight, wavLength, captureSampleRate);
  makeDownload(blob, "实时传声"); setStatus("WAV 文件已生成，可下载。");
}
async function startLiveRecord() { applyPreset("hardTune"); if (!liveSource) await startLive(); if (liveSource && !wavRecording) startRecording("边唱边录"); }
async function exportProcessedFile() {
  if (!fileBuffer) { setStatus("请先选择音频文件。"); els.fileInput?.click(); return; }
  hideDownload(); setStatus("正在离线生成电音 WAV...");
  try {
    const r = await renderProcessedBuffer(fileBuffer);
    const left = [r.getChannelData(0)]; const right = [r.numberOfChannels > 1 ? r.getChannelData(1) : r.getChannelData(0)];
    const blob = encodeWavBlob(left, right, r.length, r.sampleRate);
    makeDownload(blob, "上传音频电音版"); setStatus("电音 WAV 已生成。");
  } catch (err) { setStatus("导出失败: " + err.message); }
}
async function renderProcessedBuffer(buffer) {
  const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OC) throw new Error("浏览器不支持离线导出");
  const tail = 2.4, len = Math.ceil(buffer.length + buffer.sampleRate * tail);
  const off = new OC(2, len, buffer.sampleRate);
  const src = off.createBufferSource(); src.buffer = buffer;
  const settings = getEffectSettings();

  // 在离线上下文注册 AudioWorklet，使 5 种语音模式生效
  let offlineWorklet = null;
  try {
    const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    await off.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    offlineWorklet = new AudioWorkletNode(off, 'electro-voice-worklet');
    offlineWorklet.port.postMessage({
      mode: settings.mode, mix: settings.pitchOn ? settings.autoTuneMix : 0, scale: settings.scale,
      strength: settings.strength, formant: settings.formant || 0.5,
      distortion: settings.distortion, bitcrush: settings.bitcrush,
      warmth: settings.warm, tuneMix: settings.autoTuneMix,
    });
  } catch (e) {
    console.warn('离线渲染无法加载 AudioWorklet，回退到基础效果:', e.message);
  }

  const inp = createRenderGraph(off, off.destination, settings, 0.95, offlineWorklet);
  src.connect(inp); src.start(0); return off.startRendering();
}

// ─── 下载 ───
function makeDownload(blob, label) {
  if (lastDownloadUrl) URL.revokeObjectURL(lastDownloadUrl);
  lastDownloadBlob = blob; lastDownloadUrl = URL.createObjectURL(blob);
  const fn = label + "-" + new Date().toISOString().replace(/[:.]/g, "-") + ".wav";
  lastDownloadName = fn;
  if (els.downloadLink) { els.downloadLink.href = lastDownloadUrl; els.downloadLink.download = fn; els.downloadLink.hidden = false; els.downloadLink.textContent = "下载 WAV"; }
  if (els.outputName) els.outputName.textContent = fn;
  if (els.outputTray) { els.outputTray.hidden = false; els.outputTray.scrollIntoView({ behavior: "smooth", block: "center" }); }
}
function hideDownload() { if (els.downloadLink) els.downloadLink.hidden = true; if (els.outputTray) els.outputTray.hidden = true; }
async function saveGeneratedFile() {
  if (!lastDownloadBlob) { setStatus("还没有生成文件。"); return; }
  if (window.showSaveFilePicker) {
    try { const h = await window.showSaveFilePicker({ suggestedName: lastDownloadName, types: [{ description: "WAV", accept: { "audio/wav": [".wav"] } }] }); const w = await h.createWritable(); await w.write(lastDownloadBlob); await w.close(); setStatus("已保存。"); return; } catch (e) { if (e.name !== "AbortError") { setStatus("保存失败: " + e.message); return; } }
  }
  // 降级方案：通过 <a> 下载
  const a = document.createElement("a"); a.href = lastDownloadUrl; a.download = lastDownloadName; a.click();
}

// ─── WAV 编码 ───
function mergeChunks(chunks, length) { const r = new Float32Array(length); let o = 0; chunks.forEach(c => { r.set(c, o); o += c.length; }); return r; }
function encodeWavBlob(lchunks, rchunks, length, sr) {
  const left = mergeChunks(lchunks, length), right = mergeChunks(rchunks, length);
  const bps = 2, ch = 2;
  const buf = new ArrayBuffer(44 + length * ch * bps);
  const v = new DataView(buf);
  const ws = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  ws(0, "RIFF"); v.setUint32(4, 36 + length * ch * bps, true);
  ws(8, "WAVE"); ws(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, ch, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * ch * bps, true); v.setUint16(32, ch * bps, true);
  v.setUint16(34, 16, true); ws(36, "data"); v.setUint32(40, length * ch * bps, true);
  let off = 44;
  for (let i = 0; i < length; i++) {
    const clip = s => Math.max(-1, Math.min(1, s));
    v.setInt16(off, clip(left[i]) * (left[i] < 0 ? 0x8000 : 0x7fff), true); off += 2;
    v.setInt16(off, clip(right[i]) * (right[i] < 0 ? 0x8000 : 0x7fff), true); off += 2;
  }
  return new Blob([buf], { type: "audio/wav" });
}

// ─── 可视化 ───
function drawScope() {
  const canvas = els.scope, ctx = canvas.getContext("2d");
  const freqData = new Uint8Array(chain.analyser.frequencyBinCount);
  const timeData = new Uint8Array(chain.analyser.frequencyBinCount);
  function render() {
    const w = canvas.width, h = canvas.height;
    if (useSpectrum) {
      chain.analyser.getByteFrequencyData(freqData);
      ctx.clearRect(0, 0, w, h);
      const bg = ctx.createLinearGradient(0, 0, 0, h);
      bg.addColorStop(0, "#0a0a1e"); bg.addColorStop(0.5, "#0f0d28"); bg.addColorStop(1, "#0a0a1e");
      ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
      const barCount = Math.min(128, freqData.length), barW = w / barCount;
      for (let i = 0; i < barCount; i++) {
        const v = freqData[i] / 255, bh = Math.max(1, v * h * 0.85);
        const g = ctx.createLinearGradient(0, h, 0, h - bh);
        g.addColorStop(0, "hsla(" + (180 + i * 0.6) + ",100%,60%,0.08)");
        g.addColorStop(0.6, "hsla(" + (180 + i * 0.6) + ",100%,55%,0.25)");
        g.addColorStop(1, "hsla(" + (180 + i * 0.6 + 20) + ",100%,70%,0.45)");
        ctx.fillStyle = g; ctx.fillRect(i * barW, h - bh, Math.max(1, barW - 1), bh);
      }
    } else {
      chain.analyser.getByteTimeDomainData(timeData);
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = "rgba(79,240,180,0.04)"; ctx.lineWidth = 1;
      for (let x = 0; x < w; x += 48) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
      for (let y = 0; y < h; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
      ctx.strokeStyle = "rgba(79,240,180,0.08)"; ctx.beginPath(); ctx.moveTo(0, h/2); ctx.lineTo(w, h/2); ctx.stroke();
      ctx.lineWidth = 3; ctx.strokeStyle = "#4ff0b4"; ctx.shadowColor = "#62d8ff"; ctx.shadowBlur = 16;
      ctx.beginPath(); const slice = w / timeData.length;
      for (let i = 0; i < timeData.length; i++) { const y = (timeData[i] / 255) * h; i === 0 ? ctx.moveTo(i * slice, y) : ctx.lineTo(i * slice, y); }
      ctx.stroke(); ctx.shadowBlur = 0;
    }
    drawId = requestAnimationFrame(render);
  }
  if (drawId) cancelAnimationFrame(drawId); render();
}

// ─── 预设系统 ───
const PRESET_STORAGE_KEY = 'electro-voice-user-presets';

function applyPreset(name) {
  const presets = {
    experimental: { pitchOn: true, pitchMix: 100, scale: "minor", synthOn: true, synthMix: 100, carrier: 72, crushOn: true, crush: 18, space: 42, spaceOn: true, lowLatency: false, monitor: 60, autoTuneMix: 100, warm: 70, mode: 'ethereal', strength: 90, distortion: 25, bitcrush: 8 },
    popVocal:    { pitchOn: true, pitchMix: 76, scale: "major", synthOn: true, synthMix: 34, carrier: 132, crushOn: true, crush: 3, space: 14, spaceOn: true, lowLatency: true, monitor: 60, autoTuneMix: 65, warm: 85, mode: 'autoTune', strength: 70, distortion: 0, bitcrush: 0 },
    rapHook:     { pitchOn: true, pitchMix: 88, scale: "minor", synthOn: true, synthMix: 58, carrier: 112, crushOn: true, crush: 6, space: 18, spaceOn: true, lowLatency: true, monitor: 60, autoTuneMix: 80, warm: 60, mode: 'autoTune', strength: 85, distortion: 3, bitcrush: 2 },
    instrumentModern: { pitchOn: false, pitchMix: 24, scale: "chromatic", synthOn: true, synthMix: 82, carrier: 64, crushOn: true, crush: 22, space: 34, spaceOn: true, lowLatency: false, monitor: 60, autoTuneMix: 40, warm: 40, mode: 'alien', strength: 50, distortion: 15, bitcrush: 10 },
    hardTune:    { pitchOn: true, pitchMix: 96, scale: "minor", synthOn: true, synthMix: 94, carrier: 88, crushOn: true, crush: 6, space: 16, spaceOn: true, lowLatency: true, monitor: 60, autoTuneMix: 100, warm: 50, mode: 'hardcore', strength: 95, distortion: 15, bitcrush: 5 },
    hyperpop:    { pitchOn: true, pitchMix: 95, synthOn: true, synthMix: 54, carrier: 128, crushOn: true, crush: 34, space: 42, spaceOn: true, lowLatency: false, monitor: 60, autoTuneMix: 95, warm: 30, mode: 'autoTune', strength: 95, distortion: 30, bitcrush: 15, scale: "chromatic" },
    robot:       { pitchOn: true, pitchMix: 62, synthOn: true, synthMix: 88, carrier: 82, crushOn: true, crush: 46, space: 20, spaceOn: true, lowLatency: false, monitor: 60, autoTuneMix: 70, warm: 20, mode: 'robot', strength: 60, distortion: 5, bitcrush: 40, scale: "minor" },
    dream:       { pitchOn: true, pitchMix: 70, synthOn: true, synthMix: 32, carrier: 110, crushOn: true, crush: 16, space: 68, spaceOn: true, lowLatency: false, monitor: 60, autoTuneMix: 75, warm: 80, mode: 'ethereal', strength: 70, distortion: 0, bitcrush: 0, scale: "major" },
    clean:       { pitchOn: true, pitchMix: 48, synthOn: true, synthMix: 20, carrier: 140, crushOn: true, crush: 8, space: 22, spaceOn: true, lowLatency: true, monitor: 60, autoTuneMix: 50, warm: 90, mode: 'autoTune', strength: 45, distortion: 0, bitcrush: 0, scale: "major" },
  };

  const p = presets[name];
  if (!p) { loadUserPreset(name); return; }

  Object.entries(p).forEach(([k, v]) => {
    if (!els[k]) return;
    if (els[k].type === "checkbox") els[k].checked = Boolean(v);
    else els[k].value = v;
  });

  // 同步模式按钮
  if (p.mode && els.modeBtns) {
    els.modeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === p.mode));
    const info = MODE_INFO[p.mode];
    if (info && els.modeInfo) els.modeInfo.textContent = info.desc;
    if (info && els.modeLabel) els.modeLabel.textContent = info.label;
  }

  updateEffectValues();
  document.querySelectorAll("[data-preset]").forEach(b => b.classList.toggle("active-preset", b.dataset.preset === name));
  setStatus("已切换：" + (presetLabels[name] || name));
}

const presetLabels = { experimental: "实验电子", popVocal: "流行人声", rapHook: "说唱 Hook", instrumentModern: "器乐现代化", hardTune: "硬调电音", hyperpop: "Hyperpop", robot: "机器人", dream: "梦幻电台", clean: "清爽" };

// 用户预设
function loadUserPresets() { try { return JSON.parse(localStorage.getItem(PRESET_STORAGE_KEY)) || {}; } catch { return {}; } }
function saveUserPresets(presets) { localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(presets)); }
function saveCurrentPreset() {
  const name = prompt("保存当前设置为预设，输入名称："); if (!name) return;
  const data = {};
  ['pitchOn','pitchMix','scale','synthOn','synthMix','carrier','crushOn','crush','space','spaceOn','lowLatency','monitor','autoTuneMix','warm','mode','strength','formant','distortion','bitcrush'].forEach(k => {
    if (!els[k]) return;
    data[k] = els[k].type === "checkbox" ? els[k].checked : els[k].value;
  });
  // 保存当前模式
  const activeMode = document.querySelector('.voice-mode-btn.active')?.dataset?.mode || 'autoTune';
  data.mode = activeMode;
  const all = loadUserPresets(); all[name] = data; saveUserPresets(all); updatePresetMenu();
  setStatus("预设已保存：" + name);
}
function deleteUserPreset() {
  const all = loadUserPresets(); const names = Object.keys(all);
  if (!names.length) { setStatus("没有用户预设可删除。"); return; }
  const name = prompt("输入要删除的预设名称：\n" + names.join(", "));
  if (!name || !all[name]) { setStatus("未找到该预设。"); return; }
  delete all[name]; saveUserPresets(all); updatePresetMenu();
  setStatus("已删除：" + name);
}
function loadUserPreset(name) {
  const all = loadUserPresets(); const p = all[name];
  if (!p) { setStatus("未找到预设：" + name); return; }
  Object.entries(p).forEach(([k, v]) => {
    if (!els[k]) return;
    if (els[k].type === "checkbox") els[k].checked = Boolean(v); else els[k].value = v;
  });
  if (p.mode && els.modeBtns) {
    els.modeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === p.mode));
    const info = MODE_INFO[p.mode]; if (info && els.modeInfo) els.modeInfo.textContent = info.desc; if (info && els.modeLabel) els.modeLabel.textContent = info.label;
  }
  updateEffectValues(); setStatus("已加载用户预设：" + name);
}
function updatePresetMenu() {
  if (!els.presetLoad) return;
  const all = loadUserPresets(); const names = Object.keys(all);
  els.presetLoad.innerHTML = '<option value="">加载用户预设…</option>';
  names.forEach(n => { const opt = document.createElement("option"); opt.value = n; opt.textContent = n; els.presetLoad.appendChild(opt); });
  els.presetLoad.style.display = names.length ? "inline-block" : "none";
}

// ─── 视图切换 ───
function toggleSpectrumView() {
  useSpectrum = !useSpectrum;
  if (els.spectrumToggle) {
    els.spectrumToggle.textContent = useSpectrum ? '〰 波形' : '〰 频谱';
    els.spectrumToggle.title = useSpectrum ? '切换回波形视图' : '切换到频谱视图';
  }
  setStatus(useSpectrum ? "频谱视图" : "波形视图");
}

// ─── 快捷键 ───
function setupKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;
    switch (e.key) {
      case " ": e.preventDefault(); if (liveSource) stopLive(); else startLive(); break;
      case "r": case "R": e.preventDefault(); if (wavRecording) stopRecording(); else if (liveSource) startRecording("快捷键录制"); else { startLive(); setTimeout(() => startRecording("快捷键录制"), 300); } break;
      case "s": case "S": e.preventDefault(); stopLive(); break;
      case "1": applyPreset("experimental"); break; case "2": applyPreset("popVocal"); break; case "3": applyPreset("rapHook"); break;
      case "4": applyPreset("hyperpop"); break; case "5": applyPreset("robot"); break;
      case "v": case "V": e.preventDefault(); toggleSpectrumView(); break;
    }
  });
}

// ─── 事件绑定 ───
function runAction(action) {
  setStatus("处理中...");
  switch (action) {
    case "liveRecord": startLiveRecord(); break; case "startLive": startLive(); break;
    case "startRecord": startRecording("实时传声"); break; case "stopRecord": stopRecording(); break;
    case "stopLive": stopLive(); break; case "playFile": playFile(); break;
    case "exportFile": exportProcessedFile(); break; case "stopFile": stopFile(); break;
    case "saveFile": saveGeneratedFile(); break; case "scanMic": detectMicrophones({ requestPermission: true }); break;
  }
}

// 控件事件
[els.pitchOn, els.lowLatency, els.monitor, els.pitchMix, els.scale, els.synthOn, els.synthMix, els.carrier, els.crushOn, els.crush, els.space, els.spaceOn, els.autoTuneMix, els.warm, els.strength, els.formant, els.distortionRange, els.bitcrushRange].filter(Boolean).forEach(c => c.addEventListener("input", updateEffectValues));

// 模式按钮切换
if (els.modeBtns) {
  els.modeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      els.modeBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const mode = btn.dataset.mode;
      const info = MODE_INFO[mode];
      if (info) { if (els.modeInfo) els.modeInfo.textContent = info.desc; if (els.modeLabel) els.modeLabel.textContent = info.label; }
      updateEffectValues();
    });
  });
}

els.fileInput?.addEventListener("change", (e) => { const [f] = e.target.files; f ? loadFile(f) : (fileBuffer = null, els.fileName && (els.fileName.textContent = "未选择文件")); });

// 统一按钮事件
document.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const action = btn.dataset.action, preset = btn.dataset.preset;
  if (!action && !preset) return;
  e.preventDefault();
  preset ? applyPreset(preset) : runAction(action);
});

// 预设保存/加载
els.presetSave?.addEventListener("click", saveCurrentPreset);
els.presetDelete?.addEventListener("click", deleteUserPreset);
els.presetLoad?.addEventListener("change", (e) => { if (e.target.value) loadUserPreset(e.target.value); });
els.spectrumToggle?.addEventListener("click", toggleSpectrumView);

// ─── 初始化 ───
updateEffectValues();
updatePresetMenu();
detectMicrophones();
setupKeyboardShortcuts();
// 页面加载后主动请求麦克风权限（触发浏览器弹窗），方便后续检测设备名
setTimeout(() => {
  if (!navigator.mediaDevices?.getUserMedia) return;
  navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
    .then(s => { s.getTracks().forEach(t => t.stop()); })
    .catch(() => {})
    .finally(() => detectMicrophones());
}, 1000);
if (navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener("devicechange", () => detectMicrophones());
}
