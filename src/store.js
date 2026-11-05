const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const VERSION_DIR = path.join(DATA_DIR, 'versions');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const DRAFT_PATH = path.join(DATA_DIR, 'questions-draft.json');
const PUBLISHED_PATH = path.join(DATA_DIR, 'questions-published.json');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const ASSETS_PATH = path.join(DATA_DIR, 'assets.json');
const LEGACY_QUESTIONS_PATH = path.join(ROOT, 'questions.json');
const AUTH_PATH = path.join(DATA_DIR, 'admin-auth.json');

const NOTE_CLASS = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };

function pitchNameToMidi(value) {
  const match = String(value || '').trim().match(/^([A-G](?:#)?)(-1|[0-9])$/);
  if (!match || !(match[1] in NOTE_CLASS)) return null;
  return (Number(match[2]) + 1) * 12 + NOTE_CLASS[match[1]];
}

const DEFAULT_SETTINGS = {
  room: {
    id: '8888',
    teamNames: ['示範 A 隊', '示範 B 隊', '示範 C 隊', '示範 D 隊']
  },
  scoring: {
    perfectWindow: 80,
    goodWindow: 180,
    perfectBase: 10,
    goodBase: 5,
    missScore: 0,
    comboCap: 50,
    perfectComboRate: 0.2,
    goodComboRate: 0.1,
    holdBase: 15,
    holdComboRate: 0.3,
    holdEarlyTolerance: 200,
    passiveMissGrace: 700,
    teamScoreMode: 'active-player',
    roundBonusMode: 'percent-of-rhythm',
    roundBonusBase: 'own-team',
    roundBonusPercent: {
      directGuess: 50,
      multipleChoice: 25
    },
    pokemonPoints: {
      'three-stage-1': 10,
      'three-stage-2': 20,
      'three-stage-3': 30,
      'two-stage-1': 15,
      'two-stage-2': 30,
      'no-evolution': 25,
      legendary: 50
    }
  },
  playerAccess: {
    enabled: true,
    token: crypto.randomBytes(12).toString('hex')
  },
  uploads: {
    maxMb: 25
  },
  finalBgm: {
    sourceType: 'none',
    assetUrl: '',
    youtubeUrl: '',
    volume: 0.55
  },
  rules: {
    enabled: true,
    pages: [
      {
        title: '遊戲規則',
        markdown: '# 歡迎來到寶可夢猜歌大賽！\n\n- 每題先進行 **節奏挑戰**。\n- 節奏結束後，小組一起進行猜歌。\n- 本題捕捉判定會以 **音遊實得分 × 猜歌倍率** 計算。\n\n> 詳細規則可以在內容管理後台自行修改，也可以新增多頁。'
      }
    ]
  },
  endPages: {
    enabled: true,
    pages: [
      {
        title: '活動結束',
        backgroundColor: '#071014',
        elements: [
          { id: 'default-thanks', type: 'text', x: 240, y: 180, w: 1120, h: 260, z: 1, markdown: '# 謝謝大家參加！\n\n請掃描畫面上的 QR Code，加入後續活動與社群。', fontSize: 46, textAlign: 'center', color: '#ffffff', backgroundEnabled: false, backgroundColor: '#000000' }
        ]
      }
    ]
  },
  updatedAt: new Date().toISOString()
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) {
    return override === undefined ? base : override;
  }
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      base &&
      typeof base[key] === 'object' &&
      !Array.isArray(base[key])
    ) {
      out[key] = deepMerge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    console.error(`Failed to read JSON ${filePath}:`, error);
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf8');
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    // Windows may reject replacing an existing file with renameSync.
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    fs.renameSync(tmpPath, filePath);
  }
}

function normalizeQuestion(question, index = 0) {
  const q = question && typeof question === 'object' ? question : {};
  const pokemon = q.pokemon && typeof q.pokemon === 'object' ? q.pokemon : {};
  const multipleChoice = q.multipleChoice && typeof q.multipleChoice === 'object' ? q.multipleChoice : {};
  const performance = q.performance && typeof q.performance === 'object' ? q.performance : {};
  const id = Number.isFinite(Number(q.id)) ? Number(q.id) : index + 1;
  const options = Array.isArray(multipleChoice.options)
    ? multipleChoice.options.slice(0, 6).map((option) => String(option || ''))
    : ['', '', '', ''];
  while (options.length < 4) options.push('');
  const correctIndex = Math.min(
    Math.max(0, Number.isFinite(Number(multipleChoice.correctIndex)) ? Number(multipleChoice.correctIndex) : 0),
    Math.max(0, options.length - 1)
  );
  const sourceType = ['none', 'youtube', 'video', 'audio'].includes(performance.sourceType)
    ? performance.sourceType
    : 'none';

  return {
    id,
    songName: String(q.songName || `第 ${index + 1} 題`),
    enabled: q.enabled !== false,
    pokemon: {
      name: String(pokemon.name || '未知寶可夢'),
      evolutionType: String(pokemon.evolutionType || 'three-stage-1'),
      customPoints: Math.max(0, Number(pokemon.customPoints) || 0),
      image: String(pokemon.image && pokemon.image !== 'placeholder.png' ? pokemon.image : '')
    },
    referenceAudio: String(q.referenceAudio || ''),
    referenceAudioOffsetMs: Number.isFinite(Number(q.referenceAudioOffsetMs)) ? Number(q.referenceAudioOffsetMs) : 0,
    rhythmSource: q.rhythmSource === 'reference-audio-auto' ? 'reference-audio-auto' : 'chart',
    audioAuto: {
      density: ['sparse', 'normal', 'dense'].includes(q.audioAuto?.density) ? q.audioAuto.density : 'normal',
      generatedFrom: String(q.audioAuto?.generatedFrom || ''),
      generatedAt: String(q.audioAuto?.generatedAt || ''),
      durationMs: Math.max(0, Math.round(Number(q.audioAuto?.durationMs) || 0)),
      seed: Math.round(Number(q.audioAuto?.seed) || 0)
    },
    midiAsset: String(q.midiAsset || ''),
    scoreAsset: String(q.scoreAsset || ''),
    multipleChoice: {
      options,
      correctIndex
    },
    performance: {
      sourceType,
      youtubeUrl: String(performance.youtubeUrl || ''),
      assetUrl: String(performance.assetUrl || ''),
      startSeconds: Math.max(0, Number(performance.startSeconds) || 0),
      endSeconds: Math.max(0, Number(performance.endSeconds) || 0),
      notes: String(performance.notes || '')
    },
    notes: Array.isArray(q.notes)
      ? q.notes
          .map((note) => ({
            time: Math.max(0, Math.round(Number(note.time) || 0)),
            direction: ['left', 'down', 'up', 'right'].includes(note.direction) ? note.direction : 'left',
            pitch: String(note.pitch || 'C4'),
            midiNote:
              pitchNameToMidi(String(note.pitch || 'C4')) ??
              (note.midiNote !== null && note.midiNote !== undefined && note.midiNote !== '' && Number.isFinite(Number(note.midiNote))
                ? Number(note.midiNote)
                : null),
            duration: Math.max(0, Math.round(Number(note.duration) || 0))
          }))
          .sort((a, b) => a.time - b.time)
      : []
  };
}

function normalizeQuestions(questions) {
  const list = Array.isArray(questions) ? questions : [];
  const seen = new Set();
  let nextId = list.reduce((max, q) => Math.max(max, Number(q && q.id) || 0), 0) + 1;
  return list.map((q, index) => {
    const normalized = normalizeQuestion(q, index);
    if (seen.has(normalized.id)) normalized.id = nextId++;
    seen.add(normalized.id);
    return normalized;
  });
}

function initializeStore() {
  ensureDir(DATA_DIR);
  ensureDir(VERSION_DIR);
  ensureDir(UPLOAD_DIR);
  ['pokemon', 'audio', 'video', 'midi', 'score', 'note', 'endpage'].forEach((category) => ensureDir(path.join(UPLOAD_DIR, category)));

  const legacy = normalizeQuestions(readJson(LEGACY_QUESTIONS_PATH, []));
  if (!fs.existsSync(DRAFT_PATH)) writeJsonAtomic(DRAFT_PATH, legacy);
  if (!fs.existsSync(PUBLISHED_PATH)) writeJsonAtomic(PUBLISHED_PATH, legacy);
  if (!fs.existsSync(ASSETS_PATH)) writeJsonAtomic(ASSETS_PATH, []);

  const currentSettings = readJson(SETTINGS_PATH, {});
  const mergedSettings = deepMerge(DEFAULT_SETTINGS, currentSettings);
  if (!mergedSettings.playerAccess.token) {
    mergedSettings.playerAccess.token = crypto.randomBytes(12).toString('hex');
  }
  mergedSettings.updatedAt = currentSettings.updatedAt || new Date().toISOString();
  writeJsonAtomic(SETTINGS_PATH, mergedSettings);

  // Keep the legacy file as the currently published snapshot for old tooling.
  writeJsonAtomic(LEGACY_QUESTIONS_PATH, normalizeQuestions(readJson(PUBLISHED_PATH, legacy)));
}

function getDraftQuestions() {
  return normalizeQuestions(readJson(DRAFT_PATH, []));
}

function saveDraftQuestions(questions) {
  const normalized = normalizeQuestions(questions);
  writeJsonAtomic(DRAFT_PATH, normalized);
  return normalized;
}

function getPublishedQuestions() {
  return normalizeQuestions(readJson(PUBLISHED_PATH, []));
}

function validateQuestionsForPublish(questions) {
  const enabled = questions.filter((q) => q.enabled !== false);
  if (!enabled.length) throw new Error('正式題庫至少需要一題啟用中的題目');
  enabled.forEach((q, index) => {
    const label = `第 ${index + 1} 題「${q.songName || '未命名'}」`;
    const options = q.multipleChoice && Array.isArray(q.multipleChoice.options)
      ? q.multipleChoice.options.slice(0, 4).map((value) => String(value || '').trim())
      : [];
    if (options.length < 4 || options.some((value) => !value)) {
      throw new Error(`${label}的備援選擇題 A～D 必須全部填寫，否則無法發布`);
    }
    const correctIndex = Number(q.multipleChoice?.correctIndex);
    if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex > 3) {
      throw new Error(`${label}尚未設定有效的選擇題正確答案`);
    }
  });
  return enabled;
}

