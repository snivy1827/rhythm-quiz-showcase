const socket = io({ reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 500, reconnectionDelayMax: 3000, timeout: 10000 });
const PLAYER_SESSION_KEY = 'pokemon_rhythm_player_session_v71';
let playerSession = (() => {
  try { const raw = JSON.parse(localStorage.getItem(PLAYER_SESSION_KEY) || '{}'); if (raw && raw.sessionId) return raw; } catch (_) {}
  const bytes = new Uint8Array(12); try { crypto.getRandomValues(bytes); } catch (_) { for (let i=0;i<bytes.length;i++) bytes[i]=Math.floor(Math.random()*256); }
  return { sessionId: Array.from(bytes).map((b)=>b.toString(16).padStart(2,'0')).join('') };
})();
let roomConfigLoaded = false;
let manualJoinCompleted = false;
const accessToken = new URLSearchParams(location.search).get('access') || '';
const heldDirections = new Set();

// Client state variables
let playerId = '';
let nickname = '';
let teamId = '';
let totalScore = 0;
let roundScore = 0;
let combo = 0;
let myTeam = null;
let isRoundOperator = false;
let roundOperatorName = '';

// Time synchronization variables
let serverTimeOffset = 0;
let rtt = 0;
const timeSyncSamples = [];

// Latency Calibration variables
// V7.5: reaction-time calibration is diagnostic only and must not shift gameplay input.
let localLatencyOffset = 0;
try { localStorage.removeItem('calib_offset'); } catch (_) {}
let isCalibrating = false;
let calibBeats = [];
let calibTapsCount = 0;
let calibIntervalId = null;
let calibNextBeatTime = 0;

// Audio context for calibration beeps
let audioCtx = null;

// Game state variables
let gameStatus = "LOBBY";
let currentQuestion = null;
let gameStartTime = 0;
let perfectWindow = 80;
let goodWindow = 180;
let notesList = [];
let judgedNotes = new Set(); // set of note indices that have been processed for HEAD
let activeHolds = { left: null, down: null, up: null, right: null }; // Tracks active hold notes per direction

// Elements
const viewJoin = document.getElementById('join-view');
const viewLobby = document.getElementById('lobby-view');
const viewGame = document.getElementById('game-view');
const viewWaiting = document.getElementById('waiting-view');
const viewSettlement = document.getElementById('settlement-view');

const inputRoom = document.getElementById('input-room');
const inputNickname = document.getElementById('input-nickname');
const selectTeam = document.getElementById('select-team');
const btnJoin = document.getElementById('btn-join');

const btnOpenCalib = document.getElementById('btn-open-calib');
const btnCalibLobby = document.getElementById('btn-calib-lobby');
const overlayCalib = document.getElementById('calib-overlay');
const btnCalibTap = document.getElementById('btn-calib-tap');
const btnCalibClose = document.getElementById('btn-calib-close');
const calibVisualNode = document.getElementById('calib-visual-node');
const calibStatus = document.getElementById('calib-status');
const lobbyCalibVal = document.getElementById('lobby-calib-value');
const playerWelcomeMsg = document.getElementById('player-welcome-msg');

const hudNickname = document.getElementById('hud-nickname');
const hudTeam = document.getElementById('hud-team');
const hudScore = document.getElementById('hud-score');
const hudQuestionTitle = document.getElementById('hud-question-title');
const gameStatusLabel = document.getElementById('game-status-label');

const judgmentText = document.getElementById('judgment-text');
const comboText = document.getElementById('combo-text');
const roundScoreVal = document.getElementById('round-score-val');
const waitingScoreBox = document.getElementById('waiting-score-box');
const waitingTitle = document.getElementById('waiting-title');
const btnOpenTeamDex = document.getElementById('btn-open-team-dex');
const btnCloseTeamDex = document.getElementById('btn-close-team-dex');
const teamDexOverlay = document.getElementById('team-dex-overlay');
const teamDexTitle = document.getElementById('team-dex-title');
const teamDexSummary = document.getElementById('team-dex-summary');
const teamDexGrid = document.getElementById('team-dex-grid');

// Initialize lobby calib text
lobbyCalibVal.textContent = `${localLatencyOffset} ms`;

