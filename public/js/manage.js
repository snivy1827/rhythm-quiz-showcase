const socket = io();

let questions = [];
let assets = [];
let settings = null;
let selectedRulePageIndex = 0;
let rulesDirty = false;
let selectedEndPageIndex = 0;
let selectedEndElementId = null;
let endPagesDirty = false;
let endCanvasScale = 1;
let endCanvasResizeObserver = null;
let dashboard = null;
let versions = [];
let selectedIndex = -1;
let dirty = false;
let toastTimer = null;

const $ = (id) => document.getElementById(id);

const dom = {
  liveStatus: $('live-status'),
  toast: $('toast'),
  draftState: $('draft-state'),
  questionList: $('question-list'),
  questionCount: $('question-count'),
  questionForm: $('question-form'),
  questionEmpty: $('question-empty'),
  selectedQuestionTitle: $('selected-question-title'),
  assetList: $('asset-list'),
  uploadMessage: $('upload-message'),
  settingsMessage: $('settings-message'),
  backupMessage: $('backup-message'),
  versionList: $('version-list')
};

async function api(url, options = {}) {
  const response = await fetch(url, options);
  if (response.status === 401) {
    location.href = `/login.html?next=${encodeURIComponent(location.pathname)}`;
    throw new Error('登入已失效');
  }
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    throw new Error(payload && payload.error ? payload.error : String(payload || '操作失敗'));
  }
  return payload;
}

function showToast(message, isError = false) {
  dom.toast.textContent = message;
  dom.toast.classList.toggle('error', isError);
  dom.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => dom.toast.classList.remove('show'), 3500);
}

function markDirty() {
  dirty = true;
  dom.draftState.textContent = '尚未儲存';
  dom.draftState.style.color = 'var(--warning)';
}

function markSaved() {
  dirty = false;
  dom.draftState.textContent = '草稿已同步';
  dom.draftState.style.color = 'var(--success)';
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-TW', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  }).format(new Date(value));
}

function updateDashboard(data = dashboard) {
  if (!data) return;
  dashboard = data;
  $('metric-draft').textContent = data.draftCount ?? questions.length;
  $('metric-published').textContent = data.publishedCount ?? '—';
  $('metric-assets').textContent = data.assetCount ?? assets.length;
  $('metric-players').textContent = data.game?.connectedPlayers ?? 0;

  const game = data.game || {};
  $('game-status-badge').textContent = statusLabel(game.status);
  $('game-room').textContent = game.roomId || '—';
  $('storage-mode').textContent = data.storageMode === 'supabase' ? 'Supabase 共用雲端' : '本機檔案';
  $('game-question').textContent = game.currentQuestionIndex >= 0
    ? `第 ${game.currentQuestionIndex + 1} 題 / 共 ${game.questionCount || 0} 題`
    : `尚未載入 / 共 ${game.questionCount || 0} 題`;
  $('game-pending').textContent = game.pendingPublish ? '有，重置遊戲後套用' : '無';

  const teamWrap = $('dashboard-teams');
  teamWrap.innerHTML = '';
  const teams = game.teams || [];
  if (!teams.length) {
    teamWrap.textContent = '尚未建立隊伍';
  } else {
    teams.forEach((team) => {
      const row = document.createElement('div');
      row.className = 'team-row';
      row.innerHTML = `<strong>${escapeHtml(team.name)}</strong><span>${team.memberCount} 人連線・已捕捉 ${team.caughtCount} 隻</span>`;
      teamWrap.appendChild(row);
    });
  }
}

