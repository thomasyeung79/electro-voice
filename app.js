const els = {
  scope: document.querySelector("#scope"),
  status: document.querySelector("#status"),
  inlineStatus: document.querySelector("#inlineStatus"),
  tabs: document.querySelectorAll(".tab"),
  panels: {
    live: document.querySelector("#livePanel"),
    file: document.querySelector("#filePanel")
  },
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
  latencyHint: document.querySelector("#latencyHint"),
  pitchOn: document.querySelector("#pitchOn"),
  pitchMix: document.querySelector("#pitchMix"),
  scale: document.querySelector("#scale"),
  synthOn: document.querySelector("#synthOn"),
  synthMix: document.querySelector("#synthMix"),
  carrier: document.querySelector("#carrier"),
  crushOn: document.querySelector("#crushOn"),
  crush: document.querySelector("#crush"),
  space: document.querySelector("#space"),
  tone: document.querySelector("#tone"),
  spaceOn: document.querySelector("#spaceOn"),
  delay: document.querySelector("#delay"),
  reverb: document.querySelector("#reverb")
};

const outs = {
  monitor: document.querySelector("#monitorOut"),
  pitchMix: document.querySelector("#pitchMixOut"),
  synthMix: document.querySelector("#synthMixOut"),
  carrier: document.querySelector("#carrierOut"),
  crush: document.querySelector("#crushOut"),
  space: document.querySelector("#spaceOut"),
  tone: document.querySelector("#toneOut"),
  delay: document.querySelector("#delayOut"),
  reverb: document.querySelector("#reverbOut")
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
let exportingFile = false;

const scales = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  pentatonic: [0, 3, 5, 7, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
};

function setStatus(text) {
  if (els.status) els.status.textContent = text;
  if (els.inlineStatus) els.inlineStatus.textContent = text;
}

function setMicInfo(state, detail) {
  if (els.micState) els.micState.textContent = state;
  if (els.micDevice) els.micDevice.textContent = detail;
}

async function getMicPermissionState() {
  if (!navigator.permissions?.query) return "unknown";
  try {
    const permission = await navigator.permissions.query({ name: "microphone" });
    permission.onchange = () => detectMicrophones();
    return permission.state;
  } catch {
    return "unknown";
  }
}

async function requestTemporaryMicStream() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    }
  });
  stream.getTracks().forEach((track) => track.stop());
}