function publishDraftQuestions() {
  const draft = getDraftQuestions();
  validateQuestionsForPublish(draft);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const versionPath = path.join(VERSION_DIR, `questions-${stamp}.json`);
  writeJsonAtomic(versionPath, {
    createdAt: new Date().toISOString(),
    questions: draft
  });
  writeJsonAtomic(PUBLISHED_PATH, draft);
  writeJsonAtomic(LEGACY_QUESTIONS_PATH, draft);
  return { questions: draft, versionId: path.basename(versionPath, '.json') };
}

function listQuestionVersions() {
  ensureDir(VERSION_DIR);
  return fs
    .readdirSync(VERSION_DIR)
    .filter((name) => /^questions-.*\.json$/.test(name))
    .sort()
    .reverse()
    .map((name) => {
      const fullPath = path.join(VERSION_DIR, name);
      const data = readJson(fullPath, {});
      return {
        id: path.basename(name, '.json'),
        createdAt: data.createdAt || fs.statSync(fullPath).mtime.toISOString(),
        questionCount: Array.isArray(data.questions) ? data.questions.length : 0
      };
    });
}

function restoreQuestionVersion(versionId) {
  const safeId = String(versionId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const filePath = path.join(VERSION_DIR, `${safeId}.json`);
  if (!fs.existsSync(filePath)) throw new Error('找不到指定版本');
  const data = readJson(filePath, null);
  if (!data || !Array.isArray(data.questions)) throw new Error('版本檔案格式不正確');
  return saveDraftQuestions(data.questions);
}

function normalizeSettings(settings) {
  const merged = deepMerge(DEFAULT_SETTINGS, settings || {});
  merged.rules = merged.rules && typeof merged.rules === 'object' ? merged.rules : {};
  merged.rules.enabled = merged.rules.enabled !== false;
  const rawRulePages = Array.isArray(merged.rules.pages) ? merged.rules.pages : [];
  merged.rules.pages = rawRulePages
    .slice(0, 20)
    .map((page, index) => ({
      title: String(page?.title || `規則 ${index + 1}`).slice(0, 80),
      markdown: String(page?.markdown || '').slice(0, 12000)
    }))
    .filter((page) => page.title.trim() || page.markdown.trim());
  if (!merged.rules.pages.length) {
    merged.rules.pages = [{ title: '遊戲規則', markdown: '# 遊戲規則\n\n請在內容管理後台編輯本頁。' }];
  }

  merged.endPages = merged.endPages && typeof merged.endPages === 'object' ? merged.endPages : {};
  merged.endPages.enabled = merged.endPages.enabled !== false;
  const rawEndPages = Array.isArray(merged.endPages.pages) ? merged.endPages.pages : [];
  const clampEnd = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
  const validHex = (value, fallback) => /^#[0-9a-fA-F]{6}$/.test(String(value || '')) ? String(value) : fallback;
  const legacyElements = (page, pageIndex) => {
    const elements = [];
    const title = String(page?.title || `活動結束 ${pageIndex + 1}`);
    const markdown = String(page?.markdown || '');
    const images = [page?.imageUrl, page?.imageUrl2].filter(Boolean);
    const layout = String(page?.layout || 'image-right');
    if (title) elements.push({ id:`legacy-title-${pageIndex}`, type:'text', x:120, y:45, w:1360, h:100, z:3, markdown:`## ${title}`, fontSize:42, textAlign:'center', color:'#66fcf1', backgroundEnabled:false, backgroundColor:'#000000' });
    if (layout === 'text-only' || !images.length) {
      if (markdown) elements.push({ id:`legacy-text-${pageIndex}`, type:'text', x:140, y:180, w:1320, h:610, z:2, markdown, fontSize:32, textAlign:'left', color:'#ffffff', backgroundEnabled:false, backgroundColor:'#000000' });
      return elements;
    }
    let textRect={x:90,y:180,w:850,h:610}; let imageRects=[{x:1000,y:190,w:500,h:500},{x:1080,y:620,w:340,h:210}];
    if (layout === 'image-left') { textRect={x:660,y:180,w:850,h:610}; imageRects=[{x:90,y:190,w:500,h:500},{x:170,y:620,w:340,h:210}]; }
    if (layout === 'image-top') { textRect={x:140,y:530,w:1320,h:280}; imageRects=[{x:350,y:150,w:900,h:340},{x:1180,y:170,w:260,h:260}]; }
    if (layout === 'image-bottom') { textRect={x:140,y:160,w:1320,h:300}; imageRects=[{x:350,y:500,w:900,h:330},{x:1180,y:520,w:260,h:260}]; }
    if (layout === 'two-images') { textRect={x:160,y:150,w:1280,h:230}; imageRects=[{x:180,y:400,w:560,h:400},{x:860,y:400,w:560,h:400}]; }
    if (markdown) elements.push({ id:`legacy-text-${pageIndex}`, type:'text', ...textRect, z:2, markdown, fontSize:30, textAlign:'left', color:'#ffffff', backgroundEnabled:false, backgroundColor:'#000000' });
    images.forEach((url, imageIndex) => elements.push({ id:`legacy-img-${pageIndex}-${imageIndex}`, type:'image', ...(imageRects[imageIndex] || imageRects[0]), z:1+imageIndex, url:String(url), fit:'contain' }));
    return elements;
  };
  merged.endPages.pages = rawEndPages.slice(0, 20).map((page, pageIndex) => {
    const sourceElements = Array.isArray(page?.elements) ? page.elements : legacyElements(page || {}, pageIndex);
    const elements = sourceElements.slice(0, 80).map((raw, elementIndex) => {
      const type = raw?.type === 'image' ? 'image' : 'text';
      const x = clampEnd(raw?.x, 0, 1560), y = clampEnd(raw?.y, 0, 860);
      const common = {
        id: String(raw?.id || `end-${pageIndex}-${elementIndex}`).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 100),
        type, x, y,
        w: clampEnd(raw?.w || (type === 'image' ? 420 : 900), 40, 1600 - x),
        h: clampEnd(raw?.h || (type === 'image' ? 420 : 240), 40, 900 - y),
        z: clampEnd(raw?.z ?? elementIndex, 0, 9999)
      };
      if (type === 'image') return { ...common, url:String(raw?.url || raw?.imageUrl || '').slice(0, 2000), fit:raw?.fit === 'cover' ? 'cover' : 'contain' };
      return { ...common, markdown:String(raw?.markdown || '').slice(0, 12000), fontSize:clampEnd(raw?.fontSize || 42, 12, 120), textAlign:['left','center','right'].includes(raw?.textAlign) ? raw.textAlign : 'left', color:validHex(raw?.color,'#ffffff'), backgroundEnabled:raw?.backgroundEnabled === true, backgroundColor:validHex(raw?.backgroundColor,'#000000') };
    });
    return { title:String(page?.title || `活動結束 ${pageIndex + 1}`).slice(0,80), backgroundColor:validHex(page?.backgroundColor,'#071014'), elements };
  });
  if (!merged.endPages.pages.length) merged.endPages.pages = [{ title:'活動結束', backgroundColor:'#071014', elements:[{ id:'default-thanks', type:'text', x:240, y:180, w:1120, h:260, z:1, markdown:'# 謝謝大家參加！', fontSize:46, textAlign:'center', color:'#ffffff', backgroundEnabled:false, backgroundColor:'#000000' }] }];

  // V5.7: each team has exactly one rhythm operator per question.
  // Keep the field for backwards-compatible JSON, but retire average/sum semantics.
  merged.scoring.teamScoreMode = 'active-player';

  // V7.1: guessing uses a percentage bonus; the base can be each team's own rhythm score or the round-highest rhythm score.
  // Old V6 `roundBonus` values are intentionally ignored so copying an old data folder does not
  // accidentally turn +30/+15 fixed points into +30%/+15%.
  merged.scoring.roundBonusMode = 'percent-of-rhythm';
  merged.scoring.roundBonusBase = merged.scoring.roundBonusBase === 'round-highest' ? 'round-highest' : 'own-team';
  const rawBonusPercent = merged.scoring.roundBonusPercent || {};
  merged.scoring.roundBonusPercent = {
    directGuess: Math.max(0, Number(rawBonusPercent.directGuess) || 50),
    multipleChoice: Math.max(0, Number(rawBonusPercent.multipleChoice) || 25)
  };
  merged.finalBgm = merged.finalBgm && typeof merged.finalBgm === 'object' ? merged.finalBgm : {};
  merged.finalBgm.sourceType = ['none','audio','youtube'].includes(merged.finalBgm.sourceType) ? merged.finalBgm.sourceType : 'none';
  merged.finalBgm.assetUrl = String(merged.finalBgm.assetUrl || '');
  merged.finalBgm.youtubeUrl = String(merged.finalBgm.youtubeUrl || '');
  merged.finalBgm.volume = Math.max(0, Math.min(1, Number(merged.finalBgm.volume) || 0.55));
  return merged;
}