function statusLabel(status) {
  const labels = {
    LOBBY: '大廳準備中', INTRO: '題目介紹', RHYTHM_PLAYING: '節奏遊戲中',
    GUESSING: '猜歌搶答', MULTIPLE_CHOICE: '備援選擇題', PERFORMANCE: '完整題目／口琴演奏', ANSWER_REVEAL: '寶可夢揭曉與捕捉', SETTLEMENT: '最終結算', FINAL_RESULTS: '最終排名', END_PAGES: '活動結束頁'
  };
  return labels[status] || status || '未知';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function getSelectedQuestion() {
  return selectedIndex >= 0 ? questions[selectedIndex] : null;
}

function ensureQuestionShape(question, index) {
  question.id = Number(question.id) || index + 1;
  question.songName = question.songName || `第 ${index + 1} 題`;
  question.enabled = question.enabled !== false;
  question.referenceAudio = question.referenceAudio || '';
  question.referenceAudioOffsetMs = Number(question.referenceAudioOffsetMs) || 0;
  question.rhythmSource = question.rhythmSource === 'reference-audio-auto' ? 'reference-audio-auto' : 'chart';
  question.audioAuto = question.audioAuto || {};
  question.audioAuto.density = ['sparse', 'normal', 'dense'].includes(question.audioAuto.density) ? question.audioAuto.density : 'normal';
  question.audioAuto.generatedFrom = question.audioAuto.generatedFrom || '';
  question.audioAuto.generatedAt = question.audioAuto.generatedAt || '';
  question.audioAuto.durationMs = Math.max(0, Number(question.audioAuto.durationMs) || 0);
  question.audioAuto.seed = Number(question.audioAuto.seed) || 0;
  question.midiAsset = question.midiAsset || '';
  question.scoreAsset = question.scoreAsset || '';
  question.questionAsset = question.questionAsset || question.scoreAsset || question.midiAsset || question.referenceAudio || '';
  question.notes = Array.isArray(question.notes) ? question.notes : [];
  question.pokemon = question.pokemon || {};
  question.pokemon.name = question.pokemon.name || '未知寶可夢';
  question.pokemon.evolutionType = question.pokemon.evolutionType || 'three-stage-1';
  question.pokemon.customPoints = Math.max(0, Number(question.pokemon.customPoints) || 0);
  question.pokemon.image = question.pokemon.image || '';
  question.multipleChoice = question.multipleChoice || {};
  question.multipleChoice.options = Array.isArray(question.multipleChoice.options)
    ? question.multipleChoice.options.slice(0, 4)
    : ['', '', '', ''];
  while (question.multipleChoice.options.length < 4) question.multipleChoice.options.push('');
  question.multipleChoice.correctIndex = Math.min(3, Math.max(0, Number(question.multipleChoice.correctIndex) || 0));
  question.performance = question.performance || {};
  question.performance.sourceType = ['none', 'youtube', 'video', 'audio'].includes(question.performance.sourceType)
    ? question.performance.sourceType
    : 'none';
  question.performance.youtubeUrl = question.performance.youtubeUrl || '';
  question.performance.assetUrl = question.performance.assetUrl || '';
  question.performance.startSeconds = Number(question.performance.startSeconds) || 0;
  question.performance.endSeconds = Number(question.performance.endSeconds) || 0;
  question.performance.notes = question.performance.notes || '';
  return question;
}

function renderQuestionList() {
  dom.questionList.innerHTML = '';
  dom.questionCount.textContent = questions.length;
  questions.forEach((question, index) => {
    ensureQuestionShape(question, index);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `question-item ${index === selectedIndex ? 'active' : ''}`;
    button.innerHTML = `
      <span class="question-index">${index + 1}</span>
      <span class="question-name"><strong>${escapeHtml(question.songName)}</strong><span>${escapeHtml(question.pokemon.name)}</span></span>
      <span class="question-off">${question.enabled ? '' : '停用'}</span>
    `;
    button.addEventListener('click', () => {
      selectedIndex = index;
      renderQuestionList();
      renderQuestionForm();
    });
    dom.questionList.appendChild(button);
  });
}

function assetExtension(asset) {
  const value = String(asset?.originalName || asset?.url || '').toLowerCase();
  const match = value.match(/(\.[a-z0-9]+)(?:[?#].*)?$/);
  return match ? match[1] : '';
}

function assetKind(asset) {
  const ext = assetExtension(asset);
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) return 'image';
  if (['.musicxml', '.xml'].includes(ext)) return 'score';
  if (['.mid', '.midi'].includes(ext)) return 'midi';
  if (['.mp3', '.wav', '.ogg', '.m4a'].includes(ext)) return 'audio';
  if (['.mp4', '.webm', '.mov', '.m4v'].includes(ext)) return 'video';
  if (String(asset?.mimeType || '').startsWith('audio/')) return 'audio';
  if (String(asset?.mimeType || '').startsWith('video/')) return 'video';
  if (String(asset?.mimeType || '').startsWith('image/')) return 'image';
  return 'other';
}

function assetLogicalCategory(asset) {
  const category = String(asset?.category || '');
  if (['pokemon', 'question', 'performance', 'note'].includes(category)) return category;
  if (category === 'score' || category === 'midi') return 'question';
  if (category === 'video') return 'performance';
  if (category === 'audio') {
    const usedAsPerformance = questions.some((q) => q?.performance?.assetUrl === asset.url);
    const usedAsQuestion = questions.some((q) => q?.referenceAudio === asset.url || q?.scoreAsset === asset.url || q?.midiAsset === asset.url || q?.questionAsset === asset.url);
    return usedAsPerformance && !usedAsQuestion ? 'performance' : 'question';
  }
  return category;
}

function assetTypeLabel(asset) {
  const kind = assetKind(asset);
  return kind === 'score' ? 'MusicXML' : kind === 'midi' ? 'MIDI' : kind === 'audio' ? '音檔' : kind === 'video' ? '影片' : kind === 'image' ? '圖片' : '檔案';
}

function assetMatchesLogical(asset, logicalCategory) {
  if (logicalCategory === 'question') {
    return asset.category === 'question' || ['score', 'midi', 'audio'].includes(asset.category);
  }
  if (logicalCategory === 'performance') {
    return asset.category === 'performance' || ['video', 'audio'].includes(asset.category);
  }
  return assetLogicalCategory(asset) === logicalCategory;
}

function optionList(category, selectedValue, emptyLabel, kindFilter = null) {
  const matching = assets.filter((asset) => {
    const categoryOk = assetMatchesLogical(asset, category);
    const kindOk = !kindFilter || assetKind(asset) === kindFilter;
    return categoryOk && kindOk;
  });
  return [
    `<option value="">${emptyLabel}</option>`,
    ...matching.map((asset) => `<option value="${escapeHtml(asset.url)}" ${asset.url === selectedValue ? 'selected' : ''}>[${assetTypeLabel(asset)}] ${escapeHtml(asset.originalName)}</option>`)
  ].join('');
}

function findAssetByUrl(url) {
  return assets.find((asset) => asset.url === url) || null;
}


function renderQuestionForm() {
  const q = getSelectedQuestion();
  if (!q) {
    dom.questionEmpty.hidden = false;
    dom.questionForm.hidden = true;
    return;
  }
  ensureQuestionShape(q, selectedIndex);
  dom.questionEmpty.hidden = true;
  dom.questionForm.hidden = false;
  dom.selectedQuestionTitle.textContent = `第 ${selectedIndex + 1} 題設定`;

  $('q-enabled').checked = q.enabled;
  $('q-song-name').value = q.songName;
  $('q-pokemon-name').value = q.pokemon.name;
  $('q-evolution-type').value = q.pokemon.evolutionType;
  $('q-custom-points').value = q.pokemon.customPoints || 0;
  $('q-custom-points-field').hidden = q.pokemon.evolutionType !== 'custom';
  $('q-audio-offset').value = q.referenceAudioOffsetMs;
  $('q-audio-auto-density').value = q.audioAuto.density;
  $('q-note-count').textContent = q.notes.length;
  $('q-pokemon-image').innerHTML = optionList('pokemon', q.pokemon.image, '尚未指定（正式題目前請補上）');
  const selectedQuestionAsset = q.questionAsset || q.scoreAsset || q.midiAsset || q.referenceAudio || '';
  $('q-question-asset').innerHTML = optionList('question', selectedQuestionAsset, '未指定題目素材');
  const selectedAsset = findAssetByUrl(selectedQuestionAsset);
  const selectedKind = selectedAsset ? assetKind(selectedAsset) : (q.scoreAsset ? 'score' : q.midiAsset ? 'midi' : q.referenceAudio ? 'audio' : 'other');
  $('q-audio-offset-field').hidden = selectedKind !== 'audio';
  $('q-audio-auto-density-field').hidden = selectedKind !== 'audio';
  const autoStatus = $('q-audio-auto-status');
  if (autoStatus) {
    autoStatus.textContent = selectedKind === 'audio'
      ? (q.notes.length ? `目前 ${q.notes.length} 個自動箭頭；音檔長度約 ${(q.audioAuto.durationMs / 1000).toFixed(1)} 秒。這是聲音起點分析，不是精準音高轉譜。` : '尚未產生箭頭；選擇音檔後系統會自動分析，也可手動重新分析。')
      : 'WAV／MP3 只做節奏／聲音起點分析，不會假裝能準確還原原曲音高。';
  }
  const assetStatus = $('q-question-asset-status');
  if (assetStatus) {
    if (!selectedQuestionAsset) assetStatus.textContent = '尚未選擇題目素材';
    else if (selectedKind === 'score') assetStatus.textContent = `MusicXML：${q.notes.length} 個音符。選擇後會自動匯入第一個可用聲部；需要改聲部或細修時再開譜面編輯器。`;
    else if (selectedKind === 'midi') assetStatus.textContent = `MIDI：${q.notes.length} 個音符。遊戲中的譜面外觀與 MusicXML 相同，差別主要在來源資料格式。`;
    else if (selectedKind === 'audio') assetStatus.textContent = `音檔自動節奏：${q.notes.length} 個箭頭。只依聲音起點估算，不保證等於原曲實際音符數。`;
    else assetStatus.textContent = `已選擇：${selectedAsset?.originalName || selectedQuestionAsset}`;
  }
  q.multipleChoice.options.forEach((option, index) => { $(`q-choice-${index}`).value = option; });
  $('q-choice-correct').value = String(q.multipleChoice.correctIndex);
  $('q-performance-type').value = q.performance.sourceType;
  $('q-performance-youtube').value = q.performance.youtubeUrl;
  $('q-performance-start').value = q.performance.startSeconds;
  $('q-performance-end').value = q.performance.endSeconds;
  $('q-performance-notes').value = q.performance.notes;
  $('q-performance-asset').innerHTML = optionList('performance', q.performance.assetUrl, '未指定演奏素材');
  updatePerformanceFields();
  updateQuestionPreviews();
}

function trimTransparentPaddingForQuestionPreview(img) {
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
    if (cropWidth >= naturalWidth * 0.92 && cropHeight >= naturalHeight * 0.92) return;
    const cropped = document.createElement('canvas');
    cropped.width = cropWidth;
    cropped.height = cropHeight;
    cropped.getContext('2d').drawImage(canvas, left, top, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
    img.src = cropped.toDataURL('image/png');
  } catch (_) {
    // 外部或 CORS 圖片保留原圖；同源 uploads 圖片可正常裁掉透明邊界。
  }
}

function updateQuestionPreviews() {
  const q = getSelectedQuestion();
  if (!q) return;
  const imageWrap = $('pokemon-preview');
  imageWrap.innerHTML = '';
  if (q.pokemon.image) {
    const img = document.createElement('img');
    img.className = 'question-pokemon-preview-image';
    img.src = q.pokemon.image;
    img.alt = q.pokemon.name;
    img.addEventListener('load', () => trimTransparentPaddingForQuestionPreview(img), { once: true });
    img.addEventListener('error', () => { imageWrap.textContent = '圖片無法載入'; });
    imageWrap.appendChild(img);
  } else {
    imageWrap.textContent = '尚未指定寶可夢圖片；節奏與猜歌階段不會顯示剪影。';
  }

  const audio = $('audio-preview');
  if (q.referenceAudio) {
    audio.src = q.referenceAudio;
    audio.hidden = false;
  } else {
    audio.removeAttribute('src');
    audio.load();
    audio.hidden = true;
  }
}

function updatePerformanceFields() {
  const q = getSelectedQuestion();
  if (!q) return;
  const type = $('q-performance-type').value;
  $('performance-youtube-field').hidden = type !== 'youtube';
  $('performance-asset-field').hidden = !['video', 'audio'].includes(type);
  if (['video', 'audio'].includes(type)) {
    $('q-performance-asset').innerHTML = optionList('performance', q.performance.assetUrl, '未指定演奏素材');
  }
}

function bindQuestionFields() {
  const mappings = [
    ['q-enabled', 'change', (q, el) => { q.enabled = el.checked; }],
    ['q-song-name', 'input', (q, el) => { q.songName = el.value; }],
    ['q-pokemon-name', 'input', (q, el) => { q.pokemon.name = el.value; }],
    ['q-evolution-type', 'change', (q, el) => { q.pokemon.evolutionType = el.value; $('q-custom-points-field').hidden = el.value !== 'custom'; }],
    ['q-custom-points', 'input', (q, el) => { q.pokemon.customPoints = Math.max(0, Number(el.value) || 0); }],
    ['q-pokemon-image', 'change', (q, el) => { q.pokemon.image = el.value || ''; updateQuestionPreviews(); }],
    ['q-audio-offset', 'input', (q, el) => { q.referenceAudioOffsetMs = Number(el.value) || 0; }],
    ['q-audio-auto-density', 'change', (q, el) => { q.audioAuto.density = el.value; }],
    ['q-choice-0', 'input', (q, el) => { q.multipleChoice.options[0] = el.value; }],
    ['q-choice-1', 'input', (q, el) => { q.multipleChoice.options[1] = el.value; }],
    ['q-choice-2', 'input', (q, el) => { q.multipleChoice.options[2] = el.value; }],
    ['q-choice-3', 'input', (q, el) => { q.multipleChoice.options[3] = el.value; }],
    ['q-choice-correct', 'change', (q, el) => { q.multipleChoice.correctIndex = Number(el.value) || 0; }],
    ['q-performance-type', 'change', (q, el) => {
      q.performance.sourceType = el.value;
      q.performance.assetUrl = '';
      updatePerformanceFields();
    }],
    ['q-performance-youtube', 'input', (q, el) => { q.performance.youtubeUrl = el.value; }],
    ['q-performance-asset', 'change', (q, el) => { q.performance.assetUrl = el.value; const a = findAssetByUrl(el.value); const kind = a ? assetKind(a) : ''; if (kind === 'video') q.performance.sourceType = 'video'; else if (kind === 'audio') q.performance.sourceType = 'audio'; updatePerformanceFields(); }],
    ['q-performance-start', 'input', (q, el) => { q.performance.startSeconds = Number(el.value) || 0; }],
    ['q-performance-end', 'input', (q, el) => { q.performance.endSeconds = Number(el.value) || 0; }],
    ['q-performance-notes', 'input', (q, el) => { q.performance.notes = el.value; }]
  ];
  mappings.forEach(([id, eventName, updater]) => {
    $(id).addEventListener(eventName, (event) => {
      const q = getSelectedQuestion();
      if (!q) return;
      updater(q, event.currentTarget);
      markDirty();
      renderQuestionList();
    });
  });

  $('q-question-asset').addEventListener('change', async (event) => {
    const q = getSelectedQuestion();
    if (!q) return;
    try {
      await applyQuestionAsset(q, event.currentTarget.value || '');
      markDirty();
      renderQuestionList();
      renderQuestionForm();
    } catch (error) {
      showToast(error.message, true);
      renderQuestionForm();
    }
  });
}


const MANAGE_PITCH_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
function manageMidiNoteToPitch(midiNote) {
  const value = Math.max(0, Math.min(127, Math.round(Number(midiNote) || 0)));
  return `${MANAGE_PITCH_NAMES[value % 12]}${Math.floor(value / 12) - 1}`;
}
function manageAssignDirection(midiNote, index, pitchMin, pitchMax) {
  const dirs = ['left', 'down', 'up', 'right'];
  const range = pitchMax - pitchMin || 1;
  const normalized = (midiNote - pitchMin) / range;
  if (normalized < 0.25) return dirs[0];
  if (normalized < 0.5) return dirs[1];
  if (normalized < 0.75) return dirs[2];
  return dirs[3];
}
class ManageMidiReader {
  constructor(buffer) { this.view = new DataView(buffer); this.offset = 0; }
  readUint8() { return this.view.getUint8(this.offset++); }
  readUint16() { const v = this.view.getUint16(this.offset, false); this.offset += 2; return v; }
  readUint32() { const v = this.view.getUint32(this.offset, false); this.offset += 4; return v; }
  readBytes(n) { const a = []; for (let i = 0; i < n; i++) a.push(this.readUint8()); return a; }
  readVarLen() { let val = 0, b; do { b = this.readUint8(); val = (val << 7) | (b & 0x7F); } while (b & 0x80); return val; }
  readString(n) { return String.fromCharCode(...this.readBytes(n)); }
  skip(n) { this.offset += n; }
  peek() { return this.view.getUint8(this.offset); }
}
function parseManageMidi(buffer) {
  const r = new ManageMidiReader(buffer);
  if (r.view.byteLength < 14 || r.readString(4) !== 'MThd') throw new Error('不是有效的 MIDI 檔案');
  const headerLen = r.readUint32();
  const format = r.readUint16();
  const numTracks = r.readUint16();
  const timeDivision = r.readUint16();
  if (timeDivision & 0x8000) throw new Error('目前不支援 SMPTE time division；請改用 MusicXML。');
  if (headerLen > 6) r.skip(headerLen - 6);
  const tracks = [];
  const trackNames = [];
  for (let t = 0; t < numTracks; t++) {
    if (r.offset + 8 > r.view.byteLength) break;
    if (r.readString(4) !== 'MTrk') { const skipLen = r.readUint32(); r.skip(skipLen); continue; }
    const chunkLen = r.readUint32();
    const chunkEnd = Math.min(r.offset + chunkLen, r.view.byteLength);
    const events = [];
    let tick = 0, lastStatus = 0, trackName = `Track ${t + 1}`;
    try {
      while (r.offset < chunkEnd) {
        tick += r.readVarLen();
        let status = r.peek();
        if (status & 0x80) { status = r.readUint8(); if (status < 0xF0) lastStatus = status; } else status = lastStatus;
        if (!status) throw new Error('無有效 running status');
        const type = status & 0xF0;
        const channel = status & 0x0F;
        if (type === 0x80 || type === 0x90) {
          const note = r.readUint8(); const velocity = r.readUint8();
          events.push({ tick, type: type === 0x90 && velocity > 0 ? 'noteOn' : 'noteOff', note, channel, velocity });
        } else if (type === 0xA0 || type === 0xB0 || type === 0xE0) r.skip(2);
        else if (type === 0xC0 || type === 0xD0) r.skip(1);
        else if (status === 0xF0 || status === 0xF7) r.skip(r.readVarLen());
        else if (status === 0xFF) {
          const metaType = r.readUint8(); const metaLen = r.readVarLen();
          if (metaType === 0x51 && metaLen === 3) {
            const tempo = (r.readUint8() << 16) | (r.readUint8() << 8) | r.readUint8();
            events.push({ tick, type: 'tempo', tempo });
          } else if (metaType === 0x03) {
            const bytes = r.readBytes(metaLen); try { trackName = new TextDecoder('utf-8').decode(new Uint8Array(bytes)) || trackName; } catch (_) {}
          } else r.skip(metaLen);
        } else throw new Error(`未知 MIDI 狀態 0x${status.toString(16)}`);
      }
    } catch (error) { console.warn(`MIDI track ${t + 1} parsing stopped`, error); }
    r.offset = chunkEnd;
    tracks.push(events); trackNames.push(trackName);
  }
  return { format, timeDivision, tracks, trackNames, sourceType: 'midi' };
}
function manageMusicXmlPitchToMidi(noteElement) {
  const pitch = noteElement.querySelector(':scope > pitch');
  if (!pitch) return null;
  const step = pitch.querySelector(':scope > step')?.textContent?.trim();
  const octave = Number(pitch.querySelector(':scope > octave')?.textContent);
  const alter = Number(pitch.querySelector(':scope > alter')?.textContent || 0);
  const semitones = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  if (!(step in semitones) || !Number.isFinite(octave)) return null;
  return Math.max(0, Math.min(127, (octave + 1) * 12 + semitones[step] + alter));
}
function parseManageMusicXml(xmlText) {
  const xml = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('MusicXML 解析失敗；請使用未壓縮 .musicxml／.xml。');
  const scoreRoot = xml.querySelector('score-partwise, score-timewise');
  if (!scoreRoot || scoreRoot.tagName === 'score-timewise') throw new Error('目前僅支援 score-partwise MusicXML。');
  const PPQ = 480;
  const partNames = new Map();
  xml.querySelectorAll('part-list > score-part').forEach((part) => {
    const id = part.getAttribute('id'); const name = part.querySelector('part-name')?.textContent?.trim() || id || '聲部'; if (id) partNames.set(id, name);
  });
  const tracks = [], trackNames = []; let globalTempoEvents = [];
  [...xml.querySelectorAll('score-partwise > part')].forEach((part, partIndex) => {
    const events = []; let absoluteTick = 0, divisions = 1, lastNoteStart = 0; const openTies = new Map();
    [...part.querySelectorAll(':scope > measure')].forEach((measure) => {
      let cursor = absoluteTick, measureMax = absoluteTick;
      for (const node of [...measure.children]) {
        const tag = node.tagName;
        if (tag === 'attributes') {
          const d = Number(node.querySelector(':scope > divisions')?.textContent); if (Number.isFinite(d) && d > 0) divisions = d;
        } else if (tag === 'direction') {
          const soundTempo = Number(node.querySelector('sound[tempo]')?.getAttribute('tempo'));
          const metronomeTempo = Number(node.querySelector('metronome > per-minute')?.textContent);
          const tempo = Number.isFinite(soundTempo) && soundTempo > 0 ? soundTempo : metronomeTempo;
          if (Number.isFinite(tempo) && tempo > 0) { const ev = { tick: Math.round(cursor), type: 'tempo', tempo: Math.round(60000000 / tempo) }; events.push(ev); if (partIndex === 0) globalTempoEvents.push(ev); }
        } else if (tag === 'backup' || tag === 'forward') {
          const duration = Number(node.querySelector(':scope > duration')?.textContent || 0); const delta = (duration / divisions) * PPQ; cursor += tag === 'backup' ? -delta : delta; cursor = Math.max(absoluteTick, cursor);
        } else if (tag === 'note') {
          const durationUnits = Number(node.querySelector(':scope > duration')?.textContent || 0);
          const durationTicks = Math.max(0, (durationUnits / divisions) * PPQ);
          const isChord = Boolean(node.querySelector(':scope > chord')); const isGrace = Boolean(node.querySelector(':scope > grace')); const isRest = Boolean(node.querySelector(':scope > rest'));
          const startTick = isChord ? lastNoteStart : cursor;
          if (!isRest) {
            const midiNote = manageMusicXmlPitchToMidi(node);
            if (midiNote !== null) {
              const effectiveDuration = isGrace ? Math.max(30, PPQ / 8) : Math.max(1, durationTicks);
              const voice = node.querySelector(':scope > voice')?.textContent?.trim() || '1';
              const tieTypes = [...node.querySelectorAll(':scope > tie')].map((tie) => tie.getAttribute('type'));
              const tieStart = tieTypes.includes('start'), tieStop = tieTypes.includes('stop'), tieKey = `${voice}:${midiNote}`;
              const continuingTie = tieStop && openTies.has(tieKey);
              if (!continuingTie) events.push({ tick: Math.round(startTick), type: 'noteOn', note: midiNote, channel: 0, velocity: 100 });
              if (tieStart) openTies.set(tieKey, true); else { events.push({ tick: Math.round(startTick + effectiveDuration), type: 'noteOff', note: midiNote, channel: 0, velocity: 0 }); openTies.delete(tieKey); }
            }
          }
          lastNoteStart = startTick; if (!isChord && !isGrace) cursor += durationTicks; measureMax = Math.max(measureMax, cursor, startTick + durationTicks);
        }
      }
      absoluteTick = Math.max(absoluteTick, measureMax);
    });
    events.sort((a, b) => a.tick - b.tick || (a.type === 'noteOff' ? 1 : -1));
    tracks.push(events); trackNames.push(partNames.get(part.getAttribute('id')) || `聲部 ${partIndex + 1}`);
  });
  if (!tracks.length) throw new Error('MusicXML 中找不到聲部。');
  if (!globalTempoEvents.length) globalTempoEvents = [{ tick: 0, type: 'tempo', tempo: 500000 }];
  tracks[0] = [...globalTempoEvents, ...tracks[0]].sort((a, b) => a.tick - b.tick);
  return { format: 'musicxml', timeDivision: PPQ, tracks, trackNames, sourceType: 'musicxml' };
}
function convertManageNotationToNotes(midiData, trackIndex) {
  const { timeDivision, tracks } = midiData;
  const tempoByTick = new Map([[0, 500000]]);
  tracks.forEach((track) => track.forEach((event) => { if (event.type === 'tempo' && Number.isFinite(event.tempo)) tempoByTick.set(event.tick, event.tempo); }));
  const tempoMap = [...tempoByTick.entries()].map(([tick, tempo]) => ({ tick: Number(tick), tempo })).sort((a, b) => a.tick - b.tick);
  function ticksToMs(targetTick) {
    let ms = 0, prevTick = 0, curTempo = 500000;
    for (const seg of tempoMap) { if (seg.tick > targetTick) break; if (seg.tick > prevTick) { ms += ((seg.tick - prevTick) / timeDivision) * (curTempo / 1000); prevTick = seg.tick; } curTempo = seg.tempo; }
    if (targetTick > prevTick) ms += ((targetTick - prevTick) / timeDivision) * (curTempo / 1000); return ms;
  }
  const track = tracks[trackIndex] || [];
  const pending = new Map(), raw = [];
  track.forEach((event) => {
    const key = `${event.channel ?? 0}:${event.note}`;
    if (event.type === 'noteOn') { if (!pending.has(key)) pending.set(key, []); pending.get(key).push(event.tick); }
    else if (event.type === 'noteOff') {
      const queue = pending.get(key); if (!queue?.length) return; const startTick = queue.shift();
      raw.push({ timeMs: Math.max(0, Math.round(ticksToMs(startTick))), midiNote: event.note, durationMs: Math.max(0, Math.round(ticksToMs(event.tick) - ticksToMs(startTick))) });
    }
  });
  raw.sort((a, b) => a.timeMs - b.timeMs || a.midiNote - b.midiNote);
  if (!raw.length) return [];
  const pitchMin = Math.min(...raw.map((n) => n.midiNote)), pitchMax = Math.max(...raw.map((n) => n.midiNote));
  const lastSamePitch = new Map(); const kept = [];
  raw.forEach((note) => { const prev = lastSamePitch.get(note.midiNote); if (Number.isFinite(prev) && note.timeMs - prev <= 10) return; lastSamePitch.set(note.midiNote, note.timeMs); kept.push(note); });
  return kept.map((note, index) => ({
    time: note.timeMs,
    direction: manageAssignDirection(note.midiNote, index, pitchMin, pitchMax),
    pitch: manageMidiNoteToPitch(note.midiNote),
    midiNote: note.midiNote,
    duration: note.durationMs >= 300 ? note.durationMs : 0
  }));
}
async function importNotationAssetToQuestion(q, asset, kind) {
  const response = await fetch(asset.url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`讀取題目素材失敗（HTTP ${response.status}）`);
  let parsed;
  if (kind === 'score') parsed = parseManageMusicXml(await response.text());
  else parsed = parseManageMidi(await response.arrayBuffer());
  const trackCounts = parsed.tracks.map((track, index) => ({ index, count: track.filter((event) => event.type === 'noteOn').length }));
  const chosen = trackCounts.find((item) => item.count > 0);
  if (!chosen) throw new Error(`${kind === 'score' ? 'MusicXML' : 'MIDI'} 中沒有可用音符`);
  const notes = convertManageNotationToNotes(parsed, chosen.index);
  if (!notes.length) throw new Error('無法從此譜面建立遊戲音符');
  q.notes = notes;
  q.rhythmSource = 'chart';
  q.audioAuto = { density: q.audioAuto?.density || 'normal', generatedFrom: '', generatedAt: '', durationMs: 0, seed: 0 };
  q.notationAuto = { source: asset.url, sourceType: kind, trackIndex: chosen.index, trackName: parsed.trackNames?.[chosen.index] || `Track ${chosen.index + 1}`, generatedAt: new Date().toISOString() };
  showToast(`已自動匯入 ${notes.length} 個音符（${q.notationAuto.trackName}）。需要改聲部或細修時再開譜面編輯器。`);
}
async function applyQuestionAsset(q, url) {
  q.questionAsset = url || '';
  q.referenceAudio = '';
  q.scoreAsset = '';
  q.midiAsset = '';
  q.notationAuto = q.notationAuto || {};
  if (!url) { q.notes = []; q.rhythmSource = 'chart'; updateQuestionPreviews(); return; }
  const asset = findAssetByUrl(url);
  if (!asset) throw new Error('找不到選定的題目素材');
  const kind = assetKind(asset);
  if (kind === 'audio') {
    q.referenceAudio = url;
    q.rhythmSource = 'reference-audio-auto';
    q.notes = [];
    updateQuestionPreviews();
    renderQuestionForm();
    await generateAudioChartForSelectedQuestion();
    return;
  }
  if (kind === 'score') {
    q.scoreAsset = url;
    q.rhythmSource = 'chart'; q.referenceAudio = '';
    await importNotationAssetToQuestion(q, asset, kind);
    updateQuestionPreviews(); return;
  }
  if (kind === 'midi') {
    q.midiAsset = url;
    q.rhythmSource = 'chart'; q.referenceAudio = '';
    await importNotationAssetToQuestion(q, asset, kind);
    updateQuestionPreviews(); return;
  }
  throw new Error('題目素材只支援 MusicXML、MIDI、WAV、MP3、OGG、M4A。');
}


function stringSeed(value) {
  let h = 2166136261 >>> 0;
  for (const ch of String(value || '')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function seededRandom(seed) {
  let x = (Number(seed) >>> 0) || 0x6d2b79f5;
  return () => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

async function decodeReferenceAudio(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`讀取音檔失敗（HTTP ${response.status}）`);
  const raw = await response.arrayBuffer();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) throw new Error('此瀏覽器不支援音檔解析');
  const ctx = new AudioCtx();
  try {
    return await ctx.decodeAudioData(raw.slice(0));
  } finally {
    try { await ctx.close(); } catch (_) {}
  }
}

function autoChartFromAudioBuffer(buffer, options = {}) {
  const density = ['sparse', 'normal', 'dense'].includes(options.density) ? options.density : 'normal';
  const minGapMs = density === 'sparse' ? 460 : density === 'dense' ? 220 : 320;
  const hopMs = 10;
  const hop = Math.max(1, Math.round(buffer.sampleRate * hopMs / 1000));
  const windowSamples = Math.max(hop, Math.round(buffer.sampleRate * 0.025));
  const frameCount = Math.ceil(buffer.length / hop);
  const energy = new Float32Array(frameCount);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));

  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * hop;
    const end = Math.min(buffer.length, start + windowSamples);
    let sum = 0;
    let count = 0;
    for (let sample = start; sample < end; sample += 2) {
      let mono = 0;
      for (const channel of channels) mono += channel[sample] || 0;
      mono /= Math.max(1, channels.length);
      sum += mono * mono;
      count += 1;
    }
    energy[frame] = count ? Math.sqrt(sum / count) : 0;
  }

  const sortedEnergy = Array.from(energy).sort((a, b) => a - b);
  const percentile = (p) => sortedEnergy[Math.min(sortedEnergy.length - 1, Math.max(0, Math.floor(sortedEnergy.length * p)))] || 0;
  const noiseFloor = percentile(0.35);
  const loudRef = Math.max(percentile(0.90), noiseFloor + 0.0001);
  const onsetScores = new Float32Array(frameCount);
  for (let i = 1; i < frameCount; i += 1) {
    let prev = 0;
    const n = Math.min(8, i);
    for (let j = i - n; j < i; j += 1) prev += energy[j];
    prev /= Math.max(1, n);
    onsetScores[i] = Math.max(0, energy[i] - prev) * (0.6 + Math.min(1.5, energy[i] / loudRef));
  }
  const scoreList = Array.from(onsetScores).sort((a, b) => a - b);
  const thresholdQ = density === 'sparse' ? 0.88 : density === 'dense' ? 0.72 : 0.80;
  const scoreThreshold = Math.max(scoreList[Math.floor(scoreList.length * thresholdQ)] || 0, loudRef * 0.025);
  const startOffsetMs = Math.max(0, Number(options.offsetMs) || 0);
  const candidates = [];
  for (let i = 2; i < frameCount - 2; i += 1) {
    const tMs = i * hopMs;
    if (tMs < startOffsetMs) continue;
    if (energy[i] < Math.max(noiseFloor * 1.5, loudRef * 0.10)) continue;
    const score = onsetScores[i];
    if (score < scoreThreshold) continue;
    if (score < onsetScores[i - 1] || score < onsetScores[i + 1]) continue;
    candidates.push({ tMs, score });
  }

  const selected = [];
  let last = -1e9;
  for (const c of candidates) {
    if (c.tMs - last < minGapMs) {
      if (selected.length && c.score > selected[selected.length - 1].score * 1.25) {
        selected[selected.length - 1] = c;
        last = c.tMs;
      }
      continue;
    }
    selected.push(c);
    last = c.tMs;
  }

  // Continuous / soft audio can have few sharp onsets. Fill long gaps using the
  // loudest frame in each spacing window so the game never becomes an empty screen.
  const usableDurationMs = Math.max(0, buffer.duration * 1000 - startOffsetMs);
  const targetFloor = Math.max(4, Math.floor(usableDurationMs / (density === 'sparse' ? 1300 : density === 'dense' ? 700 : 950)));
  if (selected.length < targetFloor) {
    const blockMs = density === 'sparse' ? 900 : density === 'dense' ? 480 : 650;
    for (let blockStart = startOffsetMs + 250; blockStart < buffer.duration * 1000 - 150; blockStart += blockMs) {
      const from = Math.floor(blockStart / hopMs);
      const to = Math.min(frameCount, Math.floor((blockStart + blockMs) / hopMs));
      let best = from;
      for (let i = from + 1; i < to; i += 1) if (energy[i] > energy[best]) best = i;
      if (energy[best] < Math.max(noiseFloor * 1.25, loudRef * 0.06)) continue;
      const tMs = best * hopMs;
      if (selected.some((c) => Math.abs(c.tMs - tMs) < minGapMs * 0.75)) continue;
      selected.push({ tMs, score: onsetScores[best] || energy[best] });
    }
    selected.sort((a, b) => a.tMs - b.tMs);
  }

  const seed = Number(options.seed) || stringSeed(options.seedText || 'audio-chart');
  const rand = seededRandom(seed);
  const dirs = ['left', 'down', 'up', 'right'];
  let lastDir = '';
  let repeat = 0;
  const notes = selected.map((c) => {
    let direction = dirs[Math.floor(rand() * dirs.length) % dirs.length];
    if (direction === lastDir && repeat >= 1) {
      const alternatives = dirs.filter((d) => d !== lastDir);
      direction = alternatives[Math.floor(rand() * alternatives.length) % alternatives.length];
    }
    repeat = direction === lastDir ? repeat + 1 : 0;
    lastDir = direction;
    return {
      time: Math.max(0, Math.round(c.tMs - startOffsetMs)),
      direction,
      pitch: 'C4',
      midiNote: 60,
      duration: 0
    };
  });
  return { notes, seed, durationMs: Math.round(buffer.duration * 1000) };
}

async function generateAudioChartForSelectedQuestion() {
  const q = getSelectedQuestion();
  if (!q) return;
  if (!q.referenceAudio) throw new Error('請先選擇 WAV／MP3 參考題目音檔。');
  const button = $('q-generate-audio-chart');
  const status = $('q-audio-auto-status');
  const oldText = button?.textContent || '';
  if (button) { button.disabled = true; button.textContent = '正在分析音檔…'; }
  if (status) status.textContent = '正在偵測聲音起點並產生箭頭，請稍候…';
  try {
    const buffer = await decodeReferenceAudio(q.referenceAudio);
    const seedText = `${q.id}|${q.songName}|${q.referenceAudio}`;
    const result = autoChartFromAudioBuffer(buffer, {
      density: q.audioAuto.density,
      offsetMs: q.referenceAudioOffsetMs,
      seedText
    });
    if (!result.notes.length) throw new Error('這個音檔沒有偵測到足夠聲音，請確認音檔內容或將密度改為「較多」。');
    q.notes = result.notes;
    q.rhythmSource = 'reference-audio-auto';
    q.audioAuto.generatedFrom = q.referenceAudio;
    q.audioAuto.generatedAt = new Date().toISOString();
    q.audioAuto.durationMs = result.durationMs;
    q.audioAuto.seed = result.seed;
    markDirty();
    renderQuestionList();
    renderQuestionForm();
    showToast(`已從音檔產生 ${result.notes.length} 個箭頭。正式遊戲會播放原 WAV／MP3，不會播放假的 C4 音。`);
  } finally {
    if (button) { button.disabled = false; button.textContent = oldText || '從目前音檔產生／重產箭頭'; }
  }
}

async function saveDraft(showMessage = true) {
  questions.forEach(ensureQuestionShape);
  const result = await api('/api/admin/questions/draft', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(questions)
  });
  questions = result.questions;
  if (selectedIndex >= questions.length) selectedIndex = questions.length - 1;
  markSaved();
  renderQuestionList();
  renderQuestionForm();
  if (showMessage) showToast('草稿已儲存。');
}

