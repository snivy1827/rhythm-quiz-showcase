const socket = io();

// State variables
let gameState = null;
let teamRoundScores = {};
let teamCompetitionScores = {};
let serverTimeOffset = 0;
let rtt = 0;

// DDR playback variables
let gameStartTime = 0;
let currentNotes = [];
let noteSpeed = 0.35; // pixels per ms
let scrollDuration = 1600; // ms for notes to travel from top to judgment line
let animationFrameId = null;
let playedNotes = new Set();
let passedNotes = new Set();
let trackHeight = 600;
let judgmentLineY = 520; // exact arrow top at the visual target; recalculated from DOM

// Shared Web Audio engine. Audio scheduling is independent from the animation frame loop.
let noteSampleMap = {};
let hostAudioUnlocked = false;
let rhythmAudioSchedule = null;
let preparedRhythmTrack = null;
let preparedRhythmTrackPromise = null;
let preparedRhythmTrackKey = '';
let rhythmVisualZeroAudioTime = null;
let currentRhythmMeta = { rhythmSource: 'chart', referenceAudio: '', referenceAudioOffsetMs: 0, referenceAudioDurationMs: 0 };
let rhythmTrackEndMs = 0;
let manualAudioCompensationMs = Number(localStorage.getItem('rhythmAudioCompensationMs') || 0);
let currentPerformance = { sourceType: 'none' };
let currentPerformanceStart = 0;
let currentPerformanceEnd = 0;
let currentPerformanceController = null;
let performanceProgressTimer = null;
let youtubePerformancePlayer = null;
let youtubeApiPromise = null;
let currentPerformanceAspectRatio = 16 / 9;
let finalBgmState = { config: { sourceType: 'none' }, audio: null, iframe: null };
let currentPreparedQuestionId = '';


// Elements
const viewLobby = document.getElementById('host-lobby-view');
const viewRules = document.getElementById('host-rules-view');
const viewEnd = document.getElementById('host-end-view');
const viewIntro = document.getElementById('host-intro-view');
const viewRhythm = document.getElementById('host-rhythm-view');
const viewGuessing = document.getElementById('host-guessing-view');
const viewChoice = document.getElementById('host-choice-view');
const viewPerformance = document.getElementById('host-performance-view');
const viewReveal = document.getElementById('host-reveal-view');
const viewSettlement = document.getElementById('host-settlement-view');
const viewCelebration = document.getElementById('host-celebration-view');

const hostRoomId = document.getElementById('host-room-id');
const hostLobbyRoomCode = document.getElementById('host-lobby-room-code');
const entryQrOverlay = document.getElementById('host-entry-qr-overlay');
const entryQrImg = document.getElementById('host-entry-qr-img');
const entryQrRoom = document.getElementById('host-entry-room');
const entryQrUrlText = document.getElementById('host-entry-url-text');

const introQuestionNum = document.getElementById('intro-question-num');
const hostRulesTitle = document.getElementById('host-rules-title');
const hostRulesPageIndicator = document.getElementById('host-rules-page-indicator');
const hostRulesContent = document.getElementById('host-rules-content');
const hostRulesDots = document.getElementById('host-rules-dots');
const hostEndCanvasFrame = document.getElementById('host-end-canvas-frame');
const hostEndStage = document.getElementById('host-end-stage');
const tracksFrame = document.getElementById('tracks-frame');
const countdownOverlay = document.getElementById('rhythm-countdown');

function updateRhythmGeometry() {
  trackHeight = tracksFrame?.clientHeight || window.innerHeight || 600;
  const track = document.getElementById('track-left');
  const target = document.querySelector('.target-left');
  if (track && target) {
    const trackRect = track.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    // note-arrow and judgment-target are both 60px. Matching their top edges means
    // their centres coincide exactly regardless of viewport height / box size.
    judgmentLineY = Math.max(0, targetRect.top - trackRect.top);
  } else {
    judgmentLineY = Math.max(200, trackHeight - 113);
  }
}

function updateEndPageScale() {
  if (!hostEndCanvasFrame || !hostEndStage || !viewEnd) return;
  // V7.13: reproduce the 1600x900 content-management canvas exactly.
  // We uniformly scale the whole authored stage and pin its centre to the centre
  // of the available cyan host area. This preserves every X/Y/size relationship.
  const frameW = Math.max(1, hostEndCanvasFrame.clientWidth);
  const frameH = Math.max(1, hostEndCanvasFrame.clientHeight);
  const scale = Math.max(0.05, Math.min(frameW / 1600, frameH / 900));

  hostEndStage.style.width = '1600px';
  hostEndStage.style.height = '900px';
  hostEndStage.style.left = '50%';
  hostEndStage.style.top = '50%';
  hostEndStage.style.transformOrigin = 'center center';
  hostEndStage.style.transform = `translate(-50%, -50%) scale(${scale})`;

  // Font sizes remain in authoring pixels because the entire stage is transformed.
  // Do not separately scale text here or it would be scaled twice.
  hostEndStage.querySelectorAll('.host-end-element-text').forEach(node => {
    const base = Number(node.dataset.baseFontSize) || 42;
    node.style.fontSize = `${Math.max(12, base)}px`;
  });
}
window.addEventListener('resize', () => {
  if (gameState?.status === 'RHYTHM_PLAYING') updateRhythmGeometry();
  if (gameState?.status === 'PERFORMANCE') fitPerformanceMediaBox(currentPerformanceAspectRatio);
  if (gameState?.status === 'END_PAGES') requestAnimationFrame(updateEndPageScale);
});

const choiceOptions = document.getElementById('host-choice-options');
const performanceSongName = document.getElementById('performance-song-name');
const performanceMedia = document.getElementById('performance-media');
const performanceManualHint = document.getElementById('performance-manual-hint');
const performanceControls = document.getElementById('performance-controls');
const performancePlayToggle = document.getElementById('performance-play-toggle');
const performanceRestart = document.getElementById('performance-restart');
const performanceCurrentTime = document.getElementById('performance-current-time');
const performanceSeek = document.getElementById('performance-seek');
const performanceDuration = document.getElementById('performance-duration');
const performanceVolume = document.getElementById('performance-volume');
const hostSidebar = document.getElementById('host-sidebar');
const hostLayout = document.getElementById('host-layout');
const revealSongName = document.getElementById('reveal-song-name');
const revealPkmnName = document.getElementById('reveal-pkmn-name');
const revealWinnerTeam = document.getElementById('reveal-winner-team');
const revealWinnerScore = document.getElementById('reveal-winner-score');

const hudLeaderboard = document.getElementById('hud-leaderboard');
const rhythmTeamScoreList = document.getElementById('rhythm-team-score-list');
const collectionOverlay = document.getElementById('host-collection-overlay');
const collectionShowcaseTitle = document.getElementById('collection-showcase-title');
const collectionShowcaseContent = document.getElementById('collection-showcase-content');
const syncCalibrationButton = document.getElementById('sync-calibration-button');
const syncCalibrationPanel = document.getElementById('sync-calibration-panel');
const syncAutoLatency = document.getElementById('sync-auto-latency');
const syncManualOffset = document.getElementById('sync-manual-offset');
const syncTotalComp = document.getElementById('sync-total-comp');
const syncTestPulse = document.getElementById('sync-test-pulse');
const syncCloseButton = document.getElementById('sync-close-button');
const syncResetButton = document.getElementById('sync-reset-button');
const syncTestButton = document.getElementById('sync-test-button');

const settlementStatusText = document.getElementById('settlement-status-text');
const settlementRevealCard = document.getElementById('settlement-reveal-card');
const settleTeamName = document.getElementById('settle-team-name');
const settlePkmnGrid = document.getElementById('settle-pkmn-grid');
const settleTotalPts = document.getElementById('settle-total-pts');

const finalChampionTeam = document.getElementById('final-champion-team');
const finalChampionScore = document.getElementById('final-champion-score');
const finalLeaderboardList = document.getElementById('final-leaderboard-list');

async function refreshNoteLibrary() {
  try {
    const response = await fetch(`/api/note-library?ts=${Date.now()}`, { cache: 'no-store' });
    const library = response.ok ? await response.json() : { map: {} };
    noteSampleMap = library.map || {};
    window.RhythmAudioEngine?.setSampleMap(noteSampleMap);
  } catch (_) {}
}
refreshNoteLibrary();

// --- NTP Clock Sync ---
function syncTime() {
  socket.emit('time-sync', { clientTime: Date.now() });
}
socket.on('time-sync-response', (data) => {
  const now = Date.now();
  rtt = now - data.clientTime;
  serverTimeOffset = Math.round(data.serverTime + (rtt / 2) - now);
});
syncTime();
setInterval(syncTime, 5000);

function getSyncedTime() {
  return Date.now() + serverTimeOffset;
}