async function detectMicrophones(options = {}) {
  const { requestPermission = false } = options;
  if (!navigator.mediaDevices?.enumerateDevices) {
    setMicInfo("浏览器不支持", "这个环境没有麦克风设备列表接口");
    return;
  }

  try {
    const permissionState = await getMicPermissionState();
    if (requestPermission && permissionState !== "granted") {
      setMicInfo("等待授权", "请在浏览器弹窗里允许使用麦克风");
      await requestTemporaryMicStream();
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((device) => device.kind === "audioinput");

    if (!mics.length) {
      setMicInfo("未检测到麦克风", "检查蓝牙/USB 是否已连接，并确认 Windows 输入设备已选中");
      return;
    }

    const namedMics = mics.map((device) => device.label).filter(Boolean);
    if (!namedMics.length) {
      if (permissionState === "denied") {
        setMicInfo("权限被拒绝", "点地址栏旁边的权限图标，把麦克风改成允许，然后刷新页面");
        setStatus("麦克风设备已接入，但这个网页的麦克风权限被浏览器拒绝了。请在地址栏权限里改成允许。");
        return;
      }
      setMicInfo("已发现输入", `发现 ${mics.length} 个输入，但需要授权后才会显示设备名`);
      return;
    }

    const shown = namedMics.slice(0, 2).join(" / ");
    const extra = namedMics.length > 2 ? ` 等 ${namedMics.length} 个` : "";
    setMicInfo("麦克风已就绪", `${shown}${extra}`);
  } catch (error) {
    const message = error.name === "NotAllowedError"
      ? "浏览器拒绝了麦克风权限，请点地址栏权限改成允许"
      : error.message;
    setMicInfo("无法读取麦克风", message);
  }
}

function showActiveInput(stream) {
  const [track] = stream.getAudioTracks();
  if (!track) {
    setMicInfo("没有输入轨道", "浏览器没有从当前设备拿到声音输入");
    return;
  }
  const label = track.label || "默认输入设备";
  const settings = track.getSettings?.() || {};
  const sampleText = settings.sampleRate ? `，${settings.sampleRate} Hz` : "";
  setMicInfo("正在使用麦克风", `${label}${sampleText}`);
}

async function ensureAudio() {
  if (audio) {
    await audio.resume();
    return;
  }

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    throw new Error("这个浏览器不支持 Web Audio");
  }

  audio = new AudioContextClass({ latencyHint: "interactive" });
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

  lfo = ctx.createOscillator();
  const lfoGain = ctx.createGain();
  lfo.type = "square";
  lfo.frequency.value = 7.5;
  lfoGain.gain.value = 0.012;
  lfo.connect(lfoGain);
  lfoGain.connect(tuned.delayTime);
  lfo.start();

  const carrier = ctx.createOscillator();
  const carrierGain = ctx.createGain();
  const ring = ctx.createGain();
  const maskHigh = ctx.createBiquadFilter();
  const maskBand = ctx.createBiquadFilter();
  const maskPeak = ctx.createBiquadFilter();
  carrier.type = "sawtooth";
  carrier.frequency.value = 96;
  carrierGain.gain.value = 0;
  carrier.connect(carrierGain);
  carrierGain.connect(ring.gain);
  carrier.start();

  input.connect(dry);
  input.connect(tuned);
  tuned.connect(tuneFeedback);
  tuneFeedback.connect(tuned);
  tuned.connect(tuneWet);

  input.connect(synthIn);
  synthIn.connect(ring);
  ring.connect(maskHigh);
  maskHigh.connect(maskBand);
  maskBand.connect(maskPeak);
  maskPeak.connect(synthWet);

  input.connect(crusher);
  crusher.connect(filter);
  filter.connect(crusherWet);

  input.connect(delay);
  delay.connect(delayFeedback);
  delayFeedback.connect(delay);
  delay.connect(delayWet);

  input.connect(convolver);
  convolver.connect(reverbWet);

  dry.connect(output);
  tuneWet.connect(output);
  synthWet.connect(output);
  crusherWet.connect(output);
  delayWet.connect(output);
  reverbWet.connect(output);
  output.connect(analyser);
  output.connect(capture);
  capture.connect(captureMute);
  captureMute.connect(ctx.destination);
  analyser.connect(ctx.destination);

  analyser.fftSize = 2048;
  filter.type = "lowpass";
  maskHigh.type = "highpass";
  maskHigh.frequency.value = 180;
  maskBand.type = "bandpass";
  maskBand.frequency.value = 1150;
  maskBand.Q.value = 1.8;
  maskPeak.type = "peaking";
  maskPeak.frequency.value = 2600;
  maskPeak.Q.value = 1.1;
  maskPeak.gain.value = 8;
  convolver.buffer = makeImpulse(ctx, 1.8);
  crusher.curve = makeCrusherCurve(0.28);
  output.gain.value = 0.86;
  captureMute.gain.value = 0;
  capture.onaudioprocess = (event) => {
    if (!wavRecording) return;
    const left = event.inputBuffer.getChannelData(0);
    const right = event.inputBuffer.numberOfChannels > 1
      ? event.inputBuffer.getChannelData(1)
      : left;
    wavLeft.push(new Float32Array(left));
    wavRight.push(new Float32Array(right));
    wavLength += left.length;
  };

  return {
    input,
    dry,
    tuned,
    tuneFeedback,
    tuneWet,
    carrier,
    carrierGain,
    maskHigh,
    maskBand,
    maskPeak,
    synthWet,
    crusher,
    crusherWet,
    filter,
    delay,
    delayFeedback,
    delayWet,
    convolver,
    reverbWet,
    output,
    analyser,
    capture
  };
}