async function publishQuestions() {
  if (dirty) await saveDraft(false);
  if (!confirm('要把目前草稿發布成正式活動題庫嗎？')) return;
  const result = await api('/api/admin/questions/publish', { method: 'POST' });
  showToast(result.appliedImmediately
    ? '正式題庫已發布並立即套用。'
    : '正式題庫已發布；目前遊戲進行中，會在重置後套用。');
  await loadDashboard();
  await loadVersions();
}

function addQuestion() {
  const nextId = questions.reduce((max, q) => Math.max(max, Number(q.id) || 0), 0) + 1;
  questions.push({
    id: nextId,
    songName: '新題目',
    enabled: true,
    pokemon: { name: '未知寶可夢', evolutionType: 'three-stage-1', customPoints: 0, image: '' },
    referenceAudio: '',
    referenceAudioOffsetMs: 0,
    rhythmSource: 'chart',
    audioAuto: { density: 'normal', generatedFrom: '', generatedAt: '', durationMs: 0, seed: 0 },
    midiAsset: '',
    scoreAsset: '',
    questionAsset: '',
    multipleChoice: { options: ['', '', '', ''], correctIndex: 0 },
    performance: { sourceType: 'none', youtubeUrl: '', assetUrl: '', startSeconds: 0, endSeconds: 0, notes: '' },
    notes: []
  });
  selectedIndex = questions.length - 1;
  markDirty();
  renderQuestionList();
  renderQuestionForm();
}