async function loadRoomConfiguration() {
  try {
    const response = await fetch('/api/room');
    if (!response.ok) return;
    const config = await response.json();
    inputRoom.value = config.roomId || inputRoom.value;
    if (Array.isArray(config.teams) && config.teams.length) {
      selectTeam.innerHTML = config.teams.map((team, index) =>
        `<option value="${team.id}">${team.name} (Team ${String.fromCharCode(65 + index)})</option>`
      ).join('');
    }
    if (config.tokenRequired && !accessToken) {
      btnJoin.title = '此活動需使用現場 QR Code 入場';
    }
  } catch (error) {
    console.warn('Unable to load room configuration:', error);
  }
}
loadRoomConfiguration().finally(() => { roomConfigLoaded = true; tryAutoRejoin(); });

function updateDexButtonVisibility() {
  const canExplore = Boolean(playerId) && gameStatus !== 'RHYTHM_PLAYING' && gameStatus !== 'SETTLEMENT';
  btnOpenTeamDex.style.display = canExplore ? 'block' : 'none';
  if (!canExplore) teamDexOverlay.style.display = 'none';
}

function renderMyTeamDex() {
  const caught = Array.isArray(myTeam?.caught) ? myTeam.caught : [];
  teamDexTitle.textContent = myTeam ? `${myTeam.name}圖鑑` : '我的隊伍圖鑑';
  teamDexSummary.textContent = `目前已捕捉 ${caught.length} 隻寶可夢。`;
  teamDexGrid.innerHTML = '';
  if (!caught.length) {
    teamDexGrid.innerHTML = '<p style="grid-column:1/-1;color:#777;font-size:13px;text-align:center;padding:28px 0;">目前尚未捕捉寶可夢</p>';
    return;
  }
  caught.forEach((pokemon) => {
    const card = document.createElement('div');
    card.className = 'team-dex-card';
    const image = pokemon.image && pokemon.image !== 'placeholder.png'
      ? `<img src="${pokemon.image}" alt="${pokemon.name}">`
      : '<div class="team-dex-missing">未設定圖片</div>';
    card.innerHTML = `${image}<span>${pokemon.name}</span>`;
    teamDexGrid.appendChild(card);
  });
}

btnOpenTeamDex.addEventListener('click', () => {
  renderMyTeamDex();
  teamDexOverlay.style.display = 'flex';
});
btnCloseTeamDex.addEventListener('click', () => { teamDexOverlay.style.display = 'none'; });
teamDexOverlay.addEventListener('click', (event) => {
  if (event.target === teamDexOverlay) teamDexOverlay.style.display = 'none';
});

socket.on('player-team-update', (data) => {
  myTeam = data.team || myTeam;
  isRoundOperator = Boolean(data.team?.isRoundOperator);
  roundOperatorName = data.team?.roundOperator?.nickname || '';
  if (gameStatus === 'RHYTHM_PLAYING' || gameStatus === 'INTRO') updateRoundOperatorUI();
  if (teamDexOverlay.style.display !== 'none') renderMyTeamDex();
  updateDexButtonVisibility();
});

function updateRoundOperatorUI() {
  const dpad = document.querySelector('.mobile-dpad');
  const buttons = document.querySelectorAll('.dpad-btn');
  buttons.forEach((button) => { button.disabled = !isRoundOperator; });
  if (dpad) dpad.style.opacity = isRoundOperator ? '1' : '0.28';
  if (gameStatus === 'RHYTHM_PLAYING') {
    gameStatusLabel.textContent = isRoundOperator
      ? '你是本題操作員！看準大螢幕箭頭按按鈕！'
      : `本題由 ${roundOperatorName || '隊友'} 操作；一起聽歌並準備猜題！`;
  } else if (gameStatus === 'INTRO') {
    gameStatusLabel.textContent = isRoundOperator
      ? '本題輪到你操作節奏遊戲，準備開始！'
      : `本題由 ${roundOperatorName || '隊友'} 操作；你仍可一起參與猜歌。`;
  }
}

// --- NTP Clock Sync ---
function syncTime() {
  socket.emit('time-sync', { clientTime: Date.now() });
}

