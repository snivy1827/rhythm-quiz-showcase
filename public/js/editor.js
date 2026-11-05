// =============================================================
// Editor State & Config
// =============================================================
const MS_PER_PX = 10; // 1px = 10ms (100px = 1000ms = 1s)
const SNAP_MS = 20;   // Fine correction grid: 20ms
let timelineDurationMs = 120000; // Dynamic timeline length
const MAX_ALLOWED_DURATION_MS = 600000; // 10 minutes

let questionBank = [];
let assets = [];
let noteSampleMap = {};
let currentQIndex = 0;
const editorSocket = io();
let notes = []; // current song notes
let editorMode = 'select';
let selectedNoteIndex = -1;
let undoStack = [];
let redoStack = [];
const HISTORY_LIMIT = 80;

let isPlaying = false;
let currentTime = 0;
let lastLocalTime = 0;
let renderedNoteNodes = new Map();

// MIDI parser state
let parsedMidiData = null;
let midiTrackItems = [];

// =============================================================
// DOM Elements
// =============================================================
const playlistContainer = document.getElementById('playlist-container');
const btnAddSong = document.getElementById('btn-add-song');
const btnSaveServer = document.getElementById('btn-save-server');
const saveStatus = document.getElementById('save-status');

const selectPitch = document.getElementById('ed-note-pitch');
const selectDuration = document.getElementById('ed-note-duration');
const inputSongName = document.getElementById('ed-song-name');
const inputPkmnName = document.getElementById('ed-pkmn-name');
const selectPkmnEvo = document.getElementById('ed-pkmn-evo');
const inputPkmnCustomPoints = document.getElementById('ed-pkmn-custom-points');
const pkmnCustomPointsWrap = document.getElementById('ed-pkmn-custom-points-wrap');
const selectPkmnImage = document.getElementById('ed-pkmn-image');
const selectReferenceAudio = document.getElementById('ed-reference-audio');
const inputAudioOffset = document.getElementById('ed-audio-offset');
const referencePlayer = document.getElementById('ed-reference-player');
const syncReference = document.getElementById('ed-sync-reference');
const selectScoreAsset = document.getElementById('ed-score-asset');
const btnLoadScoreAsset = document.getElementById('btn-load-score-asset');
const selectMidiAsset = document.getElementById('ed-midi-asset');
const btnLoadMidiAsset = document.getElementById('btn-load-midi-asset');

const btnClearAll = document.getElementById('btn-clear-all');
const btnSelectMode = document.getElementById('btn-select-mode');
const btnAddMode = document.getElementById('btn-add-mode');
const btnUndo = document.getElementById('btn-undo');
const btnRedo = document.getElementById('btn-redo');
const btnDeleteSelected = document.getElementById('btn-delete-selected');
const btnPlayPause = document.getElementById('btn-play-pause');
const btnStop = document.getElementById('btn-stop');

const timelineContainer = document.getElementById('timeline-container');
const timelineRuler = document.getElementById('timeline-ruler');
const timelineTracks = document.getElementById('timeline-tracks');
const playhead = document.getElementById('playhead');
const currentTimeLbl = document.getElementById('current-time-lbl');

// MIDI elements
const btnOpenMidi = document.getElementById('btn-open-midi-import');
const midiOverlay = document.getElementById('midi-import-overlay');
const midiFileInput = document.getElementById('midi-file-input');
const midiDropZone = document.getElementById('midi-drop-zone');
const btnMidiParse = document.getElementById('btn-midi-parse');
const btnMidiConfirm = document.getElementById('btn-midi-confirm');
const btnMidiClose = document.getElementById('btn-midi-close');
const midiStatus = document.getElementById('midi-status');
const midiTrackSection = document.getElementById('midi-track-section');
const midiTracksList = document.getElementById('midi-tracks-list');
const midiPitchRange = document.getElementById('midi-pitch-range');
const midiOffsetInput = document.getElementById('midi-offset');
const midiMinGapInput = document.getElementById('midi-min-gap');
const midiDirMode = document.getElementById('midi-dir-mode');
const midiKeepLongNotes = document.getElementById('midi-keep-long-notes');
const midiInfoBox = document.getElementById('midi-info-box');
const midiInfoContent = document.getElementById('midi-info-content');
const midiAuditTable = document.getElementById('midi-audit-table');

// =============================================================
// Initialization & Playlist Management
// =============================================================

async function fetchQuestions() {
  try {
    const [questionsRes, assetsRes, noteLibraryRes] = await Promise.all([
      fetch('/api/admin/questions/draft'),
      fetch('/api/admin/assets'),
      fetch('/api/note-library')
    ]);
    if (questionsRes.status === 401 || assetsRes.status === 401) {
      location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
      return;
    }
    questionBank = questionsRes.ok ? await questionsRes.json() : [];
    assets = assetsRes.ok ? await assetsRes.json() : [];
    const noteLibrary = noteLibraryRes.ok ? await noteLibraryRes.json() : { map: {} };
    noteSampleMap = noteLibrary.map || {};
    window.RhythmAudioEngine?.setSampleMap(noteSampleMap);
    populatePitchOptions();
  } catch (e) {
    console.error(e);
    questionBank = [];
    assets = [];
  }

  if (questionBank.length === 0) {
    addNewSong();
  } else {
    const requestedId = Number(new URLSearchParams(location.search).get('q'));
    const requestedIndex = Number.isFinite(requestedId)
      ? questionBank.findIndex(q => Number(q.id) === requestedId)
      : -1;
    loadQuestion(requestedIndex >= 0 ? requestedIndex : 0);
  }
  renderPlaylist();
}