// Connect to socket as host
socket.emit('host-join');

async function prepareQuestionForRhythm(question) {
  if (!question) return;
  const questionId = String(question.id ?? '');
  const started = performance.now();
  currentPreparedQuestionId = questionId;
  currentNotes = Array.isArray(question.notes) ? question.notes : [];
  currentRhythmMeta = {
    rhythmSource: question.rhythmSource || 'chart',
    referenceAudio: question.referenceAudio || '',
    referenceAudioOffsetMs: Number(question.referenceAudioOffsetMs) || 0,
    referenceAudioDurationMs: Number(question.audioAuto?.durationMs) || 0
  };
  try {
    if (currentRhythmMeta.rhythmSource === 'reference-audio-auto' && currentRhythmMeta.referenceAudio) {
      await window.RhythmAudioEngine?.loadUrlBuffer(currentRhythmMeta.referenceAudio);
    } else {
      await prepareRhythmTrack(currentNotes, false);
    }
    if (currentPreparedQuestionId !== questionId) return;
    socket.emit('host-rhythm-ready', { questionId, ready: true, prepareMs: performance.now() - started, message: '投影端音訊已預載完成' });
  } catch (error) {
    console.error('[host audio] preload failed', error);
    if (currentPreparedQuestionId !== questionId) return;
    socket.emit('host-rhythm-ready', { questionId, ready: false, prepareMs: performance.now() - started, message: `投影端預載失敗：${error?.message || error}` });
  }
}

socket.on('host-join-success', (data) => {
  gameState = data.gameState;
  teamRoundScores = data.gameState.teamRoundScores || {};
  teamCompetitionScores = data.gameState.teamCompetitionScores || { ...teamRoundScores };
  hostRoomId.textContent = gameState.roomId;
  if (hostLobbyRoomCode) hostLobbyRoomCode.textContent = gameState.roomId;
  if (entryQrRoom) entryQrRoom.textContent = gameState.roomId;
  
  if (data.currentQuestion) prepareQuestionForRhythm(data.currentQuestion);
  
  updateHUD();
  applyHostSidebarLayout(gameState.status);
  if (gameState.status === 'RULES') {
    viewLobby.style.display = 'none';
    if (viewRules) { renderRulesPage(gameState.rules || {}); viewRules.style.display = 'flex'; }
  } else if (gameState.status === 'END_PAGES') {
    viewLobby.style.display = 'none';
    if (viewEnd) { renderEndPage(gameState.endPages || {}); viewEnd.style.display = 'flex'; }
  }
});

