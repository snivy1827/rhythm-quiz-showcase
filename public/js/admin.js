const socket = io();
let gameState = null;

const $ = (id) => document.getElementById(id);
const adminRoomId = $('admin-room-id');
const adminTeamNames = $('admin-team-names');
const adminPerfectWindow = $('admin-perfect-window');
const adminGoodWindow = $('admin-good-window');
const btnSetupRoom = $('btn-setup-room');
const connectionStatusPanel = $('connection-status-panel');
const adminStatusLbl = $('admin-status-lbl');
const adminQuestionLbl = $('admin-question-lbl');
const btnPrimaryFlow = $('btn-primary-flow');
const adminRulesPanel = $('admin-rules-panel');
const adminRulesPageLabel = $('admin-rules-page-label');
const adminRulesPageSelect = $('admin-rules-page-select');
const btnRulesPrev = $('btn-rules-prev');
const btnRulesNext = $('btn-rules-next');
const btnRulesFinish = $('btn-rules-finish');
const flowHint = $('flow-hint');
const adminJudgingPanel = $('admin-judging-panel');
const adminTeamsCheckboxes = $('admin-teams-checkboxes');
const btnSubmitGuess = $('btn-submit-guess');
const btnShowChoice = $('btn-show-choice');
const adminChoiceAnswerPanel = $('admin-choice-answer-panel');
const adminChoiceAnswerGrid = $('admin-choice-answer-grid');
const adminPerformancePanel = $('admin-performance-panel');
const btnFinalBgmPlay = $('btn-final-bgm-play');
const btnFinalBgmPause = $('btn-final-bgm-pause');
const adminRoundScorePanel = $('admin-round-score-panel');
const adminRoundScoreBreakdown = $('admin-round-score-breakdown');
const btnRevealCatch = $('btn-reveal-catch');
const adminCollectionTeam = $('admin-collection-team');
const btnShowCollection = $('btn-show-collection');
const btnHideCollection = $('btn-hide-collection');
const adminPublicUrl = $('admin-public-url');
const btnApplyPublicUrl = $('btn-apply-public-url');
const btnShowEntryQr = $('btn-show-entry-qr');
const btnHideEntryQr = $('btn-hide-entry-qr');
const entryQrStatus = $('entry-qr-status');
const btnArmReset = $('btn-arm-reset');
const resetConfirmRow = $('reset-confirm-row');
const btnConfirmReset = $('btn-confirm-reset');
const btnCancelReset = $('btn-cancel-reset');
const adminFinalPanel = $('admin-final-panel');
const settlementControlStatus = $('settlement-control-status');
const adminSettlementInterval = $('admin-settlement-interval');
const btnSettlementAuto = $('btn-settlement-auto');
const btnSettlementPause = $('btn-settlement-pause');
const btnSettlementPrev = $('btn-settlement-prev');
const btnSettlementNext = $('btn-settlement-next');
const btnSettlementWait = $('btn-settlement-wait');
const btnSettlementFinal = $('btn-settlement-final');
const btnShowEndPages = $('btn-show-end-pages');
const adminEndPagesPanel = $('admin-end-pages-panel');
const adminEndPageLabel = $('admin-end-page-label');
const adminEndPageSelect = $('admin-end-page-select');
const btnEndPagePrev = $('btn-end-page-prev');
const btnEndPageNext = $('btn-end-page-next');
const btnEndPagesBackFinal = $('btn-end-pages-back-final');
const btnRedisplayStage = $('btn-redisplay-stage');
const btnUndoFlow = $('btn-undo-flow');
const undoFlowLabel = $('undo-flow-label');
const btnSkipCurrentQuestion = $('btn-skip-current-question');
const adminQuestionProgress = $('admin-question-progress');
const questionJumpStatus = $('question-jump-status');
const PUBLIC_URL_STORAGE_KEY = 'pokemon_rhythm_public_url';
let actionLockedUntil = 0;
let actionLockTimer = null;

function lockActions(ms = 1200) {
  actionLockedUntil = Date.now() + ms;
  document.body.classList.add('admin-action-locked');
  clearTimeout(actionLockTimer);
  actionLockTimer = setTimeout(() => {
    actionLockedUntil = 0;
    document.body.classList.remove('admin-action-locked');
    updateUI();
  }, ms);
}

function guardedControl(type, data = {}, options = {}) {
  if (Date.now() < actionLockedUntil) return false;
  if (options.confirmMessage && !confirm(options.confirmMessage)) return false;
  lockActions(options.lockMs || 1200);
  socket.emit('admin-control', { type, data });
  updateUI();
  return true;
}

socket.emit('admin-join');

