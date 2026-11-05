const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { Server } = require('socket.io');
const { loadEnvFile } = require('./src/load-env');

loadEnvFile(path.join(__dirname, '.env'));

const store = require('./src/store');
const { createCloudSync } = require('./src/cloud-sync');
const { createAuth } = require('./src/auth');

store.initializeStore();

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }
});

const PORT = Number(process.env.PORT) || 3000;
const APP_VERSION = require('./package.json').version;
const PUBLIC_DIR = path.join(__dirname, 'public');
const auth = createAuth({ dataDir: store.DATA_DIR });
const cloud = createCloudSync();
let cloudSyncTimer = null;
let cloudSyncChain = Promise.resolve();

function queueCloudSync(reason = 'content-update') {
  if (!cloud.enabled) return;
  if (cloudSyncTimer) clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(() => {
    cloudSyncTimer = null;
    const bundle = store.createBackupBundle();
    cloudSyncChain = cloudSyncChain
      .then(() => cloud.saveState(bundle))
      .then(() => console.log(`[cloud] synchronized: ${reason}`))
      .catch((error) => console.error('[cloud] synchronization failed:', error.message));
  }, 250);
  cloudSyncTimer.unref?.();
}

app.disable('x-powered-by');
app.use(express.json({ limit: '40mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));

// Development/event devices frequently keep an older player.js in mobile cache.
// Always revalidate HTML/JS so control-flow fixes reach phones immediately.
app.use((req, res, next) => {
  if (/\.(?:html|js)$/i.test(req.path)) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: APP_VERSION, storageMode: cloud.mode, time: new Date().toISOString() });
});

// -----------------------------------------------------------------------------
// Authentication
// -----------------------------------------------------------------------------
app.get('/api/auth/status', (req, res) => {
  res.json({
    initialized: auth.isInitialized(),
    authenticated: auth.isRequestAuthenticated(req)
  });
});

app.post('/api/auth/setup', (req, res) => {
  try {
    auth.setupPassword(req.body.password);
    const token = auth.createSession();
    auth.setSessionCookie(res, token);
    queueCloudSync('admin-password-setup');
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/auth/login', (req, res) => {
  if (!auth.isInitialized()) {
    return res.status(409).json({ error: '尚未設定管理員密碼' });
  }
  if (!auth.verifyPassword(req.body.password)) {
    return res.status(401).json({ error: '密碼不正確' });
  }
  const token = auth.createSession();
  auth.setSessionCookie(res, token);
  res.json({ success: true });
});

app.post('/api/auth/logout', (req, res) => {
  const token = auth.getSessionTokenFromRequest(req);
  if (token) auth.destroySession(token);
  auth.clearSessionCookie(res);
  res.json({ success: true });
});

// Protect management pages before the static middleware.
['/manage.html', '/admin.html', '/editor.html'].forEach((route) => {
  app.get(route, auth.requireAdminPage, (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, path.basename(route)));
  });
});

app.use('/uploads', express.static(store.UPLOAD_DIR, {
  fallthrough: false,
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0
}));
app.use(express.static(PUBLIC_DIR));

// -----------------------------------------------------------------------------
// Local persistent content management APIs
// -----------------------------------------------------------------------------
function safeAsset(asset) {
  if (!asset) return asset;
  const { diskPath, ...publicAsset } = asset;
  return publicAsset;
}

function summarizeGameState() {
  return {
    roomId: gameState.roomId,
    status: gameState.status,
    currentQuestionIndex: gameState.currentQuestionIndex,
    questionCount: gameState.questions.length,
    pendingPublish: Boolean(gameState.pendingQuestions),
    connectedPlayers: Object.keys(gameState.players).length,
    teams: Object.values(gameState.teams).map((team) => ({
      id: team.id,
      name: team.name,
      memberCount: team.members.filter((id) => gameState.players[id]).length,
      caughtCount: team.caught.length,
      roundScore: Math.round(getTeamRoundScores()[team.id] || 0),
      roundOperator: getRoundOperator(team)
    }))
  };
}

function buildDashboard() {
  const draft = store.getDraftQuestions();
  const published = store.getPublishedQuestions();
  const assets = store.getAssets();
  const settings = store.getSettings();
  return {
    draftCount: draft.length,
    publishedCount: published.filter((q) => q.enabled !== false).length,
    assetCount: assets.length,
    lastSettingsUpdate: settings.updatedAt,
    storageMode: cloud.mode,
    game: summarizeGameState()
  };
}

function emitAdminDashboard() {
  io.to('admins').emit('admin-dashboard-update', buildDashboard());
  if (typeof adminGameState === 'function') io.to('admins').emit('admin-state-sync', adminGameState());
}

app.get('/api/questions', auth.requireAdminApi, (req, res) => {
  res.json(store.getPublishedQuestions().filter((q) => q.enabled !== false));
});

app.get('/api/room', (req, res) => {
  res.json({
    roomId: gameState.roomId,
    teams: Object.values(gameState.teams).map(({ id, name }) => ({ id, name })),
    tokenRequired: Boolean(store.getSettings().playerAccess.enabled)
  });
});

app.get('/api/admin/dashboard', auth.requireAdminApi, (req, res) => {
  res.json(buildDashboard());
});

app.get('/api/admin/questions/draft', auth.requireAdminApi, (req, res) => {
  res.json(store.getDraftQuestions());
});