function renderPlaylist() {
  playlistContainer.innerHTML = '';
  questionBank.forEach((q, idx) => {
    const item = document.createElement('div');
    item.className = `playlist-item ${idx === currentQIndex ? 'selected' : ''}`;
    item.setAttribute('draggable', 'true');
    item.dataset.index = idx;
    
    item.innerHTML = `
      <span class="drag-handle" title="拖曳排序">☰</span>
      <div class="playlist-item-title" title="${q.songName}">${idx + 1}. ${q.songName} <br><span style="color:#aaa; font-size:10px;">(${q.pokemon.name})</span></div>
      <button class="pixel-btn pixel-btn-danger" style="padding: 2px 6px; font-size: 8px;" title="刪除此題" onclick="deleteSong(event, ${idx})">X</button>
    `;
    
    item.addEventListener('click', () => {
      saveCurrentToBank();
      loadQuestion(idx);
      renderPlaylist();
    });
    
    // Drag and Drop Logic
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', idx);
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => item.classList.remove('dragging'));
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      item.style.borderTop = '2px solid var(--primary-color)';
    });
    item.addEventListener('dragleave', () => item.style.borderTop = '');
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.style.borderTop = '';
      const dragIdx = parseInt(e.dataTransfer.getData('text/plain'));
      const dropIdx = idx;
      if (dragIdx === dropIdx) return;
      
      saveCurrentToBank();
      // Reorder array
      const draggedItem = questionBank.splice(dragIdx, 1)[0];
      questionBank.splice(dropIdx, 0, draggedItem);
      
      currentQIndex = dropIdx;
      markUnsaved();
      renderPlaylist();
    });
    
    playlistContainer.appendChild(item);
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function editorAssetKind(asset) {
  const value = String(asset?.originalName || asset?.url || '').toLowerCase();
  if (/\.(musicxml|xml)(?:[?#].*)?$/.test(value)) return 'score';
  if (/\.(mid|midi)(?:[?#].*)?$/.test(value)) return 'midi';
  if (/\.(mp3|wav|ogg|m4a)(?:[?#].*)?$/.test(value) || String(asset?.mimeType || '').startsWith('audio/')) return 'audio';
  return '';
}

function renderAssetOptions(selectElement, category, selectedValue, emptyLabel) {
  const matching = assets.filter((asset) => {
    if (category === 'pokemon') return asset.category === 'pokemon';
    if (['audio', 'score', 'midi'].includes(category)) {
      return asset.category === category || (asset.category === 'question' && editorAssetKind(asset) === category);
    }
    return asset.category === category;
  });
  let html = `<option value="">${emptyLabel}</option>`;
  if (selectedValue && !matching.some(asset => asset.url === selectedValue)) {
    html += `<option value="${escapeHtml(selectedValue)}" selected>目前設定：${escapeHtml(selectedValue)}</option>`;
  }
  html += matching.map(asset =>
    `<option value="${escapeHtml(asset.url)}" ${asset.url === selectedValue ? 'selected' : ''}>${escapeHtml(asset.originalName)}</option>`
  ).join('');
  selectElement.innerHTML = html;
}

function updateReferenceAudio() {
  const q = questionBank[currentQIndex];
  if (!q || !q.referenceAudio) {
    referencePlayer.pause();
    referencePlayer.removeAttribute('src');
    referencePlayer.load();
    referencePlayer.style.display = 'none';
    return;
  }
  if (referencePlayer.getAttribute('src') !== q.referenceAudio) {
    referencePlayer.src = q.referenceAudio;
  }
  referencePlayer.style.display = 'block';
}

function desiredTimelineDuration() {
  const noteEnd = notes.reduce((max, note) => Math.max(max, Number(note.time) + Number(note.duration || 0)), 0);
  const audioEnd = referencePlayer.duration && Number.isFinite(referencePlayer.duration)
    ? Math.max(0, referencePlayer.duration * 1000 - (Number(inputAudioOffset.value) || 0))
    : 0;
  const needed = Math.max(60000, noteEnd + 10000, audioEnd + 5000);
  return Math.min(MAX_ALLOWED_DURATION_MS, Math.ceil(needed / 10000) * 10000);
}

function ensureTimelineFits() {
  const desired = desiredTimelineDuration();
  if (desired !== timelineDurationMs) {
    timelineDurationMs = desired;
    drawRuler();
  }
}

function loadQuestion(index) {
  currentQIndex = index;
  const q = questionBank[index];
  if (!q) return;
  q.pokemon = q.pokemon || { name: '未知寶可夢', evolutionType: 'three-stage-1', customPoints: 0, image: '' };
  q.pokemon.customPoints = Math.max(0, Number(q.pokemon.customPoints) || 0);
  q.referenceAudio = q.referenceAudio || '';
  q.referenceAudioOffsetMs = Number(q.referenceAudioOffsetMs) || 0;
  q.midiAsset = q.midiAsset || '';
  q.scoreAsset = q.scoreAsset || '';
  q.enabled = q.enabled !== false;

  inputSongName.value = q.songName || '';
  inputPkmnName.value = q.pokemon.name || '';
  selectPkmnEvo.value = q.pokemon.evolutionType || 'three-stage-1';
  inputPkmnCustomPoints.value = q.pokemon.customPoints || 0;
  pkmnCustomPointsWrap.style.display = selectPkmnEvo.value === 'custom' ? 'flex' : 'none';
  inputAudioOffset.value = q.referenceAudioOffsetMs;
  renderAssetOptions(selectPkmnImage, 'pokemon', q.pokemon.image || '', '尚未指定（捕捉時才顯示）');
  renderAssetOptions(selectReferenceAudio, 'audio', q.referenceAudio, '未指定參考音檔');
  renderAssetOptions(selectScoreAsset, 'score', q.scoreAsset, '未指定 MusicXML 素材');
  renderAssetOptions(selectMidiAsset, 'midi', q.midiAsset, '未指定 MIDI 素材');
  updateReferenceAudio();

  notes = (q.notes || []).map(n => {
    const dur = parseInt(n.duration) || 0;
    return {
      time: parseInt(n.time) || 0,
      direction: n.direction || 'left',
      pitch: n.pitch || 'C4',
      midiNote: Number.isFinite(Number(n.midiNote)) ? Number(n.midiNote) : pitchToMidi(n.pitch || 'C4'),
      duration: dur >= 300 ? dur : 0
    };
  }).sort((a, b) => a.time - b.time);

  currentTime = 0;
  selectedNoteIndex = -1;
  undoStack = [];
  redoStack = [];
  updateHistoryButtons();
  midiInfoBox.style.display = 'none';
  ensureTimelineFits();
  renderNotes();
  updatePlayheadPosition();
}

function saveCurrentToBank() {
  if (!questionBank[currentQIndex]) return;
  const q = questionBank[currentQIndex];
  q.songName = inputSongName.value.trim();
  q.pokemon = q.pokemon || {};
  q.pokemon.name = inputPkmnName.value.trim();
  q.pokemon.evolutionType = selectPkmnEvo.value;
  q.pokemon.customPoints = Math.max(0, Number(inputPkmnCustomPoints.value) || 0);
  q.pokemon.image = selectPkmnImage.value || '';
  q.referenceAudio = selectReferenceAudio.value || '';
  q.referenceAudioOffsetMs = parseInt(inputAudioOffset.value) || 0;
  q.scoreAsset = selectScoreAsset.value || '';
  q.midiAsset = selectMidiAsset.value || '';
  q.notes = [...notes];
}

function addNewSong() {
  saveCurrentToBank();
  const maxId = questionBank.reduce((max, q) => Math.max(max, q.id || 0), 0);
  questionBank.push({
    id: maxId + 1,
    songName: '新歌旋律',
    enabled: true,
    pokemon: { name: '未知寶可夢', evolutionType: 'three-stage-1', customPoints: 0, image: '' },
    referenceAudio: '',
    referenceAudioOffsetMs: 0,
    midiAsset: '',
    scoreAsset: '',
    multipleChoice: { options: ['', '', '', ''], correctIndex: 0 },
    notes: []
  });
  currentQIndex = questionBank.length - 1;
  markUnsaved();
  loadQuestion(currentQIndex);
  renderPlaylist();
}

function deleteSong(e, index) {
  e.stopPropagation();
  if (questionBank.length <= 1) {
    alert("至少要保留一題！");
    return;
  }
  if (confirm(`確定要刪除第 ${index + 1} 題嗎？`)) {
    questionBank.splice(index, 1);
    if (currentQIndex >= questionBank.length) currentQIndex = questionBank.length - 1;
    markUnsaved();
    loadQuestion(currentQIndex);
    renderPlaylist();
  }
}

btnAddSong.addEventListener('click', addNewSong);

function markUnsaved() {
  saveStatus.textContent = "未儲存";
  saveStatus.style.color = "#ff5757";
}

[inputSongName, inputPkmnName, selectPkmnEvo, inputPkmnCustomPoints, selectPkmnImage, selectReferenceAudio, inputAudioOffset, selectScoreAsset, selectMidiAsset].forEach(el => {
  const eventName = el.tagName === 'SELECT' ? 'change' : 'input';
  el.addEventListener(eventName, () => {
    saveCurrentToBank();
    markUnsaved();
    if (el === selectPkmnEvo) {
      pkmnCustomPointsWrap.style.display = selectPkmnEvo.value === 'custom' ? 'flex' : 'none';
    }
    if (el === selectReferenceAudio || el === inputAudioOffset) {
      updateReferenceAudio();
      ensureTimelineFits();
    }
    const titleEl = playlistContainer.children[currentQIndex]?.querySelector('.playlist-item-title');
    if (titleEl) {
      titleEl.innerHTML = `${currentQIndex + 1}. ${inputSongName.value} <br><span style="color:#aaa; font-size:10px;">(${inputPkmnName.value})</span>`;
    }
  });
});

referencePlayer.addEventListener('loadedmetadata', ensureTimelineFits);

btnSaveServer.addEventListener('click', async () => {
  saveCurrentToBank();
  try {
    const res = await fetch('/api/admin/questions/draft', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(questionBank)
    });
    if (res.status === 401) {
      location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
      return;
    }
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Save failed');
    questionBank = result.questions;
    saveStatus.textContent = "✅ 草稿已儲存；發布請到內容管理頁";
    saveStatus.style.color = "#2ECC71";
  } catch (e) {
    alert(`儲存失敗：${e.message}`);
  }
});

// =============================================================
// Timeline Ruler
// =============================================================
function drawRuler() {
  timelineRuler.innerHTML = '';
  const widthPx = timelineDurationMs / MS_PER_PX;
  timelineRuler.style.width = `${widthPx}px`;
  timelineTracks.style.width = `${widthPx}px`;
  
  for (let ms = 0; ms <= timelineDurationMs; ms += 500) {
    const xPos = ms / MS_PER_PX;
    const isMajor = (ms % 1000 === 0);
    const tick = document.createElement('div');
    tick.className = `tick-mark ${isMajor ? 'major' : ''}`;
    tick.style.left = `${xPos}px`;
    if (isMajor) {
      const text = document.createElement('span');
      text.className = 'tick-mark-text';
      text.textContent = `${ms / 1000}s`;
      tick.appendChild(text);
    }
    timelineRuler.appendChild(tick);
  }
}
drawRuler();

// =============================================================
// Audio Synth
// =============================================================
const PITCH_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

function midiNoteToPitch(midiNote) {
  const value = Math.max(0, Math.min(127, Math.round(Number(midiNote) || 0)));
  return `${PITCH_NAMES[value % 12]}${Math.floor(value / 12) - 1}`;
}

function pitchToMidi(pitch) {
  const match = String(pitch || '').match(/^([A-G])(#?)(-1|[0-9])$/);
  if (!match) return null;
  const pitchClass = PITCH_NAMES.indexOf(`${match[1]}${match[2]}`);
  return pitchClass < 0 ? null : (Number(match[3]) + 1) * 12 + pitchClass;
}

function midiToFrequency(midiNote) {
  return 440 * Math.pow(2, (Number(midiNote) - 69) / 12);
}

function populatePitchOptions() {
  const samplePitches = Object.keys(noteSampleMap).sort((a, b) => (pitchToMidi(a) ?? 999) - (pitchToMidi(b) ?? 999));
  const fallbackPitches = [];
  for (let midi = 36; midi <= 95; midi += 1) fallbackPitches.push(midiNoteToPitch(midi));
  const pitches = [...new Set([...samplePitches, ...fallbackPitches])];
  const current = selectPitch.value || 'C4';
  selectPitch.innerHTML = pitches.map((pitch) => {
    const hasSample = Boolean(noteSampleMap[pitch]);
    return `<option value="${pitch}" ${pitch === current ? 'selected' : ''}>${pitch}${hasSample ? ' ✓口琴' : '（缺音檔）'}</option>`;
  }).join('');
}

function getAudioContext() {
  return window.RhythmAudioEngine?.getContext();
}

function playNoteSynthFallback(pitch, durationMs = 180) {
  window.RhythmAudioEngine?.playNow(pitch, durationMs);
}

function playNoteSound(pitch, durationMs = 180) {
  window.RhythmAudioEngine?.playNow(pitch, durationMs);
}

// =============================================================
// Safe editing / history
// =============================================================
function cloneNotes(value = notes) {
  return value.map((note) => ({ ...note }));
}

function pushHistory() {
  undoStack.push(cloneNotes());
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack = [];
  updateHistoryButtons();
}

function updateHistoryButtons() {
  if (btnUndo) btnUndo.disabled = undoStack.length === 0;
  if (btnRedo) btnRedo.disabled = redoStack.length === 0;
  if (btnDeleteSelected) btnDeleteSelected.disabled = selectedNoteIndex < 0 || selectedNoteIndex >= notes.length;
}

function undoEdit() {
  if (!undoStack.length) return;
  redoStack.push(cloneNotes());
  notes = undoStack.pop();
  selectedNoteIndex = -1;
  markUnsaved();
  renderNotes();
  updateHistoryButtons();
}

function redoEdit() {
  if (!redoStack.length) return;
  undoStack.push(cloneNotes());
  notes = redoStack.pop();
  selectedNoteIndex = -1;
  markUnsaved();
  renderNotes();
  updateHistoryButtons();
}

function setEditorMode(mode) {
  editorMode = mode === 'add' ? 'add' : 'select';
  btnSelectMode?.classList.toggle('editor-mode-active', editorMode === 'select');
  btnAddMode?.classList.toggle('editor-mode-active', editorMode === 'add');
  timelineContainer?.classList.toggle('add-note-mode', editorMode === 'add');
}

function deleteSelectedNote() {
  if (selectedNoteIndex < 0 || selectedNoteIndex >= notes.length) return;
  pushHistory();
  notes.splice(selectedNoteIndex, 1);
  selectedNoteIndex = -1;
  markUnsaved();
  renderNotes();
}

btnSelectMode?.addEventListener('click', () => setEditorMode('select'));
btnAddMode?.addEventListener('click', () => setEditorMode('add'));
btnUndo?.addEventListener('click', undoEdit);
btnRedo?.addEventListener('click', redoEdit);
btnDeleteSelected?.addEventListener('click', deleteSelectedNote);
window.addEventListener('keydown', (event) => {
  const target = event.target;
  if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    event.shiftKey ? redoEdit() : undoEdit();
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
    event.preventDefault();
    redoEdit();
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    deleteSelectedNote();
  } else if (event.key.toLowerCase() === 'a' && !event.ctrlKey && !event.metaKey) {
    setEditorMode('add');
  } else if (event.key === 'Escape') {
    selectedNoteIndex = -1;
    setEditorMode('select');
    renderNotes();
  }
});
setEditorMode('select');
updateHistoryButtons();

// =============================================================
// Timeline click, drag-to-move, and drag-to-resize
// =============================================================
let isResizing = false;
let isDraggingNote = false;

const DIRECTION_ORDER = ['left', 'down', 'up', 'right'];

function noteWidthPx(note) {
  return note.duration && note.duration >= 300
    ? Math.max(24, Number(note.duration) / MS_PER_PX)
    : 24;
}

function updateNoteNodeHorizontalPosition(note, node) {
  if (!node) return;
  const width = noteWidthPx(note);
  node.style.width = `${width}px`;
  node.style.left = `${(Number(note.time) / MS_PER_PX) + (width / 2)}px`;
}

function directionAtClientY(clientY) {
  for (const row of trackRows) {
    const rect = row.getBoundingClientRect();
    if (clientY >= rect.top && clientY <= rect.bottom) {
      return row.getAttribute('data-direction');
    }
  }
  return null;
}

function moveNoteNodeToDirection(note, node, direction) {
  if (!node || !DIRECTION_ORDER.includes(direction)) return;
  const row = document.querySelector(`.timeline-track-row[data-direction="${direction}"]`);
  if (!row) return;
  note.direction = direction;
  DIRECTION_ORDER.forEach(dir => node.classList.remove(dir));
  node.classList.add(direction);
  row.appendChild(node);
}

const trackRows = document.querySelectorAll('.timeline-track-row');
trackRows.forEach(row => {
  row.addEventListener('click', (e) => {
    if (isResizing || isDraggingNote) return;
    if (e.target.classList.contains('timeline-track-label')) return;
    if (e.target.closest('.editor-note')) return;
    if (editorMode !== 'add') {
      selectedNoteIndex = -1;
      renderNotes();
      return;
    }

    const rect = row.getBoundingClientRect();
    const clickX = e.clientX - rect.left + timelineContainer.scrollLeft;
    let targetTime = clickX * MS_PER_PX;
    targetTime = Math.round(targetTime / SNAP_MS) * SNAP_MS;
    if (targetTime < 0 || targetTime > timelineDurationMs) return;

    const direction = row.getAttribute('data-direction');
    const pitch = selectPitch.value;
    const duration = parseInt(selectDuration.value) || 0;

    pushHistory();
    notes.push({ time: targetTime, direction, pitch, midiNote: pitchToMidi(pitch), duration });
    notes.sort((a, b) => a.time - b.time);
    
    playNoteSound(pitch, duration);
    markUnsaved();
    renderNotes();
  });
});

function renderNotes() {
  ensureTimelineFits();
  document.querySelectorAll('.editor-note').forEach(el => el.remove());
  renderedNoteNodes = new Map();
  
  notes.forEach((note, index) => {
    const row = document.querySelector(`.timeline-track-row[data-direction="${note.direction}"]`);
    if (!row) return;
    
    const noteNode = document.createElement('div');
    noteNode.className = `editor-note ${note.direction}${index === selectedNoteIndex ? ' selected' : ''}`;
    
    // Handle width for long notes (only if duration >= 300ms)
    const isLongNote = note.duration && note.duration >= 300;
    updateNoteNodeHorizontalPosition(note, noteNode);
    renderedNoteNodes.set(note, noteNode);
    
    // Head: click to select; drag to move time/lane; Shift+drag moves this note and all later notes in time.
    const headNode = document.createElement('div');
    headNode.className = 'editor-note-head';
    headNode.title = `${note.direction.toUpperCase()} | ${note.pitch} | MIDI ${note.midiNote ?? pitchToMidi(note.pitch)} | ${note.time}ms ${isLongNote ? '| dur:' + note.duration + 'ms' : ''}\n拖曳：移動單一音符的時間或箭頭列\nShift+拖曳：此音起所有後續音符一起前後移\nDelete：刪除選取`;
    headNode.textContent = note.pitch;

    headNode.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || isResizing) return;
      e.stopPropagation();
      e.preventDefault();

      setEditorMode('select');
      selectedNoteIndex = notes.indexOf(note);
      document.querySelectorAll('.editor-note.selected').forEach(el => el.classList.remove('selected'));
      noteNode.classList.add('selected');
      updateHistoryButtons();

      const startX = e.clientX;
      const startY = e.clientY;
      const anchorStartTime = Number(note.time) || 0;
      const moveWholeTail = e.shiftKey;
      // "一整段" means the anchor note plus every note at the same time or later.
      const movingNotes = moveWholeTail
        ? notes.filter(item => (Number(item.time) || 0) >= anchorStartTime)
        : [note];
      const startingTimes = new Map(movingNotes.map(item => [item, Number(item.time) || 0]));
      const earliestStart = Math.min(...movingNotes.map(item => startingTimes.get(item)));
      const latestEnd = Math.max(...movingNotes.map(item => startingTimes.get(item) + Math.max(0, Number(item.duration) || 0)));

      let dragStarted = false;
      let historyPushed = false;
      const startDirection = note.direction;

      const ensureDragHistory = () => {
        if (historyPushed) return;
        pushHistory();
        historyPushed = true;
      };

      const onMouseMove = (moveEvent) => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        if (!dragStarted && Math.hypot(dx, dy) < 3) return;

        dragStarted = true;
        isDraggingNote = true;
        ensureDragHistory();
        noteNode.classList.add('dragging');
        if (moveWholeTail) {
          movingNotes.forEach(item => renderedNoteNodes.get(item)?.classList.add('group-moving'));
        }

        let targetAnchorTime = Math.round((anchorStartTime + dx * MS_PER_PX) / SNAP_MS) * SNAP_MS;
        let deltaMs = targetAnchorTime - anchorStartTime;
        deltaMs = Math.max(deltaMs, -earliestStart);
        deltaMs = Math.min(deltaMs, MAX_ALLOWED_DURATION_MS - latestEnd);

        movingNotes.forEach(item => {
          item.time = startingTimes.get(item) + deltaMs;
          updateNoteNodeHorizontalPosition(item, renderedNoteNodes.get(item));
        });

        // Vertical dragging changes only the anchor note's arrow lane; pitch/audio stays unchanged.
        const targetDirection = directionAtClientY(moveEvent.clientY);
        if (targetDirection && targetDirection !== note.direction) {
          moveNoteNodeToDirection(note, noteNode, targetDirection);
        }
      };

      const onMouseUp = () => {
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);

        if (dragStarted) {
          notes.sort((a, b) => a.time - b.time);
          selectedNoteIndex = notes.indexOf(note);
          markUnsaved();
          ensureTimelineFits();
          renderNotes();
        } else {
          // Pure click: just select the note.
          selectedNoteIndex = notes.indexOf(note);
          renderNotes();
          updateHistoryButtons();
        }
        isDraggingNote = false;
      };

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    });
    
    noteNode.appendChild(headNode);

    // Resize Handle (Drag to extend duration)
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'editor-note-resize-handle';
    resizeHandle.title = "拖曳調整長度";
    
    resizeHandle.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      isResizing = true;
      pushHistory();
      selectedNoteIndex = index;
      let startX = e.clientX;
      let startDuration = note.duration || 0;
      
      const onMouseMove = (moveEvent) => {
        const dx = moveEvent.clientX - startX;
        const addMs = dx * MS_PER_PX;
        let newDur = Math.round((startDuration + addMs) / SNAP_MS) * SNAP_MS;
        if (newDur < 0) newDur = 0;
        
        note.duration = newDur >= 300 ? newDur : 0;
        
        // live update visual
        let curW = note.duration >= 300 ? Math.max(24, note.duration / MS_PER_PX) : 24;
        noteNode.style.width = `${curW}px`;
        noteNode.style.left = `${(note.time / MS_PER_PX) + (curW / 2)}px`;
      };
      
      const onMouseUp = () => {
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        setTimeout(() => isResizing = false, 50); // delay reset
        markUnsaved();
        renderNotes(); // re-sort or clean up
      };
      
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    });
    
    noteNode.appendChild(resizeHandle);
    row.appendChild(noteNode);
  });
  updateHistoryButtons();
}

btnClearAll.addEventListener('click', () => {
  if (confirm("確認要清空時間軸上所有音符嗎？可使用「復原」恢復。")) {
    pushHistory();
    notes = [];
    selectedNoteIndex = -1;
    markUnsaved();
    renderNotes();
  }
});

// =============================================================
// Playback Animation Loop
// =============================================================
btnPlayPause.addEventListener('click', () => {
  if (isPlaying) { pausePlayback(); } else { startPlayback(); }
});
btnStop.addEventListener('click', stopPlayback);

function startPlayback() {
  window.RhythmAudioEngine?.unlock().catch(() => {});
  isPlaying = true;
  lastLocalTime = performance.now();
  btnPlayPause.textContent = '暫停';

  if (syncReference.checked && referencePlayer.getAttribute('src')) {
    const audioTime = Math.max(0, (currentTime + (Number(inputAudioOffset.value) || 0)) / 1000);
    try {
      referencePlayer.currentTime = Math.min(audioTime, referencePlayer.duration || audioTime);
      referencePlayer.play().catch(() => {});
    } catch (_) {}
  }
  requestAnimationFrame(playbackStep);
}

function pausePlayback() {
  isPlaying = false;
  referencePlayer.pause();
  btnPlayPause.textContent = '播放 / 暫停';
}

function stopPlayback() {
  isPlaying = false;
  currentTime = 0;
  referencePlayer.pause();
  if (referencePlayer.getAttribute('src')) {
    const offsetSeconds = Math.max(0, (Number(inputAudioOffset.value) || 0) / 1000);
    try { referencePlayer.currentTime = Math.min(offsetSeconds, referencePlayer.duration || offsetSeconds); } catch (_) {}
  }
  btnPlayPause.textContent = '播放 / 暫停';
  updatePlayheadPosition();
}

function playbackStep(timestamp) {
  if (!isPlaying) return;
  const now = performance.now();
  const elapsed = now - lastLocalTime;
  lastLocalTime = now;
  const prevTime = currentTime;
  currentTime += elapsed;
  if (currentTime > timelineDurationMs) { stopPlayback(); return; }
  updatePlayheadPosition();
  
  notes.forEach(note => {
    if (prevTime < note.time && note.time <= currentTime) {
      playNoteSound(note.pitch, note.duration);
    }
  });
  
  requestAnimationFrame(playbackStep);
}

function updatePlayheadPosition() {
  const xPos = currentTime / MS_PER_PX;
  playhead.style.left = `${xPos}px`;
  currentTimeLbl.textContent = Math.round(currentTime);
  const buffer = 150;
  const containerLeft = timelineContainer.scrollLeft;
  const containerWidth = timelineContainer.clientWidth;
  if (xPos > containerLeft + containerWidth - buffer) {
    timelineContainer.scrollLeft = xPos - containerWidth + buffer;
  } else if (xPos < containerLeft) {
    timelineContainer.scrollLeft = xPos;
  }
}

// =============================================================
// MIDI Import Feature — JS Parser with NoteOff Matching
// =============================================================

function assignDirection(midiNote, index, mode, pitchMin, pitchMax) {
  const DIRS = ['left', 'down', 'up', 'right'];
  if (mode === 'round-robin') return DIRS[index % 4];
  if (mode === 'pitch-mod4') {
    return DIRS[Math.abs(Math.round(midiNote)) % 4];
  }
  const range = pitchMax - pitchMin || 1;
  const normalized = (midiNote - pitchMin) / range;
  if (normalized < 0.25) return 'left';
  if (normalized < 0.5) return 'down';
  if (normalized < 0.75) return 'up';
  return 'right';
}

class MidiReader {
  constructor(buffer) {
    this.view = new DataView(buffer);
    this.offset = 0;
  }
  readUint8() { return this.view.getUint8(this.offset++); }
  readUint16() { const v = this.view.getUint16(this.offset, false); this.offset += 2; return v; }
  readUint32() { const v = this.view.getUint32(this.offset, false); this.offset += 4; return v; }
  readBytes(n) { const a = []; for (let i = 0; i < n; i++) a.push(this.readUint8()); return a; }
  readVarLen() {
    let val = 0, b;
    do { b = this.readUint8(); val = (val << 7) | (b & 0x7F); } while (b & 0x80);
    return val;
  }
  readString(n) { return String.fromCharCode(...this.readBytes(n)); }
  skip(n) { this.offset += n; }
  peek() { return this.view.getUint8(this.offset); }
}

function parseMidi(buffer) {
  const r = new MidiReader(buffer);
  if (r.view.byteLength < 14) throw new Error('MIDI 檔案過小');
  if (r.readString(4) !== 'MThd') throw new Error('不是有效的 MIDI 檔案');

  const headerLen = r.readUint32();
  const format = r.readUint16();
  const numTracks = r.readUint16();
  const timeDivision = r.readUint16();
  if (timeDivision & 0x8000) {
    throw new Error('目前不支援 SMPTE time division；請由 MuseScore 重新匯出一般 MIDI，或改用 MusicXML。');
  }
  if (headerLen > 6) r.skip(headerLen - 6);

  const tracks = [];
  const trackNames = [];
  for (let t = 0; t < numTracks; t++) {
    if (r.offset + 8 > r.view.byteLength) break;
    if (r.readString(4) !== 'MTrk') {
      const skipLen = r.readUint32();
      r.skip(skipLen);
      continue;
    }

    const chunkLen = r.readUint32();
    const chunkEnd = Math.min(r.offset + chunkLen, r.view.byteLength);
    const events = [];
    let tick = 0;
    let lastStatus = 0;
    let trackName = `Track ${t + 1}`;

    try {
      while (r.offset < chunkEnd) {
        tick += r.readVarLen();
        let status = r.peek();
        if (status & 0x80) {
          status = r.readUint8();
          if (status < 0xF0) lastStatus = status;
        } else {
          status = lastStatus;
        }
        if (!status) throw new Error('無有效 running status');

        const type = status & 0xF0;
        const channel = status & 0x0F;
        if (type === 0x80 || type === 0x90) {
          const note = r.readUint8();
          const velocity = r.readUint8();
          const isNoteOn = type === 0x90 && velocity > 0;
          events.push({ tick, type: isNoteOn ? 'noteOn' : 'noteOff', note, channel, velocity });
        } else if (type === 0xA0 || type === 0xB0 || type === 0xE0) {
          r.skip(2);
        } else if (type === 0xC0 || type === 0xD0) {
          r.skip(1);
        } else if (status === 0xF0 || status === 0xF7) {
          r.skip(r.readVarLen());
        } else if (status === 0xFF) {
          const metaType = r.readUint8();
          const metaLen = r.readVarLen();
          if (metaType === 0x51 && metaLen === 3) {
            const tempo = (r.readUint8() << 16) | (r.readUint8() << 8) | r.readUint8();
            events.push({ tick, type: 'tempo', tempo });
          } else if (metaType === 0x03) {
            const bytes = r.readBytes(metaLen);
            try { trackName = new TextDecoder('utf-8').decode(new Uint8Array(bytes)) || trackName; } catch (_) {}
          } else {
            r.skip(metaLen);
          }
        } else {
          throw new Error(`未知 MIDI 狀態 0x${status.toString(16)}`);
        }
      }
    } catch (error) {
      console.warn(`Track ${t + 1} parsing stopped:`, error);
    }
    r.offset = chunkEnd;
    tracks.push(events);
    trackNames.push(trackName);
  }
  return { format, timeDivision, tracks, trackNames, sourceType: 'midi' };
}

function musicXmlPitchToMidi(noteElement) {
  const pitch = noteElement.querySelector(':scope > pitch');
  if (!pitch) return null;
  const step = pitch.querySelector(':scope > step')?.textContent?.trim();
  const octave = Number(pitch.querySelector(':scope > octave')?.textContent);
  const alter = Number(pitch.querySelector(':scope > alter')?.textContent || 0);
  const semitones = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  if (!(step in semitones) || !Number.isFinite(octave)) return null;
  return Math.max(0, Math.min(127, (octave + 1) * 12 + semitones[step] + alter));
}

function parseMusicXml(xmlText) {
  const xml = new DOMParser().parseFromString(xmlText, 'application/xml');
  const parserError = xml.querySelector('parsererror');
  if (parserError) throw new Error('MusicXML 解析失敗：請確認使用未壓縮 .musicxml 或 .xml，而不是 .mxl。');
  const scoreRoot = xml.querySelector('score-partwise, score-timewise');
  if (!scoreRoot) throw new Error('檔案不是可辨識的 MusicXML score-partwise／score-timewise。');
  if (scoreRoot.tagName === 'score-timewise') throw new Error('目前請由 MuseScore 匯出 score-partwise MusicXML。');

  const PPQ = 480;
  const partNames = new Map();
  xml.querySelectorAll('part-list > score-part').forEach((part) => {
    const id = part.getAttribute('id');
    const name = part.querySelector('part-name')?.textContent?.trim() || id || '聲部';
    if (id) partNames.set(id, name);
  });

  const tracks = [];
  const trackNames = [];
  let globalTempoEvents = [];
  const parts = [...xml.querySelectorAll('score-partwise > part')];
  parts.forEach((part, partIndex) => {
    const events = [];
    let absoluteTick = 0;
    let divisions = 1;
    let lastNoteStart = 0;
    const openTies = new Map();
    const measures = [...part.querySelectorAll(':scope > measure')];

    measures.forEach((measure) => {
      let cursor = absoluteTick;
      let measureMax = absoluteTick;
      const children = [...measure.children];
      for (const node of children) {
        const tag = node.tagName;
        if (tag === 'attributes') {
          const d = Number(node.querySelector(':scope > divisions')?.textContent);
          if (Number.isFinite(d) && d > 0) divisions = d;
        } else if (tag === 'direction') {
          const soundTempo = Number(node.querySelector('sound[tempo]')?.getAttribute('tempo'));
          const metronomeTempo = Number(node.querySelector('metronome > per-minute')?.textContent);
          const tempo = Number.isFinite(soundTempo) && soundTempo > 0 ? soundTempo : metronomeTempo;
          if (Number.isFinite(tempo) && tempo > 0) {
            const tempoEvent = { tick: Math.round(cursor), type: 'tempo', tempo: Math.round(60000000 / tempo) };
            events.push(tempoEvent);
            if (partIndex === 0) globalTempoEvents.push(tempoEvent);
          }
        } else if (tag === 'backup' || tag === 'forward') {
          const duration = Number(node.querySelector(':scope > duration')?.textContent || 0);
          const delta = (duration / divisions) * PPQ;
          cursor += tag === 'backup' ? -delta : delta;
          cursor = Math.max(absoluteTick, cursor);
        } else if (tag === 'note') {
          const durationUnits = Number(node.querySelector(':scope > duration')?.textContent || 0);
          const durationTicks = Math.max(0, (durationUnits / divisions) * PPQ);
          const isChord = Boolean(node.querySelector(':scope > chord'));
          const isGrace = Boolean(node.querySelector(':scope > grace'));
          const isRest = Boolean(node.querySelector(':scope > rest'));
          const startTick = isChord ? lastNoteStart : cursor;
          if (!isRest) {
            const midiNote = musicXmlPitchToMidi(node);
            if (midiNote !== null) {
              const effectiveDuration = isGrace ? Math.max(30, PPQ / 8) : Math.max(1, durationTicks);
              const voice = node.querySelector(':scope > voice')?.textContent?.trim() || '1';
              const tieTypes = [...node.querySelectorAll(':scope > tie')].map((tie) => tie.getAttribute('type'));
              const tieStart = tieTypes.includes('start');
              const tieStop = tieTypes.includes('stop');
              const tieKey = `${voice}:${midiNote}`;
              const continuingTie = tieStop && openTies.has(tieKey);

              if (!continuingTie) {
                events.push({ tick: Math.round(startTick), type: 'noteOn', note: midiNote, channel: 0, velocity: 100 });
              }
              if (tieStart) {
                openTies.set(tieKey, true);
              } else {
                events.push({ tick: Math.round(startTick + effectiveDuration), type: 'noteOff', note: midiNote, channel: 0, velocity: 0 });
                openTies.delete(tieKey);
              }
            }
          }
          lastNoteStart = startTick;
          if (!isChord && !isGrace) cursor += durationTicks;
          measureMax = Math.max(measureMax, cursor, startTick + durationTicks);
        }
      }
      absoluteTick = Math.max(absoluteTick, measureMax);
    });

    events.sort((a, b) => a.tick - b.tick || (a.type === 'noteOff' ? 1 : -1));
    tracks.push(events);
    trackNames.push(partNames.get(part.getAttribute('id')) || `聲部 ${partIndex + 1}`);
  });

  if (!tracks.length) throw new Error('MusicXML 中找不到任何聲部。');
  if (!globalTempoEvents.length) globalTempoEvents = [{ tick: 0, type: 'tempo', tempo: 500000 }];
  // Ensure every conversion sees the score tempo map, even if the selected part is not the first part.
  tracks[0] = [...globalTempoEvents, ...tracks[0]].sort((a, b) => a.tick - b.tick);
  return { format: 'musicxml', timeDivision: PPQ, tracks, trackNames, sourceType: 'musicxml' };
}

function convertMidiToNotes(midiData, selectedTrackIndices, config) {
  const { timeDivision, tracks } = midiData;
  const { offsetMs, minGapMs, dirMode, keepLongNotes } = config;

  const tempoByTick = new Map([[0, 500000]]);
  tracks.forEach((track) => {
    track.forEach((event) => {
      if (event.type === 'tempo' && Number.isFinite(event.tempo)) tempoByTick.set(event.tick, event.tempo);
    });
  });
  const tempoMap = [...tempoByTick.entries()]
    .map(([tick, tempo]) => ({ tick: Number(tick), tempo }))
    .sort((a, b) => a.tick - b.tick);

  function ticksToMs(targetTick) {
    let ms = 0;
    let prevTick = 0;
    let curTempo = 500000;
    for (const seg of tempoMap) {
      if (seg.tick > targetTick) break;
      if (seg.tick > prevTick) {
        ms += ((seg.tick - prevTick) / timeDivision) * (curTempo / 1000);
        prevTick = seg.tick;
      }
      curTempo = seg.tempo;
    }
    if (targetTick > prevTick) ms += ((targetTick - prevTick) / timeDivision) * (curTempo / 1000);
    return ms;
  }

  const rawNotes = [];
  selectedTrackIndices.forEach((trackIndex) => {
    const track = tracks[trackIndex];
    if (!track) return;
    const pendingNotes = new Map();
    track.forEach((event) => {
      const key = `${event.channel ?? 0}:${event.note}`;
      if (event.type === 'noteOn') {
        if (!pendingNotes.has(key)) pendingNotes.set(key, []);
        pendingNotes.get(key).push(event.tick);
      } else if (event.type === 'noteOff') {
        const queue = pendingNotes.get(key);
        if (!queue?.length) return;
        const startTick = queue.shift();
        const startMs = ticksToMs(startTick);
        const endMs = ticksToMs(event.tick);
        rawNotes.push({
          timeMs: Math.max(0, Math.round(startMs)),
          midiNote: event.note,
          durationMs: Math.max(0, Math.round(endMs - startMs)),
          trackIndex
        });
      }
    });
  });

  rawNotes.sort((a, b) => a.timeMs - b.timeMs || a.midiNote - b.midiNote);
  if (!rawNotes.length) return [];

  const pitchMin = Math.min(...rawNotes.map((note) => note.midiNote));
  const pitchMax = Math.max(...rawNotes.map((note) => note.midiNote));
  const dedupeThreshold = Math.max(0, Number(minGapMs) || 0);
  const lastSamePitch = new Map();
  const kept = [];
  rawNotes.forEach((note) => {
    const previous = lastSamePitch.get(note.midiNote);
    // Only remove duplicate copies of the same pitch at virtually the same onset.
    // Fast different notes and legitimate repeated notes beyond this tiny tolerance are retained.
    if (Number.isFinite(previous) && note.timeMs - previous <= dedupeThreshold) return;
    lastSamePitch.set(note.midiNote, note.timeMs);
    kept.push(note);
  });

  return kept.map((note, index) => {
    const pitch = midiNoteToPitch(note.midiNote);
    const direction = assignDirection(note.midiNote, index, dirMode, pitchMin, pitchMax);
    return {
      time: note.timeMs + offsetMs,
      direction,
      pitch,
      midiNote: note.midiNote,
      duration: keepLongNotes && note.durationMs >= 300 ? note.durationMs : 0
    };
  });
}

function renderMidiAudit(allMidiNotes) {
  const counts = new Map();
  allMidiNotes.forEach((midi) => counts.set(midi, (counts.get(midi) || 0) + 1));
  const rows = [...counts.entries()].sort((a, b) => a[0] - b[0]);
  if (!rows.length) {
    midiAuditTable.innerHTML = '';
    return;
  }
  midiAuditTable.innerHTML = `
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr><th style="text-align:left">MIDI 原始值</th><th style="text-align:left">精確音名</th><th style="text-align:left">次數</th><th style="text-align:left">口琴音檔</th></tr></thead>
      <tbody>${rows.map(([midi, count]) => {
        const pitch = midiNoteToPitch(midi);
        return `<tr style="border-top:1px solid #333"><td>${midi}</td><td>${pitch}</td><td>${count}</td><td style="color:${noteSampleMap[pitch] ? '#2ECC71' : '#ff5757'}">${noteSampleMap[pitch] ? '已對應' : '缺少'}</td></tr>`;
      }).join('')}</tbody>
    </table>`;
}

// ==== MusicXML / MIDI UI Bindings ====
let loadedMidiFile = null;

async function loadAssetIntoImporter(url, fallbackName) {
  if (!url) {
    alert('請先選擇一個素材檔案。');
    return;
  }
  try {
    midiStatus.textContent = '🔄 正在載入後台譜面素材…';
    const response = await fetch(url);
    if (!response.ok) throw new Error('下載譜面素材失敗');
    const blob = await response.blob();
    const name = assets.find((asset) => asset.url === url)?.originalName || fallbackName;
    const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
    loadMidiFile(file);
    midiOverlay.style.display = 'flex';
  } catch (error) {
    alert(error.message);
  }
}

btnLoadScoreAsset?.addEventListener('click', () => loadAssetIntoImporter(selectScoreAsset.value, 'score.musicxml'));
btnLoadMidiAsset.addEventListener('click', () => loadAssetIntoImporter(selectMidiAsset.value, 'uploaded.mid'));

btnOpenMidi.addEventListener('click', () => midiOverlay.style.display = 'flex');
btnMidiClose.addEventListener('click', () => {
  midiOverlay.style.display = 'none';
  parsedMidiData = null;
  midiTrackSection.style.display = 'none';
  btnMidiConfirm.style.display = 'none';
  midiStatus.textContent = '';
});

midiDropZone.addEventListener('click', () => midiFileInput.click());
midiDropZone.addEventListener('dragover', (event) => { event.preventDefault(); midiDropZone.style.borderColor = 'var(--color-left)'; });
midiDropZone.addEventListener('dragleave', () => { midiDropZone.style.borderColor = 'var(--primary-color)'; });
midiDropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  midiDropZone.style.borderColor = 'var(--primary-color)';
  if (event.dataTransfer.files[0]) loadMidiFile(event.dataTransfer.files[0]);
});
midiFileInput.addEventListener('change', () => { if (midiFileInput.files[0]) loadMidiFile(midiFileInput.files[0]); });