socket.on('admin-join-success', (data) => {
  gameState = data.gameState;
  adminRoomId.value = gameState.roomId || adminRoomId.value;
  adminPerfectWindow.value = gameState.perfectWindow || adminPerfectWindow.value;
  adminGoodWindow.value = gameState.goodWindow || adminGoodWindow.value;
  if (gameState.teams) adminTeamNames.value = Object.values(gameState.teams).map((team) => team.name).join(',');
  const savedPublicUrl = gameState.publicBaseUrl || localStorage.getItem(PUBLIC_URL_STORAGE_KEY) || '';
  adminPublicUrl.value = savedPublicUrl;
  entryQrStatus.textContent = gameState.entryQrVisible ? '投影中' : '尚未顯示';
  updateUI();
});

socket.on('admin-state-sync', (data = {}) => {
  if (!gameState) gameState = {};
  gameState = { ...gameState, ...data };
  updateUI();
});

socket.on('settlement-control-status', (data = {}) => {
  if (settlementControlStatus && data.message) settlementControlStatus.textContent = data.message;
});

socket.on('auth-error', () => { location.href = `/login.html?next=${encodeURIComponent(location.pathname)}`; });

socket.on('entry-qr-admin-status', (data = {}) => {
  if (data.baseUrl) {
    adminPublicUrl.value = data.baseUrl;
    localStorage.setItem(PUBLIC_URL_STORAGE_KEY, data.baseUrl);
  }
  entryQrStatus.textContent = data.message || (data.ok ? '已更新' : '設定失敗');
  entryQrStatus.style.color = data.ok ? '#7ed9a6' : '#ff8b93';
});

socket.on('host-rhythm-prep-status', (data = {}) => {
  if (!gameState) return;
  gameState.hostRhythmReady = data;
  updateUI();
});

socket.on('rhythm-start-blocked', (data = {}) => {
  alert(data.message || '投影端音訊尚未準備完成，請稍候再開始。');
});

socket.on('question-jump-status', (data = {}) => {
  if (!questionJumpStatus) return;
  questionJumpStatus.textContent = data.message || (data.ok ? '已切換題目。' : '切換失敗。');
  questionJumpStatus.style.color = data.ok ? '#7ed9a6' : '#ff8b93';
});

socket.on('settings-updated', (data = {}) => {
  if (!gameState || !data.settings) return;
  const pages = Array.isArray(data.settings.rules?.pages) ? data.settings.rules.pages : [];
  gameState.rules = {
    enabled: data.settings.rules?.enabled !== false && pages.length > 0,
    pageIndex: Math.min(Number(gameState.rules?.pageIndex) || 0, Math.max(0, pages.length - 1)),
    pageCount: pages.length,
    pages: pages.map((page) => ({ title: page.title, markdown: page.markdown })),
    page: pages[Math.min(Number(gameState.rules?.pageIndex) || 0, Math.max(0, pages.length - 1))] || null
  };
  const endPages = Array.isArray(data.settings.endPages?.pages) ? data.settings.endPages.pages : [];
  gameState.endPages = { enabled: data.settings.endPages?.enabled !== false && endPages.length > 0, pageIndex: Math.min(Number(gameState.endPages?.pageIndex)||0, Math.max(0,endPages.length-1)), pageCount:endPages.length, pages:endPages, page:endPages[Math.min(Number(gameState.endPages?.pageIndex)||0,Math.max(0,endPages.length-1))]||null };
  updateUI();
});

socket.on('room-updated', (data) => {
  if (!gameState) return;
  gameState.status = data.status;
  gameState.teams = data.teams;
  gameState.players = data.players || gameState.players;
  if (data.roomId) { gameState.roomId = data.roomId; adminRoomId.value = data.roomId; }
  updateUI();
});

socket.on('state-change', (data) => {
  if (!gameState) return;
  gameState.status = data.status;
  if (data.currentQuestionIndex !== undefined) gameState.currentQuestionIndex = data.currentQuestionIndex;
  if (data.endPages) gameState.endPages = { ...(gameState.endPages||{}), ...data.endPages };
  if (data.rules) gameState.rules = { ...(gameState.rules||{}), ...data.rules };
  if (data.question && gameState.questions && data.currentQuestionIndex >= 0) gameState.questions[data.currentQuestionIndex] = data.question;
  updateUI();
});

socket.on('admin-multiple-choice-answer', (data = {}) => {
  if (!gameState) return;
  gameState.adminChoiceAnswer = data;
  updateUI();
});

socket.on('answer-reveal', (data) => {
  if (!gameState) return;
  gameState.status = 'ANSWER_REVEAL';
  if (data.teams) gameState.teams = data.teams;
  updateUI();
});