socket.on('time-sync-response', (data) => {
  const now = Date.now();
  const sampleRtt = Math.max(0, now - Number(data.clientTime || now));
  const sampleOffset = Math.round(Number(data.serverTime || now) + (sampleRtt / 2) - now);
  rtt = sampleRtt;
  timeSyncSamples.push({ rtt: sampleRtt, offset: sampleOffset });
  if (timeSyncSamples.length > 10) timeSyncSamples.shift();

  // Network paths are often asymmetric. Prefer the lowest-RTT samples and take a
  // median offset so one temporary Wi-Fi / Cloudflare spike cannot move judgment.
  const best = [...timeSyncSamples].sort((a, b) => a.rtt - b.rtt).slice(0, Math.min(5, timeSyncSamples.length));
  const offsets = best.map((sample) => sample.offset).sort((a, b) => a - b);
  const middle = Math.floor(offsets.length / 2);
  serverTimeOffset = offsets.length % 2
    ? offsets[middle]
    : Math.round((offsets[middle - 1] + offsets[middle]) / 2);
});

// Perform NTP sync immediately and every 5 seconds. Re-sync aggressively after
// returning from another app/tab because mobile browsers may suspend timers.
syncTime();
setInterval(syncTime, 5000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    syncTime();
    setTimeout(syncTime, 250);
    setTimeout(syncTime, 800);
  }
});

function getSyncedTime() {
  return Date.now() + serverTimeOffset;
}

// --- Web Audio Helper for Beep ---
function playBeep(freq = 600, duration = 0.08) {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
  } catch (e) {
    console.error("Audio playback error:", e);
  }
}

// --- Latency Calibration Logic ---
function startCalibration() {
  isCalibrating = true;
  calibTapsCount = 0;
  calibBeats = [];
  overlayCalib.style.display = 'flex';
  calibStatus.textContent = '準備中...';
  
  if (calibIntervalId) clearInterval(calibIntervalId);

  // Play beats every 1000ms
  calibNextBeatTime = getSyncedTime() + 1000;
  
  calibIntervalId = setInterval(() => {
    const targetTime = calibNextBeatTime;
    calibNextBeatTime += 1000;
    
    // Trigger visual flash and sound
    calibVisualNode.classList.add('active');
    playBeep(800, 0.08);
    
    setTimeout(() => {
      calibVisualNode.classList.remove('active');
    }, 150);

    // Keep track of recent target times
    calibBeats.push(targetTime);
    if (calibBeats.length > 10) calibBeats.shift();
  }, 1000);
}

function handleCalibTap() {
  if (!isCalibrating) return;
  const tapTime = getSyncedTime();
  playBeep(500, 0.04);
  
  // Find the closest scheduled beat time
  if (calibBeats.length === 0) return;
  
  let closestBeat = calibBeats[0];
  let minDiff = Math.abs(tapTime - closestBeat);
  
  for (let i = 1; i < calibBeats.length; i++) {
    let diff = Math.abs(tapTime - calibBeats[i]);
    if (diff < minDiff) {
      minDiff = diff;
      closestBeat = calibBeats[i];
    }
  }

  // Latency offset: how late the user tapped compared to the actual beat
  // error = tapTime - closestBeat
  const error = tapTime - closestBeat;
  
  // Ignore taps that are way off (e.g. > 450ms) to ensure calibration is clean
  if (Math.abs(error) < 450) {
    calibTapsCount++;
    if (!this.calibErrors) this.calibErrors = [];
    this.calibErrors.push(error);
    
    calibStatus.textContent = `進度：${calibTapsCount} / 5`;
    
    if (calibTapsCount >= 5) {
      // This measures human response to the local flash/beep only. V7.5 keeps it
      // as a diagnostic and never subtracts it from rhythm-game input timestamps.
      const sum = this.calibErrors.reduce((a, b) => a + b, 0);
      const measuredReaction = Math.round(sum / this.calibErrors.length);
      localLatencyOffset = 0;
      lobbyCalibVal.textContent = `判定補償 0 ms（反應測試 ${measuredReaction >= 0 ? '+' : ''}${measuredReaction} ms）`;
      calibStatus.textContent = `測試完成：平均反應 ${measuredReaction >= 0 ? '+' : ''}${measuredReaction} ms；此數值不會套用到遊戲判定。`;
      
      this.calibErrors = [];
      clearInterval(calibIntervalId);
      calibIntervalId = null;
      
      setTimeout(() => {
        stopCalibration();
      }, 1500);
    }
  }
}

function stopCalibration() {
  isCalibrating = false;
  overlayCalib.style.display = 'none';
  if (calibIntervalId) {
    clearInterval(calibIntervalId);
    calibIntervalId = null;
  }
}

// Attach Calibration Events
btnOpenCalib.addEventListener('click', startCalibration);
btnCalibLobby.addEventListener('click', startCalibration);
btnCalibTap.addEventListener('click', handleCalibTap);
btnCalibClose.addEventListener('click', stopCalibration);