function getEffectSettings() {
  const space = Number(els.space?.value ?? 16) / 100;
  return {
    pitchOn: els.pitchOn.checked,
    pitchMix: Number(els.pitchMix.value) / 100,
    scale: els.scale.value,
    synthOn: els.synthOn.checked,
    synthMix: Number(els.synthMix.value) / 100,
    carrier: Number(els.carrier.value),
    crushOn: els.crushOn.checked,
    crush: Number(els.crush.value) / 100,
    tone: Number(els.tone?.value ?? 7200),
    spaceOn: els.spaceOn.checked,
    delay: Number(els.delay?.value ?? els.space?.value ?? 16) / 100,
    reverb: Number(els.reverb?.value ?? els.space?.value ?? 16) / 100,
    lowLatency: els.lowLatency.checked,
    monitor: Number(els.monitor.value) / 100
  };
}

function quantizedDelayFromSettings(settings) {
  const activeScale = scales[settings.scale];
  const nearest = activeScale.includes(0) ? 0 : activeScale[0] / 1200;
  return 0.004 + settings.pitchMix * (0.008 + nearest);
}

function createRenderGraph(ctx, destination, settings, monitorOverride = 1) {
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
  const lfoNode = ctx.createOscillator();
  const lfoGain = ctx.createGain();
  const carrier = ctx.createOscillator();
  const carrierGain = ctx.createGain();
  const ring = ctx.createGain();
  const maskHigh = ctx.createBiquadFilter();
  const maskBand = ctx.createBiquadFilter();
  const maskPeak = ctx.createBiquadFilter();

  lfoNode.type = "square";
  lfoNode.frequency.value = 7.5;
  lfoGain.gain.value = 0.012;
  lfoNode.connect(lfoGain);
  lfoGain.connect(tuned.delayTime);

  carrier.type = "sawtooth";
  carrier.frequency.value = settings.carrier;
  carrierGain.gain.value = settings.synthOn ? 0.65 + settings.synthMix * 0.65 : 0;
  carrier.connect(carrierGain);
  carrierGain.connect(ring.gain);

  input.connect(dry);
  input.connect(tuned);
  tuned.connect(tuneFeedback);
  tuneFeedback.connect(tuned);
  tuned.connect(tuneWet);
  input.connect(synthIn);
  synthIn.connect(ring);
  ring.connect(maskHigh);
  maskHigh.connect(maskBand);
  maskBand.connect(maskPeak);
  maskPeak.connect(synthWet);
  input.connect(crusher);
  crusher.connect(filter);
  filter.connect(crusherWet);
  input.connect(delay);
  delay.connect(delayFeedback);
  delayFeedback.connect(delay);
  delay.connect(delayWet);
  input.connect(convolver);
  convolver.connect(reverbWet);
  dry.connect(output);
  tuneWet.connect(output);
  synthWet.connect(output);
  crusherWet.connect(output);
  delayWet.connect(output);
  reverbWet.connect(output);
  output.connect(destination);

  filter.type = "lowpass";
  filter.frequency.value = settings.tone;
  filter.Q.value = 0.65 + settings.crush * 5;
  maskHigh.type = "highpass";
  maskHigh.frequency.value = 180;
  maskBand.type = "bandpass";
  maskBand.frequency.value = settings.synthMix > 0.85 ? 1120 : 1500;
  maskBand.Q.value = settings.synthMix > 0.85 ? 2.2 : 1.2;
  maskPeak.type = "peaking";
  maskPeak.frequency.value = 2600;
  maskPeak.Q.value = 1.1;
  maskPeak.gain.value = settings.synthMix > 0.85 ? 10 : 4;
  convolver.buffer = makeImpulse(ctx, 1.8);
  crusher.curve = makeCrusherCurve(settings.crush);
  const maskMode = settings.synthMix > 0.85 && settings.pitchMix > 0.88;
  const dryLevel = maskMode
    ? 0
    : Math.max(0.02, 0.42 - settings.pitchMix * 0.28 - settings.synthMix * 0.36);
  const tuneLevel = settings.pitchOn
    ? (maskMode ? 0.04 : 0.32 + settings.pitchMix * 0.42)
    : 0;
  const synthLevel = settings.synthOn
    ? (maskMode ? 1.45 : settings.synthMix * 0.98)
    : 0;
  const crushLevel = settings.crushOn ? settings.crush * (maskMode ? 0.08 : 0.16) : 0;

  dry.gain.value = dryLevel;
  output.gain.value = monitorOverride;
  tuned.delayTime.value = settings.pitchOn ? quantizedDelayFromSettings(settings) * (settings.lowLatency ? 0.45 : 1) : 0.001;
  tuneFeedback.gain.value = settings.pitchOn ? (0.11 + settings.pitchMix * 0.18) * (settings.lowLatency ? 0.55 : 1) : 0;
  tuneWet.gain.value = tuneLevel;
  synthWet.gain.value = synthLevel;
  crusherWet.gain.value = crushLevel;
  delay.delayTime.value = 0.12 + settings.delay * 0.38;
  delayFeedback.gain.value = settings.spaceOn ? settings.delay * 0.48 * (settings.lowLatency ? 0.45 : 1) : 0;
  delayWet.gain.value = settings.spaceOn ? settings.delay * 0.36 * (settings.lowLatency ? 0.4 : 1) : 0;
  reverbWet.gain.value = settings.spaceOn ? settings.reverb * 0.42 * (settings.lowLatency ? 0.55 : 1) : 0;

  lfoNode.start(0);
  carrier.start(0);
  return input;
}