function setupRoom() {
  const room = adminRoomId.value.trim();
  const rawNames = adminTeamNames.value.trim();
  if (!rawNames) return alert('請設定至少一個隊伍名稱！');
  const playerCount = Object.keys(gameState?.players || {}).length;
  if (gameState && (gameState.status !== 'LOBBY' || playerCount > 0)) {
    if (!confirm('套用房間設定會重新建立隊伍並讓目前玩家離開。確定要繼續嗎？')) return;
  }
  socket.emit('admin-setup-room', {
    roomId: room,
    teamNames: rawNames.split(',').map((name) => name.trim()).filter(Boolean),
    perfectWindow: parseInt(adminPerfectWindow.value),
    goodWindow: parseInt(adminGoodWindow.value)
  });
}
btnSetupRoom.addEventListener('click', setupRoom);

function nextUncompletedQuestionIndex(afterIndex) {
  const completed = new Set((gameState?.completedQuestionIds || []).map(String));
  const parsed = Number(afterIndex);
  const startAfter = Number.isFinite(parsed) ? parsed : -1;
  for (let i = Math.max(-1, startAfter) + 1; i < (gameState?.questions?.length || 0); i += 1) {
    const id = String(gameState.questions?.[i]?.id ?? '');
    if (!completed.has(id)) return i;
  }
  return -1;
}

function primaryFlowAction() {
  if (!gameState || Date.now() < actionLockedUntil) return;
  if (gameState.status === 'LOBBY') {
    return guardedControl(gameState.rules?.enabled && (gameState.rules?.pageCount || 0) > 0 ? 'show-rules' : 'next-question', {}, { lockMs: 1200 });
  }
  if (gameState.status === 'RULES') {
    return guardedControl('rules-finish', {}, { lockMs: 1200 });
  }
  if (gameState.status === 'INTRO') {
    return guardedControl('start-rhythm', {}, { lockMs: 1800 });
  }
  if (gameState.status === 'ANSWER_REVEAL') {
    const nextIndex = nextUncompletedQuestionIndex(gameState.currentQuestionIndex);
    if (nextIndex < 0) {
      return guardedControl('enter-settlement', {}, {
        confirmMessage: '確定進入最終公布成績環節？\n\n已跳過的題目可以保留不玩；如果還有時間，也可以先從「時間控場／跳題」點回去補玩。',
        lockMs: 1500
      });
    }
    return guardedControl('next-question', {}, {
      confirmMessage: `確定結束第 ${gameState.currentQuestionIndex + 1} 題並前往第 ${nextIndex + 1} 題？`,
      lockMs: 1500
    });
  }
}
btnPrimaryFlow.addEventListener('click', primaryFlowAction);


btnRulesPrev?.addEventListener('click', () => guardedControl('rules-prev', {}, { lockMs: 350 }));
btnRulesNext?.addEventListener('click', () => guardedControl('rules-next', {}, { lockMs: 350 }));
btnRulesFinish?.addEventListener('click', () => guardedControl('rules-finish', {}, { lockMs: 900 }));
adminRulesPageSelect?.addEventListener('change', () => guardedControl('rules-set-page', { pageIndex: Number(adminRulesPageSelect.value) || 0 }, { lockMs: 300 }));

btnSkipCurrentQuestion?.addEventListener('click', () => {
  if (!gameState || gameState.currentQuestionIndex < 0) return;
  const q = gameState.questions?.[gameState.currentQuestionIndex];
  const active = !['INTRO', 'ANSWER_REVEAL'].includes(gameState.status);
  const message = active
    ? `確定跳過第 ${gameState.currentQuestionIndex + 1} 題「${q?.songName || '未命名'}」？

目前本題的節奏分數與猜題結果都不會計入捕捉判定。`
    : `確定跳過第 ${gameState.currentQuestionIndex + 1} 題「${q?.songName || '未命名'}」？

本題將標記為已跳過，之後仍可從題目清單重新開始。`;
  guardedControl('skip-current-question', {}, { confirmMessage: message, lockMs: 1500 });
});

function adminEscapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function performanceCue(question) {
  const performance = question?.performance || {};
  const sourceType = performance.sourceType || 'none';
  const labels = {
    youtube: '▶ YouTube',
    video: '▶ 上傳影片',
    audio: '♫ 播放伴奏音檔',
    none: '♫ 現場口琴演奏'
  };
  const base = labels[sourceType] || '♫ 現場口琴演奏';
  const note = String(performance.notes || '').trim();
  return note ? `${base}｜${note}` : base;
}