function getSettings() {
  return normalizeSettings(readJson(SETTINGS_PATH, {}));
}

function saveSettings(settings) {
  const merged = normalizeSettings(settings || {});
  if (!merged.playerAccess.token) merged.playerAccess.token = crypto.randomBytes(12).toString('hex');
  merged.updatedAt = new Date().toISOString();
  writeJsonAtomic(SETTINGS_PATH, merged);
  return merged;
}

function regeneratePlayerToken() {
  const settings = getSettings();
  settings.playerAccess.token = crypto.randomBytes(12).toString('hex');
  return saveSettings(settings);
}

function getAssets() {
  const assets = readJson(ASSETS_PATH, []);
  return Array.isArray(assets) ? assets : [];
}

function saveAssets(assets) {
  writeJsonAtomic(ASSETS_PATH, Array.isArray(assets) ? assets : []);
}

function addAsset(asset) {
  const assets = getAssets();
  assets.unshift(asset);
  saveAssets(assets);
  return asset;
}

function getAsset(assetId) {
  return getAssets().find((item) => item.id === assetId) || null;
}

function removeAsset(assetId) {
  const assets = getAssets();
  const asset = assets.find((item) => item.id === assetId);
  if (!asset) return null;
  const next = assets.filter((item) => item.id !== assetId);
  saveAssets(next);
  if (asset.diskPath && fs.existsSync(asset.diskPath)) {
    fs.unlinkSync(asset.diskPath);
  }
  return asset;
}