// Initialize web audio context on first screen tap anywhere
window.addEventListener('click', () => {
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {}
  }
}, { once: true });

function persistPlayerSession() {
  playerSession = { ...playerSession, nickname, teamId, roomCode: inputRoom.value.trim(), accessToken, joined: true };
  localStorage.setItem(PLAYER_SESSION_KEY, JSON.stringify(playerSession));
}

function emitPlayerJoin({ silent = false } = {}) {
  const room = (playerSession.roomCode || inputRoom.value || '').trim();
  const joinNickname = (playerSession.nickname || nickname || inputNickname.value || '').trim();
  const joinTeamId = playerSession.teamId || teamId || selectTeam.value;
  if (!room || !joinNickname || !joinTeamId || !socket.connected) return false;
  nickname = joinNickname; teamId = joinTeamId;
  inputRoom.value = room; inputNickname.value = joinNickname;
  if ([...selectTeam.options].some((o) => o.value === joinTeamId)) selectTeam.value = joinTeamId;
  socket.emit('player-join', { nickname, teamId, roomCode: room, accessToken: accessToken || playerSession.accessToken || '', sessionId: playerSession.sessionId, reconnecting: silent });
  return true;
}

function tryAutoRejoin() {
  if (!roomConfigLoaded || !socket.connected || !playerSession?.joined || !playerSession.sessionId) return;
  emitPlayerJoin({ silent: true });
}

socket.on('connect', () => { if (roomConfigLoaded) tryAutoRejoin(); });
socket.on('disconnect', () => {
  heldDirections.clear();
  if (playerSession?.joined) {
    gameStatusLabel.textContent = '連線暫時中斷，正在自動重新連線…';
  }
});

// --- Join Room Flow ---
btnJoin.addEventListener('click', () => {
  nickname = inputNickname.value.trim();
  const room = inputRoom.value.trim();
  teamId = selectTeam.value;

  if (!nickname) {
    alert("請輸入暱稱！");
    return;
  }
  if (!room) {
    alert("請輸入房間代碼！");
    return;
  }

  playerSession = { ...playerSession, nickname, teamId, roomCode: room, accessToken, joined: true };
  localStorage.setItem(PLAYER_SESSION_KEY, JSON.stringify(playerSession));
  manualJoinCompleted = true;
  emitPlayerJoin({ silent: false });
});

socket.on('join-success', (data) => {
  playerId = data.playerId;
  persistPlayerSession();
  playerWelcomeMsg.innerHTML = `暱稱：<span class="text-cyan">${nickname}</span><br>隊伍：<span class="text-gold">${selectTeam.options[selectTeam.selectedIndex].text}</span>`;

  const synced = data.gameState || null;
  if (synced) {
    if (synced.status === 'RHYTHM_PLAYING') {
      gameStartTime = Number(synced.rhythmStartTime) || gameStartTime;
      perfectWindow = Number(synced.perfectWindow) || perfectWindow;
      goodWindow = Number(synced.goodWindow) || goodWindow;
      notesList = Array.isArray(synced.notes) ? synced.notes : notesList;
    }
    applyPlayerState(synced);
  } else {
    viewJoin.style.display = 'none';
    viewLobby.style.display = 'block';
    updateDexButtonVisibility();
  }
});

socket.on('join-error', (data) => {
  alert(data.message);
});

// --- Game Play Listeners ---
function enterRhythmView(data = {}) {
  gameStatus = 'RHYTHM_PLAYING';
  if (data.question) currentQuestion = data.question;
  if (Number.isFinite(Number(data.currentQuestionIndex))) {
    hudQuestionTitle.textContent = `第 ${Number(data.currentQuestionIndex) + 1} 題`;
  }
  hudNickname.textContent = nickname;
  hudTeam.textContent = selectTeam.options[selectTeam.selectedIndex]?.text || teamId;
  gameStatusLabel.textContent = '挑戰進行中！';
  updateRoundOperatorUI();
  judgmentText.innerHTML = '';
  comboText.style.display = combo > 0 ? 'block' : 'none';
  viewJoin.style.display = 'none';
  viewLobby.style.display = 'none';
  viewGame.style.display = 'flex';
  viewWaiting.style.display = 'none';
  viewSettlement.style.display = 'none';
  updateDexButtonVisibility();
}