function renderQuestionProgress() {
  if (!adminQuestionProgress || !gameState) return;
  const completed = new Set((gameState.completedQuestionIds || []).map(String));
  const skipped = new Set((gameState.skippedQuestionIds || []).map(String));
  const currentIndex = Number(gameState.currentQuestionIndex);
  adminQuestionProgress.innerHTML = '';
  (gameState.questions || []).forEach((question, index) => {
    const id = String(question.id ?? '');
    const isCurrent = index === currentIndex && !['SETTLEMENT', 'FINAL_RESULTS'].includes(gameState.status);
    const isCompleted = completed.has(id);
    const isSkipped = skipped.has(id);
    let status = '未進行';
    let marker = '○';
    let border = '#35515b';
    let background = '#0d171d';
    let color = '#d6e0e5';
    if (isCompleted) { status = '已完成'; marker = '✓'; border = '#347a5d'; background = 'rgba(52,122,93,.15)'; color = '#9ff0c9'; }
    else if (isCurrent) { status = '目前題目'; marker = '▶'; border = '#4d9ea4'; background = 'rgba(77,158,164,.15)'; color = '#aef7f3'; }
    else if (isSkipped) { status = '已跳過'; marker = '↷'; border = '#8a6844'; background = 'rgba(138,104,68,.14)'; color = '#f2c987'; }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pixel-btn';
    button.style.cssText = `text-align:left;padding:10px 11px;border-color:${border};background:${background};color:${color};min-height:62px;white-space:normal;line-height:1.35;`;
    const cue = performanceCue(question);
    button.innerHTML = `<div style="font-weight:800;">${marker} 第 ${index + 1} 題</div><div style="font-size:12px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${adminEscapeHtml(question.songName || '未命名')}</div><div style="font-size:11px;color:#9fdad7;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${adminEscapeHtml(cue)}</div><div style="font-size:11px;opacity:.75;margin-top:2px;">${status}</div>`;
    button.disabled = isCompleted || isCurrent;
    if (!button.disabled) {
      button.addEventListener('click', () => {
        const forward = currentIndex >= 0 && index > currentIndex;
        const active = currentIndex >= 0 && !['ANSWER_REVEAL', 'LOBBY', 'SETTLEMENT', 'FINAL_RESULTS'].includes(gameState.status);
        let detail = `確定切換到第 ${index + 1} 題「${question.songName || '未命名'}」？`;
        if (forward) detail += '\n\n中間尚未完成的題目會標記為「已跳過」。';
        if (active) detail += '\n目前這一題尚未完成，現有節奏／猜題結果將不計入捕捉。';
        if (isSkipped) detail += '\n這題會從頭重新開始。';
        guardedControl('jump-to-question', { questionIndex: index }, { confirmMessage: detail, lockMs: 1500 });
      });
    }
    adminQuestionProgress.appendChild(button);
  });
  if (!(gameState.questions || []).length) adminQuestionProgress.innerHTML = '<div class="work-subtle">尚未發布任何題目。</div>';

  if (btnSkipCurrentQuestion) {
    const noCurrent = currentIndex < 0;
    const completedCurrent = currentIndex >= 0 && completed.has(String(gameState.questions?.[currentIndex]?.id ?? ''));
    const disabledStatus = ['LOBBY', 'RULES', 'SETTLEMENT', 'FINAL_RESULTS'].includes(gameState.status);
    btnSkipCurrentQuestion.disabled = noCurrent || completedCurrent || disabledStatus;
    if (currentIndex >= 0 && nextUncompletedQuestionIndex(currentIndex) < 0) btnSkipCurrentQuestion.textContent = '跳過本題 → 結算';
    else btnSkipCurrentQuestion.textContent = '跳過本題 →';
  }
}

function normalizePublicUrlInput() {
  const raw = String(adminPublicUrl.value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.search = ''; url.hash = '';
    const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
    return `${url.origin}${pathname}`;
  } catch (_) { return ''; }
}
function applyPublicUrl(showQr = false) {
  const baseUrl = normalizePublicUrlInput();
  if (!baseUrl) return alert('請貼上完整公開網址，例如 https://xxxxx.trycloudflare.com');
  adminPublicUrl.value = baseUrl;
  localStorage.setItem(PUBLIC_URL_STORAGE_KEY, baseUrl);
  socket.emit('admin-control', { type: showQr ? 'show-entry-qr' : 'set-public-join-url', data: { baseUrl } });
}
btnApplyPublicUrl.addEventListener('click', () => applyPublicUrl(false));
btnShowEntryQr.addEventListener('click', () => applyPublicUrl(true));
btnHideEntryQr.addEventListener('click', () => {
  socket.emit('admin-control', { type: 'hide-entry-qr' });
  entryQrStatus.textContent = '尚未顯示';
});
adminPublicUrl.addEventListener('change', () => {
  const normalized = normalizePublicUrlInput();
  if (normalized) localStorage.setItem(PUBLIC_URL_STORAGE_KEY, normalized);
});

