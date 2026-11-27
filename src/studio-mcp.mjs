import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign as cryptoSign } from 'node:crypto';
import {
  createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync,
  readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync
} from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Type } from 'typebox';

const DEFAULT_PROFILES = {
  dev: {
    label: 'Studio dev (qa-dev)',
    origin: 'https://tactixcore-studio-api-qa-dev-26937793169.asia-northeast1.run.app',
    web_url: 'https://tactixcore-studio-api-qa-dev-26937793169.asia-northeast1.run.app/studio/',
    mcp_path: '/mcp/studio/'
  },
  prd: {
    label: 'Studio prd',
    origin: 'https://api.strategy-navigator.app',
    web_url: 'https://api.strategy-navigator.app/studio/',
    mcp_path: '/mcp/studio/'
  }
};
const DEFAULT_SCOPES = ['workspace:read'];
const MCP_PATH = '/mcp/studio/';
const MCP_PROTOCOL_VERSION = '2025-03-26';

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n < 1024) return `${Math.max(0, Math.round(n))} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = n / 1024;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx++;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[idx]}`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return `${m}m${String(remS).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h${String(remM).padStart(2, '0')}m`;
}

export function renderProgressBar(percent, width = 20) {
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  const filled = Math.round((clamped / 100) * width);
  return `[${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}]`;
}

export function formatProgressLine(event) {
  if (!event || typeof event !== 'object') return '';
  if (event.phase === 'download' || event.phase === 'verify_cache') {
    const pct = event.total > 0 ? Math.min(100, (event.completed / event.total) * 100) : 0;
    const bar = renderProgressBar(pct, 20);
    const speed = event.bytesPerSec > 0 ? ` ${formatBytes(event.bytesPerSec)}/s` : '';
    const eta = event.done ? ' done' : (event.etaSec !== null && event.etaSec !== undefined ? ` ETA ${formatDuration(event.etaSec)}` : '');
    const prefix = event.phase === 'verify_cache' ? 'verifying cache' : (event.prefix || 'downloading');
    const name = event.filename ? ` ${event.filename}` : '';
    return `[studio] ${prefix} ${bar} ${pct.toFixed(1).padStart(5, ' ')}% ${formatBytes(event.completed)}/${formatBytes(event.total)}${speed}${eta}${name}`;
  }
  return `[studio] ${event.message || event.phase || 'working...'}`;
}

export function createTerminalProgressReporter({ stream = process.stderr, quiet = false, isTTY = null } = {}) {
  if (quiet || !stream || typeof stream.write !== 'function') {
    return { report() {}, finish() {} };
  }
  const tty = isTTY !== null ? Boolean(isTTY) : Boolean(stream.isTTY);
  let activeInline = false;
  let lastNonTtyAt = 0;
  let lastNonTtyPct = -10;

  const clearInline = () => {
    if (tty && activeInline) {
      stream.write('\r\x1b[2K');
      activeInline = false;
    }
  };

  return {
    report(event) {
      const line = formatProgressLine(event);
      if (!line) return;
      const isTransfer = event.phase === 'download' || event.phase === 'verify_cache';
      if (isTransfer && !event.done) {
        if (tty) {
          stream.write(`\r\x1b[2K${line}`);
          activeInline = true;
        } else {
          const now = Date.now();
          const pct = event.total > 0 ? (event.completed / event.total) * 100 : 0;
          if (now - lastNonTtyAt >= 2000 || pct - lastNonTtyPct >= 10 || event.completed === 0) {
            stream.write(`${line}\n`);
            lastNonTtyAt = now;
            lastNonTtyPct = pct;
          }
        }
        return;
      }
      clearInline();
      stream.write(`${line}\n`);
      if (isTransfer && event.done) {
        lastNonTtyAt = 0;
        lastNonTtyPct = -10;
      }
    },
    finish() {
      if (tty && activeInline) {
        stream.write('\n');
        activeInline = false;
      }
    }
  };
}

async function sha256File(filePath, { totalBytes = null, onProgress = null, filename = '' } = {}) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256');
    const total = totalBytes ?? (() => { try { return lstatSync(filePath).size; } catch { return 0; } })();
    const startedAt = Date.now();
    let completed = 0;
    let lastEmit = 0;
    const stream = createReadStream(filePath);
    stream.on('data', chunk => {
      hash.update(chunk);
      completed += chunk.length;
      if (onProgress && total > 0) {
        const now = Date.now();
        if (now - lastEmit >= 200) {
          const elapsedSec = Math.max(0.001, (now - startedAt) / 1000);
          const bytesPerSec = completed / elapsedSec;
          const etaSec = bytesPerSec > 0 ? (total - completed) / bytesPerSec : null;
          onProgress({ phase: 'verify_cache', completed, total, bytesPerSec, etaSec, filename, done: false });
          lastEmit = now;
        }
      }
    });
    stream.on('error', rejectHash);
    stream.on('end', () => {
      if (onProgress && total > 0) {
        const elapsedSec = Math.max(0.001, (Date.now() - startedAt) / 1000);
        onProgress({ phase: 'verify_cache', completed: total, total, bytesPerSec: total / elapsedSec, etaSec: 0, filename, done: true });
      }
      resolveHash(hash.digest('hex'));
    });
  });
}

function safeId(value, label = 'ID') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.+-]{0,127}$/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function inside(root, targetPath) {
  const realRoot = realpathSync(root);
  let full = resolve(realRoot, targetPath);
  let parent = dirname(full);
  while (!existsSync(parent)) parent = dirname(parent);
  full = resolve(realpathSync(parent), relative(parent, full));
  const rel = relative(realRoot, full);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    throw new Error('Path escapes cache root');
  }
  return full;
}

function isLoopbackHost(hostname) {
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
}

export function studioProfiles() {
  return Object.entries(DEFAULT_PROFILES).map(([environment, row]) => ({ environment, ...row }));
}

export function studioProfile(environment = 'dev') {
  if (!Object.hasOwn(DEFAULT_PROFILES, environment)) {
    throw new Error('Studio environment must be dev or prd');
  }
  return { environment, ...DEFAULT_PROFILES[environment] };
}

export function resolveStudioOrigin({ environment = 'dev', origin } = {}) {
  const raw = (origin || studioProfile(environment).origin).trim().replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Invalid Studio API origin URL');
  }
  const allowLoopback = parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname);
  if ((parsed.protocol !== 'https:' && !allowLoopback) || parsed.username || parsed.password
    || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Studio API origin must be an HTTPS URL (or loopback HTTP for local testing)');
  }
  return parsed.origin;
}

export function createEd25519DeviceKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicJwk = publicKey.export({ format: 'jwk' });
  return {
    private_key_pkcs8: privateKey.export({ format: 'pem', type: 'pkcs8' }),
    jwk: { kty: 'OKP', crv: 'Ed25519', x: publicJwk.x }
  };
}