function makeImpulse(ctx, seconds) {
  const length = Math.floor(ctx.sampleRate * seconds);
  const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      const fade = Math.pow(1 - i / length, 2.6);
      data[i] = (Math.random() * 2 - 1) * fade;
    }
  }
  return impulse;
}

function makeCrusherCurve(amount) {
  const samples = 4096;
  const curve = new Float32Array(samples);
  const steps = Math.max(5, Math.round(80 - amount * 72));
  for (let i = 0; i < samples; i += 1) {
    const x = (i * 2) / samples - 1;
    curve[i] = Math.round(x * steps) / steps;
  }
  return curve;
}

function quantizedDelayTime() {
  const activeScale = scales[els.scale.value];
  const amount = Number(els.pitchMix.value) / 100;
  const base = 0.004;
  const nearest = activeScale.includes(0) ? 0 : activeScale[0] / 1200;
  return base + amount * (0.008 + nearest);
}

function updateEffectValues() {
  const pitch = Number(els.pitchMix.value) / 100;
  const synth = Number(els.synthMix.value) / 100;
  const crush = Number(els.crush.value) / 100;
  const space = Number(els.space?.value ?? 16) / 100;
  const delay = Number(els.delay?.value ?? els.space?.value ?? 16) / 100;
  const reverb = Number(els.reverb?.value ?? els.space?.value ?? 16) / 100;
  const monitor = Number(els.monitor.value) / 100;
  const lowLatency = els.lowLatency.checked;

  if (outs.monitor) outs.monitor.textContent = `${els.monitor.value}%`;
  if (outs.pitchMix) outs.pitchMix.textContent = `${els.pitchMix.value}%`;
  if (outs.synthMix) outs.synthMix.textContent = `${els.synthMix.value}%`;
  if (outs.carrier) outs.carrier.textContent = `${els.carrier.value} Hz`;
  if (outs.crush) outs.crush.textContent = `${els.crush.value}%`;
  if (outs.space) outs.space.textContent = `${Math.round(space * 100)}%`;
  if (outs.tone && els.tone) outs.tone.textContent = `${els.tone.value} Hz`;
  if (outs.delay && els.delay) outs.delay.textContent = `${els.delay.value}%`;
  if (outs.reverb && els.reverb) outs.reverb.textContent = `${els.reverb.value}%`;
  if (els.latencyHint) {
    els.latencyHint.textContent = lowLatency
      ? "低延迟监听已开启"
      : "完整效果监听已开启，空间感更强但会更慢一点";
  }

  if (!chain || !audio) return;
  const now = audio.currentTime;

  const maskMode = synth > 0.85 && pitch > 0.88;
  const dryLevel = maskMode
    ? 0
    : Math.max(0.02, 0.42 - pitch * 0.28 - synth * 0.36);
  const tuneLevel = els.pitchOn.checked
    ? (maskMode ? 0.04 : 0.32 + pitch * 0.42)
    : 0;
  const synthLevel = els.synthOn.checked
    ? (maskMode ? 1.45 : synth * 0.98)
    : 0;
  const crushLevel = els.crushOn.checked ? crush * (maskMode ? 0.08 : 0.16) : 0;

  chain.dry.gain.setTargetAtTime(dryLevel, now, 0.02);
  chain.output.gain.setTargetAtTime(monitor * 1.05, now, 0.02);
  chain.tuned.delayTime.setTargetAtTime(els.pitchOn.checked ? quantizedDelayTime() * (lowLatency ? 0.45 : 1) : 0.001, now, 0.02);
  chain.tuneFeedback.gain.setTargetAtTime(els.pitchOn.checked ? (0.11 + pitch * 0.18) * (lowLatency ? 0.55 : 1) : 0, now, 0.02);
  chain.tuneWet.gain.setTargetAtTime(tuneLevel, now, 0.02);

  chain.carrier.frequency.setTargetAtTime(Number(els.carrier.value), now, 0.02);
  chain.carrierGain.gain.setTargetAtTime(els.synthOn.checked ? 0.65 + synth * 0.65 : 0, now, 0.02);
  chain.maskBand.frequency.setTargetAtTime(maskMode ? 1120 : 1500, now, 0.02);
  chain.maskBand.Q.setTargetAtTime(maskMode ? 2.2 : 1.2, now, 0.02);
  chain.maskPeak.gain.setTargetAtTime(maskMode ? 10 : 4, now, 0.02);
  chain.synthWet.gain.setTargetAtTime(synthLevel, now, 0.02);

  chain.crusher.curve = makeCrusherCurve(crush);
  chain.crusherWet.gain.setTargetAtTime(crushLevel, now, 0.02);
  chain.filter.frequency.setTargetAtTime(Number(els.tone?.value ?? 7200), now, 0.02);
  chain.filter.Q.setTargetAtTime(0.65 + crush * 5, now, 0.02);

  chain.delay.delayTime.setTargetAtTime(0.12 + delay * 0.38, now, 0.02);
  chain.delayFeedback.gain.setTargetAtTime(els.spaceOn.checked ? delay * 0.48 * (lowLatency ? 0.45 : 1) : 0, now, 0.02);
  chain.delayWet.gain.setTargetAtTime(els.spaceOn.checked ? delay * 0.36 * (lowLatency ? 0.4 : 1) : 0, now, 0.02);
  chain.reverbWet.gain.setTargetAtTime(els.spaceOn.checked ? reverb * 0.42 * (lowLatency ? 0.55 : 1) : 0, now, 0.02);

  const baseLatency = audio.baseLatency ? Math.round(audio.baseLatency * 1000) : null;
  if (els.latencyHint) {
    els.latencyHint.textContent = lowLatency
      ? `低延迟监听已开启${baseLatency ? `，浏览器基础延迟约 ${baseLatency} ms` : ""}`
      : "完整效果监听已开启，空间感更强但会更慢一点";
  }
}