function collectTeamGuesses() {
  const result = {};
  adminTeamsCheckboxes.querySelectorAll('input[type="checkbox"]').forEach((cb) => { result[cb.dataset.teamId] = cb.checked; });
  return result;
}
btnShowChoice.addEventListener('click', () => guardedControl('show-multiple-choice', {}, { lockMs: 700 }));
btnSubmitGuess.addEventListener('click', () => guardedControl('start-performance', { teamGuesses: collectTeamGuesses() }, { lockMs: 1200 }));
btnFinalBgmPlay?.addEventListener('click', () => guardedControl('final-bgm-control', { command: 'play' }, { lockMs: 300 }));
btnFinalBgmPause?.addEventListener('click', () => guardedControl('final-bgm-control', { command: 'pause' }, { lockMs: 300 }));
btnRevealCatch.addEventListener('click', () => guardedControl('reveal-and-catch', {}, { confirmMessage: '確定完成本題演奏並揭曉寶可夢／決定捕捉結果？', lockMs: 1500 }));
btnShowCollection.addEventListener('click', () => socket.emit('admin-control', { type: 'show-collection', data: { teamId: adminCollectionTeam.value || 'all' } }));
btnHideCollection.addEventListener('click', () => socket.emit('admin-control', { type: 'hide-collection' }));

btnRedisplayStage?.addEventListener('click', () => guardedControl('redisplay-current-stage', {}, { lockMs: 500 }));
btnUndoFlow?.addEventListener('click', () => {
  if (!gameState?.flowUndo?.available) return;
  guardedControl('undo-last-flow', {}, {
    confirmMessage: `確定要${gameState.flowUndo.label || '回復上一遊戲階段'}？\n\n系統只保留最近一個流程檢查點。`,
    lockMs: 1300
  });
});
btnSettlementAuto?.addEventListener('click', () => guardedControl('settlement-start-auto', { intervalMs: Number(adminSettlementInterval?.value) || 6000 }, { lockMs: 800 }));
btnSettlementPause?.addEventListener('click', () => guardedControl('settlement-pause-auto', {}, { lockMs: 500 }));
btnSettlementPrev?.addEventListener('click', () => guardedControl('settlement-prev', {}, { lockMs: 700 }));
btnSettlementNext?.addEventListener('click', () => guardedControl('settlement-next', {}, { lockMs: 700 }));
btnSettlementWait?.addEventListener('click', () => guardedControl('settlement-return-waiting', {}, { lockMs: 700 }));
btnShowEndPages?.addEventListener('click', () => guardedControl('show-end-pages', {}, { lockMs: 700 }));
btnEndPagePrev?.addEventListener('click', () => guardedControl('end-page-prev', {}, { lockMs: 300 }));
btnEndPageNext?.addEventListener('click', () => guardedControl('end-page-next', {}, { lockMs: 300 }));
adminEndPageSelect?.addEventListener('change', () => guardedControl('end-page-set', { pageIndex: Number(adminEndPageSelect.value)||0 }, { lockMs: 250 }));
btnEndPagesBackFinal?.addEventListener('click', () => guardedControl('end-pages-back-final', {}, { lockMs: 700 }));

btnSettlementFinal?.addEventListener('click', () => guardedControl('settlement-show-final', {}, {
  confirmMessage: '確定現在顯示最終排名與冠軍？\n\n若主持人還要鋪陳，可以先取消並繼續停留在逐組公布畫面。',
  lockMs: 1200
}));

btnArmReset.addEventListener('click', () => {
  btnArmReset.style.display = 'none';
  resetConfirmRow.style.display = 'flex';
});
btnCancelReset.addEventListener('click', () => {
  resetConfirmRow.style.display = 'none';
  btnArmReset.style.display = 'inline-flex';
});
btnConfirmReset.addEventListener('click', () => {
  socket.emit('admin-control', { type: 'reset-game' });
  resetConfirmRow.style.display = 'none';
  btnArmReset.style.display = 'inline-flex';
  const details = $('danger-zone'); if (details) details.open = false;
});

function renderTeamCheckboxes() {
  adminTeamsCheckboxes.innerHTML = '';
  for (const [teamId, team] of Object.entries(gameState.teams || {})) {
    const div = document.createElement('div');
    div.className = 'admin-team-card';
    div.innerHTML = `<label style="display:flex;align-items:center;width:100%;cursor:pointer;"><input type="checkbox" data-team-id="${teamId}" style="width:20px;height:20px;margin-right:12px;"><span style="font-size:14px;">${team.name}</span></label>`;
    const cb = div.querySelector('input');
    cb.addEventListener('change', () => div.classList.toggle('correct', cb.checked));
    adminTeamsCheckboxes.appendChild(div);
  }
}

