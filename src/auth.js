const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SESSION_COOKIE = 'rhythm_admin';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function parseCookies(cookieHeader = '') {
  return cookieHeader.split(';').reduce((cookies, part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return cookies;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

function timingSafeEqualHex(a, b) {
  try {
    const aBuf = Buffer.from(String(a), 'hex');
    const bBuf = Buffer.from(String(b), 'hex');
    if (aBuf.length !== bBuf.length) return false;
    return crypto.timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}

function createAuth({ dataDir }) {
  const authPath = path.join(dataDir, 'admin-auth.json');
  const sessions = new Map();

  function readAuth() {
    try {
      if (!fs.existsSync(authPath)) return { initialized: false };
      return JSON.parse(fs.readFileSync(authPath, 'utf8'));
    } catch (error) {
      console.error('Failed to read admin auth file:', error);
      return { initialized: false };
    }
  }

  function writeAuth(value) {
    fs.mkdirSync(path.dirname(authPath), { recursive: true });
    const tmp = `${authPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    try {
      fs.renameSync(tmp, authPath);
    } catch (error) {
      if (fs.existsSync(authPath)) fs.unlinkSync(authPath);
      fs.renameSync(tmp, authPath);
    }
  }

  function hashPassword(password, salt) {
    return crypto.scryptSync(password, salt, 64).toString('hex');
  }

  function isInitialized() {
    const auth = readAuth();
    return Boolean(auth.initialized && auth.salt && auth.passwordHash);
  }

  function setupPassword(password) {
    if (isInitialized()) throw new Error('管理員密碼已完成設定');
    if (typeof password !== 'string' || password.length < 8) {
      throw new Error('密碼至少需要 8 個字元');
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = hashPassword(password, salt);
    writeAuth({ initialized: true, salt, passwordHash, updatedAt: new Date().toISOString() });
  }

  function verifyPassword(password) {
    const auth = readAuth();
    if (!auth.initialized) return false;
    const actual = hashPassword(String(password || ''), auth.salt);
    return timingSafeEqualHex(actual, auth.passwordHash);
  }

  function createSession() {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
    return token;
  }

  function destroySession(token) {
    sessions.delete(token);
  }

  function getSessionTokenFromRequest(req) {
    return parseCookies(req.headers.cookie || '')[SESSION_COOKIE] || '';
  }

  function isSessionValid(token) {
    if (!token) return false;
    const session = sessions.get(token);
    if (!session) return false;
    if (session.expiresAt <= Date.now()) {
      sessions.delete(token);
      return false;
    }
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    return true;
  }

  function isRequestAuthenticated(req) {
    return isSessionValid(getSessionTokenFromRequest(req));
  }

  function isSocketAuthenticated(socket) {
    const token = parseCookies(socket.handshake.headers.cookie || '')[SESSION_COOKIE] || '';
    return isSessionValid(token);
  }

  function setSessionCookie(res, token) {
    const secure = process.env.NODE_ENV === 'production';
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(
        SESSION_TTL_MS / 1000
      )}${secure ? '; Secure' : ''}`
    );
  }

  function clearSessionCookie(res) {
    const secure = process.env.NODE_ENV === 'production';
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`
    );
  }

  function requireAdminApi(req, res, next) {
    if (!isRequestAuthenticated(req)) {
      return res.status(401).json({ error: '需要管理員登入' });
    }
    next();
  }

  function requireAdminPage(req, res, next) {
    if (!isRequestAuthenticated(req)) {
      const nextPath = encodeURIComponent(req.originalUrl || '/manage.html');
      return res.redirect(`/login.html?next=${nextPath}`);
    }
    next();
  }

  return {
    SESSION_COOKIE,
    isInitialized,
    setupPassword,
    verifyPassword,
    createSession,
    destroySession,
    getSessionTokenFromRequest,
    isRequestAuthenticated,
    isSocketAuthenticated,
    setSessionCookie,
    clearSessionCookie,
    requireAdminApi,
    requireAdminPage
  };
}

module.exports = { createAuth, parseCookies };