app.put('/api/admin/questions/draft', auth.requireAdminApi, (req, res) => {
  try {
    const questions = store.saveDraftQuestions(req.body);
    io.to('admins').emit('content-updated', {
      type: 'draft-saved',
      questionCount: questions.length,
      updatedAt: new Date().toISOString()
    });
    emitAdminDashboard();
    queueCloudSync('draft-saved');
    res.json({ success: true, questions });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Backwards-compatible editor endpoint, now authenticated and draft-only.
app.post('/api/questions', auth.requireAdminApi, (req, res) => {
  try {
    const questions = store.saveDraftQuestions(req.body);
    io.to('admins').emit('content-updated', {
      type: 'draft-saved',
      questionCount: questions.length,
      updatedAt: new Date().toISOString()
    });
    emitAdminDashboard();
    queueCloudSync('draft-saved');
    res.json({ success: true, questions });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/admin/questions/publish', auth.requireAdminApi, (req, res) => {
  try {
    const result = store.publishDraftQuestions();
    const active = !['LOBBY', 'SETTLEMENT'].includes(gameState.status) || gameState.currentQuestionIndex >= 0;
    if (active) {
      gameState.pendingQuestions = result.questions.filter((q) => q.enabled !== false);
    } else {
      gameState.questions = result.questions.filter((q) => q.enabled !== false);
      gameState.pendingQuestions = null;
    }
    io.to('admins').emit('content-updated', {
      type: 'published',
      questionCount: result.questions.length,
      versionId: result.versionId,
      appliedImmediately: !active,
      updatedAt: new Date().toISOString()
    });
    emitAdminDashboard();
    queueCloudSync('questions-published');
    res.json({ success: true, ...result, appliedImmediately: !active });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/admin/versions', auth.requireAdminApi, (req, res) => {
  res.json(store.listQuestionVersions());
});

app.post('/api/admin/versions/:versionId/restore', auth.requireAdminApi, (req, res) => {
  try {
    const questions = store.restoreQuestionVersion(req.params.versionId);
    io.to('admins').emit('content-updated', {
      type: 'version-restored',
      questionCount: questions.length,
      updatedAt: new Date().toISOString()
    });
    emitAdminDashboard();
    queueCloudSync('version-restored');
    res.json({ success: true, questions });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/admin/settings', auth.requireAdminApi, (req, res) => {
  res.json(store.getSettings());
});

app.put('/api/admin/settings', auth.requireAdminApi, (req, res) => {
  try {
    const settings = store.saveSettings(req.body);
    if (gameState.status === 'LOBBY' && gameState.currentQuestionIndex < 0) {
      gameState.roomId = settings.room.id;
      setupTeams(settings.room.teamNames, false);
    }
    gameState.perfectWindow = settings.scoring.perfectWindow;
    gameState.goodWindow = settings.scoring.goodWindow;
    io.to('admins').emit('settings-updated', {
      settings,
      updatedAt: settings.updatedAt
    });
    broadcastRoomUpdate();
    emitAdminDashboard();
    queueCloudSync('settings-saved');
    res.json({ success: true, settings });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/admin/access-token/regenerate', auth.requireAdminApi, (req, res) => {
  const settings = store.regeneratePlayerToken();
  io.to('admins').emit('settings-updated', { settings, updatedAt: settings.updatedAt });
  queueCloudSync('access-token-regenerated');
  res.json({ success: true, playerAccess: settings.playerAccess });
});

app.get('/api/admin/assets', auth.requireAdminApi, (req, res) => {
  res.json(store.getAssets().map(safeAsset));
});

const CATEGORY_RULES = {
  // V6 keeps the content library intentionally simple: four visible categories.
  pokemon: new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']),
  question: new Set(['.musicxml', '.xml', '.mid', '.midi', '.mp3', '.wav', '.ogg', '.m4a']),
  performance: new Set(['.mp3', '.wav', '.ogg', '.m4a', '.mp4', '.webm', '.mov', '.m4v']),
  note: new Set(['.mp3', '.wav', '.ogg', '.m4a']),
  // Legacy categories remain accepted so old V5 backups can still be restored safely.
  audio: new Set(['.mp3', '.wav', '.ogg', '.m4a']),
  video: new Set(['.mp4', '.webm', '.mov', '.m4v']),
  midi: new Set(['.mid', '.midi']),
  score: new Set(['.musicxml', '.xml'])
};

const PITCH_CLASS = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
const FLAT_TO_SHARP = { DB: 'C#', EB: 'D#', GB: 'F#', AB: 'G#', BB: 'A#' };

function normalizePitchName(value) {
  const compact = String(value || '')
    .trim()
    .replace(/♯/g, '#')
    .replace(/♭/g, 'b')
    .replace(/sharp/ig, '#')
    .replace(/flat/ig, 'b')
    .replace(/[_\s-]+/g, '');
  const match = compact.match(/^([A-Ga-g])([#bB]?)(-1|[0-9])$/);
  if (!match) return '';
  const letter = match[1].toUpperCase();
  const accidental = match[2];
  const octave = Number(match[3]);
  let note = `${letter}${accidental === '#' ? '#' : accidental ? 'B' : ''}`;
  if (FLAT_TO_SHARP[note]) note = FLAT_TO_SHARP[note];
  if (!(note in PITCH_CLASS)) return '';
  return `${note}${octave}`;
}

function inferPitchFromFileName(fileName) {
  const base = path.basename(String(fileName || ''), path.extname(String(fileName || '')));
  const direct = normalizePitchName(base);
  if (direct) return direct;
  const match = base.match(/([A-Ga-g](?:#|b|B|sharp|flat)?-?\d)/i);
  return match ? normalizePitchName(match[1]) : '';
}

function pitchToMidi(pitch) {
  const match = String(pitch || '').match(/^([A-G](?:#)?)(-1|[0-9])$/);
  if (!match || !(match[1] in PITCH_CLASS)) return null;
  return (Number(match[2]) + 1) * 12 + PITCH_CLASS[match[1]];
}

app.get('/api/note-library', (req, res) => {
  const notes = store.getAssets()
    .filter((asset) => asset.category === 'note' && asset.pitch)
    .map(safeAsset)
    .sort((a, b) => (pitchToMidi(a.pitch) ?? 999) - (pitchToMidi(b.pitch) ?? 999));
  res.json({ notes, map: Object.fromEntries(notes.map((asset) => [asset.pitch, asset.url])) });
});


app.post('/api/admin/end-page-image/upload', auth.requireAdminApi, async (req, res) => {
  try {
    const originalName = path.basename(String(req.body.fileName || 'end-page-image'));
    const extension = path.extname(originalName).toLowerCase();
    const allowed = new Set(['.png','.jpg','.jpeg','.gif','.webp']);
    if (!allowed.has(extension)) throw new Error('活動結束頁只支援 PNG、JPG、GIF、WEBP 圖片');
    const base64 = String(req.body.dataBase64 || '').replace(/^data:[^;]+;base64,/, '');
    if (!base64) throw new Error('沒有收到圖片內容');
    const buffer = Buffer.from(base64, 'base64');
    const settings = store.getSettings();
    const maxMb = Math.max(1, Number(settings.uploads?.maxMb) || 20);
    if (!buffer.length || buffer.length > maxMb * 1024 * 1024) throw new Error(`圖片不得超過 ${maxMb} MB`);
    const id = crypto.randomUUID();
    const fileName = `${Date.now()}-${id.slice(0,8)}${extension}`;
    const mimeType = String(req.body.mimeType || 'application/octet-stream');
    let location;
    if (cloud.enabled) {
      location = await cloud.uploadAsset({ category: 'endpage', fileName, buffer, mimeType });
    } else {
      const diskPath = path.join(store.UPLOAD_DIR, 'endpage', fileName);
      fs.mkdirSync(path.dirname(diskPath), { recursive: true });
      fs.writeFileSync(diskPath, buffer);
      location = { url: `/uploads/endpage/${fileName}`, diskPath };
    }
    res.json({ success: true, url: location.url, originalName });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/admin/assets/upload', auth.requireAdminApi, async (req, res) => {
  try {
    const category = String(req.body.category || '');
    const allowed = CATEGORY_RULES[category];
    if (!allowed) throw new Error('不支援的素材類型');

    const originalName = path.basename(String(req.body.fileName || 'upload'));
    const extension = path.extname(originalName).toLowerCase();
    if (!allowed.has(extension)) throw new Error(`不支援的副檔名：${extension || '無'}`);

    const base64 = String(req.body.dataBase64 || '').replace(/^data:[^;]+;base64,/, '');
    if (!base64) throw new Error('沒有收到檔案內容');
    const buffer = Buffer.from(base64, 'base64');
    const settings = store.getSettings();
    const maxMb = Math.max(1, Number(settings.uploads?.maxMb) || 20);
    const maxBytes = maxMb * 1024 * 1024;
    if (!buffer.length || buffer.length > maxBytes) throw new Error(`檔案不得超過 ${maxMb} MB`);

    let pitch = '';
    let duplicate = null;
    if (category === 'note') {
      pitch = normalizePitchName(req.body.pitch) || inferPitchFromFileName(originalName);
      if (!pitch) throw new Error('口琴單音必須指定正確音名，例如 C4、F#5、Bb4');
      duplicate = store.getAssets().find((asset) => asset.category === 'note' && asset.pitch === pitch) || null;
      if (duplicate && String(req.body.replaceExisting || '') !== 'true') {
        throw new Error(`${pitch} 已有音檔；請先刪除舊檔，或勾選取代既有音檔`);
      }
    }

    const id = crypto.randomUUID();
    const fileName = `${Date.now()}-${id.slice(0, 8)}${extension}`;
    const mimeType = String(req.body.mimeType || 'application/octet-stream');
    let location;

    if (cloud.enabled) {
      location = await cloud.uploadAsset({ category, fileName, buffer, mimeType });
    } else {
      const diskPath = path.join(store.UPLOAD_DIR, category, fileName);
      fs.mkdirSync(path.dirname(diskPath), { recursive: true });
      fs.writeFileSync(diskPath, buffer);
      location = { url: `/uploads/${category}/${fileName}`, diskPath };
    }

    if (duplicate) {
      if (cloud.enabled && duplicate.cloudPath) await cloud.deleteAsset(duplicate);
      store.removeAsset(duplicate.id);
    }

    const asset = store.addAsset({
      id,
      category,
      originalName,
      fileName,
      url: location.url,
      cloudPath: location.cloudPath || '',
      mimeType,
      size: buffer.length,
      pitch,
      midiNote: pitch ? pitchToMidi(pitch) : null,
      uploadedAt: new Date().toISOString(),
      diskPath: location.diskPath || ''
    });

    io.to('admins').emit('assets-updated', { type: 'uploaded', asset: safeAsset(asset) });
    emitAdminDashboard();
    queueCloudSync('asset-uploaded');
    res.json({ success: true, asset: safeAsset(asset) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/admin/assets/:assetId', auth.requireAdminApi, async (req, res) => {
  try {
    const asset = store.getAsset(req.params.assetId);
    if (!asset) return res.status(404).json({ error: '找不到素材' });
    if (cloud.enabled && asset.cloudPath) await cloud.deleteAsset(asset);
    const removed = store.removeAsset(req.params.assetId);
    io.to('admins').emit('assets-updated', { type: 'deleted', assetId: req.params.assetId });
    emitAdminDashboard();
    queueCloudSync('asset-deleted');
    res.json({ success: true, asset: safeAsset(removed) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/admin/export', auth.requireAdminApi, (req, res) => {
  const bundle = store.createBackupBundle();
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="rhythm-game-backup-${stamp}.json"`);
  res.type('application/json').send(JSON.stringify(bundle, null, 2));
});

app.post('/api/admin/import', auth.requireAdminApi, (req, res) => {
  try {
    const bundle = store.importBackupBundle(req.body);
    gameState.pendingQuestions = bundle.publishedQuestions.filter((q) => q.enabled !== false);
    io.to('admins').emit('content-updated', { type: 'backup-imported', updatedAt: new Date().toISOString() });
    emitAdminDashboard();
    queueCloudSync('backup-imported');
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// -----------------------------------------------------------------------------
// Game state and authoritative scoring
// -----------------------------------------------------------------------------
const initialSettings = store.getSettings();
const gameState = {
  roomId: initialSettings.room.id,
  status: 'LOBBY',
  currentQuestionIndex: -1,
  questions: store.getPublishedQuestions().filter((q) => q.enabled !== false),
  pendingQuestions: null,
  teams: {},
  players: {},
  perfectWindow: initialSettings.scoring.perfectWindow,
  goodWindow: initialSettings.scoring.goodWindow,
  settlementStep: -1,
  roundGuesses: {},
  guessResultsSaved: false,
  roundBonuses: {},
  roundBonusRates: {},
  rhythmStartTime: 0,
  roundSettings: initialSettings.scoring,
  publicBaseUrl: '',
  entryQrVisible: false,
  settlementAutoPlaying: false,
  completedQuestionIds: [],
  skippedQuestionIds: [],
  rulesPageIndex: 0,
  endPageIndex: 0,
  hostRhythmReady: { questionId: '', ready: false, message: '尚未預載' }
};

let flowUndoCheckpoint = null;
let settlementAutoTimer = null;

function setupTeams(teamNames, resetPlayers = true) {
  if (resetPlayers) gameState.players = {};
  gameState.teams = {};
  const names = Array.isArray(teamNames) && teamNames.length ? teamNames : ['第一隊'];
  names.forEach((rawName, index) => {
    const id = `team-${index + 1}`;
    gameState.teams[id] = {
      id,
      name: String(rawName || `第 ${index + 1} 隊`),
      members: [],
      caught: [],
      roundOperatorId: null,
      roundRhythmScore: 0
    };
  });
}
setupTeams(initialSettings.room.teamNames);

function isPlayerConnected(player) { return Boolean(player && player.connected !== false); }
function publicPlayers() {
  return Object.fromEntries(
    Object.entries(gameState.players).map(([id, player]) => [
      id,
      {
        nickname: player.nickname,
        teamId: player.teamId,
        score: player.score,
        roundScore: player.roundScore,
        combo: player.combo,
        connected: isPlayerConnected(player)
      }
    ])
  );
}

function getConnectedTeamMembers(team) {
  return (team?.members || []).filter((memberId) => gameState.players[memberId] && isPlayerConnected(gameState.players[memberId]));
}

function getEligibleTeamMembers(team) {
  // A briefly backgrounded phone may lose its transport. Keep its seat/operator during the
  // reconnection grace period so switching apps does not immediately reshuffle the team.
  return (team?.members || []).filter((memberId) => gameState.players[memberId]);
}

function assignRoundOperators(force = false) {
  const questionIndex = Math.max(0, Number(gameState.currentQuestionIndex) || 0);
  for (const team of Object.values(gameState.teams)) {
    const connected = getConnectedTeamMembers(team);
    const currentExists = Boolean(team.roundOperatorId && gameState.players[team.roundOperatorId]);
    const currentConnected = Boolean(team.roundOperatorId && connected.includes(team.roundOperatorId));
    // During an active round, keep a briefly disconnected operator's seat so an app switch
    // can reconnect to the same player without immediately handing control to somebody else.
    if (!force && gameState.status === 'RHYTHM_PLAYING' && currentExists) continue;
    if (!force && currentConnected) continue;
    if (!connected.length) {
      team.roundOperatorId = null;
      continue;
    }
    team.roundOperatorId = connected[questionIndex % connected.length];
  }
}

function getRoundOperator(team) {
  const operatorId = team?.roundOperatorId;
  const player = operatorId ? gameState.players[operatorId] : null;
  return player ? { id: operatorId, nickname: player.nickname } : null;
}

function getRoundOperators() {
  return Object.fromEntries(Object.entries(gameState.teams).map(([teamId, team]) => [teamId, getRoundOperator(team)]));
}

function getTeamRoundScores() {
  return Object.fromEntries(Object.entries(gameState.teams).map(([teamId, team]) => [
    teamId,
    Number(team.roundRhythmScore) || 0
  ]));
}

function getTeamRoundBonuses() {
  const rhythm = getTeamRoundScores();
  const scoring = gameState.roundSettings || store.getSettings().scoring;
  const baseMode = scoring.roundBonusBase === 'round-highest' ? 'round-highest' : 'own-team';
  const highestRhythm = Math.max(0, ...Object.values(rhythm).map((value) => Number(value) || 0));
  return Object.fromEntries(Object.keys(gameState.teams).map((teamId) => {
    const rhythmScore = Number(rhythm[teamId]) || 0;
    const rate = Math.max(0, Number(gameState.roundBonusRates?.[teamId]) || 0);
    const bonusBase = baseMode === 'round-highest' ? highestRhythm : rhythmScore;
    return [teamId, Math.round(bonusBase * rate)];
  }));
}

function getTeamCompetitionScores() {
  const rhythm = getTeamRoundScores();
  const bonuses = getTeamRoundBonuses();
  gameState.roundBonuses = bonuses;
  return Object.fromEntries(Object.keys(gameState.teams).map((teamId) => [
    teamId,
    (Number(rhythm[teamId]) || 0) + (Number(bonuses[teamId]) || 0)
  ]));
}

function resetRoundBonuses() {
  gameState.roundBonusRates = Object.fromEntries(Object.keys(gameState.teams).map((teamId) => [teamId, 0]));
  gameState.roundBonuses = Object.fromEntries(Object.keys(gameState.teams).map((teamId) => [teamId, 0]));
}

function publicLobbyTeams() {
  return Object.fromEntries(Object.entries(gameState.teams).map(([teamId, team]) => [teamId, {
    id: team.id,
    name: team.name,
    memberCount: getConnectedTeamMembers(team).length,
    roundOperator: getRoundOperator(team)
  }]));
}

function normalizePortableAssetUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('/uploads/') || /^data:/i.test(raw)) return raw;
  if (/^https?:/i.test(raw)) {
    try {
      const parsed = new URL(raw);
      if (['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) && parsed.pathname.startsWith('/uploads/')) {
        return `${parsed.pathname}${parsed.search || ''}`;
      }
    } catch (_) {}
    return raw;
  }
  return raw;
}

function resolveAssetUrl(reference, category) {
  const value = normalizePortableAssetUrl(reference);
  if (!value) return '';
  if (/^(?:https?:|data:)/i.test(value) || value.startsWith('/uploads/')) return value;
  const baseName = path.basename(value);
  const asset = store.getAssets().find((item) =>
    item.category === category && (
      item.url === value || item.fileName === value || item.originalName === value ||
      path.basename(String(item.url || '')) === baseName || path.basename(String(item.fileName || '')) === baseName
    )
  );
  return normalizePortableAssetUrl(asset?.url || value);
}

function sanitizePokemonForDisplay(pokemon) {
  if (!pokemon) return null;
  return {
    name: pokemon.name,
    evolutionType: pokemon.evolutionType,
    image: resolveAssetUrl(pokemon.image, 'pokemon'),
    questionId: pokemon.questionId || ''
  };
}

function sanitizedTeamsForShowcase() {
  return Object.fromEntries(Object.entries(gameState.teams).map(([teamId, team]) => [teamId, {
    id: team.id,
    name: team.name,
    memberCount: team.members.filter((id) => gameState.players[id]).length,
    caught: team.caught.map(sanitizePokemonForDisplay)
  }]));
}

function emitPlayerTeamUpdate(socketId) {
  const player = gameState.players[socketId];
  if (!player) return;
  const team = gameState.teams[player.teamId];
  const roundOperator = team ? getRoundOperator(team) : null;
  io.to(socketId).emit('player-team-update', {
    team: team ? {
      id: team.id,
      name: team.name,
      caught: team.caught.map(sanitizePokemonForDisplay),
      roundRhythmScore: Number(team.roundRhythmScore) || 0,
      roundOperator,
      isRoundOperator: Boolean(roundOperator && roundOperator.id === socketId)
    } : null,
    roomTeams: publicLobbyTeams()
  });
}

let roundScoreBroadcastTimer = null;

function broadcastRoundScoresNow() {
  io.to('hosts').emit('round-scores-updated', {
    rhythmScores: getTeamRoundScores(),
    competitionScores: getTeamCompetitionScores(),
    status: gameState.status,
    currentQuestionIndex: gameState.currentQuestionIndex,
    roundBonuses: getTeamRoundBonuses(),
    roundBonusRates: gameState.roundBonusRates || {}
  });
}

function broadcastRoundScores() {
  if (roundScoreBroadcastTimer) return;
  roundScoreBroadcastTimer = setTimeout(() => {
    roundScoreBroadcastTimer = null;
    broadcastRoundScoresNow();
  }, 100);
  roundScoreBroadcastTimer.unref?.();
}

function getRulesState(includeAllPages = false) {
  const configured = store.getSettings().rules || { enabled: false, pages: [] };
  const pages = Array.isArray(configured.pages) ? configured.pages : [];
  const pageCount = pages.length;
  const safeIndex = pageCount ? Math.max(0, Math.min(pageCount - 1, Number(gameState.rulesPageIndex) || 0)) : 0;
  const base = {
    enabled: configured.enabled !== false && pageCount > 0,
    pageIndex: safeIndex,
    pageCount,
    page: pageCount ? pages[safeIndex] : null
  };
  if (includeAllPages) base.pages = pages.map((page) => ({ title: page.title, markdown: page.markdown }));
  return base;
}

function emitRulesPage() {
  const rules = getRulesState(false);
  io.emit('state-change', { status: 'RULES', currentQuestionIndex: -1, rules });
  emitAdminDashboard();
}


function getEndPagesState(includeAllPages = false) {
  const configured = store.getSettings().endPages || { enabled: false, pages: [] };
  const pages = Array.isArray(configured.pages) ? configured.pages : [];
  const pageCount = pages.length;
  const safeIndex = pageCount ? Math.max(0, Math.min(pageCount - 1, Number(gameState.endPageIndex) || 0)) : 0;
  const base = {
    enabled: configured.enabled !== false && pageCount > 0,
    pageIndex: safeIndex,
    pageCount,
    page: pageCount ? pages[safeIndex] : null
  };
  if (includeAllPages) base.pages = pages.map((page) => ({
    title: page.title,
    backgroundColor: page.backgroundColor || '#071014',
    elements: Array.isArray(page.elements) ? page.elements : []
  }));
  return base;
}

function emitEndPage() {
  const endPages = getEndPagesState(false);
  io.emit('state-change', { status: 'END_PAGES', currentQuestionIndex: gameState.currentQuestionIndex, endPages });
  emitAdminDashboard();
}

function publicGameState() {
  return {
    roomId: gameState.roomId,
    status: gameState.status,
    currentQuestionIndex: gameState.currentQuestionIndex,
    questionCount: gameState.questions.length,
    teams: publicLobbyTeams(),
    players: publicPlayers(),
    perfectWindow: gameState.perfectWindow,
    goodWindow: gameState.goodWindow,
    settlementStep: gameState.settlementStep,
    teamRoundScores: getTeamRoundScores(),
    teamCompetitionScores: getTeamCompetitionScores(),
    roundOperators: getRoundOperators(),
    pendingPublish: Boolean(gameState.pendingQuestions),
    publicBaseUrl: gameState.publicBaseUrl || '',
    entryQrVisible: Boolean(gameState.entryQrVisible),
    completedQuestionIds: [...(gameState.completedQuestionIds || [])],
    skippedQuestionIds: [...(gameState.skippedQuestionIds || [])],
    rules: getRulesState(false),
    endPages: getEndPagesState(false),
    hostRhythmReady: { ...(gameState.hostRhythmReady || {}) }
  };
}

function adminGameState() {
  return {
    ...publicGameState(),
    questions: gameState.questions,
    teams: gameState.teams,
    roundGuesses: gameState.roundGuesses,
    roundBonuses: getTeamRoundBonuses(),
    roundBonusRates: gameState.roundBonusRates || {},
    roundBonusBase: (gameState.roundSettings || store.getSettings().scoring).roundBonusBase || 'own-team',
    teamCompetitionScores: getTeamCompetitionScores(),
    settlementAutoPlaying: Boolean(gameState.settlementAutoPlaying),
    flowUndo: flowUndoCheckpoint ? { available: true, label: flowUndoCheckpoint.label } : { available: false, label: '' },
    rules: getRulesState(true),
    endPages: getEndPagesState(true),
    finalBgm: store.getSettings().finalBgm || { sourceType: 'none' }
  };
}

function broadcastRoomUpdate() {
  const hostUpdate = {
    teams: publicLobbyTeams(),
    status: gameState.status,
    players: publicPlayers(),
    roomId: gameState.roomId,
    teamRoundScores: getTeamRoundScores(),
    teamCompetitionScores: getTeamCompetitionScores(),
    roundOperators: getRoundOperators()
  };
  io.to('hosts').emit('room-updated', hostUpdate);
  io.to('admins').emit('room-updated', {
    ...hostUpdate,
    teams: gameState.teams
  });
  io.to('admins').emit('admin-game-state', summarizeGameState());
  Object.keys(gameState.players).forEach(emitPlayerTeamUpdate);
}

function getPokemonPoints(pokemon, scoring = gameState.roundSettings) {
  if (!pokemon) return 0;
  if (pokemon.evolutionType === 'custom') {
    return Math.max(0, Number(pokemon.customPoints) || 0);
  }
  return Number(scoring.pokemonPoints && scoring.pokemonPoints[pokemon.evolutionType]) || 0;
}

function getCurrentQuestion() {
  if (gameState.currentQuestionIndex < 0) return null;
  return gameState.questions[gameState.currentQuestionIndex] || null;
}

function questionKey(question) {
  return question ? String(question.id ?? '') : '';
}

function isQuestionCompleted(index) {
  const question = gameState.questions[index];
  const key = questionKey(question);
  return Boolean(key && (gameState.completedQuestionIds || []).includes(key));
}

function markQuestionCompleted(index) {
  const question = gameState.questions[index];
  const key = questionKey(question);
  if (!key) return;
  if (!(gameState.completedQuestionIds || []).includes(key)) gameState.completedQuestionIds.push(key);
  gameState.skippedQuestionIds = (gameState.skippedQuestionIds || []).filter((id) => id !== key);
}

function markQuestionSkipped(index) {
  const question = gameState.questions[index];
  const key = questionKey(question);
  if (!key || isQuestionCompleted(index)) return;
  if (!(gameState.skippedQuestionIds || []).includes(key)) gameState.skippedQuestionIds.push(key);
}

function clearQuestionSkipped(index) {
  const question = gameState.questions[index];
  const key = questionKey(question);
  if (!key) return;
  gameState.skippedQuestionIds = (gameState.skippedQuestionIds || []).filter((id) => id !== key);
}

function resetRoundForQuestionLoad() {
  Object.values(gameState.players).forEach(resetPlayerRound);
  resetTeamRoundScores();
  gameState.roundGuesses = {};
  gameState.guessResultsSaved = false;
  resetRoundBonuses();
  gameState.rhythmStartTime = 0;
}

function loadQuestionAt(index, options = {}) {
  if (!gameState.questions.length) return false;
  const safeIndex = Math.max(0, Math.min(gameState.questions.length - 1, Number(index) || 0));
  clearSettlementTimers();
  hideEntryQr();
  io.to('hosts').emit('collection-showcase', { visible: false });
  gameState.currentQuestionIndex = safeIndex;
  const prepQuestion = gameState.questions[safeIndex];
  gameState.hostRhythmReady = { questionId: String(prepQuestion?.id ?? ''), ready: false, message: '投影端正在預載音訊…' };
  io.to('admins').emit('host-rhythm-prep-status', gameState.hostRhythmReady);
  clearQuestionSkipped(safeIndex);
  gameState.status = 'INTRO';
  resetRoundForQuestionLoad();
  assignRoundOperators(true);
  if (options.clearUndo !== false) flowUndoCheckpoint = null;
  const question = getCurrentQuestion();
  io.emit('state-change', { status: gameState.status, currentQuestionIndex: gameState.currentQuestionIndex });
  io.to('hosts').emit('host-load-question', { question });
  broadcastRoomUpdate();
  broadcastRoundScoresNow();
  emitAdminDashboard();
  return true;
}

function markJumpAbandonments(targetIndex) {
  const current = Number(gameState.currentQuestionIndex);
  const target = Number(targetIndex);
  if (!Number.isFinite(target)) return;
  if (!Number.isFinite(current) || current < 0) {
    for (let i = 0; i < target; i += 1) markQuestionSkipped(i);
    return;
  }
  if (target === current) return;
  const currentAlreadyDone = isQuestionCompleted(current) || gameState.status === 'ANSWER_REVEAL';
  if (!currentAlreadyDone) markQuestionSkipped(current);
  if (target > current) {
    for (let i = current + 1; i < target; i += 1) markQuestionSkipped(i);
  }
}

function findNextUncompletedIndex(afterIndex) {
  const parsed = Number(afterIndex);
  const startAfter = Number.isFinite(parsed) ? parsed : -1;
  for (let i = Math.max(-1, startAfter) + 1; i < gameState.questions.length; i += 1) {
    if (!isQuestionCompleted(i)) return i;
  }
  return -1;
}

function resetPlayerRound(player) {
  player.roundScore = 0;
  player.combo = 0;
  player.judgedNotes = new Set();
  player.activeHolds = {};
}

function resetTeamRoundScores() {
  Object.values(gameState.teams).forEach((team) => {
    team.roundRhythmScore = 0;
  });
}

const HOLD_NOTE_MIN_DURATION_MS = 300;
const MIN_PASSIVE_MISS_GRACE_MS = 700;

function clampReportedEventTime(reportedTime, arrivalTime) {
  const numeric = Number(reportedTime);
  if (!Number.isFinite(numeric)) return arrivalTime;
  // The phone sends a server-synchronised timestamp. Allow enough room for a packet
  // that was correctly timed on the phone but reached the server late because of
  // mobile / Wi-Fi / Cloudflare jitter. The judgment window itself is unchanged.
  return Math.max(arrivalTime - 1600, Math.min(arrivalTime + 150, numeric));
}

function calculateJudgmentScore(judgment, player, scoring, isHoldTail = false) {
  if (judgment === 'MISS') {
    player.combo = 0;
    return Math.round(Number(scoring.missScore) || 0);
  }
  player.combo += 1;
  const cap = Math.max(0, Number(scoring.comboCap) || 0);
  const comboForBonus = Math.min(player.combo, cap);
  if (isHoldTail) {
    return Math.round((Number(scoring.holdBase) || 0) + comboForBonus * (Number(scoring.holdComboRate) || 0));
  }
  if (judgment === 'PERFECT') {
    return Math.round((Number(scoring.perfectBase) || 0) + comboForBonus * (Number(scoring.perfectComboRate) || 0));
  }
  return Math.round((Number(scoring.goodBase) || 0) + comboForBonus * (Number(scoring.goodComboRate) || 0));
}

function emitPlayerJudgment(socketId, player, payload) {
  const result = {
    ...payload,
    combo: player.combo,
    roundScore: player.roundScore,
    totalRhythmScore: player.score
  };
  io.to(socketId).emit('player-judgment', result);
}

function applyJudgment(socketId, player, noteKey, judgment, scoring, isHoldTail = false, detail = {}) {
  const noteScore = calculateJudgmentScore(judgment, player, scoring, isHoldTail);
  player.roundScore += noteScore;
  player.score += noteScore;
  const team = gameState.teams[player.teamId];
  if (team && team.roundOperatorId === socketId) {
    team.roundRhythmScore = (Number(team.roundRhythmScore) || 0) + noteScore;
  }
  emitPlayerJudgment(socketId, player, { noteKey, judgment, noteScore, isHoldTail, ...detail });
  broadcastRoundScores();
}

function handlePlayerPress(socket, input) {
  if (gameState.status !== 'RHYTHM_PLAYING') return;
  const player = gameState.players[socket.id];
  const question = getCurrentQuestion();
  if (!player || !question) return;
  const team = gameState.teams[player.teamId];
  if (!team || team.roundOperatorId !== socket.id) return;
  const direction = String(input.direction || '');
  if (!['left', 'down', 'up', 'right'].includes(direction)) return;
  if (player.activeHolds[direction]) return;

  const arrivalTime = Date.now();
  const eventTime = clampReportedEventTime(input.clientTime, arrivalTime);
  const scoring = gameState.roundSettings;
  let closestIndex = -1;
  let closestDiff = Infinity;
  let closestSignedDiff = 0;

  for (let index = 0; index < question.notes.length; index += 1) {
    if (player.judgedNotes.has(index)) continue;
    const note = question.notes[index];
    if (note.direction !== direction) continue;
    const targetTime = gameState.rhythmStartTime + note.time;
    const signedDiff = eventTime - targetTime;
    const diff = Math.abs(signedDiff);
    if (diff <= Number(scoring.goodWindow) && diff < closestDiff) {
      closestIndex = index;
      closestDiff = diff;
      closestSignedDiff = signedDiff;
    }
  }

  if (closestIndex < 0) {
    // For diagnostics and faster feedback, a press that is already *late* for the
    // nearest same-direction note can be safely closed as MISS. An early press is
    // not consumed because the player may still hit that note correctly later.
    let nearestLateIndex = -1;
    let nearestLateDiff = Infinity;
    let nearestLateSigned = 0;
    for (let index = 0; index < question.notes.length; index += 1) {
      if (player.judgedNotes.has(index)) continue;
      const note = question.notes[index];
      if (note.direction !== direction) continue;
      const signedDiff = eventTime - (gameState.rhythmStartTime + note.time);
      const absDiff = Math.abs(signedDiff);
      if (absDiff < nearestLateDiff) {
        nearestLateIndex = index;
        nearestLateDiff = absDiff;
        nearestLateSigned = signedDiff;
      }
    }
    if (nearestLateIndex >= 0 && nearestLateSigned > Number(scoring.goodWindow) && nearestLateSigned <= Number(scoring.goodWindow) + 650) {
      player.judgedNotes.add(nearestLateIndex);
      applyJudgment(socket.id, player, nearestLateIndex, 'MISS', scoring, false, {
        timingErrorMs: Math.round(nearestLateSigned),
        timingLabel: 'LATE',
        missReason: 'LATE_PRESS_OUTSIDE_WINDOW'
      });
    }
    return;
  }
  const note = question.notes[closestIndex];
  player.judgedNotes.add(closestIndex);
  const judgment = closestDiff <= Number(scoring.perfectWindow) ? 'PERFECT' : 'GOOD';
  applyJudgment(socket.id, player, closestIndex, judgment, scoring, false, {
    timingErrorMs: Math.round(closestSignedDiff),
    timingLabel: closestSignedDiff < 0 ? 'EARLY' : closestSignedDiff > 0 ? 'LATE' : 'ON_TIME'
  });

  // Keep the server's hold-note definition identical to the host visual definition.
  // Short MusicXML/MIDI note durations must NOT silently create a hold tail judgment.
  if (Number(note.duration) >= HOLD_NOTE_MIN_DURATION_MS) {
    player.activeHolds[direction] = {
      noteIndex: closestIndex,
      targetTailTime: gameState.rhythmStartTime + note.time + Number(note.duration)
    };
  }
}

function handlePlayerRelease(socket, input) {
  if (gameState.status !== 'RHYTHM_PLAYING') return;
  const player = gameState.players[socket.id];
  if (!player) return;
  const team = gameState.teams[player.teamId];
  if (!team || team.roundOperatorId !== socket.id) return;
  const direction = String(input.direction || '');
  const hold = player.activeHolds[direction];
  if (!hold) return;
  delete player.activeHolds[direction];

  const scoring = gameState.roundSettings;
  const eventTime = clampReportedEventTime(input.clientTime, Date.now());
  const earlyBy = hold.targetTailTime - eventTime;
  const judgment = earlyBy > Number(scoring.holdEarlyTolerance) ? 'MISS' : 'PERFECT';
  applyJudgment(socket.id, player, `${hold.noteIndex}_tail`, judgment, scoring, true, {
    timingErrorMs: Math.round(eventTime - hold.targetTailTime),
    timingLabel: eventTime < hold.targetTailTime ? 'EARLY_RELEASE' : 'LATE_RELEASE',
    holdMissReason: judgment === 'MISS' ? 'RELEASED_TOO_EARLY' : ''
  });
}

setInterval(() => {
  if (gameState.status !== 'RHYTHM_PLAYING') return;
  const question = getCurrentQuestion();
  if (!question) return;
  const now = Date.now();
  const scoring = gameState.roundSettings;

  for (const team of Object.values(gameState.teams)) {
    const socketId = team.roundOperatorId;
    const player = socketId ? gameState.players[socketId] : null;
    if (!player) continue;
    for (let index = 0; index < question.notes.length; index += 1) {
      if (player.judgedNotes.has(index)) continue;
      const note = question.notes[index];
      const missAt =
        gameState.rhythmStartTime +
        Number(note.time) +
        Number(scoring.goodWindow) +
        Math.max(MIN_PASSIVE_MISS_GRACE_MS, Number(scoring.passiveMissGrace) || 0);
      if (now >= missAt) {
        player.judgedNotes.add(index);
        applyJudgment(socketId, player, index, 'MISS', scoring, false, { missReason: 'NO_INPUT_BEFORE_NETWORK_GRACE' });
      }
    }

    for (const [direction, hold] of Object.entries(player.activeHolds)) {
      if (now >= hold.targetTailTime + 100) {
        delete player.activeHolds[direction];
        applyJudgment(socketId, player, `${hold.noteIndex}_tail`, 'PERFECT', scoring, true, {
          timingErrorMs: 100,
          timingLabel: 'AUTO_HOLD_COMPLETE',
          holdAutoComplete: true
        });
      }
    }
  }
}, 40).unref();

function getLocalNetworkCandidates() {
  const candidates = [];
  for (const [interfaceName, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const address = entry.address;
      if (/^169\.254\./.test(address)) continue;

      let priority = 50;
      if (/^192\.168\./.test(address)) priority = 10;
      else if (/^10\./.test(address)) priority = 20;
      else if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) priority = 30;

      if (/wi-?fi|wireless|wlan|無線/i.test(interfaceName)) priority -= 5;
      if (/ethernet|乙太|區域連線/i.test(interfaceName)) priority -= 3;
      if (/virtual|vmware|vbox|hyper-v|vethernet|wsl|docker|tailscale|zerotier/i.test(interfaceName)) {
        priority += 100;
      }

      candidates.push({
        interfaceName,
        address,
        origin: `http://${address}:${PORT}`,
        priority
      });
    }
  }
  const seen = new Set();
  return candidates
    .sort((a, b) => a.priority - b.priority || a.interfaceName.localeCompare(b.interfaceName))
    .filter((candidate) => {
      if (seen.has(candidate.origin)) return false;
      seen.add(candidate.origin);
      return true;
    });
}

function getJoinUrlsForSocket(socket) {
  const settings = store.getSettings();
  const suffix = settings.playerAccess.enabled
    ? `/?access=${encodeURIComponent(settings.playerAccess.token)}`
    : '/';
  const origins = [];
  const origin = socket.handshake.headers.origin;
  if (origin && /^https?:\/\//i.test(origin)) {
    try {
      const parsed = new URL(origin);
      const hostname = parsed.hostname.toLowerCase();
      const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(hostname);
      if (!isLoopback) origins.push(origin.replace(/\/$/, ''));
    } catch (_) {}
  }
  getLocalNetworkCandidates().forEach((candidate) => origins.push(candidate.origin));
  if (!origins.length && origin && /^https?:\/\//i.test(origin)) origins.push(origin.replace(/\/$/, ''));
  if (!origins.length) origins.push(`http://localhost:${PORT}`);
  return [...new Set(origins)].map((base) => `${base}${suffix}`);
}

function normalizePublicBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    parsed.search = '';
    parsed.hash = '';
    const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
    return `${parsed.origin}${pathname}`;
  } catch (_) {
    return '';
  }
}

function buildPlayerJoinUrl(baseUrl) {
  const base = normalizePublicBaseUrl(baseUrl);
  if (!base) return '';
  const settings = store.getSettings();
  const root = `${base}/`;
  return settings.playerAccess.enabled
    ? `${root}?access=${encodeURIComponent(settings.playerAccess.token)}`
    : root;
}

function hideEntryQr() {
  gameState.entryQrVisible = false;
  io.to('hosts').emit('entry-qr-visibility', { visible: false });
}


let settlementTimers = [];
function clearSettlementTimers() {
  settlementTimers.forEach((timer) => clearTimeout(timer));
  settlementTimers = [];
  if (settlementAutoTimer) clearTimeout(settlementAutoTimer);
  settlementAutoTimer = null;
  gameState.settlementAutoPlaying = false;
}

function buildFinalStandings() {
  return Object.keys(gameState.teams)
    .map((teamId) => {
      const team = gameState.teams[teamId];
      const pokemonScore = team.caught.reduce((sum, pokemon) => sum + (Number(pokemon.points) || 0), 0);
      return {
        id: teamId,
        name: team.name,
        pokemonScore,
        totalScore: pokemonScore,
        caughtCount: team.caught.length,
        caughtList: team.caught
      };
    })
    .sort((a, b) => b.totalScore - a.totalScore || b.caughtCount - a.caughtCount || a.name.localeCompare(b.name, 'zh-Hant'));
}

function clonePlayersForCheckpoint() {
  return Object.fromEntries(Object.entries(gameState.players).map(([id, player]) => [id, {
    ...player,
    judgedNotes: [...(player.judgedNotes || [])],
    activeHolds: JSON.parse(JSON.stringify(player.activeHolds || {}))
  }]));
}

function saveFlowCheckpoint(label) {
  flowUndoCheckpoint = {
    label: String(label || '回復上一遊戲階段'),
    state: {
      status: gameState.status,
      currentQuestionIndex: gameState.currentQuestionIndex,
      teams: JSON.parse(JSON.stringify(gameState.teams)),
      players: clonePlayersForCheckpoint(),
      perfectWindow: gameState.perfectWindow,
      goodWindow: gameState.goodWindow,
      settlementStep: gameState.settlementStep,
      roundGuesses: JSON.parse(JSON.stringify(gameState.roundGuesses || {})),
      guessResultsSaved: Boolean(gameState.guessResultsSaved),
      roundBonuses: JSON.parse(JSON.stringify(getTeamRoundBonuses() || {})),
      roundBonusRates: JSON.parse(JSON.stringify(gameState.roundBonusRates || {})),
      rhythmStartTime: gameState.rhythmStartTime,
      roundSettings: JSON.parse(JSON.stringify(gameState.roundSettings || {})),
      settlementAutoPlaying: false,
      completedQuestionIds: [...(gameState.completedQuestionIds || [])],
      skippedQuestionIds: [...(gameState.skippedQuestionIds || [])]
    }
  };
}

function restoreFlowCheckpoint() {
  if (!flowUndoCheckpoint) return false;
  clearSettlementTimers();
  const snap = flowUndoCheckpoint.state;
  gameState.status = snap.status;
  gameState.currentQuestionIndex = snap.currentQuestionIndex;
  gameState.teams = JSON.parse(JSON.stringify(snap.teams));
  gameState.players = Object.fromEntries(Object.entries(snap.players || {}).map(([id, player]) => [id, {
    ...player,
    judgedNotes: new Set(player.judgedNotes || []),
    activeHolds: JSON.parse(JSON.stringify(player.activeHolds || {}))
  }]));
  gameState.perfectWindow = snap.perfectWindow;
  gameState.goodWindow = snap.goodWindow;
  gameState.settlementStep = snap.settlementStep;
  gameState.roundGuesses = JSON.parse(JSON.stringify(snap.roundGuesses || {}));
  gameState.guessResultsSaved = snap.guessResultsSaved;
  gameState.roundBonuses = JSON.parse(JSON.stringify(snap.roundBonuses || {}));
  gameState.roundBonusRates = JSON.parse(JSON.stringify(snap.roundBonusRates || {}));
  gameState.rhythmStartTime = snap.rhythmStartTime;
  gameState.roundSettings = JSON.parse(JSON.stringify(snap.roundSettings || {}));
  gameState.completedQuestionIds = [...(snap.completedQuestionIds || [])];
  gameState.skippedQuestionIds = [...(snap.skippedQuestionIds || [])];
  flowUndoCheckpoint = null;
  return true;
}

function currentRevealPayload() {
  const question = getCurrentQuestion();
  if (!question) return null;
  const winningTeamIds = Object.entries(gameState.teams)
    .filter(([, team]) => (team.caught || []).some((pokemon) => String(pokemon.questionId) === String(question.id)))
    .map(([teamId]) => teamId);
  let capturedPokemon = null;
  for (const teamId of winningTeamIds) {
    capturedPokemon = (gameState.teams[teamId].caught || []).find((pokemon) => String(pokemon.questionId) === String(question.id));
    if (capturedPokemon) break;
  }
  return {
    songName: question.songName,
    winningTeamIds,
    questionPokemon: sanitizePokemonForDisplay({ ...question.pokemon, questionId: question.id }),
    capturedPokemon,
    teamRoundScores: getTeamRoundScores(),
    teamCompetitionScores: getTeamCompetitionScores(),
    roundBonuses: getTeamRoundBonuses(),
    roundBonusRates: gameState.roundBonusRates || {}
  };
}

function emitCurrentStagePresentation() {
  const question = getCurrentQuestion();
  const base = { status: gameState.status, currentQuestionIndex: gameState.currentQuestionIndex };
  if (gameState.status === 'RULES') base.rules = getRulesState(false);
  if (gameState.status === 'END_PAGES') base.endPages = getEndPagesState(false);
  if (gameState.status === 'MULTIPLE_CHOICE' && question) {
    base.multipleChoice = { options: (question.multipleChoice?.options || []).slice(0, 4) };
  }
  io.emit('state-change', base);
  if (question) io.to('hosts').emit('host-load-question', { question });
  if (gameState.status === 'PERFORMANCE' && question) {
    io.to('hosts').emit('performance-start', { songName: question.songName, performance: question.performance || { sourceType: 'none' } });
  }
  if (gameState.status === 'ANSWER_REVEAL') {
    const payload = currentRevealPayload();
    if (payload) {
      const displayPayload = { ...payload, capturedPokemon: sanitizePokemonForDisplay(payload.capturedPokemon) };
      io.to('hosts').emit('answer-reveal', displayPayload);
      io.to('admins').emit('answer-reveal', { ...payload, teams: gameState.teams });
    }
  }
  if (gameState.status === 'SETTLEMENT') {
    if (gameState.settlementStep >= 0) revealSettlementStep(gameState.settlementStep, { replay: true });
  }
  if (gameState.status === 'FINAL_RESULTS') showFinalResults({ replay: true });
  if (gameState.status === 'END_PAGES') emitEndPage();
  broadcastRoomUpdate();
  emitAdminDashboard();
}

function enterSettlement() {
  clearSettlementTimers();
  gameState.status = 'SETTLEMENT';
  gameState.settlementStep = -1;
  gameState.settlementAutoPlaying = false;
  io.emit('state-change', { status: 'SETTLEMENT', settlementStep: -1, automatic: false });
  io.to('hosts').emit('final-bgm-load', { bgm: store.getSettings().finalBgm || { sourceType: 'none' } });
  emitAdminDashboard();
}

function revealSettlementStep(index, extra = {}) {
  const teamIds = Object.keys(gameState.teams);
  if (!teamIds.length) return false;
  const safeIndex = Math.max(0, Math.min(teamIds.length - 1, Number(index) || 0));
  gameState.status = 'SETTLEMENT';
  gameState.settlementStep = safeIndex;
  const teamId = teamIds[safeIndex];
  const team = gameState.teams[teamId];
  const pokemonScore = team.caught.reduce((sum, pokemon) => sum + (Number(pokemon.points) || 0), 0);
  io.emit('state-change', { status: 'SETTLEMENT', settlementStep: safeIndex, automatic: Boolean(gameState.settlementAutoPlaying) });
  io.emit('settlement-step-reveal', {
    step: safeIndex,
    teamId,
    teamName: team.name,
    caught: team.caught,
    pokemonScore,
    totalScore: pokemonScore,
    automatic: Boolean(gameState.settlementAutoPlaying),
    ...extra
  });
  emitAdminDashboard();
  return true;
}

function showFinalResults(extra = {}) {
  clearSettlementTimers();
  gameState.status = 'FINAL_RESULTS';
  gameState.settlementAutoPlaying = false;
  io.emit('state-change', { status: 'FINAL_RESULTS', currentQuestionIndex: gameState.currentQuestionIndex });
  io.emit('final-results', { finalStandings: buildFinalStandings(), automatic: false, ...extra });
  io.to('hosts').emit('final-bgm-load', { bgm: store.getSettings().finalBgm || { sourceType: 'none' } });
  emitAdminDashboard();
}

function scheduleSettlementAuto(intervalMs = 6000) {
  clearSettlementTimers();
  gameState.status = 'SETTLEMENT';
  gameState.settlementAutoPlaying = true;
  const interval = Math.max(2500, Math.min(15000, Number(intervalMs) || 6000));
  const advance = () => {
    if (gameState.status !== 'SETTLEMENT' || !gameState.settlementAutoPlaying) return;
    const teamCount = Object.keys(gameState.teams).length;
    const next = gameState.settlementStep + 1;
    if (next < teamCount) {
      revealSettlementStep(next);
      settlementAutoTimer = setTimeout(advance, interval);
    } else {
      settlementAutoTimer = setTimeout(() => {
        if (gameState.status === 'SETTLEMENT' && gameState.settlementAutoPlaying) showFinalResults({ automatic: true });
      }, Math.min(2500, Math.round(interval * 0.45)));
    }
  };
  io.emit('state-change', { status: 'SETTLEMENT', settlementStep: gameState.settlementStep, automatic: true });
  settlementAutoTimer = setTimeout(advance, gameState.settlementStep < 0 ? 1800 : 1000);
  emitAdminDashboard();
}

function handleAdminControl(socket, action) {
  const { type, data = {} } = action || {};
  const isHostEndSignal = type === 'end-rhythm-early' && socket.data.role === 'host';
  if (!isHostEndSignal && socket.data.role !== 'admin') return;

  switch (type) {
    case 'show-rules': {
      const rules = getRulesState(false);
      if (!rules.enabled) {
        const nextIndex = findNextUncompletedIndex(-1);
        if (nextIndex >= 0) loadQuestionAt(nextIndex);
        return;
      }
      clearSettlementTimers();
      hideEntryQr();
      io.to('hosts').emit('collection-showcase', { visible: false });
      gameState.status = 'RULES';
      gameState.currentQuestionIndex = -1;
      gameState.rulesPageIndex = 0;
      flowUndoCheckpoint = null;
      emitRulesPage();
      break;
    }

    case 'rules-prev':
    case 'rules-next':
    case 'rules-set-page': {
      if (gameState.status !== 'RULES') return;
      const rules = getRulesState(false);
      if (!rules.pageCount) return;
      const target = type === 'rules-prev'
        ? rules.pageIndex - 1
        : type === 'rules-next'
          ? rules.pageIndex + 1
          : Number(data.pageIndex);
      gameState.rulesPageIndex = Math.max(0, Math.min(rules.pageCount - 1, Number(target) || 0));
      emitRulesPage();
      break;
    }

    case 'rules-finish': {
      if (gameState.status !== 'RULES') return;
      const nextIndex = findNextUncompletedIndex(-1);
      if (nextIndex < 0) return;
      loadQuestionAt(nextIndex);
      break;
    }


    case 'show-end-pages': {
      if (!['SETTLEMENT','FINAL_RESULTS','END_PAGES'].includes(gameState.status)) return;
      const endPages = getEndPagesState(false);
      if (!endPages.enabled) return;
      clearSettlementTimers();
      hideEntryQr();
      io.to('hosts').emit('collection-showcase', { visible: false });
      gameState.status = 'END_PAGES';
      gameState.endPageIndex = 0;
      emitEndPage();
      break;
    }

    case 'end-page-prev':
    case 'end-page-next':
    case 'end-page-set': {
      if (gameState.status !== 'END_PAGES') return;
      const endPages = getEndPagesState(false);
      if (!endPages.pageCount) return;
      const target = type === 'end-page-prev'
        ? endPages.pageIndex - 1
        : type === 'end-page-next'
          ? endPages.pageIndex + 1
          : Number(data.pageIndex);
      gameState.endPageIndex = Math.max(0, Math.min(endPages.pageCount - 1, Number(target) || 0));
      emitEndPage();
      break;
    }

    case 'end-pages-back-final': {
      if (gameState.status !== 'END_PAGES') return;
      showFinalResults({ replay: true });
      break;
    }

    case 'next-question': {
      if (!gameState.questions.length) return;
      if (gameState.status === 'ANSWER_REVEAL') saveFlowCheckpoint('回到上一題揭曉畫面');
      const nextIndex = findNextUncompletedIndex(gameState.currentQuestionIndex);
      if (nextIndex < 0) {
        gameState.currentQuestionIndex = Math.max(0, gameState.questions.length - 1);
        enterSettlement();
      } else {
        loadQuestionAt(nextIndex, { clearUndo: gameState.status !== 'ANSWER_REVEAL' });
      }
      emitAdminDashboard();
      break;
    }

    case 'skip-current-question': {
      if (!gameState.questions.length || gameState.currentQuestionIndex < 0) return;
      if (['SETTLEMENT', 'FINAL_RESULTS'].includes(gameState.status)) return;
      if (!isQuestionCompleted(gameState.currentQuestionIndex) && gameState.status !== 'ANSWER_REVEAL') {
        markQuestionSkipped(gameState.currentQuestionIndex);
      }
      const nextIndex = findNextUncompletedIndex(gameState.currentQuestionIndex);
      if (nextIndex < 0) {
        flowUndoCheckpoint = null;
        enterSettlement();
      } else {
        loadQuestionAt(nextIndex);
      }
      emitAdminDashboard();
      break;
    }

    case 'jump-to-question': {
      if (!gameState.questions.length) return;
      const targetIndex = Math.max(0, Math.min(gameState.questions.length - 1, Number(data.questionIndex)));
      if (!Number.isInteger(targetIndex)) return;
      if (isQuestionCompleted(targetIndex) && targetIndex !== gameState.currentQuestionIndex) {
        socket.emit('question-jump-status', { ok: false, message: '已完成的題目為避免重複捕捉與重複計分，不能直接重玩。' });
        return;
      }
      markJumpAbandonments(targetIndex);
      loadQuestionAt(targetIndex);
      socket.emit('question-jump-status', { ok: true, message: `已切換至第 ${targetIndex + 1} 題。` });
      break;
    }

    case 'start-rhythm': {
      const hostCount = io.sockets.adapter.rooms.get('hosts')?.size || 0;
      const currentQuestionForPrep = getCurrentQuestion();
      const readyMatches = gameState.hostRhythmReady?.ready && String(gameState.hostRhythmReady?.questionId || '') === String(currentQuestionForPrep?.id ?? '');
      if (hostCount > 0 && !readyMatches) {
        socket.emit('rhythm-start-blocked', { message: gameState.hostRhythmReady?.message || '投影端音訊尚未預載完成，請稍候再開始。' });
        return;
      }
      saveFlowCheckpoint('回到題目準備畫面');
      hideEntryQr();
      io.to('hosts').emit('collection-showcase', { visible: false });
      if (gameState.currentQuestionIndex < 0 && gameState.questions.length) gameState.currentQuestionIndex = 0;
      const question = getCurrentQuestion();
      if (!question) return;
      gameState.status = 'RHYTHM_PLAYING';
      const latestScoring = store.getSettings().scoring;
      gameState.roundSettings = JSON.parse(JSON.stringify(latestScoring));
      gameState.perfectWindow = latestScoring.perfectWindow;
      gameState.goodWindow = latestScoring.goodWindow;
      Object.values(gameState.players).forEach(resetPlayerRound);
      resetTeamRoundScores();
      assignRoundOperators(false);
      gameState.rhythmStartTime = Date.now() + 3000;
      broadcastRoomUpdate();

      io.emit('state-change', {
        status: gameState.status,
        currentQuestionIndex: gameState.currentQuestionIndex
      });
      io.emit('rhythm-start', {
        startTime: gameState.rhythmStartTime,
        perfectWindow: latestScoring.perfectWindow,
        goodWindow: latestScoring.goodWindow,
        notes: question.notes,
        rhythmSource: question.rhythmSource || 'chart',
        referenceAudio: question.referenceAudio || '',
        referenceAudioOffsetMs: Number(question.referenceAudioOffsetMs) || 0,
        referenceAudioDurationMs: Number(question.audioAuto?.durationMs) || 0,
        operators: getRoundOperators()
      });
      broadcastRoundScores();
      emitAdminDashboard();
      break;
    }

    case 'set-public-join-url': {
      const normalized = normalizePublicBaseUrl(data.baseUrl);
      if (!normalized) {
        socket.emit('entry-qr-admin-status', { ok: false, message: '公開網址格式不正確，請貼上 https://...trycloudflare.com' });
        return;
      }
      gameState.publicBaseUrl = normalized;
      socket.emit('entry-qr-admin-status', {
        ok: true,
        message: '本次活動公開網址已套用。',
        baseUrl: normalized,
        joinUrl: buildPlayerJoinUrl(normalized)
      });
      emitAdminDashboard();
      break;
    }

    case 'show-entry-qr': {
      const requested = normalizePublicBaseUrl(data.baseUrl) || gameState.publicBaseUrl;
      const normalized = normalizePublicBaseUrl(requested);
      if (!normalized) {
        socket.emit('entry-qr-admin-status', { ok: false, message: '請先貼上本次 Cloudflare 公開網址。' });
        return;
      }
      gameState.publicBaseUrl = normalized;
      const joinUrl = buildPlayerJoinUrl(normalized);
      gameState.entryQrVisible = true;
      io.to('hosts').emit('entry-qr-visibility', {
        visible: true,
        url: joinUrl,
        roomId: gameState.roomId
      });
      socket.emit('entry-qr-admin-status', {
        ok: true,
        message: '入場 QR Code 已顯示在投影幕。',
        baseUrl: normalized,
        joinUrl
      });
      emitAdminDashboard();
      break;
    }

    case 'hide-entry-qr': {
      hideEntryQr();
      socket.emit('entry-qr-admin-status', { ok: true, message: '入場畫面已關閉。', baseUrl: gameState.publicBaseUrl || '' });
      emitAdminDashboard();
      break;
    }

    case 'show-multiple-choice': {
      if (!['GUESSING', 'MULTIPLE_CHOICE'].includes(gameState.status)) return;
      const question = getCurrentQuestion();
      if (!question) return;
      const options = (question.multipleChoice?.options || []).slice(0, 4).map((option) => String(option).trim());
      if (options.length < 4 || options.some((option) => !option)) return;
      gameState.status = 'MULTIPLE_CHOICE';
      io.emit('state-change', {
        status: gameState.status,
        multipleChoice: { options }
      });
      const correctIndex = Math.max(0, Math.min(3, Number(question.multipleChoice?.correctIndex) || 0));
      io.to('admins').emit('admin-multiple-choice-answer', {
        questionIndex: gameState.currentQuestionIndex,
        options,
        correctIndex,
        correctOption: options[correctIndex] || ''
      });
      emitAdminDashboard();
      break;
    }

    case 'start-performance':
    case 'submit-guess-results': {
      if (!['GUESSING', 'MULTIPLE_CHOICE'].includes(gameState.status)) return;
      saveFlowCheckpoint(gameState.status === 'MULTIPLE_CHOICE' ? '回到備援選擇題' : '回到自由猜歌');
      const question = getCurrentQuestion();
      if (!question) return;
      const teamGuesses = data.teamGuesses || {};
      if (!gameState.guessResultsSaved) {
        const scoring = gameState.roundSettings || store.getSettings().scoring;
        const bonusPercent = scoring.roundBonusPercent || { directGuess: 50, multipleChoice: 25 };
        const percentValue = gameState.status === 'MULTIPLE_CHOICE'
          ? Math.max(0, Number(bonusPercent.multipleChoice) || 0)
          : Math.max(0, Number(bonusPercent.directGuess) || 0);
        const bonusRate = percentValue / 100;
        gameState.roundGuesses = {};
        resetRoundBonuses();
        for (const [teamId, correct] of Object.entries(teamGuesses)) {
          const isCorrect = Boolean(correct && gameState.teams[teamId]);
          gameState.roundGuesses[teamId] = isCorrect;
          if (isCorrect) gameState.roundBonusRates[teamId] = bonusRate;
        }
        // The bonus is always derived from the team's own ACTUAL rhythm score:
        // direct guess default = rhythm × 1.50; fallback choice default = rhythm × 1.25.
        // Recalculate the point amounts now so the projector leaderboard updates immediately.
        gameState.roundBonuses = getTeamRoundBonuses();
        gameState.guessResultsSaved = true;
        broadcastRoundScoresNow();
      }

      gameState.status = 'PERFORMANCE';
      io.emit('state-change', { status: gameState.status });
      io.emit('performance-start', {
        songName: question.songName,
        performance: question.performance || { sourceType: 'none' }
      });
      emitAdminDashboard();
      break;
    }

    case 'final-bgm-control': {
      if (!['SETTLEMENT','FINAL_RESULTS'].includes(gameState.status)) return;
      const command = data.command === 'pause' ? 'pause' : 'play';
      io.to('hosts').emit('final-bgm-control', { command, bgm: store.getSettings().finalBgm || { sourceType: 'none' } });
      break;
    }

    case 'reveal-and-catch': {
      if (!['PERFORMANCE', 'GUESSING', 'MULTIPLE_CHOICE'].includes(gameState.status)) return;
      saveFlowCheckpoint('回到完整題目／口琴演奏');
      const question = getCurrentQuestion();
      if (!question) return;

      gameState.status = 'ANSWER_REVEAL';
      const scoring = gameState.roundSettings;
      const teamRoundScores = getTeamRoundScores();
      const teamCompetitionScores = getTeamCompetitionScores();

      const values = Object.values(teamCompetitionScores);
      const maxScore = values.length ? Math.max(...values) : 0;
      const winningTeamIds = maxScore > 0
        ? Object.entries(teamCompetitionScores).filter(([, score]) => score === maxScore).map(([teamId]) => teamId)
        : [];

      let capturedPokemon = null;
      if (winningTeamIds.length) {
        capturedPokemon = {
          name: question.pokemon.name,
          evolutionType: question.pokemon.evolutionType,
          points: getPokemonPoints(question.pokemon, scoring),
          image: resolveAssetUrl(question.pokemon.image, 'pokemon'),
          questionId: question.id
        };
        winningTeamIds.forEach((teamId) => gameState.teams[teamId].caught.push({ ...capturedPokemon }));
      }

      markQuestionCompleted(gameState.currentQuestionIndex);
      const questionPokemon = sanitizePokemonForDisplay({ ...question.pokemon, questionId: question.id });
      const displayPayload = {
        songName: question.songName,
        winningTeamIds,
        questionPokemon,
        capturedPokemon: sanitizePokemonForDisplay(capturedPokemon),
        teamRoundScores,
        teamCompetitionScores
      };
      io.to('hosts').emit('answer-reveal', displayPayload);
      io.to('admins').emit('answer-reveal', {
        ...displayPayload,
        capturedPokemon,
        teams: gameState.teams,
        teamCompetitionScores,
        roundBonuses: getTeamRoundBonuses(),
        roundBonusRates: gameState.roundBonusRates || {}
      });
      for (const socketId of Object.keys(gameState.players)) {
        io.to(socketId).emit('answer-reveal', displayPayload);
        emitPlayerTeamUpdate(socketId);
      }
      broadcastRoundScores();
      emitAdminDashboard();
      break;
    }

    case 'show-collection': {
      if (gameState.status === 'RHYTHM_PLAYING') return;
      const requestedTeamId = String(data.teamId || 'all');
      io.to('hosts').emit('collection-showcase', {
        visible: true,
        teamId: requestedTeamId,
        teams: sanitizedTeamsForShowcase()
      });
      break;
    }

    case 'hide-collection':
      io.to('hosts').emit('collection-showcase', { visible: false });
      break;

    case 'end-rhythm-early':
      if (gameState.status === 'RHYTHM_PLAYING') {
        gameState.status = 'GUESSING';
        io.emit('state-change', { status: gameState.status });
        emitAdminDashboard();
      }
      break;

    case 'enter-settlement': {
      const noPendingAfterCurrent = findNextUncompletedIndex(gameState.currentQuestionIndex) < 0;
      if (gameState.status !== 'ANSWER_REVEAL' || !noPendingAfterCurrent) return;
      saveFlowCheckpoint('回到最後完成的題目答案與寶可夢揭曉');
      enterSettlement();
      break;
    }

    case 'settlement-start-auto': {
      if (!['SETTLEMENT', 'FINAL_RESULTS'].includes(gameState.status)) return;
      if (gameState.status === 'FINAL_RESULTS') {
        gameState.status = 'SETTLEMENT';
        gameState.settlementStep = -1;
      }
      scheduleSettlementAuto(data.intervalMs);
      break;
    }

    case 'settlement-pause-auto': {
      if (gameState.status !== 'SETTLEMENT') return;
      clearSettlementTimers();
      io.to('admins').emit('settlement-control-status', { message: '自動公布已暫停，可改用手動控制。' });
      emitAdminDashboard();
      break;
    }

    case 'settlement-next': {
      if (gameState.status !== 'SETTLEMENT') return;
      clearSettlementTimers();
      const teamCount = Object.keys(gameState.teams).length;
      const next = gameState.settlementStep + 1;
      if (next < teamCount) revealSettlementStep(next);
      else showFinalResults();
      break;
    }

    case 'settlement-prev': {
      if (!['SETTLEMENT', 'FINAL_RESULTS'].includes(gameState.status)) return;
      clearSettlementTimers();
      const wasFinal = gameState.status === 'FINAL_RESULTS';
      gameState.status = 'SETTLEMENT';
      const prev = wasFinal ? Math.max(0, gameState.settlementStep) : Math.max(-1, gameState.settlementStep - 1);
      gameState.settlementStep = prev;
      if (prev < 0) io.emit('state-change', { status: 'SETTLEMENT', settlementStep: -1, automatic: false });
      else revealSettlementStep(prev, { replay: true });
      emitAdminDashboard();
      break;
    }

    case 'settlement-show-final': {
      if (!['SETTLEMENT', 'FINAL_RESULTS'].includes(gameState.status)) return;
      showFinalResults();
      break;
    }

    case 'settlement-return-waiting': {
      clearSettlementTimers();
      gameState.status = 'SETTLEMENT';
      gameState.settlementStep = -1;
      io.emit('state-change', { status: 'SETTLEMENT', settlementStep: -1, automatic: false });
  io.to('hosts').emit('final-bgm-load', { bgm: store.getSettings().finalBgm || { sourceType: 'none' } });
      emitAdminDashboard();
      break;
    }

    case 'redisplay-current-stage': {
      emitCurrentStagePresentation();
      break;
    }

    case 'undo-last-flow': {
      if (gameState.status === 'RHYTHM_PLAYING') return;
      if (!restoreFlowCheckpoint()) return;
      emitCurrentStagePresentation();
      break;
    }

    case 'reveal-settlement-step': {
      if (gameState.status !== 'SETTLEMENT') enterSettlement();
      revealSettlementStep(gameState.settlementStep + 1);
      break;
    }

    case 'reset-game': {
      clearSettlementTimers();
      flowUndoCheckpoint = null;
      const settings = store.getSettings();
      hideEntryQr();
      io.to('hosts').emit('collection-showcase', { visible: false });
      flowUndoCheckpoint = null;
      gameState.status = 'LOBBY';
      gameState.currentQuestionIndex = -1;
      gameState.settlementStep = -1;
      gameState.completedQuestionIds = [];
      gameState.skippedQuestionIds = [];
      gameState.rulesPageIndex = 0;
      gameState.roundGuesses = {};
      gameState.guessResultsSaved = false;
      gameState.players = {};
      gameState.questions = gameState.pendingQuestions || store.getPublishedQuestions().filter((q) => q.enabled !== false);
      gameState.pendingQuestions = null;
      gameState.roomId = settings.room.id;
      setupTeams(settings.room.teamNames);
      resetRoundBonuses();
      broadcastRoomUpdate();
      io.emit('state-change', { status: gameState.status });
      emitAdminDashboard();
      break;
    }
  }
}

io.on('connection', (socket) => {
  socket.data.role = 'guest';

  socket.on('time-sync', (data = {}) => {
    socket.emit('time-sync-response', {
      clientTime: data.clientTime,
      serverTime: Date.now()
    });
  });

  socket.on('admin-join', () => {
    if (!auth.isSocketAuthenticated(socket)) {
      return socket.emit('auth-error', { message: '管理員登入已失效，請重新登入' });
    }
    socket.data.role = 'admin';
    socket.join('admins');
    socket.emit('admin-join-success', { gameState: adminGameState(), dashboard: buildDashboard() });
  });

  socket.on('admin-setup-room', (config = {}) => {
    if (socket.data.role !== 'admin') return;
    clearSettlementTimers();
    flowUndoCheckpoint = null;
    const settings = store.getSettings();
    const teamNames = Array.isArray(config.teamNames) && config.teamNames.length
      ? config.teamNames
      : settings.room.teamNames;
    gameState.status = 'LOBBY';
    gameState.currentQuestionIndex = -1;
    gameState.settlementStep = -1;
    gameState.completedQuestionIds = [];
    gameState.skippedQuestionIds = [];
    gameState.rulesPageIndex = 0;
    gameState.roundGuesses = {};
    gameState.guessResultsSaved = false;
    gameState.hostRhythmReady = { questionId: '', ready: false, message: '尚未預載' };
    gameState.roomId = String(config.roomId || settings.room.id);
    gameState.perfectWindow = Number(config.perfectWindow) || settings.scoring.perfectWindow;
    gameState.goodWindow = Number(config.goodWindow) || settings.scoring.goodWindow;
    setupTeams(teamNames);
    resetRoundBonuses();
    broadcastRoomUpdate();
    io.emit('state-change', { status: gameState.status });
    emitAdminDashboard();
  });

  socket.on('host-join', () => {
    socket.data.role = 'host';
    socket.join('hosts');
    socket.join(gameState.roomId);
    const serverUrls = getJoinUrlsForSocket(socket);
    socket.emit('host-join-success', {
      gameState: publicGameState(),
      serverUrl: serverUrls[0],
      serverUrls,
      currentQuestion: getCurrentQuestion()
    });
    if (gameState.entryQrVisible && gameState.publicBaseUrl) {
      socket.emit('entry-qr-visibility', {
        visible: true,
        url: buildPlayerJoinUrl(gameState.publicBaseUrl),
        roomId: gameState.roomId
      });
    }
  });

  socket.on('host-rhythm-ready', (data = {}) => {
    if (socket.data.role !== 'host') return;
    const question = getCurrentQuestion();
    const questionId = String(data.questionId ?? '');
    if (!question || questionId !== String(question.id ?? '')) return;
    gameState.hostRhythmReady = {
      questionId,
      ready: data.ready !== false,
      message: String(data.message || (data.ready === false ? '投影端預載失敗' : '投影端音訊已預載完成')),
      prepareMs: Math.max(0, Math.round(Number(data.prepareMs) || 0))
    };
    io.to('admins').emit('host-rhythm-prep-status', gameState.hostRhythmReady);
    emitAdminDashboard();
  });

  socket.on('player-join', (data = {}) => {
    const settings = store.getSettings();
    if (String(data.roomCode || '') !== gameState.roomId) {
      return socket.emit('join-error', { message: '房間代碼不正確！' });
    }
    if (settings.playerAccess.enabled && String(data.accessToken || '') !== settings.playerAccess.token) {
      return socket.emit('join-error', { message: '此活動需要有效的 QR Code 入場連結。' });
    }
    if (!gameState.teams[data.teamId]) {
      return socket.emit('join-error', { message: '選擇的隊伍不存在！' });
    }

    const sessionId = String(data.sessionId || '').slice(0, 80);
    let migratedPlayer = null;
    let migratedFromId = '';
    if (sessionId) {
      const match = Object.entries(gameState.players).find(([id, player]) => id !== socket.id && player.clientSessionId === sessionId);
      if (match) {
        [migratedFromId, migratedPlayer] = match;
        const oldTeam = gameState.teams[migratedPlayer.teamId];
        if (oldTeam) {
          if (migratedPlayer.teamId === data.teamId) oldTeam.members = oldTeam.members.map((id) => id === migratedFromId ? socket.id : id);
          else oldTeam.members = oldTeam.members.filter((id) => id !== migratedFromId);
          if (oldTeam.roundOperatorId === migratedFromId) oldTeam.roundOperatorId = migratedPlayer.teamId === data.teamId ? socket.id : null;
        }
        delete gameState.players[migratedFromId];
      }
    }

    const oldPlayer = gameState.players[socket.id];
    if (oldPlayer && gameState.teams[oldPlayer.teamId] && oldPlayer.teamId !== data.teamId) {
      gameState.teams[oldPlayer.teamId].members = gameState.teams[oldPlayer.teamId].members.filter((id) => id !== socket.id);
    }

    gameState.players[socket.id] = migratedPlayer || oldPlayer || {
      nickname: String(data.nickname || '玩家').slice(0, 30),
      teamId: data.teamId,
      score: 0,
      roundScore: 0,
      combo: 0,
      judgedNotes: new Set(),
      activeHolds: {}
    };
    Object.assign(gameState.players[socket.id], {
      nickname: String(data.nickname || gameState.players[socket.id].nickname || '玩家').slice(0, 30),
      teamId: data.teamId,
      clientSessionId: sessionId || gameState.players[socket.id].clientSessionId || '',
      connected: true,
      disconnectedAt: 0
    });
    if (!gameState.teams[data.teamId].members.includes(socket.id)) gameState.teams[data.teamId].members.push(socket.id);
    if (['INTRO', 'RHYTHM_PLAYING'].includes(gameState.status)) assignRoundOperators(false);
    socket.data.role = 'player';
    socket.join(gameState.roomId);
    const currentQuestion = getCurrentQuestion();
    socket.emit('join-success', {
      playerId: socket.id,
      teamId: data.teamId,
      nickname: gameState.players[socket.id].nickname,
      gameState: {
        status: gameState.status,
        currentQuestionIndex: gameState.currentQuestionIndex,
        rhythmStartTime: gameState.rhythmStartTime,
        perfectWindow: gameState.perfectWindow,
        goodWindow: gameState.goodWindow,
        notes: gameState.status === 'RHYTHM_PLAYING' && currentQuestion ? currentQuestion.notes : [],
        rhythmSource: currentQuestion?.rhythmSource || 'chart',
        referenceAudio: currentQuestion?.referenceAudio || '',
        referenceAudioOffsetMs: Number(currentQuestion?.referenceAudioOffsetMs) || 0,
        referenceAudioDurationMs: Number(currentQuestion?.audioAuto?.durationMs) || 0,
        operators: getRoundOperators(),
        rules: gameState.status === 'RULES' ? getRulesState(false) : undefined
      }
    });
    emitPlayerTeamUpdate(socket.id);
    broadcastRoomUpdate();
  });

  socket.on('admin-control', (action) => handleAdminControl(socket, action));
  socket.on('player-input', (input = {}) => {
    if (socket.data.role !== 'player') return;
    if (input.action === 'press') handlePlayerPress(socket, input);
    if (input.action === 'release') handlePlayerRelease(socket, input);
  });

  // Legacy clients cannot submit scores anymore. Kept as an explicit no-op.
  socket.on('player-hit', () => {});

  socket.on('disconnect', () => {
    const player = gameState.players[socket.id];
    if (!player) return;
    player.connected = false;
    player.disconnectedAt = Date.now();
    const disconnectedAt = player.disconnectedAt;
    broadcastRoomUpdate();
    setTimeout(() => {
      const stale = gameState.players[socket.id];
      if (!stale || stale.connected !== false || stale.disconnectedAt !== disconnectedAt) return;
      const team = gameState.teams[stale.teamId];
      if (team) team.members = team.members.filter((id) => id !== socket.id);
      delete gameState.players[socket.id];
      if (team && team.roundOperatorId === socket.id) {
        team.roundOperatorId = null;
        if (['INTRO', 'RHYTHM_PLAYING'].includes(gameState.status)) assignRoundOperators(false);
      }
      broadcastRoomUpdate();
    }, 90000).unref?.();
  });
});

function hydrateGameStateFromStore() {
  const settings = store.getSettings();
  gameState.roomId = settings.room.id;
  gameState.questions = store.getPublishedQuestions().filter((q) => q.enabled !== false);
  gameState.pendingQuestions = null;
  gameState.perfectWindow = settings.scoring.perfectWindow;
  gameState.goodWindow = settings.scoring.goodWindow;
  gameState.roundSettings = settings.scoring;
  gameState.status = 'LOBBY';
  gameState.currentQuestionIndex = -1;
  gameState.settlementStep = -1;
  gameState.completedQuestionIds = [];
  gameState.skippedQuestionIds = [];
  gameState.roundGuesses = {};
  gameState.guessResultsSaved = false;
  gameState.hostRhythmReady = { questionId: '', ready: false, message: '尚未預載' };
  setupTeams(settings.room.teamNames);
  resetRoundBonuses();
}

async function startServer() {
  if (cloud.enabled) {
    try {
      const cloudState = await cloud.loadState();
      if (cloudState) {
        store.importBackupBundle(cloudState);
        console.log('[cloud] loaded shared content from Supabase');
      } else {
        await cloud.saveState(store.createBackupBundle());
        console.log('[cloud] initialized Supabase with local content');
      }
    } catch (error) {
      console.error('[cloud] startup synchronization failed; continuing with local cache:', error.message);
    }
  }

  hydrateGameStateFromStore();
  httpServer.listen(PORT, process.env.HOST || '127.0.0.1', () => {
    const networkCandidates = getLocalNetworkCandidates();
    const localIp = networkCandidates[0]?.address || '127.0.0.1';
    console.log('=============================================================');
    console.log('  寶可夢猜歌節奏遊戲伺服器已啟動');
    console.log(`  玩家端：       http://localhost:${PORT}`);
    console.log(`  內容管理：     http://localhost:${PORT}/manage.html`);
    console.log(`  主持控制：     http://localhost:${PORT}/admin.html`);
    console.log(`  譜面編輯：     http://localhost:${PORT}/editor.html`);
    console.log(`  投影畫面：     http://localhost:${PORT}/host.html`);
    console.log(`  手機區域網路： http://${localIp}:${PORT}`);
    console.log(`  資料模式：     ${cloud.enabled ? 'Supabase 共用雲端' : '本機檔案'}`);
    if (!auth.isInitialized()) {
      console.log('  首次使用：請開啟內容管理頁設定至少 8 字元的管理員密碼。');
    }
    console.log('=============================================================');
  });
}

startServer().catch((error) => {
  console.error('伺服器啟動失敗：', error);
  process.exitCode = 1;
});