export function createDpopProof(device, method, fullUrl, accessToken = null) {
  const parsed = new URL(fullUrl);
  const htu = `${parsed.origin}${parsed.pathname}`;
  const header = { typ: 'dpop+jwt', alg: 'EdDSA', jwk: device.jwk };
  const claims = {
    htu,
    htm: method.toUpperCase(),
    iat: Math.floor(Date.now() / 1000),
    jti: randomBytes(16).toString('hex')
  };
  if (accessToken) {
    claims.ath = b64url(createHash('sha256').update(accessToken, 'utf8').digest());
  }
  const a = b64url(Buffer.from(JSON.stringify(header), 'utf8'));
  const b = b64url(Buffer.from(JSON.stringify(claims), 'utf8'));
  const sig = cryptoSign(null, Buffer.from(`${a}.${b}`, 'utf8'), createPrivateKey(device.private_key_pkcs8));
  return `${a}.${b}.${b64url(sig)}`;
}

function defaultOpenBrowser(uri) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', uri] : [uri];
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.unref();
}

function atomicWriteJson(filePath, value, mode = 0o600) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tempPath, JSON.stringify(value, null, 2) + '\n', { mode });
  renameSync(tempPath, filePath);
}

function removeEmptyParents(dirPath, stopRoot) {
  let current = resolve(dirPath);
  const boundary = resolve(stopRoot);
  while (current !== boundary && current.startsWith(boundary + '/')) {
    try {
      if (readdirSync(current).length > 0) break;
      rmdirSync(current);
      current = dirname(current);
    } catch {
      break;
    }
  }
}

export class StudioOAuthStore {
  constructor(profileDir) {
    this.profileDir = resolve(profileDir);
    this.file = join(this.profileDir, 'studio-auth.json');
  }

  _readAll() {
    if (!existsSync(this.file)) return { schema_version: 1, origins: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.origins && typeof parsed.origins === 'object') {
        return parsed;
      }
    } catch { /* reset corrupt file */ }
    return { schema_version: 1, origins: {} };
  }

  get(origin) {
    return this._readAll().origins[origin] || null;
  }

  set(origin, record) {
    const all = this._readAll();
    all.origins[origin] = record;
    atomicWriteJson(this.file, all, 0o600);
  }

  delete(origin) {
    const all = this._readAll();
    delete all.origins[origin];
    atomicWriteJson(this.file, all, 0o600);
  }
}

export class StudioOAuthClient {
  constructor(profileDir, { fetchImpl = globalThis.fetch, openBrowser = defaultOpenBrowser, store = null } = {}) {
    this.profileDir = resolve(profileDir);
    this.fetchImpl = fetchImpl;
    this.openBrowser = openBrowser;
    this.store = store || new StudioOAuthStore(this.profileDir);
  }

  status({ environment = 'dev', origin } = {}) {
    const resolvedOrigin = resolveStudioOrigin({ environment, origin });
    const session = this.store.get(resolvedOrigin);
    if (!session) {
      return {
        connected: false,
        environment,
        origin: resolvedOrigin,
        profiles: studioProfiles()
      };
    }
    const now = Date.now();
    return {
      connected: true,
      environment: session.environment || environment,
      origin: resolvedOrigin,
      device_id: session.device_id,
      scopes: session.scopes || DEFAULT_SCOPES,
      expires_at: session.expires_at,
      access_expired: !session.expires_at || session.expires_at <= now,
      device_expires_at: session.device_expires_at || null,
      connected_at: session.connected_at,
      profiles: studioProfiles()
    };
  }

  async login({ environment = 'dev', origin, scopes = DEFAULT_SCOPES, timeoutMs = 180_000, openBrowser, onProgress = null } = {}) {
    const resolvedOrigin = resolveStudioOrigin({ environment, origin });
    const device = createEd25519DeviceKey();
    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash('sha256').update(verifier, 'ascii').digest());
    const state = randomBytes(24).toString('hex');

    let resolveCallback;
    let rejectCallback;
    const callbackPromise = new Promise((res, rej) => {
      resolveCallback = res;
      rejectCallback = rej;
    });