function loadMidiFile(file) {
  const lowerName = String(file?.name || '').toLowerCase();
  if (!/\.(mid|midi|musicxml|xml)$/.test(lowerName)) {
    midiStatus.textContent = '❌ 僅支援 .musicxml、.xml、.mid、.midi。若是 .mxl，請由 MuseScore 改匯出未壓縮 MusicXML。';
    return;
  }
  loadedMidiFile = file;
  parsedMidiData = null;
  midiTrackSection.style.display = 'none';
  btnMidiConfirm.style.display = 'none';
  midiStatus.textContent = `已選取：${file.name}`;
  midiDropZone.querySelector('p').textContent = `✅ ${file.name}`;
}

async function parseLoadedNotationFile() {
  if (!loadedMidiFile) return;
  midiStatus.textContent = '🔄 解析中...';
  const lowerName = loadedMidiFile.name.toLowerCase();
  if (lowerName.endsWith('.musicxml') || lowerName.endsWith('.xml')) {
    parsedMidiData = parseMusicXml(await loadedMidiFile.text());
  } else {
    parsedMidiData = parseMidi(await loadedMidiFile.arrayBuffer());
  }
}

btnMidiParse.addEventListener('click', async () => {
  if (!loadedMidiFile) return;
  try {
    await parseLoadedNotationFile();
    const sourceLabel = parsedMidiData.sourceType === 'musicxml' ? 'MusicXML' : 'MIDI';
    midiStatus.textContent = `✅ ${sourceLabel} 解析成功！共 ${parsedMidiData.tracks.length} 個聲部／軌道`;
    const allMidiNotes = parsedMidiData.tracks.flatMap((track) => track.filter((event) => event.type === 'noteOn').map((event) => event.note));
    if (allMidiNotes.length) {
      const minNote = Math.min(...allMidiNotes);
      const maxNote = Math.max(...allMidiNotes);
      midiPitchRange.textContent = `${midiNoteToPitch(minNote)} ～ ${midiNoteToPitch(maxNote)}`;
    } else {
      midiPitchRange.textContent = '未偵測到音符';
    }
    renderMidiAudit(allMidiNotes);
    midiTracksList.innerHTML = '';

    let hasSelected = false;
    parsedMidiData.tracks.forEach((events, trackIndex) => {
      const noteOns = events.filter((event) => event.type === 'noteOn');
      const item = document.createElement('div');
      item.className = noteOns.length > 0 && !hasSelected ? 'midi-track-item selected' : 'midi-track-item';
      if (noteOns.length > 0 && !hasSelected) hasSelected = true;
      item.dataset.trackIndex = trackIndex;
      const name = parsedMidiData.trackNames?.[trackIndex] || `${sourceLabel} ${trackIndex + 1}`;
      item.innerHTML = `<span style="font-weight:bold;">${escapeHtml(name)}</span> <span class="text-gold" style="font-size:10px;">${noteOns.length} 音符</span>`;
      if (!noteOns.length) item.style.opacity = '0.5';
      item.addEventListener('click', () => item.classList.toggle('selected'));
      midiTracksList.appendChild(item);
    });

    if (!hasSelected) midiStatus.textContent = `⚠️ ${sourceLabel} 中沒有偵測到可用音符`;
    midiTrackSection.style.display = 'block';
    btnMidiConfirm.style.display = 'block';
  } catch (error) {
    parsedMidiData = null;
    midiStatus.textContent = `❌ 解析失敗：${error.message}`;
  }
});