function applyPlayerState(data = {}) {
  if (!data.status) return;
  gameStatus = data.status;
  if (data.question) currentQuestion = data.question;

  if (gameStatus === 'RHYTHM_PLAYING') {
    enterRhythmView(data);
    return;
  }

  if (gameStatus === 'LOBBY') {
    totalScore = 0;
    roundScore = 0;
    combo = 0;
    hudScore.textContent = '0';
    judgedNotes.clear();
    heldDirections.clear();

    viewLobby.style.display = playerId ? 'block' : 'none';
    viewJoin.style.display = playerId ? 'none' : 'block';
    viewGame.style.display = 'none';
    viewWaiting.style.display = 'none';
    viewSettlement.style.display = 'none';
  }
  else if (gameStatus === 'RULES') {
    if (waitingScoreBox) waitingScoreBox.style.display = 'none';
    viewJoin.style.display = 'none';
    viewLobby.style.display = 'none';
    viewGame.style.display = 'none';
    viewWaiting.style.display = 'block';
    viewSettlement.style.display = 'none';
    waitingTitle.textContent = '遊戲規則說明';
    const pageIndex = Math.max(0, Number(data.rules?.pageIndex) || 0);
    const pageCount = Math.max(1, Number(data.rules?.pageCount) || 1);
    document.getElementById('waiting-desc').innerHTML = `請看大螢幕聽主持人說明規則。<br><span style="opacity:.7;font-size:13px;">目前第 ${pageIndex + 1} / ${pageCount} 頁</span>`;
  }
  else if (gameStatus === 'INTRO') {
    roundScore = 0;
    combo = 0;
    judgedNotes.clear();
    heldDirections.clear();

    hudNickname.textContent = nickname;
    hudTeam.textContent = selectTeam.options[selectTeam.selectedIndex]?.text || teamId;
    hudScore.textContent = roundScore;
    if (Number.isFinite(Number(data.currentQuestionIndex))) {
      hudQuestionTitle.textContent = `第 ${Number(data.currentQuestionIndex) + 1} 題`;
    }
    gameStatusLabel.textContent = '準備挑戰本題節奏；寶可夢將於捕捉階段揭曉';
    updateRoundOperatorUI();

    judgmentText.innerHTML = '';
    comboText.style.display = 'none';

    viewJoin.style.display = 'none';
    viewLobby.style.display = 'none';
    viewGame.style.display = 'flex';
    viewWaiting.style.display = 'none';
    viewSettlement.style.display = 'none';
  }
  else if (gameStatus === 'GUESSING') {
    if (waitingScoreBox) waitingScoreBox.style.display = 'block';
    viewJoin.style.display = 'none';
    viewLobby.style.display = 'none';
    viewGame.style.display = 'none';
    viewWaiting.style.display = 'block';
    viewSettlement.style.display = 'none';

    waitingTitle.textContent = '猜歌搶答中';
    roundScoreVal.textContent = isRoundOperator ? roundScore : (Number(myTeam?.roundRhythmScore) || 0);
    document.getElementById('waiting-desc').innerHTML = isRoundOperator
      ? `節奏挑戰已結束！<br>你本題操作獲得 <strong>${roundScore}分</strong>！<br>接下來全隊都可以一起參與猜歌！`
      : `節奏挑戰已結束！<br>本題由 <strong>${roundOperatorName || '隊友'}</strong> 操作。<br>接下來全隊都可以一起參與猜歌！`;
  }
  else if (['MULTIPLE_CHOICE', 'PERFORMANCE', 'ANSWER_REVEAL'].includes(gameStatus)) {
    if (waitingScoreBox) waitingScoreBox.style.display = 'none';
    viewJoin.style.display = 'none';
    viewLobby.style.display = 'none';
    viewGame.style.display = 'none';
    viewWaiting.style.display = 'block';
    viewSettlement.style.display = 'none';
    waitingTitle.textContent = gameStatus === 'MULTIPLE_CHOICE'
      ? '請看大螢幕選擇題'
      : gameStatus === 'PERFORMANCE'
        ? '完整題目／口琴演奏'
        : '答案揭曉';
  }
  else if (gameStatus === 'END_PAGES') {
    if (waitingScoreBox) waitingScoreBox.style.display = 'none';
    viewJoin.style.display='none'; viewLobby.style.display='none'; viewGame.style.display='none'; viewWaiting.style.display='block'; viewSettlement.style.display='none';
    waitingTitle.textContent='活動已結束'; document.getElementById('waiting-desc').innerHTML='謝謝您的參與！<br>請看大螢幕並掃描活動結束頁上的 QR Code。';
  }
  else if (gameStatus === 'SETTLEMENT') {
    if (waitingScoreBox) waitingScoreBox.style.display = 'none';
    viewJoin.style.display = 'none';
    viewLobby.style.display = 'none';
    viewGame.style.display = 'none';
    viewWaiting.style.display = 'none';
    viewSettlement.style.display = 'block';
  }
  updateDexButtonVisibility();
}