function readVersionSnapshots() {
  ensureDir(VERSION_DIR);
  return fs
    .readdirSync(VERSION_DIR)
    .filter((name) => /^questions-.*\.json$/.test(name))
    .map((name) => ({ id: path.basename(name, '.json'), data: readJson(path.join(VERSION_DIR, name), null) }))
    .filter((item) => item.data && Array.isArray(item.data.questions));
}

function createBackupBundle() {
  return {
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    draftQuestions: getDraftQuestions(),
    publishedQuestions: getPublishedQuestions(),
    settings: getSettings(),
    assets: getAssets(),
    adminAuth: readJson(AUTH_PATH, null),
    versions: readVersionSnapshots()
  };
}

function importBackupBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') throw new Error('備份格式不正確');
  if (Array.isArray(bundle.draftQuestions)) saveDraftQuestions(bundle.draftQuestions);
  if (Array.isArray(bundle.publishedQuestions)) {
    const normalized = normalizeQuestions(bundle.publishedQuestions);
    writeJsonAtomic(PUBLISHED_PATH, normalized);
    writeJsonAtomic(LEGACY_QUESTIONS_PATH, normalized);
  }
  if (bundle.settings) saveSettings(bundle.settings);
  if (Array.isArray(bundle.assets)) saveAssets(bundle.assets);
  if (bundle.adminAuth && bundle.adminAuth.initialized) writeJsonAtomic(AUTH_PATH, bundle.adminAuth);
  if (Array.isArray(bundle.versions)) {
    ensureDir(VERSION_DIR);
    for (const version of bundle.versions) {
      const safeId = String(version && version.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
      if (!safeId || !version.data || !Array.isArray(version.data.questions)) continue;
      writeJsonAtomic(path.join(VERSION_DIR, `${safeId}.json`), version.data);
    }
  }
  return createBackupBundle();
}

module.exports = {
  ROOT,
  DATA_DIR,
  VERSION_DIR,
  UPLOAD_DIR,
  DEFAULT_SETTINGS,
  initializeStore,
  normalizeQuestions,
  validateQuestionsForPublish,
  getDraftQuestions,
  saveDraftQuestions,
  getPublishedQuestions,
  publishDraftQuestions,
  listQuestionVersions,
  restoreQuestionVersion,
  getSettings,
  saveSettings,
  regeneratePlayerToken,
  getAssets,
  getAsset,
  addAsset,
  removeAsset,
  createBackupBundle,
  importBackupBundle
};