    const server = createServer((req, res) => {
      const port = server.address()?.port;
      const expectedHost = `127.0.0.1:${port}`;
      const parsed = new URL(req.url || '/', `http://${expectedHost}`);
      if (
        req.method !== 'GET'
        || req.headers.host !== expectedHost
        || parsed.pathname !== '/callback'
        || parsed.searchParams.get('state') !== state
        || !parsed.searchParams.get('code')
      ) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Invalid OAuth callback');
        return;
      }
      const code = parsed.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html lang="ja"><meta charset="utf-8"><title>接続完了</title><h1>TactixCore Code の認証が完了しました</h1><p>このタブを閉じてターミナルへ戻ってください。</p></html>');
      resolveCallback(code);
    });

    await new Promise((res, rej) => {
      server.once('error', rej);
      server.listen(0, '127.0.0.1', res);
    });

    const timer = setTimeout(() => {
      rejectCallback(new Error('Studio OAuth authorization timed out'));
    }, timeoutMs);
    timer.unref?.();

    try {
      const port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}/callback`;
      const enrollRes = await this.fetchImpl(`${resolvedOrigin}/auth/requests`, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'tactixcore-code',
          redirect_uri: redirectUri,
          state,
          code_challenge: challenge,
          scopes,
          jwk: device.jwk
        })
      });
      if (!enrollRes.ok) {
        throw new Error(`Studio OAuth enrollment failed (HTTP ${enrollRes.status})`);
      }
      const enrollment = await enrollRes.json();
      if (!enrollment?.authorization_uri) {
        throw new Error('Studio OAuth authorization_uri missing');
      }
      const opener = openBrowser || this.openBrowser;
      onProgress?.({ phase: 'oauth', message: `OAuth ログイン開始 (${resolvedOrigin}) — ブラウザで認証を完了してください...` });
      await opener(enrollment.authorization_uri, { redirect_uri: redirectUri, state });
      const waitStarted = Date.now();
      const waitTicker = onProgress ? setInterval(() => {
        const remainSec = Math.max(0, Math.round((timeoutMs - (Date.now() - waitStarted)) / 1000));
        onProgress({ phase: 'oauth', message: `ブラウザでの OAuth 承認を待機中... (残り ${formatDuration(remainSec)})` });
      }, 15_000) : null;
      waitTicker?.unref?.();
      let code;
      try {
        code = await callbackPromise;
      } finally {
        if (waitTicker) clearInterval(waitTicker);
      }
      onProgress?.({ phase: 'oauth', message: '認可コード受信 — DPoP トークンを発行中...' });

      const tokenUrl = `${resolvedOrigin}/auth/token`;
      const proof = createDpopProof(device, 'POST', tokenUrl);
      const form = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier
      });
      const tokenRes = await this.fetchImpl(tokenUrl, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          DPoP: proof
        },
        body: form.toString()
      });
      if (!tokenRes.ok) {
        throw new Error(`Studio OAuth token exchange failed (HTTP ${tokenRes.status})`);
      }
      const tokenData = await tokenRes.json();
      const now = Date.now();
      const record = {
        environment,
        origin: resolvedOrigin,
        device_id: tokenData.device_id,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        scopes: String(tokenData.scope || scopes.join(' ')).split(/\s+/).filter(Boolean),
        expires_at: now + Math.max(60, Number(tokenData.expires_in || 900)) * 1000,
        device_expires_at: tokenData.device_expires_in ? now + Number(tokenData.device_expires_in) * 1000 : null,
        connected_at: new Date(now).toISOString(),
        device: {
          private_key_pkcs8: device.private_key_pkcs8,
          jwk: device.jwk
        }
      };
      this.store.set(resolvedOrigin, record);
      return this.status({ environment, origin: resolvedOrigin });
    } finally {
      clearTimeout(timer);
      await new Promise(res => server.close(res));
    }
  }

  async refresh(origin) {
    const session = this.store.get(origin);
    if (!session?.refresh_token || !session?.device_id || !session?.device) {
      throw new Error('Studio OAuth session not found. Run /studio login or tactixcore-code studio login.');
    }
    const tokenUrl = `${origin}/auth/token`;
    const proof = createDpopProof(session.device, 'POST', tokenUrl);
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      device_id: session.device_id,
      refresh_token: session.refresh_token
    });
    const res = await this.fetchImpl(tokenUrl, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        DPoP: proof
      },
      body: form.toString()
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        this.store.delete(origin);
        throw new Error('Studio OAuth refresh token expired or revoked. Run /studio login again.');
      }
      throw new Error(`Studio OAuth token refresh failed (HTTP ${res.status})`);
    }
    const tokenData = await res.json();
    const now = Date.now();
    const updated = {
      ...session,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || session.refresh_token,
      scopes: tokenData.scope ? String(tokenData.scope).split(/\s+/).filter(Boolean) : session.scopes,
      expires_at: now + Math.max(60, Number(tokenData.expires_in || 900)) * 1000
    };
    this.store.set(origin, updated);
    return updated;
  }

  async logout({ environment = 'dev', origin } = {}) {
    const resolvedOrigin = resolveStudioOrigin({ environment, origin });
    const session = this.store.get(resolvedOrigin);
    if (session) {
      try {
        await this.authorizedFetch(resolvedOrigin, '/auth/revoke', { method: 'POST', retryRefresh: false });
      } catch { /* best-effort revoke */ }
      this.store.delete(resolvedOrigin);
    }
    return this.status({ environment, origin: resolvedOrigin });
  }

  async authorizedFetch(origin, path, { method = 'GET', headers = {}, body, signal, retryRefresh = true } = {}) {
    let session = this.store.get(origin);
    if (!session) {
      throw new Error('Not logged in to Studio API. Run /studio login or tactixcore-code studio login.');
    }
    if (retryRefresh && session.expires_at && session.expires_at <= Date.now() + 30_000) {
      session = await this.refresh(origin);
    }
    const targetUrl = `${origin}${path}`;
    const executeRequest = current => {
      const proof = createDpopProof(current.device, method, targetUrl, current.access_token);
      return this.fetchImpl(targetUrl, {
        method,
        redirect: 'error',
        headers: {
          ...headers,
          Authorization: `DPoP ${current.access_token}`,
          DPoP: proof
        },
        body,
        signal
      });
    };
    let response = await executeRequest(session);
    if (response.status === 401 && retryRefresh) {
      session = await this.refresh(origin);
      response = await executeRequest(session);
    }
    return response;
  }
}

export class StudioMCPClient {
  constructor(oauth) {
    this.oauth = oauth;
    this.initializedOrigins = new Set();
    this.nextId = 1;
  }

  async _rpc(origin, method, params = {}, { signal } = {}) {
    const id = this.nextId++;
    const res = await this.oauth.authorizedFetch(origin, MCP_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal
    });
    if (!res.ok) {
      let detail = '';
      try {
        const err = await res.json();
        detail = err?.error ? `: ${err.error}` : '';
      } catch { /* ignore */ }
      throw new Error(`Studio MCP request failed (HTTP ${res.status}${detail})`);
    }
    if (res.status === 202) return null;
    const payload = await res.json();
    if (payload.error) {
      throw new Error(`Studio MCP error (${payload.error.code}): ${payload.error.message}`);
    }
    return payload.result;
  }

  async ensureInitialized(origin, { signal } = {}) {
    if (this.initializedOrigins.has(origin)) return;
    await this._rpc(origin, 'initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'tactixcore-code', version: '0.2.0' }
    }, { signal });
    await this.oauth.authorizedFetch(origin, MCP_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
      signal
    });
    this.initializedOrigins.add(origin);
  }

  async callTool(origin, name, args = {}, { signal } = {}) {
    await this.ensureInitialized(origin, { signal });
    const result = await this._rpc(origin, 'tools/call', { name, arguments: args }, { signal });
    if (result?.isError) {
      throw new Error(result?.content?.[0]?.text || `MCP tool ${name} failed`);
    }
    if (result?.structuredContent !== undefined) return result.structuredContent;
    const text = result?.content?.[0]?.text;
    return text ? JSON.parse(text) : result;
  }

  listTeams(origin, { account_id, signal } = {}) {
    return this.callTool(origin, 'list_teams', account_id ? { account_id } : {}, { signal });
  }

  listGames(origin, { team_id, account_id, signal } = {}) {
    return this.callTool(origin, 'list_games', {
      ...(team_id ? { team_id } : {}),
      ...(account_id ? { account_id } : {})
    }, { signal });
  }

  listWorkspaces(origin, { team_id, account_id, signal } = {}) {
    return this.callTool(origin, 'list_workspaces', {
      ...(team_id ? { team_id } : {}),
      ...(account_id ? { account_id } : {})
    }, { signal });
  }

  getVideoMetadata(origin, { team_id, game_id, workspace_id, account_id, video_id, signal }) {
    const gid = game_id || workspace_id;
    return this.callTool(origin, 'get_video_metadata', {
      team_id,
      game_id: gid,
      ...(account_id ? { account_id } : {}),
      ...(video_id ? { video_id } : {})
    }, { signal });
  }

  getTransitionAnnotations(origin, { team_id, game_id, workspace_id, account_id, video_id, signal }) {
    const gid = game_id || workspace_id;
    return this.callTool(origin, 'get_transition_annotations', {
      team_id,
      game_id: gid,
      ...(account_id ? { account_id } : {}),
      ...(video_id ? { video_id } : {})
    }, { signal });
  }

  getVideoDownloadInfo(origin, { team_id, game_id, workspace_id, account_id, video_id, asset_id, signal }) {
    const gid = game_id || workspace_id;
    return this.callTool(origin, 'get_video_download_info', {
      team_id,
      game_id: gid,
      ...(account_id ? { account_id } : {}),
      ...(video_id ? { video_id } : {}),
      ...(asset_id ? { asset_id } : {})
    }, { signal });
  }

  getAnalysisResults(origin, { team_id, game_id, workspace_id, account_id, signal }) {
    const gid = game_id || workspace_id;
    return this.callTool(origin, 'get_analysis_results', {
      team_id,
      game_id: gid,
      ...(account_id ? { account_id } : {})
    }, { signal });
  }
}

export class StudioDataManager {
  constructor(profileDir, { fetchImpl = globalThis.fetch, openBrowser = defaultOpenBrowser, oauth = null, mcp = null, cacheDir = null } = {}) {
    this.profileDir = resolve(profileDir);
    this.oauth = oauth || new StudioOAuthClient(this.profileDir, { fetchImpl, openBrowser });
    this.mcp = mcp || new StudioMCPClient(this.oauth);
    this.cacheDir = cacheDir ? resolve(cacheDir) : join(this.profileDir, 'studio-cache');
    this.indexFile = join(this.cacheDir, 'index.json');
  }

  _ensureCacheDir() {
    mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
  }

  _readIndex() {
    if (!existsSync(this.indexFile)) return { schema_version: 1, entries: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.indexFile, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
        return parsed;
      }
    } catch { /* reset corrupt index */ }
    return { schema_version: 1, entries: {} };
  }

  _writeIndex(index) {
    this._ensureCacheDir();
    atomicWriteJson(this.indexFile, index, 0o600);
  }

  _entryKey(origin, teamId, workspaceId, kind, subKey = 'all') {
    return `${sha256Hex(origin).slice(0, 12)}:${teamId}:${workspaceId}:${kind}:${subKey}`;
  }

  _safeCachePath(origin, teamId, workspaceId, ...segments) {
    safeId(teamId, 'team_id');
    safeId(workspaceId, 'workspace_id');
    this._ensureCacheDir();
    const originHash = sha256Hex(origin).slice(0, 12);
    return inside(this.cacheDir, join(this.cacheDir, originHash, 'teams', teamId, workspaceId, ...segments));
  }

  _isPresentFile(filePath, expectedSize = null) {
    try {
      const st = lstatSync(filePath);
      if (st.isSymbolicLink() || !st.isFile()) return false;
      if (expectedSize !== null && st.size !== expectedSize) return false;
      return true;
    } catch {
      return false;
    }
  }

  status(opts = {}) { return this.oauth.status(opts); }
  login(opts = {}) { return this.oauth.login(opts); }
  logout(opts = {}) { return this.oauth.logout(opts); }

  async listTeams({ environment = 'dev', origin, account_id, signal } = {}) {
    const resolvedOrigin = resolveStudioOrigin({ environment, origin });
    return this.mcp.listTeams(resolvedOrigin, { account_id, signal });
  }

  async listGames({ environment = 'dev', origin, team_id, account_id, signal } = {}) {
    const resolvedOrigin = resolveStudioOrigin({ environment, origin });
    return this.mcp.listGames(resolvedOrigin, { team_id, account_id, signal });
  }

  async listWorkspaces({ environment = 'dev', origin, team_id, account_id, signal } = {}) {
    const resolvedOrigin = resolveStudioOrigin({ environment, origin });
    return this.mcp.listWorkspaces(resolvedOrigin, { team_id, account_id, signal });
  }

  async ensureAnalysisResults({ environment = 'dev', origin, team_id, game_id, workspace_id, account_id, force_refresh = false, signal } = {}) {
    const resolvedOrigin = resolveStudioOrigin({ environment, origin });
    const gid = game_id || workspace_id;
    safeId(team_id, 'team_id');
    safeId(gid, 'game_id');
    const key = this._entryKey(resolvedOrigin, team_id, gid, 'results', 'all');
    const filePath = this._safeCachePath(resolvedOrigin, team_id, gid, 'results', 'results.json');
    const index = this._readIndex();
    const existing = index.entries[key];
    if (!force_refresh && existing && this._isPresentFile(filePath, existing.size_bytes)) {
      const data = JSON.parse(readFileSync(filePath, 'utf8'));
      existing.last_accessed_at = new Date().toISOString();
      this._writeIndex(index);
      return { source: 'cache', refetched_missing: false, path: filePath, sha256: existing.sha256, fetched_at: existing.fetched_at, data };
    }
    const refetchedMissing = Boolean(existing && !this._isPresentFile(filePath));
    const data = await this.mcp.getAnalysisResults(resolvedOrigin, { team_id, game_id: gid, account_id, signal });
    const buf = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(tmp, buf, { mode: 0o600 });
    renameSync(tmp, filePath);
    const now = new Date().toISOString();
    const sha256 = sha256Hex(buf);
    index.entries[key] = {
      key, origin: resolvedOrigin, account_id: data.account_id || account_id || null,
      team_id, workspace_id: gid, game_id: gid, kind: 'results',
      video_id: null, asset_id: null, path: filePath, sha256,
      size_bytes: buf.length, fetched_at: now, last_accessed_at: now
    };
    this._writeIndex(index);
    return { source: 'remote', refetched_missing: refetchedMissing, path: filePath, sha256, fetched_at: now, data };
  }

  async ensureVideoMetadata({ environment = 'dev', origin, team_id, game_id, workspace_id, account_id, video_id, force_refresh = false, signal } = {}) {
    const resolvedOrigin = resolveStudioOrigin({ environment, origin });
    const gid = game_id || workspace_id;
    safeId(team_id, 'team_id');
    safeId(gid, 'game_id');
    if (video_id) safeId(video_id, 'video_id');

    const subKey = video_id || 'all';
    const key = this._entryKey(resolvedOrigin, team_id, gid, 'video_metadata', subKey);
    const filePath = this._safeCachePath(resolvedOrigin, team_id, gid, 'metadata', `videos-${subKey}.json`);
    const index = this._readIndex();
    const existing = index.entries[key];

    if (!force_refresh && existing && this._isPresentFile(filePath, existing.size_bytes)) {
      const data = JSON.parse(readFileSync(filePath, 'utf8'));
      existing.last_accessed_at = new Date().toISOString();
      this._writeIndex(index);
      return { source: 'cache', refetched_missing: false, path: filePath, sha256: existing.sha256, fetched_at: existing.fetched_at, data };
    }

    const refetchedMissing = Boolean(existing && !this._isPresentFile(filePath));
    const data = await this.mcp.getVideoMetadata(resolvedOrigin, { team_id, game_id: gid, account_id, video_id, signal });
    const buf = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(tmp, buf, { mode: 0o600 });
    renameSync(tmp, filePath);

    const now = new Date().toISOString();
    const sha256 = sha256Hex(buf);
    index.entries[key] = {
      key, origin: resolvedOrigin, account_id: data.account_id || account_id || null,
      team_id, workspace_id: gid, game_id: gid, kind: 'video_metadata',
      video_id: video_id || null, asset_id: null, path: filePath, sha256,
      size_bytes: buf.length, fetched_at: now, last_accessed_at: now
    };
    this._writeIndex(index);
    return { source: 'remote', refetched_missing: refetchedMissing, path: filePath, sha256, fetched_at: now, data };
  }

  async ensureTransitionAnnotations({ environment = 'dev', origin, team_id, game_id, workspace_id, account_id, video_id, force_refresh = false, signal } = {}) {
    const resolvedOrigin = resolveStudioOrigin({ environment, origin });
    const gid = game_id || workspace_id;
    safeId(team_id, 'team_id');
    safeId(gid, 'game_id');
    if (video_id) safeId(video_id, 'video_id');

    const subKey = video_id || 'all';
    const key = this._entryKey(resolvedOrigin, team_id, gid, 'annotations', subKey);
    const filePath = this._safeCachePath(resolvedOrigin, team_id, gid, 'annotations', `transitions-${subKey}.json`);
    const index = this._readIndex();
    const existing = index.entries[key];

    if (!force_refresh && existing && this._isPresentFile(filePath, existing.size_bytes)) {
      const data = JSON.parse(readFileSync(filePath, 'utf8'));
      existing.last_accessed_at = new Date().toISOString();
      this._writeIndex(index);
      return {
        source: 'cache', refetched_missing: false, path: filePath, sha256: existing.sha256,
        fetched_at: existing.fetched_at, content_revision: existing.revision ?? data.content_revision ?? 0, data
      };
    }

    const refetchedMissing = Boolean(existing && !this._isPresentFile(filePath));
    const data = await this.mcp.getTransitionAnnotations(resolvedOrigin, { team_id, game_id: gid, account_id, video_id, signal });
    const buf = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(tmp, buf, { mode: 0o600 });
    renameSync(tmp, filePath);

    const now = new Date().toISOString();
    const sha256 = sha256Hex(buf);
    index.entries[key] = {
      key, origin: resolvedOrigin, account_id: data.account_id || account_id || null,
      team_id, workspace_id: gid, game_id: gid, kind: 'annotations',
      video_id: video_id || null, asset_id: null, path: filePath, sha256,
      size_bytes: buf.length, revision: data.content_revision ?? 0, fetched_at: now, last_accessed_at: now
    };
    this._writeIndex(index);
    return {
      source: 'remote', refetched_missing: refetchedMissing, path: filePath, sha256,
      fetched_at: now, content_revision: data.content_revision ?? 0, data
    };
  }

  async ensureVideoFile({ environment = 'dev', origin, team_id, game_id, workspace_id, account_id, video_id, asset_id, force_refresh = false, verify_hash = true, signal, onProgress = null, videoIndex = null, videoTotal = null } = {}) {
    const resolvedOrigin = resolveStudioOrigin({ environment, origin });
    const gid = game_id || workspace_id;
    safeId(team_id, 'team_id');
    safeId(gid, 'game_id');
    if (video_id) safeId(video_id, 'video_id');
    if (asset_id) safeId(asset_id, 'asset_id');
    if (!video_id && !asset_id) throw new Error('video_id or asset_id is required');

    const index = this._readIndex();
    const cachedEntry = Object.values(index.entries).find(
      entry => entry.origin === resolvedOrigin && entry.team_id === team_id && (entry.game_id === gid || entry.workspace_id === gid)
        && entry.kind === 'video_file'
        && (video_id ? entry.video_id === video_id : true)
        && (asset_id ? entry.asset_id === asset_id : true)
    );

    if (!force_refresh && cachedEntry && this._isPresentFile(cachedEntry.path, cachedEntry.size_bytes)) {
      const hashOk = !verify_hash || (await sha256File(cachedEntry.path, {
        totalBytes: cachedEntry.size_bytes,
        onProgress,
        filename: cachedEntry.filename || cachedEntry.asset_id
      })) === cachedEntry.sha256;
      if (hashOk) {
        cachedEntry.last_accessed_at = new Date().toISOString();
        this._writeIndex(index);
        onProgress?.({ phase: 'video_cache', message: `動画キャッシュ再利用: ${cachedEntry.filename || cachedEntry.asset_id} (${formatBytes(cachedEntry.size_bytes)})` });
        return {
          source: 'cache', refetched_missing: false, path: cachedEntry.path, team_id, game_id: gid, workspace_id: gid,
          video_id: cachedEntry.video_id, asset_id: cachedEntry.asset_id, filename: cachedEntry.filename,
          sha256: cachedEntry.sha256, size_bytes: cachedEntry.size_bytes, fetched_at: cachedEntry.fetched_at
        };
      }
    }

    const refetchedMissing = Boolean(cachedEntry && !this._isPresentFile(cachedEntry.path));
    onProgress?.({ phase: 'download_info', message: `動画ダウンロード情報を取得中 (${video_id || asset_id})...` });
    const info = await this.mcp.getVideoDownloadInfo(resolvedOrigin, { team_id, game_id: gid, account_id, video_id, asset_id, signal });
    const rawExt = extname(info.filename || '').toLowerCase();
    const safeExt = /^\.[a-z0-9]{1,8}$/.test(rawExt) ? rawExt : '.mp4';
    const filePath = this._safeCachePath(resolvedOrigin, team_id, gid, 'media', `${info.asset_id}${safeExt}`);

    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    const partPath = `${filePath}.${randomBytes(6).toString('hex')}.part`;
    const chunkBytes = Math.max(64 * 1024, Number(info.chunk_bytes || 8 * 1024 * 1024));
    const hasher = createHash('sha256');
    const startedAt = Date.now();
    const prefix = videoIndex && videoTotal ? `video ${videoIndex}/${videoTotal}` : 'downloading';
    const displayName = info.filename || `${info.asset_id}${safeExt}`;
    let written = 0;

    onProgress?.({
      phase: 'download', prefix, completed: 0, total: info.size_bytes,
      bytesPerSec: 0, etaSec: null, filename: displayName, done: false
    });

    try {
      const writer = createWriteStream(partPath, { mode: 0o600 });
      try {
        while (written < info.size_bytes) {
          const end = Math.min(info.size_bytes - 1, written + chunkBytes - 1);
          const res = await this.oauth.authorizedFetch(resolvedOrigin, info.download_path, {
            method: 'GET',
            headers: { Range: `bytes=${written}-${end}` },
            signal
          });
          if (res.status !== 206 && res.status !== 200) {
            throw new Error(`Video download failed (HTTP ${res.status})`);
          }
          const chunk = Buffer.from(await res.arrayBuffer());
          if (chunk.length === 0) throw new Error('Video download stream ended unexpectedly');
          hasher.update(chunk);
          written += chunk.length;
          if (!writer.write(chunk)) {
            await new Promise((resDrain, rejDrain) => {
              const onDrain = () => {
                writer.off('error', onError);
                resDrain();
              };
              const onError = err => {
                writer.off('drain', onDrain);
                rejDrain(err);
              };
              writer.once('drain', onDrain);
              writer.once('error', onError);
            });
          }
          const elapsedSec = Math.max(0.001, (Date.now() - startedAt) / 1000);
          const bytesPerSec = written / elapsedSec;
          const remaining = Math.max(0, info.size_bytes - written);
          const etaSec = bytesPerSec > 0 ? remaining / bytesPerSec : null;
          onProgress?.({
            phase: 'download', prefix, completed: written, total: info.size_bytes,
            bytesPerSec, etaSec, filename: displayName, done: false
          });
          if (res.status === 200) break;
        }
      } finally {
        if (!writer.destroyed && !writer.errored) {
          await new Promise((resEnd, rejEnd) => {
            const onFinish = () => {
              writer.off('error', onError);
              resEnd();
            };
            const onError = err => {
              writer.off('finish', onFinish);
              rejEnd(err);
            };
            writer.once('error', onError);
            writer.end(onFinish);
          });
        }
      }
      const actualHash = hasher.digest('hex');
      if (written !== info.size_bytes) throw new Error(`Video size mismatch: expected=${info.size_bytes}, actual=${written}`);
      if (actualHash !== info.sha256) throw new Error(`Video SHA-256 mismatch: expected=${info.sha256}, actual=${actualHash}`);
      renameSync(partPath, filePath);
      const totalElapsedSec = Math.max(0.001, (Date.now() - startedAt) / 1000);
      onProgress?.({
        phase: 'download', prefix, completed: written, total: info.size_bytes,
        bytesPerSec: written / totalElapsedSec, etaSec: 0, filename: displayName, done: true
      });
    } catch (error) {
      try { unlinkSync(partPath); } catch { /* ignore */ }
      throw error;
    }

    const now = new Date().toISOString();
    const key = this._entryKey(resolvedOrigin, team_id, gid, 'video_file', info.asset_id);
    index.entries[key] = {
      key, origin: resolvedOrigin, account_id: info.account_id || account_id || null,
      team_id, workspace_id: gid, game_id: gid, kind: 'video_file',
      video_id: info.video_id, asset_id: info.asset_id, filename: info.filename || `${info.asset_id}${safeExt}`,
      path: filePath, sha256: info.sha256, size_bytes: info.size_bytes, fetched_at: now, last_accessed_at: now
    };
    this._writeIndex(index);
    return {
      source: 'remote', refetched_missing: refetchedMissing, path: filePath, team_id, game_id: gid, workspace_id: gid,
      video_id: info.video_id, asset_id: info.asset_id, filename: info.filename,
      sha256: info.sha256, size_bytes: info.size_bytes, fetched_at: now
    };
  }

  async ensureMatchData({ environment = 'dev', origin, team_id, game_id, workspace_id, account_id, video_id, include_video = true, force_refresh = false, signal, onProgress = null } = {}) {
    const gid = game_id || workspace_id;
    const totalSteps = include_video ? 3 : 2;
    onProgress?.({ phase: 'metadata', message: `[1/${totalSteps}] 動画メタデータを取得中 (${team_id}/${gid})...` });
    const metadata = await this.ensureVideoMetadata({ environment, origin, team_id, game_id: gid, account_id, video_id, force_refresh, signal });
    onProgress?.({ phase: 'metadata', message: `[1/${totalSteps}] メタデータ完了 (${metadata.source}, 動画 ${metadata.data.count ?? (metadata.data.videos || []).length}本)` });

    onProgress?.({ phase: 'annotations', message: `[2/${totalSteps}] トランジション注釈を取得中 (${team_id}/${gid})...` });
    const annotations = await this.ensureTransitionAnnotations({ environment, origin, team_id, game_id: gid, account_id, video_id, force_refresh, signal });
    onProgress?.({ phase: 'annotations', message: `[2/${totalSteps}] 注釈完了 (${annotations.source}, ${annotations.data.count ?? 0}件)` });

    const videos = [];
    if (include_video) {
      const list = metadata.data.videos || [];
      onProgress?.({ phase: 'videos', message: `[3/${totalSteps}] 動画ファイルを確認・取得中 (${list.length}本)...` });
      for (let i = 0; i < list.length; i++) {
        const v = list[i];
        videos.push(await this.ensureVideoFile({
          environment, origin, team_id, game_id: gid, account_id, video_id: v.id, asset_id: v.asset_id,
          force_refresh, signal, onProgress, videoIndex: i + 1, videoTotal: list.length
        }));
      }
    }
    return {
      account_id: metadata.data.account_id || account_id || null,
      team_id,
      game_id: gid,
      workspace_id: gid,
      video_metadata: { source: metadata.source, refetched_missing: metadata.refetched_missing, path: metadata.path, count: metadata.data.count },
      annotations: { source: annotations.source, refetched_missing: annotations.refetched_missing, path: annotations.path, count: annotations.data.count, content_revision: annotations.content_revision },
      videos
    };
  }

  cacheStatus({ team_id, game_id, workspace_id } = {}) {
    const gid = game_id || workspace_id;
    const index = this._readIndex();
    const entries = Object.values(index.entries).filter(
      e => (!team_id || e.team_id === team_id) && (!gid || e.game_id === gid || e.workspace_id === gid)
    );
    let totalBytes = 0; let videoBytes = 0; let metadataBytes = 0;
    let presentCount = 0; let missingCount = 0;
    const items = entries.map(entry => {
      const present = this._isPresentFile(entry.path);
      let diskBytes = 0;
      if (present) {
        presentCount++;
        diskBytes = lstatSync(entry.path).size;
        totalBytes += diskBytes;
        if (entry.kind === 'video_file') videoBytes += diskBytes;
        else metadataBytes += diskBytes;
      } else {
        missingCount++;
      }
      return {
        key: entry.key, team_id: entry.team_id, workspace_id: entry.workspace_id, kind: entry.kind,
        video_id: entry.video_id, asset_id: entry.asset_id, filename: entry.filename || null,
        path: entry.path, present, size_bytes: diskBytes, expected_bytes: entry.size_bytes,
        sha256: entry.sha256, fetched_at: entry.fetched_at, last_accessed_at: entry.last_accessed_at
      };
    });
    return {
      cache_dir: this.cacheDir, total_entries: items.length, present_entries: presentCount,
      missing_entries: missingCount, total_bytes: totalBytes, video_bytes: videoBytes,
      metadata_bytes: metadataBytes, items
    };
  }

  clean({ all = false, videos_only = false, team_id, game_id, workspace_id, max_age_hours, max_bytes, dry_run = false } = {}) {
    const gid = game_id || workspace_id;
    const index = this._readIndex();
    const now = Date.now();
    const allEntries = Object.values(index.entries);
    const toRemove = new Set();

    const matchesScope = entry =>
      (!team_id || entry.team_id === team_id)
      && (!gid || entry.game_id === gid || entry.workspace_id === gid)
      && (!videos_only || entry.kind === 'video_file');

    if ((all || videos_only || team_id || gid) && max_age_hours === undefined && max_bytes === undefined) {
      for (const entry of allEntries) if (matchesScope(entry)) toRemove.add(entry.key);
    }
    if (max_age_hours !== undefined) {
      const cutoff = now - Number(max_age_hours) * 3600_000;
      for (const entry of allEntries) {
        if (!matchesScope(entry)) continue;
        const ts = Date.parse(entry.last_accessed_at || entry.fetched_at || 0);
        if (!Number.isFinite(ts) || ts <= cutoff) toRemove.add(entry.key);
      }
    }
    if (max_bytes !== undefined) {
      const limit = Math.max(0, Number(max_bytes));
      const surviving = allEntries
        .filter(e => !toRemove.has(e.key) && matchesScope(e))
        .map(e => ({
          entry: e,
          bytes: this._isPresentFile(e.path) ? lstatSync(e.path).size : 0,
          ts: Date.parse(e.last_accessed_at || e.fetched_at || 0) || 0
        }))
        .sort((a, b) => a.ts - b.ts);
      let currentBytes = surviving.reduce((sum, x) => sum + x.bytes, 0);
      for (const item of surviving) {
        if (currentBytes <= limit) break;
        toRemove.add(item.entry.key);
        currentBytes -= item.bytes;
      }
    }

    const removedPaths = [];
    let reclaimedBytes = 0;
    for (const key of toRemove) {
      const entry = index.entries[key];
      if (!entry) continue;
      const safeTarget = inside(this.cacheDir, entry.path);
      const present = this._isPresentFile(safeTarget);
      const size = present ? lstatSync(safeTarget).size : 0;
      reclaimedBytes += size;
      removedPaths.push(safeTarget);
      if (!dry_run) {
        if (present) {
          rmSync(safeTarget, { force: true });
          removeEmptyParents(dirname(safeTarget), this.cacheDir);
        }
        delete index.entries[key];
      }
    }
    if (!dry_run && toRemove.size > 0) this._writeIndex(index);

    const remainingEntries = Object.values(index.entries).filter(e => !(dry_run && toRemove.has(e.key)));
    const remainingBytes = remainingEntries.reduce((sum, e) => sum + (this._isPresentFile(e.path) ? lstatSync(e.path).size : 0), 0);
    return {
      dry_run: Boolean(dry_run), removed_count: removedPaths.length, reclaimed_bytes: reclaimedBytes,
      removed_paths: removedPaths, remaining_count: remainingEntries.length, remaining_bytes: remainingBytes
    };
  }
}

export function createStudioTool(manager) {
  return {
    name: 'studio_mcp',
    label: 'Studio MCP (teams, games, videos, annotations, results)',
    description: 'Connect to TactixCore Studio API via OAuth (PKCE+DPoP) and MCP to list teams/games and fetch video metadata, video files, transition annotations, and analysis results into the user profile cache (~/.config/tactixcore-code/studio-cache). Automatically re-fetches if a cached file is missing, and supports per-team/per-game/videos-only local cache cleanup.',
    parameters: Type.Object({
      action: Type.Union(['status', 'login', 'logout', 'teams', 'games', 'workspaces', 'videos', 'annotations', 'results', 'ensure_video', 'ensure_match', 'cache_status', 'clean'].map(v => Type.Literal(v))),
      environment: Type.Optional(Type.Union([Type.Literal('dev'), Type.Literal('prd')])),
      origin: Type.Optional(Type.String()),
      account_id: Type.Optional(Type.String()),
      team_id: Type.Optional(Type.String()),
      game_id: Type.Optional(Type.String()),
      workspace_id: Type.Optional(Type.String()),
      video_id: Type.Optional(Type.String()),
      asset_id: Type.Optional(Type.String()),
      include_video: Type.Optional(Type.Boolean()),
      force_refresh: Type.Optional(Type.Boolean()),
      all: Type.Optional(Type.Boolean()),
      videos_only: Type.Optional(Type.Boolean()),
      max_age_hours: Type.Optional(Type.Number()),
      max_bytes: Type.Optional(Type.Number()),
      dry_run: Type.Optional(Type.Boolean())
    }, { additionalProperties: false }),
    async execute(_id, args, signal, onUpdate) {
      const env = args.environment || 'dev';
      const gid = args.game_id || args.workspace_id;
      let lastUpdate = 0;
      const onProgress = typeof onUpdate === 'function' ? event => {
        const now = Date.now();
        if (!event.done && (event.phase === 'download' || event.phase === 'verify_cache') && now - lastUpdate < 1000) return;
        lastUpdate = now;
        try {
          onUpdate({ content: [{ type: 'text', text: formatProgressLine(event) }], details: { progress: event } });
        } catch { /* ignore UI update errors */ }
      } : null;
      let result;
      if (args.action === 'status') result = manager.status({ environment: env, origin: args.origin });
      else if (args.action === 'login') result = await manager.login({ environment: env, origin: args.origin, onProgress });
      else if (args.action === 'logout') result = await manager.logout({ environment: env, origin: args.origin });
      else if (args.action === 'teams') result = await manager.listTeams({ environment: env, origin: args.origin, account_id: args.account_id, signal });
      else if (args.action === 'games') result = await manager.listGames({ environment: env, origin: args.origin, team_id: args.team_id, account_id: args.account_id, signal });
      else if (args.action === 'workspaces') result = await manager.listWorkspaces({ environment: env, origin: args.origin, team_id: args.team_id, account_id: args.account_id, signal });
      else if (args.action === 'videos') result = await manager.ensureVideoMetadata({ environment: env, origin: args.origin, team_id: args.team_id, game_id: gid, account_id: args.account_id, video_id: args.video_id, force_refresh: Boolean(args.force_refresh), signal });
      else if (args.action === 'annotations') result = await manager.ensureTransitionAnnotations({ environment: env, origin: args.origin, team_id: args.team_id, game_id: gid, account_id: args.account_id, video_id: args.video_id, force_refresh: Boolean(args.force_refresh), signal });
      else if (args.action === 'results') result = await manager.ensureAnalysisResults({ environment: env, origin: args.origin, team_id: args.team_id, game_id: gid, account_id: args.account_id, force_refresh: Boolean(args.force_refresh), signal });
      else if (args.action === 'ensure_video') result = await manager.ensureVideoFile({ environment: env, origin: args.origin, team_id: args.team_id, game_id: gid, account_id: args.account_id, video_id: args.video_id, asset_id: args.asset_id, force_refresh: Boolean(args.force_refresh), signal, onProgress });
      else if (args.action === 'ensure_match') result = await manager.ensureMatchData({ environment: env, origin: args.origin, team_id: args.team_id, game_id: gid, account_id: args.account_id, video_id: args.video_id, include_video: args.include_video !== false, force_refresh: Boolean(args.force_refresh), signal, onProgress });
      else if (args.action === 'cache_status') result = manager.cacheStatus({ team_id: args.team_id, game_id: gid });
      else if (args.action === 'clean') result = manager.clean({ all: Boolean(args.all), videos_only: Boolean(args.videos_only), team_id: args.team_id, game_id: gid, max_age_hours: args.max_age_hours, max_bytes: args.max_bytes, dry_run: Boolean(args.dry_run) });
      else throw new Error('Unknown studio_mcp action');
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: {} };
    }
  };
}

export function studioExtension(manager) {
  return pi => {
    pi.registerCommand('studio', {
      description: 'Studio MCP OAuth & cache: /studio login|status|logout|teams|games|fetch|cache|clean [dev|prd]',
      handler: async (args, ctx) => {
        const parts = String(args || '').trim().split(/\s+/).filter(Boolean);
        const sub = parts[0] || 'status';
        const env = parts.includes('prd') ? 'prd' : 'dev';
        try {
          if (sub === 'status') {
            const st = manager.status({ environment: env });
            ctx.ui.notify(`Studio (${st.environment}): ${st.connected ? `connected (${st.origin})` : 'not connected'}`, 'info');
            return;
          }
          if (sub === 'login') {
            ctx.ui.notify(`Opening browser for Studio OAuth (${env})...`, 'info');
            const st = await manager.login({ environment: env });
            ctx.ui.notify(`Studio OAuth connected: ${st.origin}`, 'info');
            return;
          }
          if (sub === 'logout') {
            await manager.logout({ environment: env });
            ctx.ui.notify(`Studio OAuth disconnected (${env}).`, 'info');
            return;
          }
          if (sub === 'teams') {
            const res = await manager.listTeams({ environment: env });
            const lines = (res.teams || []).map(t => `${t.team_id}(${t.game_count}試合)`).join(', ');
            ctx.ui.notify(`Teams (${res.count}): ${lines || 'none'}`, 'info');
            return;
          }
          if (sub === 'games' || sub === 'workspaces') {
            const teamArg = parts.slice(1).find(p => !p.startsWith('--') && p !== 'dev' && p !== 'prd');
            const res = await manager.listGames({ environment: env, team_id: teamArg });
            const lines = (res.games || []).map(g => `${g.team_id}/${g.game_id} (${g.name || g.workspace_id})`).join(', ');
            ctx.ui.notify(`Games (${res.count}): ${lines || 'none'}`, 'info');
            return;
          }
          if (sub === 'fetch') {
            const positional = parts.slice(1).filter(p => !p.startsWith('--') && p !== 'dev' && p !== 'prd');
            const [team_id, game_id, video_id] = positional;
            if (!team_id || !game_id) {
              ctx.ui.notify('Usage: /studio fetch <team_id> <game_id> [video_id] [--no-video] [--refresh]', 'warning');
              return;
            }
            const include_video = !parts.includes('--no-video');
            const force_refresh = parts.includes('--refresh');
            ctx.ui.notify(`Fetching Studio data (${team_id}/${game_id})...`, 'info');
            let lastBucket = -1;
            const onProgress = event => {
              const line = formatProgressLine(event);
              ctx.ui.setStatus?.('studio', line);
              if ((event.phase === 'download' || event.phase === 'verify_cache') && event.total > 0) {
                const bucket = Math.floor((event.completed / event.total) * 4); // 0%, 25%, 50%, 75%, 100%
                if (event.done || bucket > lastBucket) {
                  lastBucket = bucket;
                  ctx.ui.notify(line, 'info');
                }
              }
            };
            let res;
            try {
              res = await manager.ensureMatchData({ environment: env, team_id, game_id, video_id, include_video, force_refresh, onProgress });
            } finally {
              ctx.ui.setStatus?.('studio', '');
            }
            ctx.ui.notify(`Fetched ${team_id}/${game_id}: metadata(${res.video_metadata.source}), annotations(${res.annotations.source}, ${res.annotations.count}件), videos(${res.videos.length}本)`, 'info');
            return;
          }
          if (sub === 'cache') {
            const st = manager.cacheStatus();
            ctx.ui.notify(`Studio cache: ${st.present_entries} present, ${st.missing_entries} missing, ${st.total_bytes} bytes (${st.cache_dir})`, 'info');
            return;
          }
          if (sub === 'clean') {
            const videosOnly = parts.includes('--videos-only');
            const res = manager.clean({ all: !videosOnly, videos_only: videosOnly });
            ctx.ui.notify(`Studio cache cleaned: removed ${res.removed_count} files (${res.reclaimed_bytes} bytes reclaimed).`, 'info');
            return;
          }
          ctx.ui.notify('Usage: /studio login|status|logout|teams|games|fetch|cache|clean [dev|prd] [--videos-only]', 'warning');
        } catch (error) {
          ctx.ui.notify(`Studio error: ${error.message}`, 'error');
        }
      }
    });
  };
}

export async function runStudioCommand(flags, { profile, out = console.log, err = console.error, manager = null, progressStream = process.stderr } = {}) {
  const studio = manager || new StudioDataManager(profile);
  const action = flags[0] && !flags[0].startsWith('--') ? flags[0] : 'status';
  const rest = flags[0] && !flags[0].startsWith('--') ? flags.slice(1) : flags;
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        environment: { type: 'string', default: 'dev' },
        origin: { type: 'string' },
        account: { type: 'string' },
        team: { type: 'string' },
        game: { type: 'string' },
        workspace: { type: 'string' },
        video: { type: 'string' },
        asset: { type: 'string' },
        'max-age-hours': { type: 'string' },
        'max-bytes': { type: 'string' },
        refresh: { type: 'boolean', default: false },
        'no-video': { type: 'boolean', default: false },
        all: { type: 'boolean', default: false },
        'videos-only': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        quiet: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false }
      }
    }));
  } catch {
    err('Usage: tactixcore-code studio login|status|logout|teams|games|videos|annotations|results|fetch|cache|clean [--environment dev|prd] [--team ID] [--game ID] [--videos-only] [--all] [--dry-run] [--quiet]');
    return 2;
  }
  if (values.help) {
    out('Usage: tactixcore-code studio login|status|logout|teams|games|videos|annotations|results|fetch|cache|clean [--environment dev|prd] [--team ID] [--game ID] [--videos-only] [--all] [--dry-run] [--quiet]');
    return 0;
  }
  const reporter = createTerminalProgressReporter({ stream: progressStream, quiet: values.quiet });
  const onProgress = event => reporter.report(event);
  try {
    const opts = { environment: values.environment, origin: values.origin, account_id: values.account };
    const gid = values.game || values.workspace;
    let result;
    if (action === 'status') result = studio.status(opts);
    else if (action === 'login') result = await studio.login({ ...opts, onProgress });
    else if (action === 'logout') result = await studio.logout(opts);
    else if (action === 'teams') {
      onProgress({ phase: 'teams', message: `チーム一覧を取得中 (${values.environment})...` });
      result = await studio.listTeams(opts);
    }
    else if (action === 'games') {
      onProgress({ phase: 'games', message: `試合一覧を取得中 (${values.team || 'all'})...` });
      result = await studio.listGames({ ...opts, team_id: values.team });
    }
    else if (action === 'workspaces') result = await studio.listWorkspaces({ ...opts, team_id: values.team });
    else if (action === 'videos') result = await studio.ensureVideoMetadata({ ...opts, team_id: values.team, game_id: gid, video_id: values.video, force_refresh: values.refresh });
    else if (action === 'annotations') result = await studio.ensureTransitionAnnotations({ ...opts, team_id: values.team, game_id: gid, video_id: values.video, force_refresh: values.refresh });
    else if (action === 'results') result = await studio.ensureAnalysisResults({ ...opts, team_id: values.team, game_id: gid, force_refresh: values.refresh });
    else if (action === 'fetch') {
      result = values.asset
        ? await studio.ensureVideoFile({ ...opts, team_id: values.team, game_id: gid, video_id: values.video, asset_id: values.asset, force_refresh: values.refresh, onProgress })
        : await studio.ensureMatchData({ ...opts, team_id: values.team, game_id: gid, video_id: values.video, include_video: !values['no-video'], force_refresh: values.refresh, onProgress });
    }
    else if (action === 'cache') result = studio.cacheStatus({ team_id: values.team, game_id: gid });
    else if (action === 'clean') {
      result = studio.clean({
        all: values.all,
        videos_only: values['videos-only'],
        team_id: values.team,
        game_id: gid,
        max_age_hours: values['max-age-hours'] !== undefined ? Number(values['max-age-hours']) : undefined,
        max_bytes: values['max-bytes'] !== undefined ? Number(values['max-bytes']) : undefined,
        dry_run: values['dry-run']
      });
    } else {
      err(`Unknown studio subcommand: ${action}`);
      return 2;
    }
    reporter.finish();
    out(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    reporter.finish();
    err(`Studio command failed: ${error.message}`);
    return 1;
  }
}