socket.on('state-change', applyPlayerState);

// Rhythm Start Event
socket.on('rhythm-start', (data) => {
  gameStartTime = data.startTime;
  const operator = data.operators?.[teamId] || null;
  isRoundOperator = Boolean(operator && operator.id === playerId);
  roundOperatorName = operator?.nickname || '';
  perfectWindow = data.perfectWindow;
  goodWindow = data.goodWindow;
  notesList = Array.isArray(data.notes) ? data.notes : [];
  judgedNotes.clear();
  heldDirections.clear();
  enterRhythmView({ status: 'RHYTHM_PLAYING' });
});

// Answer Reveal Event
socket.on('answer-reveal', (data) => {
  viewGame.style.display = 'none';
  viewWaiting.style.display = 'block';
  
  waitingTitle.textContent = "公布本題答案";
  
  const isWinning = data.winningTeamIds.includes(teamId);
  const pokemonCaughtName = data.capturedPokemon ? data.capturedPokemon.name : "無";
  
  let desc = `正確答案：<strong class="text-gold">${data.songName}</strong><br><br>`;
  if (isWinning && data.capturedPokemon) {
    desc += `🎉 恭喜！您的小組獲得本題最高分，成功捕捉了 <strong class="text-cyan">${pokemonCaughtName}</strong>！`;
  } else if (data.capturedPokemon) {
    desc += `由本題綜合判定最高的小組成功捕捉 <strong class="text-cyan">${pokemonCaughtName}</strong>。`;
  } else {
    desc += "本題沒有小組成功捕捉寶可夢。";
  }

  // Update total score
  if (data.teams && data.teams[teamId]) {
    // Total score is synced at backend, but we can update our local HUD
    // Wait, totalScore can be calculated from client or just sync
  }

  document.getElementById('waiting-desc').innerHTML = desc;
  updateDexButtonVisibility();
});

// Final results sync
socket.on('final-results', (data) => {
  viewGame.style.display = 'none';
  viewWaiting.style.display = 'none';
  viewSettlement.style.display = 'block';
  
  // If the user's team won, display nice congratulations
  const myTeamStandings = data.finalStandings.find(t => t.id === teamId);
  if (myTeamStandings) {
    totalScore = myTeamStandings.totalScore;
    hudScore.textContent = roundScore;
  }
  updateDexButtonVisibility();
});

// --- Tap handling & local judgment ---
const dpadButtons = document.querySelectorAll('.dpad-btn');
dpadButtons.forEach(btn => {
  // Use touchstart for faster response on mobile, fallback to mousedown
  btn.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const dir = btn.getAttribute('data-dir');
    btn.style.transform = 'translateY(4px)';
    btn.style.boxShadow = '0 2px 0px rgba(0,0,0,0.6)';
    handleDirectionPress(dir);
  });
  
  btn.addEventListener('touchend', (e) => {
    e.preventDefault();
    const dir = btn.getAttribute('data-dir');
    btn.style.transform = '';
    btn.style.boxShadow = '';
    handleDirectionRelease(dir);
  });
  
  btn.addEventListener('touchcancel', (e) => {
    const dir = btn.getAttribute('data-dir');
    btn.style.transform = '';
    btn.style.boxShadow = '';
    handleDirectionRelease(dir);
  });
  
  btn.addEventListener('mousedown', (e) => {
    if (e.pointerType === 'touch') return;
    const dir = btn.getAttribute('data-dir');
    handleDirectionPress(dir);
  });
  
  btn.addEventListener('mouseup', (e) => {
    if (e.pointerType === 'touch') return;
    const dir = btn.getAttribute('data-dir');
    handleDirectionRelease(dir);
  });
  
  btn.addEventListener('mouseleave', (e) => {
    if (e.pointerType === 'touch') return;
    const dir = btn.getAttribute('data-dir');
    handleDirectionRelease(dir);
  });
});