btnMidiConfirm.addEventListener('click', () => {
  if (!parsedMidiData) return;
  const selectedItems = midiTracksList.querySelectorAll('.midi-track-item.selected');
  if (!selectedItems.length) {
    alert('請至少選擇一個聲部／軌道！');
    return;
  }

  const selectedIndices = [...selectedItems].map((element) => Number(element.dataset.trackIndex));
  const config = {
    offsetMs: Number(midiOffsetInput.value) || 0,
    minGapMs: Math.max(0, Number(midiMinGapInput.value) || 0),
    dirMode: midiDirMode.value,
    keepLongNotes: midiKeepLongNotes.checked
  };
  const converted = convertMidiToNotes(parsedMidiData, selectedIndices, config);
  if (!converted.length) {
    midiStatus.textContent = '⚠️ 未能轉換出音符';
    return;
  }

  pushHistory();
  if (notes.length > 0) {
    const replaceAll = confirm(`偵測到現有 ${notes.length} 個音符。\n\n確定：用匯入結果「取代」目前譜面\n取消：把匯入結果「追加」到譜面結尾`);
    if (replaceAll) {
      notes = converted;
    } else {
      const lastTime = Math.max(...notes.map((note) => note.time + (note.duration || 0)), 0);
      converted.forEach((note) => { note.time += lastTime + 2000; });
      notes = [...notes, ...converted].sort((a, b) => a.time - b.time);
    }
  } else {
    notes = converted;
  }
  selectedNoteIndex = -1;

  const sourceLabel = parsedMidiData.sourceType === 'musicxml' ? 'MusicXML' : 'MIDI';
  midiStatus.textContent = `✅ 匯入 ${converted.length} 個音符！`;
  midiInfoBox.style.display = 'block';
  const missingPitches = [...new Set(converted.map((note) => note.pitch).filter((pitch) => !noteSampleMap[pitch]))];
  midiInfoContent.innerHTML = `來源：${escapeHtml(loadedMidiFile?.name || sourceLabel)}（${sourceLabel}）<br>匯入音符：${converted.length}<br>時間範圍：${converted[0].time}～${converted[converted.length - 1].time} ms<br>音高：依檔案原始書面／MIDI 音高精確換算，不做鄰近音吸附。<br>${missingPitches.length ? `<span style="color:#ff5757">缺少口琴音檔：${missingPitches.join('、')}</span>` : '<span style="color:#2ECC71">所有音高均有口琴錄音</span>'}<br>請使用同步播放和參考題目音檔逐段比對。`;
  saveCurrentToBank();
  markUnsaved();
  renderNotes();
  updateHistoryButtons();
  setTimeout(() => { midiOverlay.style.display = 'none'; }, 800);
});

editorSocket.on('connect', () => editorSocket.emit('admin-join'));
editorSocket.on('auth-error', () => {
  location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
});
editorSocket.on('content-updated', (event) => {
  if (event.type === 'draft-saved') {
    saveStatus.textContent = '⚠️ 題庫已由另一個後台更新；請先儲存或重新整理';
    saveStatus.style.color = '#F4D03F';
  }
});
editorSocket.on('assets-updated', async () => {
  try {
    const response = await fetch('/api/admin/assets');
    if (response.ok) {
      assets = await response.json();
      const noteResponse = await fetch('/api/note-library');
      if (noteResponse.ok) {
        const noteLibrary = await noteResponse.json();
        noteSampleMap = noteLibrary.map || {};
        window.RhythmAudioEngine?.setSampleMap(noteSampleMap);
        populatePitchOptions();
      }
      loadQuestion(currentQIndex);
    }
  } catch (_) {}
});

window.addEventListener('beforeunload', (event) => {
  if (saveStatus.textContent === '未儲存') {
    event.preventDefault();
    event.returnValue = '';
  }
});

// Boot editor
fetchQuestions();