async function startLive() {
  try {
    await ensureAudio();
    stopFile();
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("当前浏览器环境没有可用的麦克风权限接口");
    }
    liveStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });
    showActiveInput(liveStream);
    liveSource = audio.createMediaStreamSource(liveStream);
    liveSource.connect(chain.input);
    setStatus("实时传声已开启。说话时会直接从扬声器输出处理后的电音声音。");
  } catch (error) {
    stopLive();
    detectMicrophones();
    setStatus(`无法开启麦克风：${error.message}`);
  }
}

function stopLive() {
  if (!liveSource && !liveStream && !wavRecording) {
    setStatus("当前没有开启实时传声。");
    return;
  }
  const wasRecording = wavRecording;
  if (wavRecording) {
    stopRecording();
  }
  if (liveSource) {
    liveSource.disconnect();
    liveSource = null;
  }
  if (liveStream) {
    liveStream.getTracks().forEach((track) => track.stop());
    liveStream = null;
  }
  setStatus(wasRecording ? "实时传声已停止，声音文件已经生成，可以下载。" : "实时传声已停止。");
}

async function loadFile(file) {
  await ensureAudio();
  stopLive();
  const bytes = await file.arrayBuffer();
  fileBuffer = await audio.decodeAudioData(bytes);
  els.fileName.textContent = file.name;
  updateFileButtons();
  setStatus("音频已载入，可以播放电音版。");
}

