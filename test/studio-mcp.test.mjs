import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, randomBytes, verify as cryptoVerify } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.mjs';
import { createStudioTool, StudioDataManager, studioExtension } from '../src/studio-mcp.mjs';

function verifyDpop(proof, method, expectedUrl, expectedJwk, expectedToken = null) {
  const [a, b, c] = proof.split('.');
  const header = JSON.parse(Buffer.from(a, 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
  assert.equal(header.typ, 'dpop+jwt');
  assert.equal(header.alg, 'EdDSA');
  assert.deepEqual(header.jwk, expectedJwk);
  const pubKey = createPublicKey({ key: header.jwk, format: 'jwk' });
  assert.equal(cryptoVerify(null, Buffer.from(`${a}.${b}`, 'utf8'), pubKey, Buffer.from(c, 'base64url')), true);
  assert.equal(payload.htm, method.toUpperCase());
  assert.equal(payload.htu, expectedUrl);
  if (expectedToken) {
    assert.equal(payload.ath, createHash('sha256').update(expectedToken, 'utf8').digest('base64url'));
  }
}

async function startMockStudio() {
  const videoBytes = Buffer.from('MOCK_VIDEO_BYTES_'.repeat(2500));
  const videoSha = createHash('sha256').update(videoBytes).digest('hex');
  const requests = new Map();
  const codes = new Map();
  const devices = new Map();
  let mediaCalls = 0;

  const server = createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const url = new URL(req.url, origin);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };

    if (req.method === 'POST' && url.pathname === '/auth/requests') {
      const body = JSON.parse(raw);
      assert.equal(body.client_id, 'tactixcore-code');
      const rid = randomBytes(8).toString('hex');
      requests.set(rid, body);
      return json(200, { request_id: rid, authorization_uri: `${origin}/auth/authorize/${rid}` });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/auth/authorize/')) {
      const rid = url.pathname.split('/').pop();
      const row = requests.get(rid);
      const code = randomBytes(16).toString('base64url');
      codes.set(code, row);
      res.writeHead(303, { Location: `${row.redirect_uri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(row.state)}` });
      res.end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/auth/token') {
      const form = new URLSearchParams(raw);
      const code = form.get('code');
      const row = codes.get(code);
      codes.delete(code);
      assert.equal(createHash('sha256').update(form.get('code_verifier'), 'ascii').digest('base64url'), row.code_challenge);
      verifyDpop(req.headers.dpop, 'POST', `${origin}/auth/token`, row.jwk);
      const deviceId = randomBytes(8).toString('hex');
      const access = 'acc_' + randomBytes(12).toString('hex');
      const refresh = 'ref_' + randomBytes(12).toString('hex');
      devices.set(deviceId, { jwk: row.jwk, access, refresh });
      return json(200, { access_token: access, refresh_token: refresh, device_id: deviceId, token_type: 'DPoP', expires_in: 900, scope: 'workspace:read' });
    }
    const auth = () => {
      const h = req.headers.authorization || '';
      if (!h.startsWith('DPoP ')) return null;
      const tok = h.slice(5);
      const found = [...devices.entries()].find(([, d]) => d.access === tok);
      if (!found) return null;
      verifyDpop(req.headers.dpop, req.method, `${origin}${url.pathname}`, found[1].jwk, tok);
      return found;
    };
    if (req.method === 'POST' && url.pathname === '/auth/revoke') {
      const a = auth();
      if (!a) return json(401, { error: 'auth_required' });
      devices.delete(a[0]);
      return json(200, { revoked: true });
    }
    if (req.method === 'POST' && url.pathname === '/mcp/studio/') {
      if (!auth()) return json(401, { error: 'auth_required' });
      const rpc = JSON.parse(raw);
      if (rpc.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
      if (rpc.method === 'initialize') return json(200, { jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'tactixcore-studio-mcp', version: '1.0.0' } } });
      if (rpc.method === 'tools/call') {
        const { name, arguments: args } = rpc.params;
        let data;
        if (name === 'list_workspaces') data = { workspaces: [{ id: 'm1', owner_team_id: 'team_a', name: 'Match 1' }], count: 1 };
        if (name === 'get_video_metadata') data = { team_id: args.team_id, workspace_id: args.workspace_id, count: 1, videos: [{ id: 'v1', asset_id: 'a1', filename: 'clip.mp4', sha256: videoSha, size_bytes: videoBytes.length, download_path: `/api/studio/v1/workspaces/${args.team_id}/${args.workspace_id}/media/a1` }] };
        if (name === 'get_transition_annotations') data = { team_id: args.team_id, workspace_id: args.workspace_id, content_revision: 2, count: 1, items: [{ id: 'tr1', video: { id: 'v1' }, segment: { start_sec: 1, end_sec: 5 } }] };
        if (name === 'get_video_download_info') data = { team_id: args.team_id, workspace_id: args.workspace_id, video_id: 'v1', asset_id: 'a1', filename: 'clip.mp4', sha256: videoSha, size_bytes: videoBytes.length, download_path: `/api/studio/v1/workspaces/${args.team_id}/${args.workspace_id}/media/a1`, chunk_bytes: 20000 };
        return json(200, { jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false } });
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/studio/v1/workspaces/team_a/m1/media/a1') {
      if (!auth()) return json(401, { error: 'auth_required' });
      mediaCalls++;
      const range = req.headers.range;
      const [, s, e] = range.match(/^bytes=(\d+)-(\d+)$/);
      const slice = videoBytes.subarray(Number(s), Number(e) + 1);
      res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Length': String(slice.length), 'Content-Range': `bytes ${s}-${e}/${videoBytes.length}` });
      res.end(slice);
      return;
    }
    json(404, { error: 'not_found' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, videoBytes, videoSha, getMediaCalls: () => mediaCalls, close: () => new Promise(resolve => server.close(resolve)) };
}

test('standalone tactixcore-code CLI supports --version and studio commands from any directory', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-code-studio-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outputs = [];
  assert.equal(await main(['--version'], { out: s => outputs.push(s), err: () => {} }), 0);
  assert.match(outputs[0], /^tactixcore-code 0\.2\.0/);

  const statusOut = [];
  assert.equal(await main(['studio', 'status', '--environment', 'dev'], {
    env: { XDG_CONFIG_HOME: dir },
    out: s => statusOut.push(s),
    err: () => {}
  }), 0);
  const parsed = JSON.parse(statusOut[0]);
  assert.equal(parsed.connected, false);
  assert.equal(parsed.environment, 'dev');
});