function duplicateQuestion() {
  const q = getSelectedQuestion();
  if (!q) return;
  const copy = clone(q);
  copy.id = questions.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
  copy.songName = `${copy.songName}（副本）`;
  questions.splice(selectedIndex + 1, 0, copy);
  selectedIndex += 1;
  markDirty();
  renderQuestionList();
  renderQuestionForm();
}

function deleteQuestion() {
  const q = getSelectedQuestion();
  if (!q || !confirm(`確定刪除「${q.songName}」嗎？`)) return;
  questions.splice(selectedIndex, 1);
  selectedIndex = Math.min(selectedIndex, questions.length - 1);
  markDirty();
  renderQuestionList();
  renderQuestionForm();
}

function moveQuestion(delta) {
  const target = selectedIndex + delta;
  if (selectedIndex < 0 || target < 0 || target >= questions.length) return;
  [questions[selectedIndex], questions[target]] = [questions[target], questions[selectedIndex]];
  selectedIndex = target;
  markDirty();
  renderQuestionList();
  renderQuestionForm();
}

function renderNoteLibrary() {
  const noteAssets = assets
    .filter((asset) => asset.category === 'note' && asset.pitch)
    .sort((a, b) => (Number(a.midiNote) || 999) - (Number(b.midiNote) || 999));
  $('note-library-count').textContent = `${noteAssets.length} 個音`;
  const wrap = $('note-library-grid');
  wrap.innerHTML = '';
  if (!noteAssets.length) {
    wrap.innerHTML = '<span class="muted">尚未上傳。請選「口琴單音音檔」，檔名使用 C4.wav、C#4.wav、D4.wav…</span>';
    return;
  }
  noteAssets.forEach((asset) => {
    const chip = document.createElement('div');
    chip.className = 'note-chip';
    chip.innerHTML = `<strong>${escapeHtml(asset.pitch)}</strong><small>MIDI ${asset.midiNote ?? '—'}</small><button type="button">試聽</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      const audio = new Audio(asset.url);
      audio.play().catch((error) => showToast(`無法播放：${error.message}`, true));
    });
    wrap.appendChild(chip);
  });
}

function renderAssets() {
  dom.assetList.innerHTML = '';
  renderNoteLibrary();
  if (!assets.length) {
    dom.assetList.innerHTML = '<article class="panel-card muted">尚未上傳素材。</article>';
    renderQuestionForm();
    return;
  }

  const groups = [
    ['pokemon', '寶可夢圖片'],
    ['question', '題目素材'],
    ['performance', '演奏所需素材'],
    ['note', '口琴單音音檔']
  ];

  groups.forEach(([logical, groupLabel]) => {
    const groupAssets = assets.filter((asset) => assetLogicalCategory(asset) === logical || (logical === 'question' && ['score', 'midi'].includes(asset.category)));
    if (!groupAssets.length) return;
    const title = document.createElement('div');
    title.className = 'asset-group-title';
    title.innerHTML = `<strong>${groupLabel}</strong><span>${groupAssets.length} 個</span>`;
    dom.assetList.appendChild(title);

    groupAssets.forEach((asset) => {
      const card = document.createElement('article');
      card.className = 'asset-card';
      const kind = assetKind(asset);
      let preview = '';
      if (kind === 'image') {
        preview = `<img src="${escapeHtml(asset.url)}" alt="${escapeHtml(asset.originalName)}">`;
      } else if (kind === 'audio') {
        preview = `<audio src="${escapeHtml(asset.url)}" controls preload="metadata"></audio>`;
      } else if (kind === 'video') {
        preview = `<video src="${escapeHtml(asset.url)}" controls preload="metadata" style="width:100%;height:150px;object-fit:contain;background:#071014"></video>`;
      } else {
        preview = `<div class="pokemon-preview">${escapeHtml(assetTypeLabel(asset))}</div>`;
      }
      const categoryLabel = logical === 'note'
        ? `口琴單音 ${asset.pitch || ''}`
        : `${groupLabel} · ${assetTypeLabel(asset)}`;
      card.innerHTML = `
        ${preview}
        <div class="asset-meta">
          <strong>${escapeHtml(asset.originalName)}</strong>
          <span>${escapeHtml(categoryLabel)}・${formatBytes(asset.size)}・${formatDate(asset.uploadedAt)}</span>
        </div>
        <div class="asset-card-actions">
          <code>${escapeHtml(asset.url)}</code>
          <button type="button" class="ghost-btn danger-text">刪除</button>
        </div>
      `;
      card.querySelector('button').addEventListener('click', async () => {
        if (!confirm(`刪除素材「${asset.originalName}」？已經被題目引用的網址會失效。`)) return;
        try {
          await api(`/api/admin/assets/${encodeURIComponent(asset.id)}`, { method: 'DELETE' });
          assets = assets.filter((item) => item.id !== asset.id);
          renderAssets();
          renderQuestionForm();
          showToast('素材已刪除。');
        } catch (error) {
          showToast(error.message, true);
        }
      });
      dom.assetList.appendChild(card);
    });
  });
  renderQuestionForm();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('讀取檔案失敗'));
    reader.readAsDataURL(file);
  });
}

async function uploadAsset() {
  const files = [...$('asset-file').files];
  const category = $('asset-category').value;
  if (!files.length) {
    dom.uploadMessage.textContent = '請先選擇檔案。';
    dom.uploadMessage.classList.add('error');
    return;
  }
  if (files.some((file) => file.size > 25 * 1024 * 1024)) {
    dom.uploadMessage.textContent = '其中一個檔案超過 25 MB。';
    dom.uploadMessage.classList.add('error');
    return;
  }

  const button = $('upload-asset-btn');
  button.disabled = true;
  button.textContent = '上傳中…';
  dom.uploadMessage.classList.remove('error');
  try {
    const uploaded = [];
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      dom.uploadMessage.textContent = `正在上傳 ${index + 1}/${files.length}：${file.name}`;
      const dataBase64 = await fileToDataUrl(file);
      const manualPitch = files.length === 1 ? $('asset-note-pitch').value.trim() : '';
      const result = await api('/api/admin/assets/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category,
          fileName: file.name,
          mimeType: file.type,
          dataBase64,
          pitch: manualPitch,
          replaceExisting: $('asset-note-replace').checked
        })
      });
      uploaded.push(result.asset);
    }
    assets = [...uploaded.reverse(), ...assets.filter((existing) => !uploaded.some((item) => item.pitch && item.pitch === existing.pitch && item.category === 'note'))];
    $('asset-file').value = '';
    $('asset-note-pitch').value = '';
    dom.uploadMessage.textContent = `已上傳 ${uploaded.length} 個素材。`;
    renderAssets();
    showToast('素材上傳完成。');
  } catch (error) {
    dom.uploadMessage.textContent = error.message;
    dom.uploadMessage.classList.add('error');
    await loadAssets();
  } finally {
    button.disabled = false;
    button.textContent = '上傳素材';
  }
}

function updateAssetUploadMode() {
  const isNote = $('asset-category').value === 'note';
  $('note-upload-options').hidden = !isNote;
  const input = $('asset-file');
  const accepts = {
    pokemon: 'image/png,image/jpeg,image/gif,image/webp',
    question: '.musicxml,.xml,.mid,.midi,audio/*,.m4a',
    performance: 'audio/*,video/mp4,video/webm,.mov,.m4v,.m4a',
    note: 'audio/*,.m4a'
  };
  input.accept = accepts[$('asset-category').value] || '';
}

function setNumber(id, value) { $(id).value = Number(value) || 0; }
function getNumber(id) { return Number($(id).value) || 0; }


function ensureRulesShape() {
  if (!settings) return;
  if (!settings.rules || typeof settings.rules !== 'object') settings.rules = { enabled: true, pages: [] };
  settings.rules.enabled = settings.rules.enabled !== false;
  if (!Array.isArray(settings.rules.pages)) settings.rules.pages = [];
  settings.rules.pages = settings.rules.pages.map((page, index) => ({
    title: String(page?.title || `規則 ${index + 1}`),
    markdown: String(page?.markdown || '')
  }));
  if (!settings.rules.pages.length) settings.rules.pages.push({ title: '遊戲規則', markdown: '# 遊戲規則\n\n請在這裡輸入規則內容。' });
  selectedRulePageIndex = Math.max(0, Math.min(settings.rules.pages.length - 1, selectedRulePageIndex));
}

function renderRulePreview() {
  const page = settings?.rules?.pages?.[selectedRulePageIndex];
  const preview = $('rule-preview');
  if (!preview) return;
  preview.innerHTML = window.MarkdownLite?.render(page?.markdown || '') || '';
}

function renderRulesEditor() {
  if (!settings || !$('rule-page-list')) return;
  ensureRulesShape();
  $('rules-enabled').checked = settings.rules.enabled !== false;
  $('rule-page-count').textContent = `${settings.rules.pages.length} 頁`;
  const list = $('rule-page-list');
  list.innerHTML = '';
  settings.rules.pages.forEach((page, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `rule-page-item ${index === selectedRulePageIndex ? 'active' : ''}`;
    button.innerHTML = `<strong>第 ${index + 1} 頁｜${escapeHtml(page.title || `規則 ${index + 1}`)}</strong><span>${escapeHtml(String(page.markdown || '').replace(/[#*_>`~-]/g,'').trim().slice(0, 42) || '尚未輸入內容')}</span>`;
    button.addEventListener('click', () => { selectedRulePageIndex = index; renderRulesEditor(); });
    list.appendChild(button);
  });
  const page = settings.rules.pages[selectedRulePageIndex];
  $('rule-editor-empty').hidden = Boolean(page);
  $('rule-editor-form').hidden = !page;
  if (page) {
    $('rule-page-title').value = page.title || '';
    $('rule-page-markdown').value = page.markdown || '';
    $('rule-move-up').disabled = selectedRulePageIndex <= 0;
    $('rule-move-down').disabled = selectedRulePageIndex >= settings.rules.pages.length - 1;
    $('rule-delete-page').disabled = settings.rules.pages.length <= 1;
    renderRulePreview();
  }
  $('rules-save-state').textContent = rulesDirty ? '尚未儲存' : '已同步';
}

function markRulesDirty() {
  rulesDirty = true;
  if ($('rules-save-state')) $('rules-save-state').textContent = '尚未儲存';
}

function updateSelectedRulePage() {
  const page = settings?.rules?.pages?.[selectedRulePageIndex];
  if (!page) return;
  page.title = $('rule-page-title').value.slice(0, 80);
  page.markdown = $('rule-page-markdown').value.slice(0, 12000);
  markRulesDirty();
  renderRulePreview();
  $('rule-page-count').textContent = `${settings.rules.pages.length} 頁`;
}

function addRulePage() {
  ensureRulesShape();
  settings.rules.pages.push({ title: `規則 ${settings.rules.pages.length + 1}`, markdown: '## 新的規則頁面\n\n- 在這裡輸入內容' });
  selectedRulePageIndex = settings.rules.pages.length - 1;
  markRulesDirty(); renderRulesEditor();
}
function moveRulePage(delta) {
  const target = selectedRulePageIndex + delta;
  if (!settings?.rules?.pages || target < 0 || target >= settings.rules.pages.length) return;
  [settings.rules.pages[selectedRulePageIndex], settings.rules.pages[target]] = [settings.rules.pages[target], settings.rules.pages[selectedRulePageIndex]];
  selectedRulePageIndex = target; markRulesDirty(); renderRulesEditor();
}
function deleteRulePage() {
  if (!settings?.rules?.pages || settings.rules.pages.length <= 1) return;
  const page = settings.rules.pages[selectedRulePageIndex];
  if (!confirm(`確定刪除「${page.title || `第 ${selectedRulePageIndex + 1} 頁`}」？`)) return;
  settings.rules.pages.splice(selectedRulePageIndex, 1);
  selectedRulePageIndex = Math.min(selectedRulePageIndex, settings.rules.pages.length - 1);
  markRulesDirty(); renderRulesEditor();
}

async function saveRules() {
  ensureRulesShape();
  settings.rules.enabled = $('rules-enabled').checked;
  updateSelectedRulePage();
  try {
    const result = await api('/api/admin/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings)
    });
    settings = result.settings; rulesDirty = false; renderSettings(); renderRulesEditor();
    showToast('遊戲規則已儲存。');
  } catch (error) { showToast(error.message, true); }
}


function endClamp(value, min, max) { return Math.max(min, Math.min(max, Number(value) || 0)); }
function endElementId(prefix = 'el') { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
function makeEndElement(type, overrides = {}) {
  const base = type === 'image'
    ? { id:endElementId('img'), type:'image', x:1040, y:220, w:420, h:420, z:1, url:'', fit:'contain' }
    : { id:endElementId('txt'), type:'text', x:180, y:150, w:920, h:260, z:1, markdown:'# 謝謝大家參加！', fontSize:46, textAlign:'center', color:'#ffffff', backgroundEnabled:false, backgroundColor:'#000000' };
  return { ...base, ...overrides };
}
function legacyEndElements(page = {}, index = 0) {
  const title = String(page.title || `活動結束 ${index + 1}`);
  const markdown = String(page.markdown || '');
  const images = [page.imageUrl, page.imageUrl2].filter(Boolean);
  const layout = String(page.layout || 'image-right');
  const els = [];
  if (title) els.push(makeEndElement('text', { id:`legacy-title-${index}`, x:120, y:45, w:1360, h:100, z:3, markdown:`## ${title}`, fontSize:42, textAlign:'center', color:'#66fcf1' }));
  if (layout === 'text-only' || !images.length) {
    if (markdown) els.push(makeEndElement('text', { id:`legacy-text-${index}`, x:140, y:180, w:1320, h:610, z:2, markdown, fontSize:32, textAlign:'left' }));
    return els;
  }
  let textRect = { x:90, y:180, w:850, h:610 };
  let imageRects = [{ x:1000, y:190, w:500, h:500 }, { x:1080, y:620, w:340, h:210 }];
  if (layout === 'image-left') { textRect={x:660,y:180,w:850,h:610}; imageRects=[{x:90,y:190,w:500,h:500},{x:170,y:620,w:340,h:210}]; }
  if (layout === 'image-top') { textRect={x:140,y:530,w:1320,h:280}; imageRects=[{x:350,y:150,w:900,h:340},{x:1180,y:170,w:260,h:260}]; }
  if (layout === 'image-bottom') { textRect={x:140,y:160,w:1320,h:300}; imageRects=[{x:350,y:500,w:900,h:330},{x:1180,y:520,w:260,h:260}]; }
  if (layout === 'two-images') { textRect={x:160,y:150,w:1280,h:230}; imageRects=[{x:180,y:400,w:560,h:400},{x:860,y:400,w:560,h:400}]; }
  if (markdown) els.push(makeEndElement('text', { id:`legacy-text-${index}`, ...textRect, z:2, markdown, fontSize:30, textAlign:'left' }));
  images.forEach((url, i) => els.push(makeEndElement('image', { id:`legacy-img-${index}-${i}`, ...(imageRects[i] || imageRects[0]), z:1+i, url, fit:'contain' })));
  return els;
}
function normalizeEndElement(raw, index = 0) {
  const type = raw?.type === 'image' ? 'image' : 'text';
  const out = makeEndElement(type, raw || {});
  out.id = String(raw?.id || endElementId(type === 'image' ? 'img' : 'txt')).slice(0, 100);
  out.x = endClamp(raw?.x, 0, 1560); out.y = endClamp(raw?.y, 0, 860);
  out.w = endClamp(raw?.w || out.w, 40, 1600 - out.x); out.h = endClamp(raw?.h || out.h, 40, 900 - out.y);
  out.z = endClamp(raw?.z ?? index, 0, 9999);
  if (type === 'text') {
    out.markdown = String(raw?.markdown ?? out.markdown ?? '').slice(0, 12000);
    out.fontSize = endClamp(raw?.fontSize || 42, 12, 120);
    out.textAlign = ['left','center','right'].includes(raw?.textAlign) ? raw.textAlign : 'left';
    out.color = /^#[0-9a-fA-F]{6}$/.test(String(raw?.color || '')) ? raw.color : '#ffffff';
    out.backgroundEnabled = raw?.backgroundEnabled === true;
    out.backgroundColor = /^#[0-9a-fA-F]{6}$/.test(String(raw?.backgroundColor || '')) ? raw.backgroundColor : '#000000';
  } else {
    out.url = String(raw?.url || raw?.imageUrl || '').slice(0, 2000);
    out.fit = raw?.fit === 'cover' ? 'cover' : 'contain';
  }
  return out;
}
function ensureEndPagesShape() {
  if (!settings) return;
  if (!settings.endPages || typeof settings.endPages !== 'object') settings.endPages = { enabled:true, pages:[] };
  settings.endPages.enabled = settings.endPages.enabled !== false;
  if (!Array.isArray(settings.endPages.pages)) settings.endPages.pages = [];
  settings.endPages.pages = settings.endPages.pages.map((page, index) => {
    const hadElements = Array.isArray(page?.elements);
    const sourceElements = hadElements ? page.elements : legacyEndElements(page || {}, index);
    return {
      title: String(page?.title || `活動結束 ${index + 1}`),
      backgroundColor: /^#[0-9a-fA-F]{6}$/.test(String(page?.backgroundColor || '')) ? page.backgroundColor : '#071014',
      elements: sourceElements.slice(0, 80).map(normalizeEndElement)
    };
  });
  if (!settings.endPages.pages.length) settings.endPages.pages.push({ title:'活動結束', backgroundColor:'#071014', elements:[makeEndElement('text')] });
  selectedEndPageIndex = Math.max(0, Math.min(settings.endPages.pages.length - 1, selectedEndPageIndex));
  const page = settings.endPages.pages[selectedEndPageIndex];
  if (!page.elements.some(el => el.id === selectedEndElementId)) selectedEndElementId = null;
}
function markEndPagesDirty(){ endPagesDirty=true; if($('end-save-state')) $('end-save-state').textContent='尚未儲存'; }
function getSelectedEndPage(){ return settings?.endPages?.pages?.[selectedEndPageIndex] || null; }
function getSelectedEndElement(){ return getSelectedEndPage()?.elements?.find(el => el.id === selectedEndElementId) || null; }
function updateEndCanvasScale(){
  const canvas=$('end-free-canvas'), stage=$('end-free-stage');
  if(!canvas||!stage)return;
  // The end-page tab can be rendered while hidden. In that state clientWidth is 0.
  // Never overwrite the valid scale with the old 0.05 fallback; wait until the
  // canvas actually has a layout box, then fit the 1600×900 stage to it.
  const width=canvas.getBoundingClientRect().width;
  if(!Number.isFinite(width) || width < 40) return;
  endCanvasScale=width/1600;
  stage.style.transform=`scale(${endCanvasScale})`;
}
function scheduleEndCanvasFit(){
  requestAnimationFrame(()=>{
    updateEndCanvasScale();
    requestAnimationFrame(updateEndCanvasScale);
  });
  setTimeout(updateEndCanvasScale,60);
  setTimeout(updateEndCanvasScale,180);
}
function installEndCanvasAutoFit(){
  const canvas=$('end-free-canvas');
  if(!canvas)return;
  endCanvasResizeObserver?.disconnect?.();
  if('ResizeObserver' in window){
    endCanvasResizeObserver=new ResizeObserver(()=>updateEndCanvasScale());
    endCanvasResizeObserver.observe(canvas);
  }
  window.addEventListener('resize', scheduleEndCanvasFit);
  document.addEventListener('visibilitychange',()=>{ if(!document.hidden)scheduleEndCanvasFit(); });
  scheduleEndCanvasFit();
}
function endElementStyle(el){ return `left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px;z-index:${el.z};`; }
function renderEndFreeCanvas(){
  const page=getSelectedEndPage(); const stage=$('end-free-stage'); const canvas=$('end-free-canvas'); if(!page||!stage||!canvas)return;
  canvas.style.background=page.backgroundColor||'#071014'; stage.innerHTML='';
  [...page.elements].sort((a,b)=>a.z-b.z).forEach(el=>{
    const node=document.createElement('div'); node.className=`end-free-element end-free-element-${el.type}${el.id===selectedEndElementId?' selected':''}`; node.dataset.id=el.id; node.style.cssText=endElementStyle(el);
    if(el.type==='text'){
      node.style.fontSize=`${el.fontSize}px`; node.style.textAlign=el.textAlign; node.style.color=el.color; node.style.background=el.backgroundEnabled?el.backgroundColor:'transparent';
      node.innerHTML=window.MarkdownLite?.render(el.markdown||'')||'<p>文字</p>';
    }else{
      node.innerHTML=el.url?`<img src="${escapeHtml(el.url)}" alt="活動結束頁圖片" style="object-fit:${el.fit==='cover'?'cover':'contain'}">`:'<span style="color:#888">圖片</span>';
    }
    const handle=document.createElement('span'); handle.className='resize-handle'; node.appendChild(handle);
    node.addEventListener('pointerdown', event=>beginEndElementPointer(event,el,event.target===handle?'resize':'move'));
    stage.appendChild(node);
  });
  scheduleEndCanvasFit();
}
function renderEndElementInspector(){
  const el=getSelectedEndElement(); $('end-element-empty').hidden=Boolean(el); $('end-element-form').hidden=!el; if(!el)return;
  $('end-element-heading').textContent=el.type==='image'?'圖片元素':'文字元素'; $('end-element-type').textContent=el.type==='image'?'IMAGE':'TEXT';
  $('end-el-x').value=Math.round(el.x); $('end-el-y').value=Math.round(el.y); $('end-el-w').value=Math.round(el.w); $('end-el-h').value=Math.round(el.h);
  $('end-text-options').hidden=el.type!=='text'; $('end-image-options').hidden=el.type!=='image';
  if(el.type==='text'){
    $('end-el-markdown').value=el.markdown||''; $('end-el-font-size').value=el.fontSize||42; $('end-el-align').value=el.textAlign||'left'; $('end-el-color').value=el.color||'#ffffff'; $('end-el-bg-enabled').checked=el.backgroundEnabled===true; $('end-el-bg-color').value=el.backgroundColor||'#000000'; $('end-el-bg-color-field').style.opacity=el.backgroundEnabled?1:.45;
  }else{
    $('end-el-fit').value=el.fit||'contain'; $('end-selected-image-preview').innerHTML=el.url?`<img src="${escapeHtml(el.url)}" alt="已選圖片">`:'尚未上傳';
  }
}
function renderEndPagesEditor(){
  if(!settings)return; ensureEndPagesShape(); $('end-pages-enabled').checked=settings.endPages.enabled!==false; $('end-page-count').textContent=`${settings.endPages.pages.length} 頁`;
  const list=$('end-page-list'); list.innerHTML=''; settings.endPages.pages.forEach((page,index)=>{ const b=document.createElement('button'); b.type='button'; b.className=`rule-page-item ${index===selectedEndPageIndex?'active':''}`; b.innerHTML=`<strong>第 ${index+1} 頁｜${escapeHtml(page.title||'未命名')}</strong><span>${page.elements.length} 個元素</span>`; b.onclick=()=>{selectedEndPageIndex=index;selectedEndElementId=null;renderEndPagesEditor();}; list.appendChild(b); });
  const page=getSelectedEndPage(); $('end-editor-empty').hidden=Boolean(page); $('end-editor-form').hidden=!page; if(!page)return;
  $('end-page-title').value=page.title||''; $('end-page-bg').value=page.backgroundColor||'#071014'; $('end-move-up').disabled=selectedEndPageIndex<=0; $('end-move-down').disabled=selectedEndPageIndex>=settings.endPages.pages.length-1; $('end-delete-page').disabled=settings.endPages.pages.length<=1;
  renderEndFreeCanvas(); renderEndElementInspector(); $('end-save-state').textContent=endPagesDirty?'尚未儲存':'已同步';
}
function updateSelectedEndPageMeta(){ const page=getSelectedEndPage(); if(!page)return; page.title=$('end-page-title').value; page.backgroundColor=$('end-page-bg').value||'#071014'; markEndPagesDirty(); renderEndFreeCanvas(); }
function addEndPage(){ ensureEndPagesShape(); settings.endPages.pages.push({title:`活動結束 ${settings.endPages.pages.length+1}`,backgroundColor:'#071014',elements:[makeEndElement('text')]}); selectedEndPageIndex=settings.endPages.pages.length-1; selectedEndElementId=null; markEndPagesDirty(); renderEndPagesEditor(); }
function moveEndPage(delta){ const pages=settings?.endPages?.pages; const target=selectedEndPageIndex+delta; if(!pages||target<0||target>=pages.length)return; [pages[selectedEndPageIndex],pages[target]]=[pages[target],pages[selectedEndPageIndex]]; selectedEndPageIndex=target; markEndPagesDirty(); renderEndPagesEditor(); }
function deleteEndPage(){ const pages=settings?.endPages?.pages; if(!pages||pages.length<=1)return; if(!confirm('確定刪除這一頁活動結束頁？'))return; pages.splice(selectedEndPageIndex,1); selectedEndPageIndex=Math.min(selectedEndPageIndex,pages.length-1); selectedEndElementId=null; markEndPagesDirty(); renderEndPagesEditor(); }
function selectEndElement(id){ selectedEndElementId=id; document.querySelectorAll('.end-free-element').forEach(node=>node.classList.toggle('selected',node.dataset.id===id)); renderEndElementInspector(); }
function beginEndElementPointer(event, el, mode){
  event.preventDefault(); event.stopPropagation(); selectEndElement(el.id);
  const startClientX=event.clientX, startClientY=event.clientY, startX=el.x, startY=el.y, startW=el.w, startH=el.h;
  const node=event.currentTarget; node.setPointerCapture?.(event.pointerId);
  const move=e=>{
    const dx=(e.clientX-startClientX)/endCanvasScale, dy=(e.clientY-startClientY)/endCanvasScale;
    if(mode==='resize'){ el.w=endClamp(startW+dx,40,1600-el.x); el.h=endClamp(startH+dy,40,900-el.y); }
    else { el.x=endClamp(startX+dx,0,1600-el.w); el.y=endClamp(startY+dy,0,900-el.h); }
    node.style.left=`${el.x}px`; node.style.top=`${el.y}px`; node.style.width=`${el.w}px`; node.style.height=`${el.h}px`; markEndPagesDirty();
    $('end-el-x').value=Math.round(el.x); $('end-el-y').value=Math.round(el.y); $('end-el-w').value=Math.round(el.w); $('end-el-h').value=Math.round(el.h);
  };
  const up=e=>{ node.releasePointerCapture?.(event.pointerId); node.removeEventListener('pointermove',move); node.removeEventListener('pointerup',up); node.removeEventListener('pointercancel',up); renderEndElementInspector(); };
  node.addEventListener('pointermove',move); node.addEventListener('pointerup',up); node.addEventListener('pointercancel',up);
}
function addEndTextElement(){ const page=getSelectedEndPage(); if(!page)return; const z=Math.max(0,...page.elements.map(e=>e.z||0))+1; const count=page.elements.filter(e=>e.type==='text').length; const el=makeEndElement('text',{x:180+count*25,y:160+count*25,w:900,h:240,z}); page.elements.push(el); selectedEndElementId=el.id; markEndPagesDirty(); renderEndPagesEditor(); }
async function uploadEndImageFile(file){
  const dataBase64=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(new Error('讀取圖片失敗'));r.readAsDataURL(file);});
  const result=await api('/api/admin/end-page-image/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fileName:file.name,mimeType:file.type,dataBase64})}); return result.url;
}
async function addEndImageFiles(fileList){ const page=getSelectedEndPage(); if(!page)return; const files=[...fileList]; if(!files.length)return; let z=Math.max(0,...page.elements.map(e=>e.z||0))+1; let imageCount=page.elements.filter(e=>e.type==='image').length; for(const file of files){ const url=await uploadEndImageFile(file); const col=imageCount%3,row=Math.floor(imageCount/3)%3; const el=makeEndElement('image',{x:180+col*440,y:180+row*230,w:360,h:210,z:z++,url,fit:'contain'}); page.elements.push(el); selectedEndElementId=el.id; imageCount++; } markEndPagesDirty(); renderEndPagesEditor(); showToast(`${files.length} 張圖片已加入畫布。`); }
async function replaceEndSelectedImage(file){ const el=getSelectedEndElement(); if(!el||el.type!=='image'||!file)return; el.url=await uploadEndImageFile(file); markEndPagesDirty(); renderEndPagesEditor(); showToast('圖片已更換。'); }
function updateSelectedEndElement(){
  const el=getSelectedEndElement(); if(!el)return; el.x=endClamp($('end-el-x').value,0,1600-el.w); el.y=endClamp($('end-el-y').value,0,900-el.h); el.w=endClamp($('end-el-w').value,40,1600-el.x); el.h=endClamp($('end-el-h').value,40,900-el.y);
  if(el.type==='text'){ el.markdown=$('end-el-markdown').value; el.fontSize=endClamp($('end-el-font-size').value,12,120); el.textAlign=$('end-el-align').value; el.color=$('end-el-color').value; el.backgroundEnabled=$('end-el-bg-enabled').checked; el.backgroundColor=$('end-el-bg-color').value; $('end-el-bg-color-field').style.opacity=el.backgroundEnabled?1:.45; }
  else el.fit=$('end-el-fit').value==='cover'?'cover':'contain'; markEndPagesDirty(); renderEndFreeCanvas();
}
function deleteSelectedEndElement(){ const page=getSelectedEndPage(); if(!page||!selectedEndElementId)return; page.elements=page.elements.filter(el=>el.id!==selectedEndElementId); selectedEndElementId=null; markEndPagesDirty(); renderEndPagesEditor(); }
function changeEndElementLayer(front=true){ const page=getSelectedEndPage(), el=getSelectedEndElement(); if(!page||!el)return; el.z=front?Math.max(0,...page.elements.map(e=>e.z||0))+1:Math.min(0,...page.elements.map(e=>e.z||0))-1; markEndPagesDirty(); renderEndFreeCanvas(); renderEndElementInspector(); }
async function saveEndPages(){ ensureEndPagesShape(); settings.endPages.enabled=$('end-pages-enabled').checked; try{ const result=await api('/api/admin/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({...collectSettings(),endPages:settings.endPages})}); settings=result.settings; ensureEndPagesShape(); endPagesDirty=false; renderSettings(); renderEndPagesEditor(); showToast('活動結束頁已儲存。'); } catch(error){showToast(error.message,true);} }

function renderSettings() {
  if (!settings) return;
  const s = settings.scoring;
  $('s-room-id').value = settings.room.id;
  $('s-team-names').value = settings.room.teamNames.join('\n');
  $('s-access-enabled').checked = settings.playerAccess.enabled;
  $('s-access-token').value = settings.playerAccess.token;
  updateJoinUrl();
  setNumber('s-perfect-window', s.perfectWindow);
  setNumber('s-good-window', s.goodWindow);
  setNumber('s-perfect-base', s.perfectBase);
  setNumber('s-good-base', s.goodBase);
  setNumber('s-miss-score', s.missScore);
  setNumber('s-combo-cap', s.comboCap);
  setNumber('s-perfect-combo', s.perfectComboRate);
  setNumber('s-good-combo', s.goodComboRate);
  setNumber('s-hold-base', s.holdBase);
  setNumber('s-hold-combo', s.holdComboRate);
  setNumber('s-hold-tolerance', s.holdEarlyTolerance);
  $('s-round-bonus-base').value = s.roundBonusBase === 'round-highest' ? 'round-highest' : 'own-team';
  setNumber('s-direct-guess-percent', s.roundBonusPercent?.directGuess ?? 50);
  setNumber('s-choice-percent', s.roundBonusPercent?.multipleChoice ?? 25);
  const finalBgm = settings.finalBgm || { sourceType: 'none', assetUrl: '', youtubeUrl: '', volume: 0.55 };
  $('s-final-bgm-type').value = finalBgm.sourceType || 'none';
  $('s-final-bgm-youtube').value = finalBgm.youtubeUrl || '';
  setNumber('s-final-bgm-volume', Math.round((Number(finalBgm.volume) || 0.55) * 100));
  const bgmAssets = (assets || []).filter((asset) => asset.category === 'performance' && /\.(mp3|wav|ogg|m4a)$/i.test(asset.fileName || asset.originalName || asset.url || ''));
  $('s-final-bgm-asset').innerHTML = '<option value="">未指定音檔</option>' + bgmAssets.map((asset) => `<option value="${escapeHtml(asset.url)}">${escapeHtml(asset.originalName || asset.fileName || asset.url)}</option>`).join('');
  $('s-final-bgm-asset').value = finalBgm.assetUrl || '';
  setNumber('p-three-1', s.pokemonPoints['three-stage-1']);
  setNumber('p-three-2', s.pokemonPoints['three-stage-2']);
  setNumber('p-three-3', s.pokemonPoints['three-stage-3']);
  setNumber('p-two-1', s.pokemonPoints['two-stage-1']);
  setNumber('p-two-2', s.pokemonPoints['two-stage-2']);
  setNumber('p-none', s.pokemonPoints['no-evolution']);
  setNumber('p-legendary', s.pokemonPoints.legendary);
  renderRulesEditor();
  renderEndPagesEditor();
}

function updateJoinUrl() {
  const token = $('s-access-token').value;
  const enabled = $('s-access-enabled').checked;
  $('s-join-url').value = `${location.origin}/${enabled ? `?access=${encodeURIComponent(token)}` : ''}`;
}

function collectSettings() {
  return {
    ...settings,
    room: {
      id: $('s-room-id').value.trim() || '8888',
      teamNames: $('s-team-names').value.split(/\r?\n/).map((name) => name.trim()).filter(Boolean)
    },
    playerAccess: {
      enabled: $('s-access-enabled').checked,
      token: $('s-access-token').value
    },
    rules: settings.rules,
    endPages: settings.endPages,
    finalBgm: {
      sourceType: $('s-final-bgm-type').value || 'none',
      assetUrl: $('s-final-bgm-asset').value || '',
      youtubeUrl: $('s-final-bgm-youtube').value.trim(),
      volume: Math.max(0, Math.min(1, getNumber('s-final-bgm-volume') / 100))
    },
    scoring: {
      ...settings.scoring,
      perfectWindow: getNumber('s-perfect-window'),
      goodWindow: getNumber('s-good-window'),
      perfectBase: getNumber('s-perfect-base'),
      goodBase: getNumber('s-good-base'),
      missScore: getNumber('s-miss-score'),
      comboCap: getNumber('s-combo-cap'),
      perfectComboRate: getNumber('s-perfect-combo'),
      goodComboRate: getNumber('s-good-combo'),
      holdBase: getNumber('s-hold-base'),
      holdComboRate: getNumber('s-hold-combo'),
      holdEarlyTolerance: getNumber('s-hold-tolerance'),
      teamScoreMode: 'active-player',
      roundBonusMode: 'percent-of-rhythm',
      roundBonusBase: $('s-round-bonus-base').value === 'round-highest' ? 'round-highest' : 'own-team',
      roundBonusPercent: {
        directGuess: getNumber('s-direct-guess-percent'),
        multipleChoice: getNumber('s-choice-percent')
      },
      pokemonPoints: {
        'three-stage-1': getNumber('p-three-1'),
        'three-stage-2': getNumber('p-three-2'),
        'three-stage-3': getNumber('p-three-3'),
        'two-stage-1': getNumber('p-two-1'),
        'two-stage-2': getNumber('p-two-2'),
        'no-evolution': getNumber('p-none'),
        legendary: getNumber('p-legendary')
      }
    }
  };
}

async function saveSettings() {
  dom.settingsMessage.classList.remove('error');
  try {
    const result = await api('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collectSettings())
    });
    settings = result.settings;
    renderSettings();
    dom.settingsMessage.textContent = '設定已儲存；新節奏回合會使用最新計分公式。';
    showToast('設定已儲存。');
  } catch (error) {
    dom.settingsMessage.textContent = error.message;
    dom.settingsMessage.classList.add('error');
  }
}

async function regenerateToken() {
  if (!confirm('產生新權杖後，舊 QR 連結會失效。確定繼續？')) return;
  try {
    const result = await api('/api/admin/access-token/regenerate', { method: 'POST' });
    settings.playerAccess = result.playerAccess;
    renderSettings();
    showToast('已產生新的 QR 入場權杖。');
  } catch (error) {
    showToast(error.message, true);
  }
}

function renderVersions() {
  dom.versionList.innerHTML = '';
  if (!versions.length) {
    dom.versionList.textContent = '尚無發布版本。第一次發布正式題庫後會出現。';
    return;
  }
  versions.forEach((version) => {
    const row = document.createElement('div');
    row.className = 'version-row';
    row.innerHTML = `
      <div><strong>${formatDate(version.createdAt)}</strong><span>${version.questionCount} 題・${escapeHtml(version.id)}</span></div>
      <button type="button" class="ghost-btn">還原到草稿</button>
    `;
    row.querySelector('button').addEventListener('click', async () => {
      if (!confirm('還原只會覆蓋目前草稿，不會直接變更正式題庫。確定繼續？')) return;
      try {
        await api(`/api/admin/versions/${encodeURIComponent(version.id)}/restore`, { method: 'POST' });
        await loadQuestions();
        showToast('版本已還原到草稿。');
      } catch (error) {
        showToast(error.message, true);
      }
    });
    dom.versionList.appendChild(row);
  });
}

async function importBackup() {
  const file = $('backup-file').files[0];
  if (!file) {
    dom.backupMessage.textContent = '請選擇 JSON 備份檔。';
    dom.backupMessage.classList.add('error');
    return;
  }
  if (!confirm('匯入會覆蓋現有草稿、正式題庫與設定。確定繼續？')) return;
  try {
    const bundle = JSON.parse(await file.text());
    await api('/api/admin/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bundle)
    });
    dom.backupMessage.textContent = '備份已匯入。';
    dom.backupMessage.classList.remove('error');
    await loadAll();
    showToast('備份匯入完成。');
  } catch (error) {
    dom.backupMessage.textContent = error.message;
    dom.backupMessage.classList.add('error');
  }
}

async function loadQuestions() {
  questions = await api('/api/admin/questions/draft');
  questions.forEach(ensureQuestionShape);
  if (!questions.length) selectedIndex = -1;
  else if (selectedIndex < 0 || selectedIndex >= questions.length) selectedIndex = 0;
  markSaved();
  renderQuestionList();
  renderQuestionForm();
}

async function loadAssets() {
  assets = await api('/api/admin/assets');
  renderAssets();
}

async function loadSettings() {
  settings = await api('/api/admin/settings');
  ensureRulesShape();
  ensureEndPagesShape();
  rulesDirty = false;
  endPagesDirty = false;
  renderSettings();
}

async function loadDashboard() {
  dashboard = await api('/api/admin/dashboard');
  updateDashboard();
}

async function loadVersions() {
  versions = await api('/api/admin/versions');
  renderVersions();
}

async function loadAll() {
  try {
    await Promise.all([loadQuestions(), loadAssets(), loadSettings(), loadDashboard(), loadVersions()]);
  } catch (error) {
    showToast(error.message, true);
  }
}

function bindTabs() {
  document.querySelectorAll('.tab-btn').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((btn) => btn.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.remove('active'));
      button.classList.add('active');
      $(`tab-${button.dataset.tab}`).classList.add('active');
      if(button.dataset.tab==='endpages') scheduleEndCanvasFit();
    });
  });
}

