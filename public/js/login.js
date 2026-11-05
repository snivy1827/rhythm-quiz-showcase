const form = document.getElementById('login-form');
const title = document.getElementById('login-title');
const desc = document.getElementById('login-desc');
const label = document.getElementById('password-label');
const password = document.getElementById('password');
const confirmWrap = document.getElementById('confirm-wrap');
const passwordConfirm = document.getElementById('password-confirm');
const submitBtn = document.getElementById('submit-btn');
const message = document.getElementById('login-message');

let setupMode = false;
const params = new URLSearchParams(location.search);
const nextPath = params.get('next') || '/manage.html';

async function initialize() {
  try {
    const response = await fetch('/api/auth/status');
    const status = await response.json();
    if (status.authenticated) {
      location.replace(nextPath);
      return;
    }
    setupMode = !status.initialized;
    if (setupMode) {
      title.textContent = '首次設定管理員密碼';
      desc.textContent = '這個密碼會保護內容管理、主持控制及譜面編輯頁。';
      label.textContent = '設定新密碼';
      password.autocomplete = 'new-password';
      confirmWrap.hidden = false;
      passwordConfirm.required = true;
      submitBtn.textContent = '設定並進入後台';
    }
  } catch (error) {
    showMessage(`無法連線到伺服器：${error.message}`, true);
  }
}

function showMessage(text, isError = false) {
  message.textContent = text;
  message.classList.toggle('error', isError);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  showMessage('');
  if (setupMode && password.value !== passwordConfirm.value) {
    showMessage('兩次輸入的密碼不一致。', true);
    return;
  }
  if (password.value.length < 8) {
    showMessage('密碼至少需要 8 個字元。', true);
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = setupMode ? '設定中…' : '登入中…';
  try {
    const response = await fetch(setupMode ? '/api/auth/setup' : '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password.value })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '操作失敗');
    location.replace(nextPath);
  } catch (error) {
    showMessage(error.message, true);
    submitBtn.disabled = false;
    submitBtn.textContent = setupMode ? '設定並進入後台' : '登入';
  }
});

initialize();