socket.on('entry-qr-visibility', (data = {}) => {
  if (!entryQrOverlay) return;
  if (!data.visible) {
    entryQrOverlay.style.display = 'none';
    return;
  }
  const url = String(data.url || '').trim();
  if (!url) return;
  if (entryQrImg) {
    entryQrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=360x360&data=${encodeURIComponent(url)}`;
  }
  if (entryQrUrlText) entryQrUrlText.textContent = url;
  if (entryQrRoom) entryQrRoom.textContent = data.roomId || gameState?.roomId || '8888';
  entryQrOverlay.style.display = 'flex';
});

socket.on('room-updated', (data) => {
  if (!gameState) return;
  gameState.teams = data.teams;
  gameState.players = data.players || gameState.players;
  if (data.teamRoundScores) teamRoundScores = data.teamRoundScores;
  if (data.teamCompetitionScores) teamCompetitionScores = data.teamCompetitionScores;
  if (data.roomId) {
    hostRoomId.textContent = data.roomId;
    if (hostLobbyRoomCode) hostLobbyRoomCode.textContent = data.roomId;
    if (entryQrRoom) entryQrRoom.textContent = data.roomId;
  }
  updateHUD();
});

// Load question charts
socket.on('host-load-question', (data) => {
  if (data.question) prepareQuestionForRhythm(data.question);
  playedNotes.clear();
  passedNotes.clear();
});

// V7.13 projection layout: when a stage has no team sidebar, collapse that
// column but KEEP the original room header and cyan pixel stage frame.  This is
// a responsive presentation mode rather than a hard-coded immersive fullscreen.
function applyHostSidebarLayout(status = gameState?.status) {
  const noSidebar = ['RULES','SETTLEMENT','FINAL_RESULTS','END_PAGES'].includes(String(status || ''));
  if (hostSidebar) hostSidebar.style.display = noSidebar ? 'none' : 'flex';
  if (hostLayout) {
    hostLayout.classList.toggle('host-layout-fullwidth', noSidebar);
    hostLayout.classList.toggle('host-layout-presentation', noSidebar);
    hostLayout.classList.remove('host-layout-immersive');
    // Inline grid sizing is intentional: even if a projector browser keeps an
    // older cached stylesheet, the empty 380px sidebar column cannot remain.
    hostLayout.style.gridTemplateColumns = noSidebar ? 'minmax(0, 1fr)' : '';
  }
  if (noSidebar) {
    requestAnimationFrame(() => {
      if (status === 'END_PAGES') updateEndPageScale();
    });
  }
}

// Update Right Sidebar HUD
function updateHUD() {
  if (!gameState || !gameState.teams) return;

  // The current-question leaderboard is the actual capture competition total:
  // rhythm judgment score × guessing multiplier (direct/fallback choice). Pokémon point values
  // are still excluded because those belong only to final settlement.
  const teamList = Object.keys(gameState.teams).map((teamId) => {
    const team = gameState.teams[teamId];
    return {
      id: teamId,
      name: team.name,
      score: Number(teamCompetitionScores[teamId] ?? teamRoundScores[teamId]) || 0,
      memberCount: Array.isArray(team.members) ? team.members.length : Number(team.memberCount) || 0,
      operatorName: team.roundOperator?.nickname || ''
    };
  }).sort((a, b) => b.score - a.score);

  hudLeaderboard.innerHTML = '';
  teamList.forEach((team, index) => {
    const isFirst = index === 0 && team.score > 0;
    const item = document.createElement('div');
    item.className = `rank-item ${isFirst ? 'first' : ''}`;
    item.innerHTML = `
      <div>
        <span class="retro-text" style="font-size:10px;">#${index + 1}</span>
        <strong style="margin-left:8px;">${team.name}</strong>
        <span style="font-size:11px;opacity:.6;"> (${team.memberCount}人${team.operatorName ? `｜操作：${team.operatorName}` : ''})</span>
      </div>
      <span class="retro-text text-cyan" style="font-size:11px;">本題 ${Math.round(team.score)}分</span>
    `;
    hudLeaderboard.appendChild(item);
  });

  if (!teamList.length) {
    hudLeaderboard.innerHTML = '<p class="text-center" style="color:#666;margin-top:30px;">等待玩家登入...</p>';
  }

  renderRhythmScoreboard(teamList);
}

function renderRhythmScoreboard(teamList) {
  if (!rhythmTeamScoreList) return;
  rhythmTeamScoreList.innerHTML = '';
  if (!teamList.length) {
    rhythmTeamScoreList.innerHTML = '<p style="font-size:11px;color:#777;text-align:center;">等待玩家加入</p>';
    return;
  }
  teamList.forEach((team, index) => {
    const row = document.createElement('div');
    row.className = `rhythm-team-score-row ${index === 0 && team.score > 0 ? 'leading' : ''}`;
    row.innerHTML = `
      <span class="rhythm-team-score-name">${team.name}</span>
      <span class="rhythm-team-score-value">${Math.round(team.score)} 分</span>
    `;
    rhythmTeamScoreList.appendChild(row);
  });
}

socket.on('round-scores-updated', (data) => {
  // Backward-compatible with older servers while preferring V5.8's explicit fields.
  teamRoundScores = data.rhythmScores || data.scores || {};
  teamCompetitionScores = data.competitionScores || { ...teamRoundScores };
  updateHUD();
});

function renderCollectionShowcase(data) {
  if (!data.visible) {
    collectionOverlay.style.display = 'none';
    return;
  }
  const teams = data.teams || {};
  const selected = data.teamId && data.teamId !== 'all' ? [data.teamId] : Object.keys(teams);
  collectionShowcaseTitle.textContent = data.teamId && data.teamId !== 'all' && teams[data.teamId]
    ? `${teams[data.teamId].name}目前圖鑑`
    : '各小組目前圖鑑';
  collectionShowcaseContent.innerHTML = '';

  selected.forEach((teamId) => {
    const team = teams[teamId];
    if (!team) return;
    const section = document.createElement('section');
    section.className = 'collection-team-section';
    const caught = Array.isArray(team.caught) ? team.caught : [];
    section.innerHTML = `
      <div class="d-flex justify-between align-center" style="margin-bottom:10px;">
        <h3 class="retro-text text-cyan" style="font-size:14px;">${team.name}</h3>
        <span style="font-size:12px;color:#aaa;">已捕捉 ${caught.length} 隻</span>
      </div>
      <div class="collection-pokemon-grid"></div>
    `;
    const grid = section.querySelector('.collection-pokemon-grid');
    if (!caught.length) {
      grid.innerHTML = '<p style="grid-column:1/-1;color:#666;font-size:13px;">尚未捕捉寶可夢</p>';
    } else {
      caught.forEach((pokemon) => {
        const item = document.createElement('div');
        item.className = 'collection-pokemon-card';
        item.innerHTML = `${pokemonIconMarkup(pokemon, '')}<span>${pokemon.name}</span>`;
        grid.appendChild(item);
      });
    }
    collectionShowcaseContent.appendChild(section);
  });
  collectionOverlay.style.display = 'flex';
}

socket.on('collection-showcase', renderCollectionShowcase);

// --- Shared Web Audio sample & fallback synthesizer ---
const PITCH_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

function midiNoteToPitch(midiNote) {
  return window.RhythmAudioEngine?.midiToPitch(midiNote) || (() => {
    const value = Math.max(0, Math.min(127, Math.round(Number(midiNote) || 0)));
    return `${PITCH_NAMES[value % 12]}${Math.floor(value / 12) - 1}`;
  })();
}

async function unlockHostAudio() {
  try {
    await refreshNoteLibrary();
    hostAudioUnlocked = Boolean(await window.RhythmAudioEngine?.unlock());
  } catch (_) {
    hostAudioUnlocked = false;
  }
  return hostAudioUnlocked;
}

// A pointer gesture is still used opportunistically when available, but there is no
// projection-screen button anymore. In browsers that already allow playback, the
// rendered rhythm track starts normally without any extra action.
document.addEventListener('pointerdown', () => { if (!hostAudioUnlocked) unlockHostAudio(); }, { once: true });

function playNoteSound(pitch, durationMs = 180) {
  if (!pitch) return;
  window.RhythmAudioEngine?.playNow(String(pitch).trim(), durationMs);
}

function rhythmTrackKey(notes) {
  return JSON.stringify((notes || []).map((note) => [
    Number(note.time) || 0,
    Number(note.duration) || 0,
    String(note.pitch || window.RhythmAudioEngine?.midiToPitch(note.midiNote) || '')
  ]));
}

async function prepareRhythmTrack(notes, force = false) {
  const key = rhythmTrackKey(notes);
  if (!force && preparedRhythmTrack && preparedRhythmTrackKey === key) return preparedRhythmTrack;
  if (!force && preparedRhythmTrackPromise && preparedRhythmTrackKey === key) return preparedRhythmTrackPromise;

  preparedRhythmTrackKey = key;
  preparedRhythmTrack = null;
  preparedRhythmTrackPromise = (async () => {
    await refreshNoteLibrary();
    const rendered = await window.RhythmAudioEngine?.renderSequenceToBuffer(notes, {
      sampleRate: 44100,
      masterGain: 0.78,
      tailMs: 180
    });
    preparedRhythmTrack = rendered;
    return rendered;
  })();

  try {
    return await preparedRhythmTrackPromise;
  } finally {
    preparedRhythmTrackPromise = null;
  }
}

function getAutoOutputLatencyMs() {
  const audio = window.RhythmAudioEngine?.getContext?.();
  if (!audio) return 0;
  const output = Number(audio.outputLatency);
  if (Number.isFinite(output) && output > 0) return Math.round(output * 1000);
  const base = Number(audio.baseLatency);
  if (Number.isFinite(base) && base > 0) return Math.round(base * 1000);
  return 0;
}

function getTotalAudioCompensationMs() {
  return Math.max(-500, Math.min(500, getAutoOutputLatencyMs() + Number(manualAudioCompensationMs || 0)));
}

function refreshSyncCalibrationUI() {
  if (syncAutoLatency) syncAutoLatency.textContent = `${getAutoOutputLatencyMs()} ms`;
  if (syncManualOffset) syncManualOffset.value = String(Math.round(manualAudioCompensationMs || 0));
  if (syncTotalComp) syncTotalComp.textContent = `${Math.round(getTotalAudioCompensationMs())} ms`;
}

function saveManualAudioCompensation(value) {
  manualAudioCompensationMs = Math.max(-500, Math.min(500, Number(value) || 0));
  localStorage.setItem('rhythmAudioCompensationMs', String(manualAudioCompensationMs));
  refreshSyncCalibrationUI();
}

async function runSyncCalibrationTest() {
  try {
    await window.RhythmAudioEngine?.unlock();
    const audio = window.RhythmAudioEngine?.getContext?.();
    if (!audio) return;
    const compensationSec = getTotalAudioCompensationMs() / 1000;
    const visualBase = audio.currentTime + 1.0;
    const targets = Array.from({ length: 6 }, (_, i) => visualBase + i * 0.65);
    targets.forEach((visualTime) => {
      window.RhythmAudioEngine?.schedulePitch('C5', visualTime - compensationSec, 90);
    });
    let index = 0;
    let activeUntil = 0;
    const draw = () => {
      const now = audio.currentTime;
      while (index < targets.length && now >= targets[index]) {
        activeUntil = now + 0.10;
        index += 1;
      }
      if (syncTestPulse) syncTestPulse.classList.toggle('active', now < activeUntil);
      if (index < targets.length || now < activeUntil) requestAnimationFrame(draw);
      else if (syncTestPulse) syncTestPulse.classList.remove('active');
    };
    requestAnimationFrame(draw);
  } catch (error) {
    console.error('[sync calibration] test failed', error);
  }
}

if (syncCalibrationButton) syncCalibrationButton.addEventListener('click', () => {
  refreshSyncCalibrationUI();
  syncCalibrationPanel.style.display = 'block';
});
if (syncCloseButton) syncCloseButton.addEventListener('click', () => { syncCalibrationPanel.style.display = 'none'; });
if (syncManualOffset) syncManualOffset.addEventListener('change', () => saveManualAudioCompensation(syncManualOffset.value));
if (syncResetButton) syncResetButton.addEventListener('click', () => saveManualAudioCompensation(0));
if (syncTestButton) syncTestButton.addEventListener('click', runSyncCalibrationTest);
document.querySelectorAll('[data-sync-adjust]').forEach((button) => {
  button.addEventListener('click', () => saveManualAudioCompensation((Number(manualAudioCompensationMs) || 0) + Number(button.dataset.syncAdjust || 0)));
});
refreshSyncCalibrationUI();

function getRhythmElapsedMs() {
  const audio = window.RhythmAudioEngine?.getContext?.();
  if (audio && audio.state === 'running' && Number.isFinite(rhythmVisualZeroAudioTime)) {
    return (audio.currentTime - rhythmVisualZeroAudioTime) * 1000;
  }
  return getSyncedTime() - gameStartTime;
}

async function scheduleRhythmAudio(notes, startTime, meta = currentRhythmMeta) {
  try {
    window.RhythmAudioEngine?.cancelScheduled();
    const compensationMs = getTotalAudioCompensationMs();
    if (meta?.rhythmSource === 'reference-audio-auto' && meta.referenceAudio) {
      // No score/MIDI: play the original WAV/MP3 itself. Arrows are only a rhythm
      // interaction layer generated from the audio envelope; C4 placeholders in the
      // note objects are never heard.
      rhythmAudioSchedule = await window.RhythmAudioEngine?.playUrlBufferAtEpoch(meta.referenceAudio, {
        startEpochMs: startTime - compensationMs,
        getNowEpochMs: getSyncedTime,
        offsetMs: Number(meta.referenceAudioOffsetMs) || 0,
        volume: 0.95
      });
      const audio = window.RhythmAudioEngine?.getContext?.();
      if (audio && rhythmAudioSchedule && !rhythmAudioSchedule.skipped) {
        rhythmVisualZeroAudioTime = Number(rhythmAudioSchedule.when) - (Number(rhythmAudioSchedule.lateSec) || 0) + (compensationMs / 1000);
        const remainingMs = Math.max(0, ((Number(rhythmAudioSchedule.bufferDurationSec) || 0) - (Number(rhythmAudioSchedule.baseOffsetSec) || 0)) * 1000);
        rhythmTrackEndMs = Math.max(rhythmTrackEndMs, remainingMs);
      }
      hostAudioUnlocked = audio?.state === 'running';
      return;
    }

    // Normal score/MIDI path: render the note chart into one continuous buffer.
    const rendered = await prepareRhythmTrack(notes);
    rhythmAudioSchedule = await window.RhythmAudioEngine?.playRenderedBufferAtEpoch(rendered, {
      startEpochMs: startTime - compensationMs,
      getNowEpochMs: getSyncedTime,
      volume: 0.95
    });
    const audio = window.RhythmAudioEngine?.getContext?.();
    if (audio && rhythmAudioSchedule && !rhythmAudioSchedule.skipped) {
      const offsetSec = Number(rhythmAudioSchedule.offsetSec) || 0;
      rhythmVisualZeroAudioTime = Number(rhythmAudioSchedule.when) - offsetSec + (compensationMs / 1000);
    }
    hostAudioUnlocked = audio?.state === 'running';
  } catch (error) {
    console.error('[host audio] playback failed', error);
    // Only chart-based questions can fall back to the per-note scheduler.
    if (meta?.rhythmSource === 'reference-audio-auto') return;
    try {
      const compensationMs = getTotalAudioCompensationMs();
      rhythmAudioSchedule = await window.RhythmAudioEngine?.scheduleSequence(notes, {
        startEpochMs: startTime - compensationMs,
        getNowEpochMs: getSyncedTime
      });
      if (rhythmAudioSchedule?.baseAudioTime) {
        rhythmVisualZeroAudioTime = Number(rhythmAudioSchedule.baseAudioTime) + (compensationMs / 1000);
      }
    } catch (fallbackError) {
      console.error('[host audio] fallback scheduling failed', fallbackError);
    }
  }
}

// --- Dynamic SVG Pokemon generator (Silhouette & Pixels) ---
function drawPokemonSVG(svgNode, pokemonName, isSilhouette = false) {
  svgNode.innerHTML = '';
  
  // Pick color based on name hash
  let hash = 0;
  for (let i = 0; i < pokemonName.length; i++) {
    hash = pokemonName.charCodeAt(i) + ((hash << 5) - hash);
  }
  const colors = ['#FF5757', '#F4D03F', '#3498DB', '#9B59B6', '#E67E22', '#2ECC71', '#F1948A', '#85C1E9'];
  const pColor = isSilhouette ? '#111111' : colors[Math.abs(hash) % colors.length];

  // Draw a cute retro retro monster silhouette
  // Add body path
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('fill', pColor);
  
  // Generate shapes based on name hash
  const earStyle = Math.abs(hash) % 3; // 0=pointed, 1=round, 2=long
  const wingStyle = (Math.abs(hash) >> 2) % 2 === 0;
  
  let d = '';
  // Main body circle
  d += 'M 50 30 C 35 30, 25 40, 25 55 C 25 70, 35 80, 50 80 C 65 80, 75 70, 75 55 C 75 40, 65 30, 50 30 ';
  
  // Left ear
  if (earStyle === 0) {
    d += 'M 30 35 L 20 15 L 38 28 Z '; // Pointed
  } else if (earStyle === 1) {
    d += 'M 32 32 Q 18 18, 25 35 Z '; // Round
  } else {
    d += 'M 28 32 C 10 20, 10 40, 28 35 Z '; // Floppy long
  }
  
  // Right ear
  if (earStyle === 0) {
    d += 'M 70 35 L 80 15 L 62 28 Z ';
  } else if (earStyle === 1) {
    d += 'M 68 32 Q 82 18, 75 35 Z ';
  } else {
    d += 'M 72 32 C 90 20, 90 40, 72 35 Z ';
  }

  // Wings (for legendary or special types)
  if (wingStyle) {
    d += 'M 25 55 Q 5 45, 15 65 Q 20 70, 25 60 Z '; // Left wing
    d += 'M 75 55 Q 95 45, 85 65 Q 80 70, 75 60 Z '; // Right wing
  }

  // Tail
  d += 'M 25 75 Q 10 85, 12 90 Q 20 90, 35 80 Z ';
  
  path.setAttribute('d', d);
  svgNode.appendChild(path);

  // Draw retro glowing eyes if not silhouette
  if (!isSilhouette) {
    const eye1 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    eye1.setAttribute('cx', '42');
    eye1.setAttribute('cy', '50');
    eye1.setAttribute('r', '4');
    eye1.setAttribute('fill', '#ffffff');
    
    const eye2 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    eye2.setAttribute('cx', '58');
    eye2.setAttribute('cy', '50');
    eye2.setAttribute('r', '4');
    eye2.setAttribute('fill', '#ffffff');

    const pupil1 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    pupil1.setAttribute('cx', '43');
    pupil1.setAttribute('cy', '50');
    pupil1.setAttribute('r', '2');
    pupil1.setAttribute('fill', '#000000');
    
    const pupil2 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    pupil2.setAttribute('cx', '59');
    pupil2.setAttribute('cy', '50');
    pupil2.setAttribute('r', '2');
    pupil2.setAttribute('fill', '#000000');

    svgNode.appendChild(eye1);
    svgNode.appendChild(eye2);
    svgNode.appendChild(pupil1);
    svgNode.appendChild(pupil2);

    // Cheek dots (Pikachu-like)
    const cheek1 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    cheek1.setAttribute('cx', '34');
    cheek1.setAttribute('cy', '58');
    cheek1.setAttribute('r', '4');
    cheek1.setAttribute('fill', '#FF5757');

    const cheek2 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    cheek2.setAttribute('cx', '66');
    cheek2.setAttribute('cy', '58');
    cheek2.setAttribute('r', '4');
    cheek2.setAttribute('fill', '#FF5757');

    svgNode.appendChild(cheek1);
    svgNode.appendChild(cheek2);
  }
}

function hasPokemonImage(image) {
  return Boolean(image && image !== 'placeholder.png');
}

function trimTransparentPadding(img) {
  if (!img || img.dataset.alphaTrimmed === '1') return;
  img.dataset.alphaTrimmed = '1';
  try {
    const naturalWidth = img.naturalWidth || 0;
    const naturalHeight = img.naturalHeight || 0;
    if (!naturalWidth || !naturalHeight) return;
    const canvas = document.createElement('canvas');
    canvas.width = naturalWidth;
    canvas.height = naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const pixels = ctx.getImageData(0, 0, naturalWidth, naturalHeight).data;
    let left = naturalWidth, right = -1, top = naturalHeight, bottom = -1;
    for (let y = 0; y < naturalHeight; y += 1) {
      for (let x = 0; x < naturalWidth; x += 1) {
        const alpha = pixels[(y * naturalWidth + x) * 4 + 3];
        if (alpha > 8) {
          if (x < left) left = x;
          if (x > right) right = x;
          if (y < top) top = y;
          if (y > bottom) bottom = y;
        }
      }
    }
    if (right < left || bottom < top) return;
    const cropWidth = right - left + 1;
    const cropHeight = bottom - top + 1;
    // Only trim when there is meaningful transparent padding.
    if (cropWidth >= naturalWidth * 0.92 && cropHeight >= naturalHeight * 0.92) return;
    const cropped = document.createElement('canvas');
    cropped.width = cropWidth;
    cropped.height = cropHeight;
    cropped.getContext('2d').drawImage(canvas, left, top, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
    img.src = cropped.toDataURL('image/png');
  } catch (_) {
    // External/CORS-protected images simply keep their original source.
  }
}

function renderPokemonVisual(container, svgNode, pokemon, silhouette = false) {
  container.querySelectorAll('img.uploaded-pokemon-image, .no-pokemon-marker').forEach(node => node.remove());
  const name = pokemon?.name || '未知寶可夢';
  const image = pokemon?.image || '';
  if (svgNode) svgNode.style.display = 'none';
  if (hasPokemonImage(image)) {
    const img = document.createElement('img');
    img.className = 'uploaded-pokemon-image';
    img.src = image;
    img.alt = name;
    img.style.width = '80%';
    img.style.height = '80%';
    img.style.objectFit = 'contain';
    img.style.imageRendering = 'pixelated';
    img.addEventListener('load', () => trimTransparentPadding(img), { once: true });
    img.addEventListener('error', () => {
      img.remove();
      const marker = document.createElement('span');
      marker.className = 'no-pokemon-marker';
      marker.textContent = '圖片載入失敗';
      container.appendChild(marker);
    });
    container.appendChild(img);
  } else {
    const marker = document.createElement('span');
    marker.className = 'no-pokemon-marker';
    marker.style.fontSize = '16px';
    marker.textContent = '尚未設定寶可夢圖片';
    container.appendChild(marker);
  }
}

function pokemonIconMarkup(pokemon, svgClass, svgStyle = '') {
  if (hasPokemonImage(pokemon.image)) {
    return `<img src="${pokemon.image}" alt="${pokemon.name}" style="width:50px;height:50px;object-fit:contain;image-rendering:pixelated;">`;
  }
  return `<span style="display:grid;place-items:center;width:50px;height:50px;border:1px dashed #666;">?</span>`;
}

function formatPerformanceTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const m = Math.floor(total / 60);
  const sec = String(total % 60).padStart(2, '0');
  return `${m}:${sec}`;
}

function stopPerformanceProgressTimer() {
  if (performanceProgressTimer) clearInterval(performanceProgressTimer);
  performanceProgressTimer = null;
}

function setPerformanceControlsVisible(visible) {
  if (!performanceControls) return;
  performanceControls.style.display = visible ? 'grid' : 'none';
}

function effectivePerformanceEnd(duration) {
  const start = Math.max(0, Number(currentPerformanceStart) || 0);
  const requestedEnd = Math.max(0, Number(currentPerformanceEnd) || 0);
  if (requestedEnd > start) return requestedEnd;
  return Math.max(start, Number(duration) || start);
}

function updatePerformanceControls() {
  if (!currentPerformanceController) return;
  let duration = 0;
  let current = 0;
  try { duration = Number(currentPerformanceController.getDuration?.()) || 0; } catch (_) {}
  try { current = Number(currentPerformanceController.getCurrentTime?.()) || 0; } catch (_) {}
  const start = Math.max(0, Number(currentPerformanceStart) || 0);
  const end = effectivePerformanceEnd(duration);
  if (performanceSeek) {
    performanceSeek.min = String(start);
    performanceSeek.max = String(Math.max(start + 0.01, end));
    if (document.activeElement !== performanceSeek) performanceSeek.value = String(Math.min(end, Math.max(start, current)));
  }
  if (performanceCurrentTime) performanceCurrentTime.textContent = formatPerformanceTime(Math.max(0, current - start));
  if (performanceDuration) performanceDuration.textContent = formatPerformanceTime(Math.max(0, end - start));
  let playing = false;
  try { playing = Boolean(currentPerformanceController.isPlaying?.()); } catch (_) {}
  if (performancePlayToggle) performancePlayToggle.textContent = playing ? '⏸ 暫停' : '▶ 播放';
  if (end > start && current >= end - 0.03 && playing) {
    try { currentPerformanceController.pause?.(); } catch (_) {}
  }
}

function attachPerformanceController(controller) {
  currentPerformanceController = controller;
  setPerformanceControlsVisible(Boolean(controller));
  stopPerformanceProgressTimer();
  updatePerformanceControls();
  if (controller) performanceProgressTimer = setInterval(updatePerformanceControls, 200);
}

function destroyYoutubePerformancePlayer() {
  try { youtubePerformancePlayer?.destroy?.(); } catch (_) {}
  youtubePerformancePlayer = null;
}

function clearPerformanceMedia() {
  stopPerformanceProgressTimer();
  attachPerformanceController(null);
  destroyYoutubePerformancePlayer();
  performanceMedia.querySelectorAll('video,audio').forEach((media) => {
    try { media.pause(); } catch (_) {}
    media.removeAttribute('src');
    try { media.load(); } catch (_) {}
  });
  performanceMedia.innerHTML = '';
}

function loadYoutubeIframeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (youtubeApiPromise) return youtubeApiPromise;
  youtubeApiPromise = new Promise((resolve, reject) => {
    const previousReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      try { previousReady?.(); } catch (_) {}
      resolve(window.YT);
    };
    if (!document.querySelector('script[data-pokemon-youtube-api]')) {
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.dataset.pokemonYoutubeApi = '1';
      script.onerror = () => reject(new Error('YouTube Player API 載入失敗'));
      document.head.appendChild(script);
    }
    setTimeout(() => {
      if (window.YT?.Player) resolve(window.YT);
    }, 1500);
  });
  return youtubeApiPromise;
}

function youtubeVideoId(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    if (parsed.hostname.includes('youtu.be')) return parsed.pathname.split('/').filter(Boolean)[0] || '';
    if (parsed.pathname.startsWith('/shorts/')) return parsed.pathname.split('/')[2] || '';
    if (parsed.pathname.startsWith('/embed/')) return parsed.pathname.split('/')[2] || '';
    return parsed.searchParams.get('v') || '';
  } catch (_) {
    return String(url || '').trim().match(/^[a-zA-Z0-9_-]{11}$/)?.[0] || '';
  }
}

function fitPerformanceMediaBox(ratio = 16 / 9) {
  if (!performanceMedia) return;
  const safeRatio = Number.isFinite(Number(ratio)) && Number(ratio) > 0.2 ? Number(ratio) : 16 / 9;
  currentPerformanceAspectRatio = safeRatio;

  // Fit the *entire* native video frame inside the visible projection area.
  // Uploaded 4:3 / vertical / legacy videos must never be forced into a 16:9 crop.
  const parentWidth = Math.max(320, viewPerformance?.clientWidth || performanceMedia.parentElement?.clientWidth || window.innerWidth * 0.72);
  const maxWidth = Math.min(900, parentWidth);
  const viewportHeight = Math.max(480, window.innerHeight || 720);
  // Reserve room for the page label + song title + borders/margins.
  const maxHeight = Math.max(260, viewportHeight - 235);

  let width = maxWidth;
  let height = width / safeRatio;
  if (height > maxHeight) {
    height = maxHeight;
    width = height * safeRatio;
  }

  performanceMedia.style.width = `${Math.floor(width)}px`;
  performanceMedia.style.height = `${Math.floor(height)}px`;
  performanceMedia.style.aspectRatio = 'auto';
  performanceMedia.style.maxWidth = '100%';
  performanceMedia.style.maxHeight = `${Math.floor(maxHeight)}px`;
  performanceMedia.style.overflow = 'hidden';
}

function resetPerformanceMediaBox() {
  fitPerformanceMediaBox(16 / 9);
}

function bindHtmlPerformanceMedia(media, start, end) {
  media.controls = true; // Native controls are kept as a fallback.
  media.autoplay = false;
  media.preload = 'auto';
  media.style.width = '100%';
  if (media.tagName === 'VIDEO') {
    media.style.height = '100%';
    media.style.objectFit = 'contain';
    media.style.objectPosition = 'center center';
    media.style.background = '#000';
  }
  const controller = {
    play: () => media.play(),
    pause: () => media.pause(),
    seek: (seconds) => { media.currentTime = Math.max(start, Number(seconds) || start); },
    setVolume: (value) => { media.volume = Math.max(0, Math.min(1, Number(value) || 0)); },
    getCurrentTime: () => media.currentTime || start,
    getDuration: () => media.duration || 0,
    isPlaying: () => !media.paused && !media.ended,
  };
  media.addEventListener('loadedmetadata', () => {
    if (media.tagName === 'VIDEO') {
      const naturalW = Number(media.videoWidth) || 16;
      const naturalH = Number(media.videoHeight) || 9;
      fitPerformanceMediaBox(naturalW / naturalH);
    }
    if (start) media.currentTime = start;
    updatePerformanceControls();
  });
  media.addEventListener('play', updatePerformanceControls);
  media.addEventListener('pause', updatePerformanceControls);
  media.addEventListener('ended', updatePerformanceControls);
  if (end > start) media.addEventListener('timeupdate', () => {
    if (media.currentTime >= end) {
      media.pause();
      media.currentTime = end;
    }
  });
  attachPerformanceController(controller);
}

async function renderYoutubePerformance(id, data, start, end) {
  fitPerformanceMediaBox(16 / 9);
  const holder = document.createElement('div');
  holder.id = `youtube-performance-${Date.now()}`;
  holder.style.width = '100%';
  holder.style.height = '100%';
  performanceMedia.appendChild(holder);
  try {
    const YT = await loadYoutubeIframeApi();
    if (!document.getElementById(holder.id)) return;
    youtubePerformancePlayer = new YT.Player(holder.id, {
      width: '100%',
      height: '100%',
      videoId: id,
      playerVars: {
        autoplay: 0,
        controls: 1,
        playsinline: 1,
        rel: 0,
        start: Math.floor(start || 0),
        ...(end > start ? { end: Math.floor(end) } : {}),
      },
      events: {
        onReady: (event) => {
          try { event.target.pauseVideo(); } catch (_) {}
          const controller = {
            play: () => event.target.playVideo(),
            pause: () => event.target.pauseVideo(),
            seek: (seconds) => event.target.seekTo(Math.max(start, Number(seconds) || start), true),
            setVolume: (value) => event.target.setVolume(Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100)),
            getCurrentTime: () => event.target.getCurrentTime?.() || start,
            getDuration: () => event.target.getDuration?.() || 0,
            isPlaying: () => event.target.getPlayerState?.() === YT.PlayerState.PLAYING,
          };
          attachPerformanceController(controller);
          if (performanceVolume) controller.setVolume(Number(performanceVolume.value) / 100);
        },
        onStateChange: () => updatePerformanceControls(),
        onError: () => {
          if (performanceManualHint) performanceManualHint.textContent = 'YouTube 播放器發生錯誤，請確認網址與網路。';
        },
      },
    });
  } catch (error) {
    performanceMedia.innerHTML = `<div style="padding:24px;">YouTube 播放器載入失敗：${String(error?.message || error)}</div>`;
    setPerformanceControlsVisible(false);
  }
}

function renderPerformance(data) {
  clearPerformanceMedia();
  resetPerformanceMediaBox();
  performanceSongName.textContent = data.songName || '完整題目';
  const performance = data.performance || { sourceType: 'none' };
  currentPerformance = performance;
  const start = Math.max(0, Number(performance.startSeconds) || 0);
  const end = Math.max(0, Number(performance.endSeconds) || 0);
  currentPerformanceStart = start;
  currentPerformanceEnd = end;
  if (performanceManualHint) performanceManualHint.textContent = '媒體已載入；下方控制列會固定顯示，可直接播放、暫停與拖曳進度。';
  if (performance.sourceType === 'youtube') {
    const id = youtubeVideoId(performance.youtubeUrl);
    if (!id) { performanceMedia.textContent = 'YouTube 網址未設定或格式不正確'; return; }
    renderYoutubePerformance(id, data, start, end);
    return;
  }
  if (['video', 'audio'].includes(performance.sourceType) && performance.assetUrl) {
    const media = document.createElement(performance.sourceType);
    media.src = performance.assetUrl;
    performanceMedia.appendChild(media);
    bindHtmlPerformanceMedia(media, start, end);
    return;
  }
  setPerformanceControlsVisible(false);
  if (performanceManualHint) performanceManualHint.textContent = '本題為現場演奏，請由主持人自行開始。';
  performanceMedia.innerHTML = '<div><div style="font-size:64px">🎵</div><p style="font-size:18px">請進行現場口琴演奏或播放外部伴奏</p></div>';
}

if (performancePlayToggle) performancePlayToggle.addEventListener('click', async () => {
  if (!currentPerformanceController) return;
  let playing = false;
  try { playing = Boolean(currentPerformanceController.isPlaying?.()); } catch (_) {}
  try {
    if (playing) currentPerformanceController.pause?.();
    else await currentPerformanceController.play?.();
  } catch (error) {
    console.warn('Performance playback failed:', error);
  }
  updatePerformanceControls();
});

if (performanceRestart) performanceRestart.addEventListener('click', () => {
  if (!currentPerformanceController) return;
  try {
    currentPerformanceController.seek?.(currentPerformanceStart || 0);
    currentPerformanceController.pause?.();
  } catch (_) {}
  updatePerformanceControls();
});

if (performanceSeek) performanceSeek.addEventListener('input', () => {
  if (!currentPerformanceController) return;
  try { currentPerformanceController.seek?.(Number(performanceSeek.value)); } catch (_) {}
  updatePerformanceControls();
});

if (performanceVolume) performanceVolume.addEventListener('input', () => {
  if (!currentPerformanceController) return;
  try { currentPerformanceController.setVolume?.(Number(performanceVolume.value) / 100); } catch (_) {}
});

function youtubeBgmId(url) { return youtubeVideoId(url); }
function clearFinalBgm() {
  try { finalBgmState.audio?.pause(); } catch (_) {}
  try { finalBgmState.iframe?.remove(); } catch (_) {}
  finalBgmState = { config: { sourceType: 'none' }, audio: null, iframe: null };
}
function loadFinalBgm(config = {}) {
  const same = JSON.stringify(finalBgmState.config || {}) === JSON.stringify(config || {});
  if (same && (finalBgmState.audio || finalBgmState.iframe || config.sourceType === 'none')) return;
  clearFinalBgm();
  finalBgmState.config = { ...config };
  if (config.sourceType === 'audio' && config.assetUrl) {
    const audio = new Audio(config.assetUrl);
    audio.loop = true; audio.preload = 'auto'; audio.volume = Math.max(0, Math.min(1, Number(config.volume) || 0.55));
    finalBgmState.audio = audio; audio.load();
  } else if (config.sourceType === 'youtube' && config.youtubeUrl) {
    const id = youtubeBgmId(config.youtubeUrl); if (!id) return;
    const iframe = document.createElement('iframe');
    iframe.src = `https://www.youtube.com/embed/${id}?autoplay=0&playsinline=1&rel=0&enablejsapi=1&loop=1&playlist=${id}`;
    iframe.allow = 'autoplay; encrypted-media'; iframe.style.cssText = 'position:fixed;width:1px;height:1px;left:-100px;top:-100px;border:0;opacity:0;pointer-events:none;';
    document.body.appendChild(iframe); finalBgmState.iframe = iframe;
  }
}
function controlFinalBgm(command) {
  const config = finalBgmState.config || {};
  if (finalBgmState.audio) { if (command === 'pause') finalBgmState.audio.pause(); else finalBgmState.audio.play().catch(() => {}); return; }
  const iframe = finalBgmState.iframe;
  if (iframe?.contentWindow) iframe.contentWindow.postMessage(JSON.stringify({ event:'command', func: command === 'pause' ? 'pauseVideo' : 'playVideo', args:[] }), '*');
}
socket.on('final-bgm-load', ({ bgm } = {}) => loadFinalBgm(bgm || {}));
socket.on('final-bgm-control', ({ command, bgm } = {}) => { if (bgm) loadFinalBgm(bgm); controlFinalBgm(command); });

function renderRulesPage(rules = {}) {
  const page = rules.page || {};
  const pageIndex = Math.max(0, Number(rules.pageIndex) || 0);
  const pageCount = Math.max(1, Number(rules.pageCount) || 1);
  if (hostRulesTitle) hostRulesTitle.textContent = page.title || '遊戲規則';
  if (hostRulesPageIndicator) hostRulesPageIndicator.textContent = `${pageIndex + 1} / ${pageCount}`;
  if (hostRulesContent) {
    hostRulesContent.innerHTML = window.MarkdownLite?.render(page.markdown || '') || '<p>尚未設定規則內容。</p>';
    hostRulesContent.scrollTop = 0;
  }
  if (hostRulesDots) {
    hostRulesDots.innerHTML = Array.from({ length: pageCount }, (_, index) => `<span class="rules-dot ${index === pageIndex ? 'active' : ''}"></span>`).join('');
  }
}


function renderEndPage(endPages = {}) {
  const page = endPages.page || {};
  if (!hostEndStage || !hostEndCanvasFrame) return;
  const pageBg = page.backgroundColor || '#071014';
  hostEndCanvasFrame.style.backgroundColor = pageBg;
  // Preserve the grid across BOTH the authored canvas and any spare projector area,
  // so a non-16:9 host stage never shows a separate black letterbox block.
  hostEndCanvasFrame.style.backgroundImage = 'linear-gradient(rgba(102,252,241,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(102,252,241,.035) 1px,transparent 1px)';
  hostEndCanvasFrame.style.backgroundSize = '25px 25px';
  hostEndStage.style.background = 'transparent';
  hostEndStage.innerHTML = '';
  const elements = Array.isArray(page.elements) ? [...page.elements].sort((a,b)=>(Number(a.z)||0)-(Number(b.z)||0)) : [];
  elements.forEach(el => {
    const type = el?.type === 'image' ? 'image' : 'text';
    const node = document.createElement('div');
    node.className = `host-end-element host-end-element-${type}`;
    const x = Number(el.x) || 0, y = Number(el.y) || 0;
    const w = Number(el.w) || 100, h = Number(el.h) || 100;
    // Keep the exact same 1600x900 pixel coordinates as the content editor.
    // updateEndPageScale() scales the whole stage uniformly afterwards.
    node.style.left = `${x}px`; node.style.top = `${y}px`;
    node.style.width = `${w}px`; node.style.height = `${h}px`; node.style.zIndex = String(Number(el.z)||0);
    if (type === 'image') {
      if (el.url) node.innerHTML = `<img src="${String(el.url).replaceAll('&','&amp;').replaceAll('"','&quot;')}" alt="活動結束頁圖片" style="object-fit:${el.fit==='cover'?'cover':'contain'}">`;
    } else {
      const baseFontSize = Math.max(12, Number(el.fontSize) || 42);
      node.dataset.baseFontSize = String(baseFontSize);
      node.style.fontSize = `${baseFontSize}px`;
      node.style.textAlign = ['left','center','right'].includes(el.textAlign) ? el.textAlign : 'left';
      node.style.color = /^#[0-9a-fA-F]{6}$/.test(String(el.color||'')) ? el.color : '#ffffff';
      node.style.background = el.backgroundEnabled ? (/^#[0-9a-fA-F]{6}$/.test(String(el.backgroundColor||'')) ? el.backgroundColor : '#000000') : 'transparent';
      node.innerHTML = window.MarkdownLite?.render(el.markdown || '') || '';
    }
    hostEndStage.appendChild(node);
  });
  requestAnimationFrame(updateEndPageScale);
}

// --- Game Flow State Transitions ---
socket.on('state-change', (data) => {
  const status = data.status;
  if (!gameState) return;
  gameState.status = status;
  
  // Hide all screens initially
  viewLobby.style.display = 'none';
  if (viewRules) viewRules.style.display = 'none';
  if (viewEnd) viewEnd.style.display = 'none';
  viewIntro.style.display = 'none';
  viewRhythm.style.display = 'none';
  viewRhythm.classList.remove('host-rhythm-fullscreen');
  viewGuessing.style.display = 'none';
  viewChoice.style.display = 'none';
  viewPerformance.style.display = 'none';
  viewReveal.style.display = 'none';
  viewSettlement.style.display = 'none';
  viewCelebration.style.display = 'none';
  
  stopConfetti();
  applyHostSidebarLayout(status);
  if (status !== 'RHYTHM_PLAYING') {
    window.RhythmAudioEngine?.cancelScheduled();
    rhythmVisualZeroAudioTime = null;
  }
  if (status !== 'PERFORMANCE') clearPerformanceMedia();

  if (status === "LOBBY") {
    viewLobby.style.display = 'block';
  }
  else if (status === "RULES") {
    renderRulesPage(data.rules || gameState.rules || {});
    if (viewRules) viewRules.style.display = 'flex';
  } 
  else if (status === 'END_PAGES') {
    renderEndPage(data.endPages || gameState.endPages || {});
    if (viewEnd) viewEnd.style.display = 'flex';
  }
  else if (status === "INTRO") {
    gameState.currentQuestionIndex = data.currentQuestionIndex;
    teamRoundScores = Object.fromEntries(Object.keys(gameState.teams || {}).map((teamId) => [teamId, 0]));
    teamCompetitionScores = { ...teamRoundScores };
    updateHUD();
    
    introQuestionNum.textContent = `第 ${data.currentQuestionIndex + 1} 題`;
    viewIntro.style.display = 'block';
  } 
  else if (status === "RHYTHM_PLAYING") {
    viewRhythm.style.display = 'flex';
    viewRhythm.classList.add('host-rhythm-fullscreen');
  } 
  else if (status === "GUESSING") {
    viewGuessing.style.display = 'block';
  }
  else if (status === "MULTIPLE_CHOICE") {
    choiceOptions.innerHTML = '';
    const options = data.multipleChoice?.options || [];
    options.forEach((option, index) => {
      const card = document.createElement('div');
      card.className = 'pixel-box';
      card.style.padding = '22px';
      card.style.fontSize = '20px';
      card.innerHTML = `<span class="retro-text text-gold">${String.fromCharCode(65 + index)}</span><br>${option}`;
      choiceOptions.appendChild(card);
    });
    viewChoice.style.display = 'block';
  }
  else if (status === "PERFORMANCE") {
    viewPerformance.style.display = 'block';
  }
  else if (status === "SETTLEMENT") {
    viewSettlement.style.display = 'block';
    settlementRevealCard.style.display = 'none';
    settlementStatusText.textContent = '最終成績已準備完成，等待主持人開始公布。';
  }
});

// Rhythm play synchronization starts
socket.on('rhythm-start', (data) => {
  if (gameState) {
    gameState.status = "RHYTHM_PLAYING";
  }
  applyHostSidebarLayout('RHYTHM_PLAYING');
  gameStartTime = data.startTime;
  if (data.notes && data.notes.length > 0) {
    currentNotes = data.notes;
  }
  currentRhythmMeta = {
    rhythmSource: data.rhythmSource || 'chart',
    referenceAudio: data.referenceAudio || '',
    referenceAudioOffsetMs: Number(data.referenceAudioOffsetMs) || 0,
    referenceAudioDurationMs: Number(data.referenceAudioDurationMs) || 0
  };
  const lastConfiguredNote = currentNotes[currentNotes.length - 1];
  rhythmTrackEndMs = lastConfiguredNote ? lastConfiguredNote.time + Math.max(1000, (Number(lastConfiguredNote.duration) || 0) + 350) : 0;
  if (currentRhythmMeta.rhythmSource === 'reference-audio-auto') {
    rhythmTrackEndMs = Math.max(rhythmTrackEndMs, Math.max(0, currentRhythmMeta.referenceAudioDurationMs - currentRhythmMeta.referenceAudioOffsetMs));
  }
  
  viewLobby.style.display = 'none';
  if (viewRules) viewRules.style.display = 'none';
  if (viewEnd) viewEnd.style.display = 'none';
  viewIntro.style.display = 'none';
  viewGuessing.style.display = 'none';
  viewChoice.style.display = 'none';
  viewPerformance.style.display = 'none';
  viewReveal.style.display = 'none';
  viewSettlement.style.display = 'none';
  viewCelebration.style.display = 'none';

  viewRhythm.style.display = 'flex';
  viewRhythm.classList.add('host-rhythm-fullscreen');
  
  // Recalculate against the real 60px target box. Do not guess with a fixed -110px.
  updateRhythmGeometry();
  
  countdownOverlay.style.display = 'block';
  
  // Clear any existing arrow elements in the track DOM
  document.querySelectorAll('.note-arrow').forEach(el => el.remove());
  
  if (animationFrameId) cancelAnimationFrame(animationFrameId);
  
  // Schedule the entire question against the Web Audio clock. The returned audio
  // timeline becomes the visual master clock so arrows follow the sound timeline.
  rhythmVisualZeroAudioTime = null;
  scheduleRhythmAudio(currentNotes, gameStartTime, currentRhythmMeta).catch((error) => console.error('[host audio] schedule failed', error));

  playedNotes.clear();
  passedNotes.clear();
  teamRoundScores = {};
  teamCompetitionScores = {};
  updateHUD();
  
  // Animation Loop
  animationFrameId = requestAnimationFrame(updateRhythmFrame);
});

// DDR falling notes loop
function updateRhythmFrame() {
  if (gameState.status !== "RHYTHM_PLAYING") return;
  
  // Prefer the AudioContext clock once the rendered track is scheduled. This avoids
  // drift between requestAnimationFrame / Date.now() and the actual audio timeline.
  const elapsed = getRhythmElapsedMs();
  
  // 1. Countdown screen overlays
  if (elapsed < 0) {
    const secondsLeft = Math.ceil(Math.abs(elapsed) / 1000);
    countdownOverlay.textContent = secondsLeft;
  } else {
    countdownOverlay.style.display = 'none';
  }

  // 2. Track arrow updates
  currentNotes.forEach((note, index) => {
    const noteTargetTime = note.time; // ms offset relative to gameStartTime
    const noteTimeDiff = noteTargetTime - elapsed; // ms until judgment line head hits
    const noteTailDiff = noteTimeDiff + (note.duration || 0); // ms until tail hits
    
    // Check if we should spawn note arrow visually
    if (noteTimeDiff <= scrollDuration && noteTailDiff >= -200) {
      let arrowNode = document.getElementById(`arrow-node-${index}`);
      if (!arrowNode) {
        // Create arrow
        arrowNode = document.createElement('div');
        arrowNode.id = `arrow-node-${index}`;
        arrowNode.className = `note-arrow note-${note.direction}`;
        
        const isLongNote = note.duration && note.duration >= 300;
        if (isLongNote) {
          const bodyNode = document.createElement('div');
          bodyNode.className = 'note-body';
          const speed = judgmentLineY / scrollDuration;
          const bodyHeight = note.duration * speed;
          bodyNode.style.height = `${bodyHeight}px`;
          arrowNode.appendChild(bodyNode);
        }
        
        document.getElementById(`track-${note.direction}`).appendChild(arrowNode);
      }
      
      // Calculate Y coordinate based on elapsed time. At noteTimeDiff === 0 the
      // 60px falling note overlays the 60px target exactly. Long-note heads continue
      // past the line after their hit moment; they are no longer pinned in a visually
      // "still hittable" position after the server's head judgment window has passed.
      const yPos = (1 - (noteTimeDiff / scrollDuration)) * judgmentLineY;
      const isLongNote = note.duration && note.duration >= 300;
      arrowNode.style.top = `${yPos}px`;
      
      // Visual hit flash only. Audio is pre-scheduled by the Web Audio engine.
      if (elapsed >= noteTargetTime && !playedNotes.has(index)) {
        playedNotes.add(index);
        const target = document.querySelector(`.target-${note.direction}`);
        if (target) {
          target.style.backgroundColor = `var(--color-${note.direction})`;
          if (isLongNote) {
            target.style.boxShadow = `0 0 20px var(--color-${note.direction})`;
            setTimeout(() => {
              target.style.backgroundColor = 'rgba(255,255,255,0.05)';
              target.style.boxShadow = '';
            }, note.duration);
          } else {
            setTimeout(() => { target.style.backgroundColor = 'rgba(255,255,255,0.05)'; }, 100);
          }
        }
      }
      
      // Fade out and remove notes that are past the judgment line
      if (noteTailDiff < 0) {
        arrowNode.style.opacity = Math.max(0, 1 + (noteTailDiff / 200));
      }
    } else {
      // Remove element if out of screen range
      const arrowNode = document.getElementById(`arrow-node-${index}`);
      if (arrowNode) arrowNode.remove();
    }
  });

  // Check if all notes are played & passed, notify backend to transition automatically
  const lastNote = currentNotes[currentNotes.length - 1];
  if ((lastNote || rhythmTrackEndMs > 0) && elapsed > Math.max(rhythmTrackEndMs, lastNote ? lastNote.time + Math.max(1000, (Number(lastNote.duration) || 0) + 350) : 0)) {
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    socket.emit('admin-control', { type: 'end-rhythm-early' });
    return;
  }
  
  animationFrameId = requestAnimationFrame(updateRhythmFrame);
}

// Individual PERFECT / GOOD / MISS feedback is intentionally shown only on each player's phone.

socket.on('performance-start', (data) => {
  if (gameState) gameState.status = 'PERFORMANCE';
  applyHostSidebarLayout('PERFORMANCE');
  viewLobby.style.display = 'none';
  viewIntro.style.display = 'none';
  viewRhythm.style.display = 'none';
  viewGuessing.style.display = 'none';
  viewChoice.style.display = 'none';
  viewReveal.style.display = 'none';
  viewSettlement.style.display = 'none';
  viewCelebration.style.display = 'none';
  viewPerformance.style.display = 'block';
  renderPerformance(data);
});

// Answer revealed
socket.on('answer-reveal', (data) => {
  applyHostSidebarLayout('ANSWER_REVEAL');
  clearPerformanceMedia();
  viewGuessing.style.display = 'none';
  viewChoice.style.display = 'none';
  viewPerformance.style.display = 'none';
  viewReveal.style.display = 'block';
  
  revealSongName.textContent = data.songName;
  
  // Always reveal the Pokémon assigned to this question. Capture success is a separate result.
  const revealPokemon = data.questionPokemon || data.capturedPokemon || null;
  if (revealPokemon) {
    revealPkmnName.textContent = revealPokemon.name || '未知寶可夢';
    const revSvg = document.getElementById('reveal-svg');
    renderPokemonVisual(document.getElementById('reveal-pkmn-img'), revSvg, revealPokemon, false);
  } else {
    revealPkmnName.textContent = '未設定寶可夢';
    const revealBox = document.getElementById('reveal-pkmn-img');
    revealBox.querySelectorAll('img.uploaded-pokemon-image, .no-pokemon-marker').forEach(node => node.remove());
    const revealSvg = document.getElementById('reveal-svg');
    if (revealSvg) revealSvg.style.display = 'none';
    const marker = document.createElement('span');
    marker.className = 'no-pokemon-marker';
    marker.style.fontSize = '18px';
    marker.textContent = '尚未設定寶可夢';
    revealBox.appendChild(marker);
  }
  
  if (data.winningTeamIds.length > 0) {
    // Show winning team(s) names
    const winNames = data.winningTeamIds.map(tid => gameState.teams[tid] ? gameState.teams[tid].name : tid);
    revealWinnerTeam.textContent = winNames.join(' & ');
    revealWinnerScore.textContent = '本題綜合判定勝出，成功取得捕捉機會！';
  } else {
    revealWinnerTeam.textContent = '無';
    revealWinnerScore.textContent = '本題沒有隊伍完成捕捉條件';
  }
  
  if (data.teams) gameState.teams = data.teams;
  if (data.teamRoundScores) teamRoundScores = data.teamRoundScores;
  if (data.teamCompetitionScores) teamCompetitionScores = data.teamCompetitionScores;
  updateHUD();
});

// Step-by-step points reveal animation
socket.on('settlement-step-reveal', (data) => {
  applyHostSidebarLayout('SETTLEMENT');
  viewSettlement.style.display = 'block';
  settlementRevealCard.style.display = 'block';
  
  settlementStatusText.textContent = `正在揭曉第 ${data.step + 1} 組圖鑑積分...`;
  settleTeamName.textContent = data.teamName;
  settleTotalPts.textContent = `${data.totalScore} 點`;
  
  // Render caught pokemons
  settlePkmnGrid.innerHTML = '';
  if (data.caught.length === 0) {
    settlePkmnGrid.innerHTML = '<span style="grid-column: span 4; color: #666; font-size: 13px;">無捕獲寶可夢</span>';
  } else {
    data.caught.forEach(pkmn => {
      const pNode = document.createElement('div');
      pNode.className = 'caught-pkmn-icon';
      pNode.style.width = '70px';
      pNode.style.height = '70px';
      pNode.innerHTML = `
        ${pokemonIconMarkup(pkmn, 'pkmn-settle-svg', 'width:50px;height:50px;')}
        <div style="font-size: 7px; margin-top:2px;">${pkmn.name}</div>
        <span class="points-tag">${pkmn.points}P</span>
      `;
      const settleSvg = pNode.querySelector('.pkmn-settle-svg');
      if (settleSvg) drawPokemonSVG(settleSvg, pkmn.name, false);
      settlePkmnGrid.appendChild(pNode);
    });
  }
  
  // Play dynamic chime note
  playNoteSound('C5');
});

// Final rankings screen with confetti
socket.on('final-results', (data) => {
  if (gameState) gameState.status = 'FINAL_RESULTS';
  applyHostSidebarLayout('FINAL_RESULTS');
  viewSettlement.style.display = 'none';
  viewCelebration.style.display = 'block';
  
  const champion = data.finalStandings[0];
  finalChampionTeam.textContent = champion ? champion.name : '無';
  finalChampionScore.textContent = champion ? `以總積分 ${champion.totalScore} 點奪得第一名！` : '';
  
  finalLeaderboardList.innerHTML = '';
  data.finalStandings.forEach((team, index) => {
    const row = document.createElement('div');
    row.className = 'd-flex justify-between';
    row.style.borderBottom = '1px dashed #333';
    row.style.padding = '5px 10px';
    row.style.fontSize = index === 0 ? '16px' : '13px';
    if (index === 0) row.className += ' text-gold';
    
    row.innerHTML = `
      <span>#${index + 1} ${team.name}</span>
      <span class="retro-text">${team.totalScore} 點｜捕捉 ${team.caughtCount} 隻</span>
    `;
    finalLeaderboardList.appendChild(row);
  });
  
  // Trigger particle confetti
  startConfetti();
});

// --- Confetti Particle System ---
let confettiCanvas = document.getElementById('confetti');
let confettiCtx = confettiCanvas.getContext('2d');
let confettiActive = false;
let confettiParticles = [];

function resizeConfettiCanvas() {
  confettiCanvas.width = window.innerWidth;
  confettiCanvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeConfettiCanvas);

function startConfetti() {
  resizeConfettiCanvas();
  confettiActive = true;
  confettiParticles = [];
  
  // Create 150 particles
  for (let i = 0; i < 150; i++) {
    confettiParticles.push({
      x: Math.random() * confettiCanvas.width,
      y: Math.random() * confettiCanvas.height - confettiCanvas.height,
      r: Math.random() * 6 + 4,
      d: Math.random() * confettiCanvas.height,
      color: `hsl(${Math.random() * 360}, 100%, 50%)`,
      tilt: Math.random() * 10 - 5,
      tiltAngleIncremental: Math.random() * 0.07 + 0.02,
      tiltAngle: 0
    });
  }
  
  requestAnimationFrame(drawConfettiFrame);
}

function stopConfetti() {
  confettiActive = false;
  confettiCtx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
}

function drawConfettiFrame() {
  if (!confettiActive) return;
  confettiCtx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
  
  confettiParticles.forEach((p, idx) => {
    p.tiltAngle += p.tiltAngleIncremental;
    p.y += (Math.cos(p.d) + 3 + p.r / 2) / 2;
    p.tilt = Math.sin(p.tiltAngle - idx / 3) * 15;
    
    confettiCtx.beginPath();
    confettiCtx.lineWidth = p.r;
    confettiCtx.strokeStyle = p.color;
    confettiCtx.moveTo(p.x + p.tilt + p.r / 2, p.y);
    confettiCtx.lineTo(p.x + p.tilt, p.y + p.tilt + p.r / 2);
    confettiCtx.stroke();
    
    // Recycle particle if falls off screen
    if (p.y > confettiCanvas.height) {
      confettiParticles[idx] = {
        ...p,
        x: Math.random() * confettiCanvas.width,
        y: -20,
        tilt: Math.random() * 10 - 5
      };
    }
  });
  
  requestAnimationFrame(drawConfettiFrame);
}