function renderAdminChoiceAnswer(question) {
  if (!adminChoiceAnswerPanel || !adminChoiceAnswerGrid) return;
  const source = gameState?.adminChoiceAnswer && gameState.adminChoiceAnswer.questionIndex === gameState.currentQuestionIndex
    ? gameState.adminChoiceAnswer
    : null;
  const options = source?.options || question?.multipleChoice?.options || [];
  const correctIndex = Number.isInteger(source?.correctIndex)
    ? source.correctIndex
    : Math.max(0, Math.min(3, Number(question?.multipleChoice?.correctIndex) || 0));
  if (!Array.isArray(options) || options.length < 4 || options.some((item) => !String(item || '').trim())) {
    adminChoiceAnswerPanel.style.display = 'none';
    return;
  }
  adminChoiceAnswerPanel.style.display = 'block';
  adminChoiceAnswerGrid.innerHTML = options.slice(0, 4).map((option, index) => {
    const correct = index === correctIndex;
    const label = String.fromCharCode(65 + index);
    return `<div style="padding:10px 12px;border:2px solid ${correct ? '#48d597' : '#34454d'};background:${correct ? 'rgba(72,213,151,.16)' : '#101c22'};border-radius:8px;font-weight:${correct ? '800' : '600'};color:${correct ? '#b9ffd9' : '#d6e0e5'};">${correct ? '✓ ' : ''}${label}. ${String(option)}</div>`;
  }).join('');
}

function renderRoundScoreBreakdown() {
  if (!adminRoundScorePanel || !adminRoundScoreBreakdown || !gameState) return;
  const visible = ['GUESSING', 'MULTIPLE_CHOICE', 'PERFORMANCE', 'ANSWER_REVEAL'].includes(gameState.status);
  adminRoundScorePanel.style.display = visible ? 'block' : 'none';
  if (!visible) return;
  const rhythm = gameState.teamRoundScores || {};
  const bonuses = gameState.roundBonuses || {};
  const bonusRates = gameState.roundBonusRates || {};
  const combined = gameState.teamCompetitionScores || {};
  adminRoundScoreBreakdown.innerHTML = Object.entries(gameState.teams || {}).map(([teamId, team]) => {
    const r = Math.round(Number(rhythm[teamId]) || 0);
    const b = Math.round(Number(bonuses[teamId]) || 0);
    const rate = Math.max(0, Number(bonusRates[teamId]) || 0);
    const total = Math.round(Number(combined[teamId]) || (r + b));
    const bonusBaseLabel = gameState.roundBonusBase === 'round-highest' ? '最高隊音遊分數基準' : '本隊音遊分數基準';
    const operatorName = team.roundOperatorId && gameState.players?.[team.roundOperatorId]?.nickname
      ? gameState.players[team.roundOperatorId].nickname
      : (team.roundOperator?.nickname || '—');
    return `<div style="padding:10px 12px;border:1px solid #35515b;border-radius:8px;background:#0d171d;"><div style="display:flex;justify-content:space-between;gap:12px;font-weight:800;"><span>${team.name}</span><span style="color:#9fe7e2;">${total} 分</span></div><div class="work-subtle" style="margin-top:4px;">音遊 ${r}${rate > 0 ? ` ＋ 猜歌 ${Math.round(rate * 100)}%（+${b}，${bonusBaseLabel}）` : ' ＋ 猜歌 0'} ｜本題操作：${operatorName}</div></div>`;
  }).join('') || '<div class="work-subtle">尚無隊伍資料</div>';
}