async function playFile() {
  if (!fileBuffer) {
    setStatus("请先选择一个音频文件。");
    els.fileInput.click();
    return;
  }
  await ensureAudio();
  stopFile();
  fileSource = audio.createBufferSource();
  fileSource.buffer = fileBuffer;
  fileSource.connect(chain.input);
  fileSource.onended = () => {
    fileSource = null;
    updateFileButtons();
  };
  fileSource.start();
  updateFileButtons();
  setStatus("正在播放上传音频的电音版。");
}

function stopFile() {
  const wasPlaying = Boolean(fileSource);
  if (fileSource) {
    try {
      fileSource.stop();
    } catch {
      // BufferSource can only stop once.
    }
    fileSource.disconnect();
    fileSource = null;
  }
  updateFileButtons();
  if (!wasPlaying) {
    setStatus("当前没有正在播放的上传音频。");
  }
}

function updateFileButtons() {
  const playing = Boolean(fileSource);
  if (playing) {
    setStatus("上传音频正在播放。");
  }
}

function startRecording(label = "实时电音") {
  if (!chain || !liveSource) {
    setStatus("请先开启实时传声，再录制导出。");
    return false;
  }

  wavRecording = true;
  wavLeft = [];
  wavRight = [];
  wavLength = 0;
  captureSampleRate = audio.sampleRate;
  hideDownload();
  setStatus(`${label}录制中，停止后会生成 WAV 声音文件。`);
  return true;
}

function stopRecording() {
  if (!wavRecording) {
    setStatus("当前没有正在录制的实时声音。");
    return;
  }
  wavRecording = false;

  if (!wavLength) {
    setStatus("还没有录到声音，请先说话再停止导出。");
    return;
  }

  const blob = encodeWavBlob(wavLeft, wavRight, wavLength, captureSampleRate);
  makeDownload(blob, "实时传声");
  setStatus("声音文件已经生成，可以下载。");
}

async function startLiveRecord() {
  applyPreset("hardTune");
  if (!liveSource) {
    await startLive();
  }
  if (liveSource && !wavRecording) {
    startRecording("边唱边录电音");
  }
}

async function exportProcessedFile() {
  if (!fileBuffer) {
    setStatus("请先选择一个音频文件，再导出声音。");
    els.fileInput.click();
    return;
  }
  exportingFile = true;
  updateFileButtons();
  hideDownload();
  setStatus("正在离线生成电音 WAV 文件...");

  try {
    const rendered = await renderProcessedBuffer(fileBuffer);
    const left = [rendered.getChannelData(0)];
    const right = [rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : rendered.getChannelData(0)];
    const blob = encodeWavBlob(left, right, rendered.length, rendered.sampleRate);
    makeDownload(blob, "上传音频电音版");
    setStatus("上传音频的电音声音文件已经生成，可以下载。");
  } catch (error) {
    setStatus(`导出失败：${error.message}`);
  } finally {
    exportingFile = false;
    updateFileButtons();
  }
}

async function renderProcessedBuffer(buffer) {
  const OfflineContextClass = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OfflineContextClass) {
    throw new Error("这个浏览器不支持离线导出");
  }

  const tailSeconds = 2.4;
  const length = Math.ceil(buffer.length + buffer.sampleRate * tailSeconds);
  const offline = new OfflineContextClass(2, length, buffer.sampleRate);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  const input = createRenderGraph(offline, offline.destination, getEffectSettings(), 0.95);
  source.connect(input);
  source.start(0);
  return offline.startRendering();
}

function makeDownload(blob, label) {
  if (lastDownloadUrl) URL.revokeObjectURL(lastDownloadUrl);
  lastDownloadBlob = blob;
  lastDownloadUrl = URL.createObjectURL(blob);
  const fileName = `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}.wav`;
  lastDownloadName = fileName;
  els.downloadLink.href = lastDownloadUrl;
  els.downloadLink.download = fileName;
  els.downloadLink.hidden = false;
  els.downloadLink.textContent = "下载声音文件";
  if (els.outputName) els.outputName.textContent = fileName;
  if (els.outputTray) {
    els.outputTray.hidden = false;
    els.outputTray.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function hideDownload() {
  if (els.downloadLink) els.downloadLink.hidden = true;
  if (els.outputTray) els.outputTray.hidden = true;
}

async function saveGeneratedFile() {
  if (!lastDownloadBlob) {
    setStatus("还没有生成声音文件。请先录制或导出。");
    return;
  }

  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: lastDownloadName,
        types: [{
          description: "WAV audio",
          accept: { "audio/wav": [".wav"] }
        }]
      });
      const writable = await handle.createWritable();
      await writable.write(lastDownloadBlob);
      await writable.close();
      setStatus("声音文件已保存。");
      return;
    } catch (error) {
      if (error.name === "AbortError") {
        setStatus("已取消保存。");
        return;
      }
    }
  }

  const link = document.createElement("a");
  link.href = lastDownloadUrl;
  link.download = lastDownloadName;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setStatus("如果没有看到下载，请检查浏览器下载栏或弹窗拦截。");
}