function calibratedInputTime() {
  // Do not subtract human reaction time. Input uses only robust server clock sync.
  return getSyncedTime();
}

function handleDirectionPress(dir) {
  if (gameStatus !== "RHYTHM_PLAYING" || !isRoundOperator) return;
  if (heldDirections.has(dir)) return;
  heldDirections.add(dir);
  socket.emit('player-input', {
    action: 'press',
    direction: dir,
    clientTime: calibratedInputTime()
  });
}

function handleDirectionRelease(dir) {
  if (!heldDirections.has(dir)) return;
  heldDirections.delete(dir);
  if (gameStatus !== "RHYTHM_PLAYING" || !isRoundOperator) return;
  socket.emit('player-input', {
    action: 'release',
    direction: dir,
    clientTime: calibratedInputTime()
  });
}

socket.on('player-judgment', (data) => {
  combo = Number(data.combo) || 0;
  roundScore = Number(data.roundScore) || 0;
  totalScore = Number(data.totalRhythmScore) || 0;
  hudScore.textContent = roundScore;
  roundScoreVal.textContent = roundScore;
  showJudgmentFeedback(data.judgment, data);
});

function showJudgmentFeedback(judg, detail = {}) {
  // Reset animations
  judgmentText.className = 'judgment-text';
  judgmentText.textContent = '';
  
  if (judg === 'PERFECT') {
    judgmentText.classList.add('judg-perfect');
    judgmentText.textContent = '🌟 PERFECT 🌟';
  } else if (judg === 'GOOD') {
    judgmentText.classList.add('judg-good');
    judgmentText.textContent = '👍 GOOD 👍';
  } else {
    judgmentText.classList.add('judg-miss');
    judgmentText.textContent = detail.isHoldTail ? '💀 HOLD MISS 💀' : '💀 MISS 💀';
  }

  const timing = Number(detail.timingErrorMs);
  if (Number.isFinite(timing)) {
    const timingLine = document.createElement('div');
    timingLine.className = 'judgment-timing-debug';
    timingLine.textContent = `${timing > 0 ? '+' : ''}${Math.round(timing)} ms ${timing < 0 ? 'EARLY' : timing > 0 ? 'LATE' : 'ON TIME'}`;
    judgmentText.appendChild(timingLine);
  } else if (detail.missReason === 'NO_INPUT_BEFORE_NETWORK_GRACE') {
    const timingLine = document.createElement('div');
    timingLine.className = 'judgment-timing-debug';
    timingLine.textContent = 'NO INPUT';
    judgmentText.appendChild(timingLine);
  }
  
  if (combo > 0) {
    comboText.style.display = 'block';
    comboText.textContent = `${combo} COMBO`;
  } else {
    comboText.style.display = 'none';
  }
}

// Keyboard controls mapping for testing/playing on computer/laptop
window.addEventListener('keydown', (e) => {
  if (gameStatus !== "RHYTHM_PLAYING" || e.repeat) return;
  
  let dir = null;
  const key = e.key.toLowerCase();
  
  if (e.key === 'ArrowLeft' || key === 'a') dir = 'left';
  else if (e.key === 'ArrowDown' || key === 's') dir = 'down';
  else if (e.key === 'ArrowUp' || key === 'w') dir = 'up';
  else if (e.key === 'ArrowRight' || key === 'd') dir = 'right';
  
  if (dir) {
    const btn = document.querySelector(`.dpad-${dir}`);
    if (btn) {
      btn.style.transform = 'translateY(4px)';
      btn.style.boxShadow = '0 2px 0px rgba(0,0,0,0.6)';
    }
    handleDirectionPress(dir);
  }
});

window.addEventListener('keyup', (e) => {
  if (gameStatus !== "RHYTHM_PLAYING") return;
  
  let dir = null;
  const key = e.key.toLowerCase();
  
  if (e.key === 'ArrowLeft' || key === 'a') dir = 'left';
  else if (e.key === 'ArrowDown' || key === 's') dir = 'down';
  else if (e.key === 'ArrowUp' || key === 'w') dir = 'up';
  else if (e.key === 'ArrowRight' || key === 'd') dir = 'right';
  
  if (dir) {
    const btn = document.querySelector(`.dpad-${dir}`);
    if (btn) {
      btn.style.transform = '';
      btn.style.boxShadow = '';
    }
    handleDirectionRelease(dir);
  }
});