test('StudioDataManager, studio_mcp tool, and /studio extension handle OAuth, cache, clean, and auto-refetch', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-code-studio-e2e-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const mock = await startMockStudio();
  t.after(mock.close);

  const manager = new StudioDataManager(dir, {
    async openBrowser(authUri) {
      const r = await fetch(authUri, { redirect: 'manual' });
      assert.equal(r.status, 303);
      assert.equal((await fetch(r.headers.get('location'))).status, 200);
    }
  });

  const tool = createStudioTool(manager);
  const runTool = async args => JSON.parse((await tool.execute('id', args)).content[0].text);

  const loggedIn = await runTool({ action: 'login', environment: 'dev', origin: mock.origin });
  assert.equal(loggedIn.connected, true);
  assert.equal(statSync(join(dir, 'studio-auth.json')).mode & 0o777, 0o600);

  const first = await runTool({ action: 'ensure_match', environment: 'dev', origin: mock.origin, team_id: 'team_a', workspace_id: 'm1' });
  assert.equal(first.videos[0].source, 'remote');
  assert.equal(first.videos[0].sha256, mock.videoSha);
  assert.deepEqual(readFileSync(first.videos[0].path), mock.videoBytes);
  const callsAfterFirst = mock.getMediaCalls();

  const second = await runTool({ action: 'ensure_match', environment: 'dev', origin: mock.origin, team_id: 'team_a', workspace_id: 'm1' });
  assert.equal(second.videos[0].source, 'cache');
  assert.equal(mock.getMediaCalls(), callsAfterFirst);

  // External delete -> auto-refetch
  unlinkSync(first.videos[0].path);
  assert.equal(existsSync(first.videos[0].path), false);
  const refetched = await runTool({ action: 'ensure_video', environment: 'dev', origin: mock.origin, team_id: 'team_a', workspace_id: 'm1', video_id: 'v1' });
  assert.equal(refetched.source, 'remote');
  assert.equal(refetched.refetched_missing, true);

  // /studio command registration & clean
  const commands = new Map();
  studioExtension(manager)({ registerCommand: (name, def) => commands.set(name, def) });
  assert.ok(commands.has('studio'));
  const notifications = [];
  await commands.get('studio').handler('clean --videos-only', { ui: { notify: (msg, level) => notifications.push({ msg, level }) } });
  assert.match(notifications[0].msg, /removed 1 files/);
  assert.equal(existsSync(refetched.path), false);

  await runTool({ action: 'logout', environment: 'dev', origin: mock.origin });
});