function mergeChunks(chunks, length) {
  const result = new Float32Array(length);
  let offset = 0;
  chunks.forEach((chunk) => {
    result.set(chunk, offset);
    offset += chunk.length;
  });
  return result;
}

function encodeWavBlob(leftChunks, rightChunks, length, sampleRate) {
  const left = mergeChunks(leftChunks, length);
  const right = mergeChunks(rightChunks, length);
  const bytesPerSample = 2;
  const channelCount = 2;
  const buffer = new ArrayBuffer(44 + length * channelCount * bytesPerSample);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + length * channelCount * bytesPerSample, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true);
  view.setUint16(32, channelCount * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, length * channelCount * bytesPerSample, true);

  let offset = 44;
  for (let i = 0; i < length; i += 1) {
    writeSample(view, offset, left[i]);
    offset += 2;
    writeSample(view, offset, right[i]);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function writeSample(view, offset, sample) {
  const clipped = Math.max(-1, Math.min(1, sample));
  view.setInt16(offset, clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff, true);
}

function writeString(view, offset, value) {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}

function drawScope() {
  const canvas = els.scope;
  const ctx = canvas.getContext("2d");
  const data = new Uint8Array(chain.analyser.frequencyBinCount);

  function render() {
    const width = canvas.width;
    const height = canvas.height;
    chain.analyser.getByteTimeDomainData(data);

    ctx.clearRect(0, 0, width, height);
    const glow = ctx.createLinearGradient(0, 0, width, height);
    glow.addColorStop(0, "rgba(79, 240, 180, 0.12)");
    glow.addColorStop(0.55, "rgba(98, 216, 255, 0.1)");
    glow.addColorStop(1, "rgba(255, 94, 168, 0.12)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.lineWidth = 1;
    for (let x = 0; x < width; x += 48) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }

    ctx.lineWidth = 4;
    ctx.strokeStyle = "#4ff0b4";
    ctx.shadowColor = "#62d8ff";
    ctx.shadowBlur = 18;
    ctx.beginPath();
    const slice = width / data.length;
    for (let i = 0; i < data.length; i += 1) {
      const y = (data[i] / 255) * height;
      const x = i * slice;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    drawId = requestAnimationFrame(render);
  }

  if (drawId) cancelAnimationFrame(drawId);
  render();
}

function switchMode(mode) {
  els.tabs.forEach((tab) => {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  Object.entries(els.panels).forEach(([key, panel]) => {
    if (!panel) return;
    panel.classList.toggle("active", key === mode);
  });
}

function applyPreset(name) {
  const preset = {
    experimental: {
      pitchOn: true,
      pitchMix: 100,
      scale: "minor",
      synthOn: true,
      synthMix: 100,
      carrier: 72,
      crushOn: true,
      crush: 18,
      space: 42,
      tone: 6800,
      spaceOn: true,
      delay: 42,
      reverb: 38,
      lowLatency: false,
      monitor: 72
    },
    popVocal: {
      pitchOn: true,
      pitchMix: 76,
      scale: "major",
      synthOn: true,
      synthMix: 34,
      carrier: 132,
      crushOn: true,
      crush: 3,
      space: 14,
      tone: 8600,
      spaceOn: true,
      delay: 12,
      reverb: 16,
      lowLatency: true,
      monitor: 78
    },
    rapHook: {
      pitchOn: true,
      pitchMix: 88,
      scale: "minor",
      synthOn: true,
      synthMix: 58,
      carrier: 112,
      crushOn: true,
      crush: 6,
      space: 18,
      tone: 7800,
      spaceOn: true,
      delay: 16,
      reverb: 16,
      lowLatency: true,
      monitor: 76
    },
    instrumentModern: {
      pitchOn: false,
      pitchMix: 24,
      scale: "chromatic",
      synthOn: true,
      synthMix: 82,
      carrier: 64,
      crushOn: true,
      crush: 22,
      space: 34,
      tone: 6200,
      spaceOn: true,
      delay: 34,
      reverb: 30,
      lowLatency: false,
      monitor: 74
    },
    hardTune: {
      pitchOn: true,
      pitchMix: 96,
      scale: "minor",
      synthOn: true,
      synthMix: 94,
      carrier: 88,
      crushOn: true,
      crush: 6,
      tone: 7200,
      spaceOn: true,
      delay: 12,
      reverb: 10,
      lowLatency: true,
      monitor: 78
    },
    hyperpop: { pitchMix: 95, synthMix: 54, carrier: 128, crush: 34, tone: 7600, delay: 42, reverb: 26 },
    robot: { pitchMix: 62, synthMix: 88, carrier: 82, crush: 46, tone: 5200, delay: 20, reverb: 18 },
    dream: { pitchMix: 70, synthMix: 32, carrier: 110, crush: 16, tone: 9000, delay: 58, reverb: 70 },
    clean: { pitchMix: 48, synthMix: 20, carrier: 140, crush: 8, tone: 8400, delay: 24, reverb: 22 }
  }[name];
  Object.entries(preset).forEach(([key, value]) => {
    if (!els[key]) return;
    if (els[key].type === "checkbox") {
      els[key].checked = Boolean(value);
    } else {
      els[key].value = value;
    }
  });
  updateEffectValues();
  document.querySelectorAll("[data-preset]").forEach((button) => {
    button.classList.toggle("active-preset", button.dataset.preset === name);
  });
  setStatus(`已切换到：${presetLabels[name] || name}`);
}

const presetLabels = {
  experimental: "实验电子",
  popVocal: "流行人声",
  rapHook: "说唱 Hook",
  instrumentModern: "器乐现代化",
  hardTune: "硬调电音",
  hyperpop: "Hyperpop",
  robot: "机器人",
  dream: "梦幻电台",
  clean: "清爽"
};

function runAction(action) {
  setStatus("已收到点击，正在处理...");
  switch (action) {
    case "liveRecord":
      startLiveRecord();
      break;
    case "startLive":
      startLive();
      break;
    case "startRecord":
      startRecording("实时传声");
      break;
    case "stopRecord":
      stopRecording();
      break;
    case "stopLive":
      stopLive();
      break;
    case "playFile":
      playFile();
      break;
    case "exportFile":
      exportProcessedFile();
      break;
    case "stopFile":
      stopFile();
      break;
    case "saveFile":
      saveGeneratedFile();
      break;
    case "scanMic":
      detectMicrophones({ requestPermission: true });
      break;
    default:
      break;
  }
}

[
  els.pitchOn,
  els.lowLatency,
  els.monitor,
  els.pitchMix,
  els.scale,
  els.synthOn,
  els.synthMix,
  els.carrier,
  els.crushOn,
  els.crush,
  els.space,
  els.tone,
  els.spaceOn,
  els.delay,
  els.reverb
].filter(Boolean).forEach((control) => control.addEventListener("input", updateEffectValues));

els.tabs?.forEach((tab) => tab.addEventListener("click", () => switchMode(tab.dataset.mode)));
els.fileInput?.addEventListener("change", (event) => {
  const [file] = event.target.files;
  if (file) {
    loadFile(file);
  } else {
    fileBuffer = null;
    els.fileName.textContent = "还没有选择音频文件，可以上传人声、beat、器乐或采样";
    updateFileButtons();
  }
});

document.addEventListener("pointerup", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const action = button.dataset.action;
  const preset = button.dataset.preset;
  if (!action && !preset) return;
  event.preventDefault();
  if (preset) {
    applyPreset(preset);
  } else {
    runAction(action);
  }
}, true);

document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const action = button.dataset.action;
  const preset = button.dataset.preset;
  if (!action && !preset) return;
  event.preventDefault();
});

updateEffectValues();
updateFileButtons();
detectMicrophones();

if (navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener("devicechange", () => detectMicrophones());
}