function bindActions() {
  $('refresh-all-btn').addEventListener('click', loadAll);
  $('add-question-btn').addEventListener('click', addQuestion);
  $('q-generate-audio-chart').addEventListener('click', () => generateAudioChartForSelectedQuestion().catch((error) => showToast(error.message, true)));
  $('save-draft-btn').addEventListener('click', () => saveDraft().catch((error) => showToast(error.message, true)));
  $('publish-btn').addEventListener('click', () => publishQuestions().catch((error) => showToast(error.message, true)));
  $('duplicate-question-btn').addEventListener('click', duplicateQuestion);
  $('delete-question-btn').addEventListener('click', deleteQuestion);
  $('move-up-btn').addEventListener('click', () => moveQuestion(-1));
  $('move-down-btn').addEventListener('click', () => moveQuestion(1));
  $('open-editor-btn').addEventListener('click', async () => {
    const q = getSelectedQuestion();
    if (!q) return;
    try {
      if (dirty) await saveDraft(false);
      location.href = `/editor.html?q=${encodeURIComponent(q.id)}`;
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $('upload-asset-btn').addEventListener('click', uploadAsset);
  $('asset-category').addEventListener('change', updateAssetUploadMode);
  $('save-settings-btn').addEventListener('click', saveSettings);
  $('save-rules-btn')?.addEventListener('click', saveRules);

  $('save-end-pages-btn')?.addEventListener('click', saveEndPages);
  $('add-end-page-btn')?.addEventListener('click', addEndPage);
  $('end-move-up')?.addEventListener('click', () => moveEndPage(-1));
  $('end-move-down')?.addEventListener('click', () => moveEndPage(1));
  $('end-delete-page')?.addEventListener('click', deleteEndPage);
  $('end-page-title')?.addEventListener('input', updateSelectedEndPageMeta);
  $('end-page-bg')?.addEventListener('input', updateSelectedEndPageMeta);
  $('end-pages-enabled')?.addEventListener('change', () => { if(settings?.endPages) settings.endPages.enabled=$('end-pages-enabled').checked; markEndPagesDirty(); });
  $('end-add-text')?.addEventListener('click', addEndTextElement);
  $('end-add-image-file')?.addEventListener('change', event => addEndImageFiles(event.target.files).catch(e=>showToast(e.message,true)).finally(()=>{event.target.value='';}));
  $('end-replace-image-file')?.addEventListener('change', event => replaceEndSelectedImage(event.target.files?.[0]).catch(e=>showToast(e.message,true)).finally(()=>{event.target.value='';}));
  ['end-el-x','end-el-y','end-el-w','end-el-h','end-el-markdown','end-el-font-size','end-el-align','end-el-color','end-el-bg-enabled','end-el-bg-color','end-el-fit'].forEach(id => {
    const node=$(id); if(!node)return; node.addEventListener(node.tagName==='TEXTAREA'||node.type==='number'||node.type==='color'?'input':'change', updateSelectedEndElement);
  });
  $('end-delete-element')?.addEventListener('click', deleteSelectedEndElement);
  $('end-bring-front')?.addEventListener('click', () => changeEndElementLayer(true));
  $('end-send-back')?.addEventListener('click', () => changeEndElementLayer(false));
  $('end-free-canvas')?.addEventListener('pointerdown', event => { if(event.target.id==='end-free-canvas'||event.target.id==='end-free-stage'){ selectedEndElementId=null; document.querySelectorAll('.end-free-element').forEach(n=>n.classList.remove('selected')); renderEndElementInspector(); } });

  $('add-rule-page-btn')?.addEventListener('click', addRulePage);
  $('rule-move-up')?.addEventListener('click', () => moveRulePage(-1));
  $('rule-move-down')?.addEventListener('click', () => moveRulePage(1));
  $('rule-delete-page')?.addEventListener('click', deleteRulePage);
  $('rule-page-title')?.addEventListener('input', updateSelectedRulePage);
  $('rule-page-markdown')?.addEventListener('input', updateSelectedRulePage);
  $('rules-enabled')?.addEventListener('change', () => { if (settings?.rules) settings.rules.enabled = $('rules-enabled').checked; markRulesDirty(); });
  $('s-access-enabled').addEventListener('change', updateJoinUrl);
  $('regenerate-token-btn').addEventListener('click', regenerateToken);
  $('refresh-versions-btn').addEventListener('click', loadVersions);
  $('import-backup-btn').addEventListener('click', importBackup);
  $('logout-btn').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    location.href = '/login.html';
  });
}

socket.on('connect', () => {
  dom.liveStatus.classList.remove('offline');
  dom.liveStatus.lastChild.textContent = '即時連線中';
  socket.emit('admin-join');
});
socket.on('disconnect', () => {
  dom.liveStatus.classList.add('offline');
  dom.liveStatus.lastChild.textContent = '連線中斷';
});
socket.on('auth-error', () => {
  location.href = `/login.html?next=${encodeURIComponent(location.pathname)}`;
});
socket.on('admin-dashboard-update', updateDashboard);
socket.on('admin-game-state', (game) => updateDashboard({ ...(dashboard || {}), game }));
socket.on('content-updated', async (event) => {
  if (event.type === 'draft-saved' && dirty) {
    showToast('另一個後台已更新草稿；你目前有未儲存內容，暫不自動覆蓋。', true);
    return;
  }
  if (!dirty) {
    await loadQuestions();
  }
  if (event.type === 'published' || event.type === 'version-restored') await loadVersions();
  showToast(`即時更新：${event.type}`);
});
socket.on('assets-updated', async () => {
  await loadAssets();
  showToast('素材庫已即時更新。');
});
socket.on('settings-updated', (event) => {
  settings = event.settings;
  renderSettings();
  showToast('設定已由另一個後台更新。');
});

window.addEventListener('beforeunload', (event) => {
  if (!dirty) return;
  event.preventDefault();
  event.returnValue = '';
});

bindTabs();
bindQuestionFields();
bindActions();
updateAssetUploadMode();
loadAll();

window.addEventListener('resize', () => { if(document.getElementById('tab-endpages')?.classList.contains('active')) requestAnimationFrame(updateEndCanvasScale); });
window.addEventListener('keydown', event => {
  const tag=document.activeElement?.tagName; if(['INPUT','TEXTAREA','SELECT'].includes(tag)) return;
  const el=getSelectedEndElement(); if(!el || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
  event.preventDefault(); const step=event.shiftKey?10:1;
  if(event.key==='ArrowLeft') el.x=endClamp(el.x-step,0,1600-el.w);
  if(event.key==='ArrowRight') el.x=endClamp(el.x+step,0,1600-el.w);
  if(event.key==='ArrowUp') el.y=endClamp(el.y-step,0,900-el.h);
  if(event.key==='ArrowDown') el.y=endClamp(el.y+step,0,900-el.h);
  markEndPagesDirty(); renderEndFreeCanvas(); renderEndElementInspector();
});

installEndCanvasAutoFit();