function updateUI() {
  if (!gameState) return;
  const statusLabels = {
    LOBBY: '大廳準備中', RULES: '遊戲規則說明中', INTRO: '題目準備中', RHYTHM_PLAYING: '節奏挑戰進行中', GUESSING: '自由猜歌中',
    MULTIPLE_CHOICE: '備援選擇題中', PERFORMANCE: '完整題目／口琴演奏中', ANSWER_REVEAL: '答案與捕捉揭曉中', SETTLEMENT: '最終公布控制中', FINAL_RESULTS: '最終排名已公布', END_PAGES: '活動結束頁顯示中'
  };
  adminStatusLbl.textContent = statusLabels[gameState.status] || gameState.status;
  entryQrStatus.textContent = gameState.entryQrVisible ? '投影中' : (entryQrStatus.textContent === '投影中' ? '尚未顯示' : entryQrStatus.textContent);

  const totalQuestions = gameState.questions?.length || 0;
  const qIndex = gameState.currentQuestionIndex;
  const q = qIndex >= 0 ? gameState.questions?.[qIndex] : null;
  adminQuestionLbl.textContent = q ? `第 ${qIndex + 1} 題 / 共 ${totalQuestions} 題｜${q.songName || '未命名'}` : `尚未載入｜共 ${totalQuestions} 題`;
  renderQuestionProgress();

  btnPrimaryFlow.style.display = 'block';
  btnPrimaryFlow.disabled = false;
  if (gameState.status === 'LOBBY') {
    const hasRules = Boolean(gameState.rules?.enabled && (gameState.rules?.pageCount || 0) > 0);
    btnPrimaryFlow.textContent = totalQuestions ? (hasRules ? '顯示遊戲規則' : '載入第 1 題') : '尚未發布任何題目';
    btnPrimaryFlow.disabled = !totalQuestions;
    flowHint.textContent = hasRules ? '玩家加入完成後，先把規則投影到大螢幕。' : '先載入題目，再開始節奏挑戰。';
  } else if (gameState.status === 'RULES') {
    btnPrimaryFlow.textContent = '規則說明完成 → 載入第 1 題';
    flowHint.textContent = '可用下方規則控制自由切頁；講解完成後再載入第一題。';
  } else if (gameState.status === 'INTRO') {
    const prep = gameState.hostRhythmReady || {};
    btnPrimaryFlow.textContent = prep.ready ? `開始第 ${qIndex + 1} 題節奏挑戰` : '投影端正在準備音訊…';
    btnPrimaryFlow.disabled = !prep.ready;
    flowHint.textContent = prep.ready
      ? `音訊預載完成${prep.prepareMs ? `（${prep.prepareMs} ms）` : ''}，確認玩家已準備好再開始。`
      : (prep.message || '請等待投影端完成音檔／口琴音色預載，避免開場卡頓。');
  } else if (gameState.status === 'RHYTHM_PLAYING') {
    btnPrimaryFlow.textContent = '節奏挑戰進行中'; btnPrimaryFlow.disabled = true;
    flowHint.textContent = '本題結束後會自動進入猜歌階段。';
  } else if (['GUESSING', 'MULTIPLE_CHOICE', 'PERFORMANCE'].includes(gameState.status)) {
    btnPrimaryFlow.style.display = 'none';
    flowHint.textContent = '請使用下方目前階段的控制項。';
  } else if (gameState.status === 'ANSWER_REVEAL') {
    const nextIndex = nextUncompletedQuestionIndex(qIndex);
    const noNext = nextIndex < 0;
    btnPrimaryFlow.textContent = noNext ? '進入最終公布成績' : `前往第 ${nextIndex + 1} 題`;
    btnPrimaryFlow.disabled = false;
    flowHint.textContent = noNext ? '目前往後沒有尚未完成的題目；可直接結算，或從跳題清單補玩先前跳過的題目。' : '確認本題揭曉完成後再進下一個尚未完成的題目。';
  } else if (['SETTLEMENT', 'FINAL_RESULTS'].includes(gameState.status)) {
    btnPrimaryFlow.style.display = 'none';
    flowHint.textContent = '使用下方「最終公布控制」依現場氣氛手動或自動操作。';
  } else if (gameState.status === 'END_PAGES') {
    btnPrimaryFlow.style.display = 'none';
    flowHint.textContent = '活動結束頁由下方控制上一頁／下一頁；可回到最終排名。';
  }

  if (adminRulesPanel) {
    const rules = gameState.rules || { enabled: false, pageIndex: 0, pageCount: 0, pages: [] };
    const visible = gameState.status === 'RULES';
    adminRulesPanel.style.display = visible ? 'block' : 'none';
    if (visible) {
      const pageCount = Math.max(1, Number(rules.pageCount) || 1);
      const pageIndex = Math.max(0, Math.min(pageCount - 1, Number(rules.pageIndex) || 0));
      adminRulesPageLabel.textContent = `第 ${pageIndex + 1} / ${pageCount} 頁`;
      adminRulesPageSelect.innerHTML = (rules.pages || []).map((page, index) => `<option value="${index}">第 ${index + 1} 頁｜${String(page.title || `規則 ${index + 1}`)}</option>`).join('');
      adminRulesPageSelect.value = String(pageIndex);
      btnRulesPrev.disabled = pageIndex <= 0;
      btnRulesNext.disabled = pageIndex >= pageCount - 1;
    }
  }

  const inFinal = ['SETTLEMENT', 'FINAL_RESULTS'].includes(gameState.status);
  if (adminFinalPanel) adminFinalPanel.style.display = inFinal ? 'block' : 'none';

  if (btnShowEndPages) btnShowEndPages.style.display = gameState.status === 'FINAL_RESULTS' && gameState.endPages?.enabled ? 'block' : 'none';
  if (adminEndPagesPanel) {
    const visible = gameState.status === 'END_PAGES'; adminEndPagesPanel.style.display = visible ? 'block' : 'none';
    if (visible) { const ep=gameState.endPages||{pageIndex:0,pageCount:0,pages:[]}; const count=Math.max(1,Number(ep.pageCount)||1); const idx=Math.max(0,Math.min(count-1,Number(ep.pageIndex)||0)); adminEndPageLabel.textContent=`第 ${idx+1} / ${count} 頁`; adminEndPageSelect.innerHTML=(ep.pages||[]).map((page,i)=>`<option value="${i}">第 ${i+1} 頁｜${String(page.title||`活動結束 ${i+1}`)}</option>`).join(''); adminEndPageSelect.value=String(idx); btnEndPagePrev.disabled=idx<=0; btnEndPageNext.disabled=idx>=count-1; }
  }

  if (inFinal && settlementControlStatus) {
    const teamCount = Object.keys(gameState.teams || {}).length;
    const step = Number(gameState.settlementStep);
    if (gameState.status === 'FINAL_RESULTS') {
      settlementControlStatus.textContent = '最終排名已顯示；仍可回上一組或回到等待畫面重新鋪陳。';
    } else if (gameState.settlementAutoPlaying) {
      settlementControlStatus.textContent = `自動公布中｜目前 ${step >= 0 ? `第 ${step + 1}/${teamCount} 組` : '等待第一組'}。可隨時暫停改手動。`;
    } else {
      settlementControlStatus.textContent = step >= 0
        ? `目前顯示第 ${step + 1}/${teamCount} 組；可手動前後切換或開始自動。`
        : '等待主持人開始公布；可先講話鋪陳，再選手動或自動。';
    }
    if (btnSettlementPause) btnSettlementPause.disabled = !gameState.settlementAutoPlaying;
    if (btnSettlementPrev) btnSettlementPrev.disabled = gameState.status === 'SETTLEMENT' && step < 0;
    if (btnSettlementNext) btnSettlementNext.textContent = (gameState.status === 'SETTLEMENT' && step >= teamCount - 1) ? '顯示最終排名 →' : '下一組 →';
  }

  if (btnUndoFlow && undoFlowLabel) {
    const available = Boolean(gameState.flowUndo?.available) && gameState.status !== 'RHYTHM_PLAYING';
    btnUndoFlow.disabled = !available;
    undoFlowLabel.textContent = available
      ? `可回復：${gameState.flowUndo.label}`
      : (gameState.status === 'RHYTHM_PLAYING' ? '節奏挑戰進行中不可回復，避免玩家狀態不同步。' : '目前沒有可回復的流程檢查點。');
  }
  if (btnRedisplayStage) btnRedisplayStage.disabled = gameState.status === 'RHYTHM_PLAYING';

  const locked = Date.now() < actionLockedUntil;
  if (locked && btnPrimaryFlow) btnPrimaryFlow.disabled = true;

  connectionStatusPanel.innerHTML = '';
  for (const [teamId, team] of Object.entries(gameState.teams || {})) {
    const memberNames = (team.members || []).map((sid) => gameState.players?.[sid]?.nickname || '離線玩家').join(', ');
    const div = document.createElement('div');
    div.style.marginBottom = '12px';
    const operatorName = team.roundOperatorId && gameState.players?.[team.roundOperatorId]?.nickname
      ? gameState.players[team.roundOperatorId].nickname
      : (team.roundOperator?.nickname || '尚未指定');
    div.innerHTML = `<div style="font-weight:700;font-size:13px;">${team.name} <span class="work-subtle">｜已捕捉 ${team.caught?.length || 0} 隻</span></div><div class="work-subtle" style="padding-left:8px;">成員：${memberNames || '無'}<br>本題節奏操作：<strong style="color:#9fe7e2;">${operatorName}</strong></div>`;
    connectionStatusPanel.appendChild(div);
  }

  const selected = adminCollectionTeam.value || 'all';
  adminCollectionTeam.innerHTML = '<option value="all">全部小組</option>';
  Object.entries(gameState.teams || {}).forEach(([teamId, team]) => {
    const option = document.createElement('option'); option.value = teamId; option.textContent = `${team.name}（${team.caught?.length || 0} 隻）`; adminCollectionTeam.appendChild(option);
  });
  if ([...adminCollectionTeam.options].some((option) => option.value === selected)) adminCollectionTeam.value = selected;
  btnShowCollection.disabled = gameState.status === 'RHYTHM_PLAYING';

  const judging = ['GUESSING', 'MULTIPLE_CHOICE'].includes(gameState.status);
  adminJudgingPanel.style.display = judging ? 'block' : 'none';
  if (judging) {
    renderTeamCheckboxes();
    renderAdminChoiceAnswer(q);
    btnShowChoice.style.display = gameState.status === 'GUESSING' ? 'block' : 'none';
    btnSubmitGuess.textContent = gameState.status === 'MULTIPLE_CHOICE'
      ? '確認選擇題答對隊伍 → 進入完整題目'
      : '確認直接猜中隊伍 → 進入完整題目';
  }
  if (!judging && adminChoiceAnswerPanel) adminChoiceAnswerPanel.style.display = 'none';
  adminPerformancePanel.style.display = gameState.status === 'PERFORMANCE' ? 'block' : 'none';
  renderRoundScoreBreakdown();
}
