(function () {
  const PITCH_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  let ctx = null;
  let sampleMap = {};
  const bufferCache = new Map();
  const inflight = new Map();
  const urlBufferCache = new Map();
  const urlInflight = new Map();
  let scheduledNodes = [];

  function getContext() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    return ctx;
  }

  function pitchToMidi(pitch) {
    const match = String(pitch || '').trim().match(/^([A-G])(#?)(-1|[0-9])$/);
    if (!match) return null;
    const pitchClass = PITCH_NAMES.indexOf(`${match[1]}${match[2]}`);
    if (pitchClass < 0) return null;
    return (Number(match[3]) + 1) * 12 + pitchClass;
  }

  function midiToPitch(midi) {
    const value = Math.max(0, Math.min(127, Math.round(Number(midi) || 0)));
    return `${PITCH_NAMES[value % 12]}${Math.floor(value / 12) - 1}`;
  }

  function normalizeDurationMs(durationMs) {
    const n = Number(durationMs);
    if (!Number.isFinite(n) || n <= 0) return 180;
    return Math.max(55, Math.min(8000, n));
  }

  function setSampleMap(map) {
    sampleMap = map && typeof map === 'object' ? { ...map } : {};
  }

  async function unlock({ testPitch = null } = {}) {
    const audio = getContext();
    if (audio.state === 'suspended') await audio.resume();
    if (testPitch) scheduleSynth(testPitch, audio.currentTime + 0.02, 180, 0.18);
    return audio.state === 'running';
  }

  async function loadBufferForPitch(pitch) {
    const url = sampleMap[pitch];
    if (!url) return null;
    if (bufferCache.has(pitch)) return bufferCache.get(pitch);
    if (inflight.has(pitch)) return inflight.get(pitch);
    const promise = fetch(url, { cache: 'force-cache' })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      .then((raw) => getContext().decodeAudioData(raw.slice(0)))
      .then((buffer) => {
        bufferCache.set(pitch, buffer);
        inflight.delete(pitch);
        return buffer;
      })
      .catch(() => {
        inflight.delete(pitch);
        return null;
      });
    inflight.set(pitch, promise);
    return promise;
  }


  async function loadUrlBuffer(url) {
    const key = String(url || '').trim();
    if (!key) return null;
    if (urlBufferCache.has(key)) return urlBufferCache.get(key);
    if (urlInflight.has(key)) return urlInflight.get(key);
    const promise = fetch(key, { cache: 'force-cache' })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      .then((raw) => getContext().decodeAudioData(raw.slice(0)))
      .then((buffer) => {
        urlBufferCache.set(key, buffer);
        urlInflight.delete(key);
        return buffer;
      })
      .catch((error) => {
        urlInflight.delete(key);
        throw error;
      });
    urlInflight.set(key, promise);
    return promise;
  }

  async function playUrlBufferAtEpoch(url, options = {}) {
    const buffer = await loadUrlBuffer(url);
    if (!buffer) throw new Error('No audio buffer');
    const audio = getContext();
    if (audio.state === 'suspended') {
      try { await audio.resume(); } catch (_) {}
    }
    const getNowEpochMs = typeof options.getNowEpochMs === 'function' ? options.getNowEpochMs : () => Date.now();
    const startEpochMs = Number(options.startEpochMs) || getNowEpochMs();
    const nowEpochMs = getNowEpochMs();
    const delayMs = Math.max(0, startEpochMs - nowEpochMs);
    const lateMs = Math.max(0, nowEpochMs - startEpochMs);
    const baseOffsetSec = Math.max(0, Number(options.offsetMs) || 0) / 1000;
    const lateSec = lateMs / 1000;
    const offsetSec = baseOffsetSec + lateSec;
    if (offsetSec >= buffer.duration - 0.01) return { skipped: true, reason: 'track-ended' };
    const src = audio.createBufferSource();
    const gain = audio.createGain();
    src.buffer = buffer;
    gain.gain.value = Number.isFinite(Number(options.volume)) ? Number(options.volume) : 0.95;
    src.connect(gain);
    gain.connect(audio.destination);
    const when = audio.currentTime + delayMs / 1000;
    src.start(when, offsetSec);
    remember(src);
    return { source: src, when, offsetSec, baseOffsetSec, lateSec, bufferDurationSec: buffer.duration, state: audio.state };
  }

  async function preloadPitches(pitches) {
    const unique = [...new Set((pitches || []).map((p) => String(p || '').trim()).filter(Boolean))];
    await Promise.all(unique.filter((pitch) => sampleMap[pitch]).map(loadBufferForPitch));
    return unique.reduce((acc, pitch) => {
      acc[pitch] = bufferCache.has(pitch) ? 'sample' : 'synth';
      return acc;
    }, {});
  }

  function remember(node) {
    scheduledNodes.push(node);
    if (scheduledNodes.length > 2000) scheduledNodes = scheduledNodes.slice(-1000);
  }

  function scheduleSynthOnContext(audio, destination, pitch, when, durationMs = 180, volume = 0.22) {
    const midi = pitchToMidi(pitch);
    if (midi === null) return null;
    const duration = normalizeDurationMs(durationMs) / 1000;
    const startAt = Math.max(0, Number(when) || 0);
    const stopAt = startAt + duration;
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    const osc1 = audio.createOscillator();
    const osc2 = audio.createOscillator();
    const gain = audio.createGain();
    const harmonicGain = audio.createGain();
    osc1.type = 'triangle';
    osc2.type = 'square';
    osc1.frequency.setValueAtTime(freq, startAt);
    osc2.frequency.setValueAtTime(freq, startAt);
    harmonicGain.gain.setValueAtTime(0.08, startAt);
    osc1.connect(gain);
    osc2.connect(harmonicGain);
    harmonicGain.connect(gain);
    gain.connect(destination);

    const attack = Math.min(0.018, duration * 0.25);
    const release = Math.min(0.045, duration * 0.35);
    const sustainEnd = Math.max(startAt + attack, stopAt - release);
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.02, volume), startAt + Math.max(0.003, attack));
    gain.gain.setValueAtTime(Math.max(0.02, volume), sustainEnd);
    gain.gain.exponentialRampToValueAtTime(0.0001, stopAt);
    osc1.start(startAt);
    osc2.start(startAt);
    osc1.stop(stopAt + 0.02);
    osc2.stop(stopAt + 0.02);
    return { osc1, osc2 };
  }

  function scheduleSampleOnContext(audio, destination, pitch, buffer, when, durationMs = 180, volume = 0.72) {
    if (!buffer) return scheduleSynthOnContext(audio, destination, pitch, when, durationMs);
    const startAt = Math.max(0, Number(when) || 0);
    const requested = normalizeDurationMs(durationMs) / 1000;
    const playFor = Math.max(0.05, requested);
    const src = audio.createBufferSource();
    const gain = audio.createGain();
    src.buffer = buffer;
    // For notes longer than the recorded one-shot sample, loop the stable middle portion
    // and stop exactly at the chart duration. This is intended for sustained harmonica samples.
    if (playFor > (buffer.duration || 0) + 0.03 && buffer.duration > 0.35) {
      src.loop = true;
      src.loopStart = Math.min(0.18, buffer.duration * 0.18);
      src.loopEnd = Math.max(src.loopStart + 0.08, buffer.duration - Math.min(0.15, buffer.duration * 0.12));
    }
    const attack = Math.min(0.012, playFor * 0.2);
    const release = Math.min(0.06, playFor * 0.25);
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.02, volume), startAt + Math.max(0.003, attack));
    gain.gain.setValueAtTime(Math.max(0.02, volume), Math.max(startAt + attack, startAt + playFor - release));
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + playFor);
    src.connect(gain);
    gain.connect(destination);
    src.start(startAt, 0);
    src.stop(startAt + playFor + 0.01);
    return src;
  }

  function scheduleSynth(pitch, when, durationMs = 180, volume = 0.22) {
    const audio = getContext();
    const startAt = Math.max(audio.currentTime + 0.005, Number(when) || audio.currentTime);
    const nodes = scheduleSynthOnContext(audio, audio.destination, pitch, startAt, durationMs, volume);
    if (!nodes) return null;
    remember(nodes.osc1);
    remember(nodes.osc2);
    return { source: 'synth', pitch, when: startAt };
  }

  function scheduleSample(pitch, buffer, when, durationMs = 180, volume = 0.8) {
    if (!buffer) return scheduleSynth(pitch, when, durationMs);
    const audio = getContext();
    const startAt = Math.max(audio.currentTime + 0.005, Number(when) || audio.currentTime);
    const src = scheduleSampleOnContext(audio, audio.destination, pitch, buffer, startAt, durationMs, volume);
    remember(src);
    return { source: 'sample', pitch, when: startAt };
  }

  function schedulePitch(pitch, when, durationMs = 180) {
    const buffer = bufferCache.get(pitch);
    if (buffer) return scheduleSample(pitch, buffer, when, durationMs);
    return scheduleSynth(pitch, when, durationMs);
  }

  function playNow(pitch, durationMs = 180) {
    const audio = getContext();
    return schedulePitch(pitch, audio.currentTime + 0.01, durationMs);
  }

  function cancelScheduled() {
    const now = ctx ? ctx.currentTime : 0;
    scheduledNodes.forEach((node) => {
      try { node.stop(now + 0.001); } catch (_) {}
      try { node.disconnect(); } catch (_) {}
    });
    scheduledNodes = [];
  }

  // Legacy per-note scheduler retained as a fallback/debug tool.
  async function scheduleSequence(notes, options = {}) {
    const audio = getContext();
    if (audio.state === 'suspended') {
      try { await audio.resume(); } catch (_) {}
    }
    const getNowEpochMs = typeof options.getNowEpochMs === 'function' ? options.getNowEpochMs : () => Date.now();
    const startEpochMs = Number(options.startEpochMs) || getNowEpochMs();
    const pitches = (notes || []).map((note) => note.pitch || midiToPitch(note.midiNote));
    await preloadPitches(pitches);
    const nowEpochMs = getNowEpochMs();
    const baseAudioTime = audio.currentTime + Math.max(0, (startEpochMs - nowEpochMs) / 1000);
    const lateMs = Math.max(0, nowEpochMs - startEpochMs);
    const events = [];
    (notes || []).forEach((note) => {
      const pitch = String(note.pitch || midiToPitch(note.midiNote) || '').trim();
      if (!pitch) return;
      const offsetMs = Number(note.time) || 0;
      if (offsetMs + normalizeDurationMs(note.duration) < lateMs - 40) return;
      const when = baseAudioTime + Math.max(0, offsetMs - lateMs) / 1000;
      events.push(schedulePitch(pitch, when, note.duration));
    });
    return { baseAudioTime, events, state: audio.state };
  }

  // Render the whole chart into ONE continuous AudioBuffer before gameplay.
  // This mirrors what the editor sounds like, but gameplay only starts one source,
  // so fast notes cannot be dropped by JS/rendering jitter.
  async function renderSequenceToBuffer(notes, options = {}) {
    const normalizedNotes = (notes || []).map((note) => ({
      ...note,
      time: Math.max(0, Number(note.time) || 0),
      duration: normalizeDurationMs(note.duration),
      pitch: String(note.pitch || midiToPitch(note.midiNote) || '').trim()
    })).filter((note) => note.pitch);

    const pitches = normalizedNotes.map((note) => note.pitch);
    await preloadPitches(pitches);

    const maxEndMs = normalizedNotes.reduce((max, note) => Math.max(max, note.time + note.duration), 0);
    const tailMs = Math.max(120, Number(options.tailMs) || 180);
    const sampleRate = Math.max(22050, Math.min(48000, Number(options.sampleRate) || 44100));
    const totalSeconds = Math.max(0.25, (maxEndMs + tailMs) / 1000);
    const frameCount = Math.ceil(totalSeconds * sampleRate);
    const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OfflineCtx) throw new Error('OfflineAudioContext is not supported');
    const offline = new OfflineCtx(2, frameCount, sampleRate);

    const master = offline.createGain();
    master.gain.value = Number.isFinite(Number(options.masterGain)) ? Number(options.masterGain) : 0.78;
    const compressor = offline.createDynamicsCompressor();
    compressor.threshold.value = -10;
    compressor.knee.value = 12;
    compressor.ratio.value = 6;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.12;
    master.connect(compressor);
    compressor.connect(offline.destination);

    normalizedNotes.forEach((note) => {
      const when = note.time / 1000;
      const buffer = bufferCache.get(note.pitch);
      if (buffer) {
        scheduleSampleOnContext(offline, master, note.pitch, buffer, when, note.duration, 0.72);
      } else {
        scheduleSynthOnContext(offline, master, note.pitch, when, note.duration, 0.20);
      }
    });

    const rendered = await offline.startRendering();
    return {
      buffer: rendered,
      durationMs: rendered.duration * 1000,
      noteCount: normalizedNotes.length,
      sampleRate: rendered.sampleRate
    };
  }

  async function playRenderedBufferAtEpoch(rendered, options = {}) {
    const buffer = rendered?.buffer || rendered;
    if (!buffer) throw new Error('No rendered audio buffer');
    const audio = getContext();
    if (audio.state === 'suspended') {
      try { await audio.resume(); } catch (_) {}
    }
    const getNowEpochMs = typeof options.getNowEpochMs === 'function' ? options.getNowEpochMs : () => Date.now();
    const startEpochMs = Number(options.startEpochMs) || getNowEpochMs();
    const nowEpochMs = getNowEpochMs();
    const delayMs = Math.max(0, startEpochMs - nowEpochMs);
    const lateMs = Math.max(0, nowEpochMs - startEpochMs);
    const offsetSec = Math.min(Math.max(0, lateMs / 1000), Math.max(0, buffer.duration - 0.01));
    if (lateMs >= buffer.duration * 1000) return { skipped: true, reason: 'track-ended' };

    const src = audio.createBufferSource();
    const gain = audio.createGain();
    src.buffer = buffer;
    gain.gain.value = Number.isFinite(Number(options.volume)) ? Number(options.volume) : 0.95;
    src.connect(gain);
    gain.connect(audio.destination);
    const when = audio.currentTime + delayMs / 1000;
    src.start(when, offsetSec);
    remember(src);
    return { source: src, when, offsetSec, state: audio.state };
  }

  window.RhythmAudioEngine = {
    getContext,
    setSampleMap,
    loadUrlBuffer,
    playUrlBufferAtEpoch,
    preloadPitches,
    unlock,
    playNow,
    schedulePitch,
    scheduleSequence,
    renderSequenceToBuffer,
    playRenderedBufferAtEpoch,
    cancelScheduled,
    pitchToMidi,
    midiToPitch,
    normalizeDurationMs,
    getSampleMode(pitch) { return bufferCache.has(pitch) ? 'sample' : (sampleMap[pitch] ? 'loading' : 'synth'); }
  };
})();
