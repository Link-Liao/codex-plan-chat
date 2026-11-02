import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

const root = resolve('public');
const dataDir = resolve(process.env.DATA_DIR || 'data');
const credentialsPath = resolve(dataDir, 'credentials.json');
const password = process.env.APP_PASSWORD || '';
const model = process.env.CODEX_MODEL || 'gpt-6-luna';
const port = Number(process.env.PORT || 8080);

if (!password) throw new Error('APP_PASSWORD must be set before starting the web app.');

function constantTimeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function authorized(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  let decoded;
  try { decoded = Buffer.from(header.slice(6), 'base64').toString('utf8'); } catch { return false; }
  const colon = decoded.indexOf(':');
  if (colon < 0) return false;
  return constantTimeEqual(decoded.slice(0, colon), 'codex') && constantTimeEqual(decoded.slice(colon + 1), password);
}

async function loadCredentials() {
  if (!existsSync(credentialsPath)) throw new Error('ChatGPT plan credentials are not installed on this server yet.');
  return JSON.parse(await readFile(credentialsPath, 'utf8'));
}

let refreshInFlight;
async function getAccessToken() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const auth = await loadCredentials();
    if (!auth.access_token || !auth.refresh_token || !auth.client_id || !auth.scopes?.includes('chatgpt.tokens.use.direct')) throw new Error('Credential file is incomplete or missing ChatGPT plan permission.');
    if (Date.now() < Number(auth.expires_at || 0) - 120_000) return auth.access_token;

    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: auth.client_id,
      refresh_token: auth.refresh_token,
      resource: 'https://api.openai.com/v1',
    });
    const response = await fetch('https://auth.openai.com/api/accounts/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error_description || body.error || `Token refresh failed (${response.status}).`);
    const updated = { ...auth, ...body, expires_at: Date.now() + Number(body.expires_in || 3600) * 1000 };
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await writeFile(credentialsPath, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
    await chmod(credentialsPath, 0o600);
    return updated.access_token;
  })();
  try { return await refreshInFlight; } finally { refreshInFlight = undefined; }
}

function readBody(req, limit = 12_000) {
  return new Promise((resolveBody, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      data += chunk;
      if (data.length > limit) reject(Object.assign(new Error('Request is too large.'), { status: 413 }));
    });
    req.on('end', () => resolveBody(data));
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function codexReply(prompt) {
  const accessToken = await getAccessToken();
  const child = spawn('codex', [
    'app-server', '--listen', 'stdio://',
    '-c', 'model_provider="openai_chatgpt_plan"',
    '-c', 'model_providers.openai_chatgpt_plan.name="ChatGPT plan"',
    '-c', 'model_providers.openai_chatgpt_plan.base_url="https://api.openai.com/v1"',
    '-c', 'model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN"',
    '-c', 'model_providers.openai_chatgpt_plan.wire_api="responses"',
    '-c', 'model_providers.openai_chatgpt_plan.requires_openai_auth=false',
    '-c', 'model_providers.openai_chatgpt_plan.supports_websockets=false',
  ], {
    env: {
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      HOME: process.env.HOME || '/var/lib/codex-plan-chat',
      CODEX_HOME: process.env.CODEX_HOME || '/var/lib/codex-plan-chat/codex-home',
      LANG: process.env.LANG || 'C.UTF-8',
      ACCESS_TOKEN: accessToken,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return new Promise((resolveReply, rejectReply) => {
    let stderr = '';
    let buffer = '';
    let threadId;
    let responseText = '';
    let finished = false;
    const timer = setTimeout(() => fail(new Error('Codex timed out. Please try again.')), 120_000);
    const lines = createInterface({ input: child.stdout });

    function finish(error, value) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      if (error) rejectReply(error); else resolveReply(value);
    }
    function fail(error) {
      child.kill();
      finish(error);
    }
    function send(message) { child.stdin.write(`${JSON.stringify(message)}\n`); }

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000); });
    child.on('error', error => finish(error));
    child.on('exit', code => {
      if (!finished) finish(new Error(code === 0 ? 'Codex ended before completing the reply.' : `Codex failed (${code}). ${stderr.trim()}`));
    });
    lines.on('line', line => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.error) return fail(new Error(msg.error.message || 'Codex request failed.'));
      if (msg.id === 0) {
        send({ method: 'initialized', params: {} });
        send({ method: 'thread/start', id: 1, params: { model, cwd: '/tmp', approvalPolicy: 'never', sandbox: 'read-only', serviceName: 'codex-plan-chat' } });
      } else if (msg.id === 1 && msg.result?.thread?.id) {
        threadId = msg.result.thread.id;
        send({ method: 'turn/start', id: 2, params: { threadId, input: [{ type: 'text', text: prompt }], model, cwd: '/tmp', approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' } } });
      } else if (msg.method === 'item/agentMessage/delta') {
        responseText += msg.params?.delta || '';
      } else if (msg.method === 'turn/completed') {
        if (msg.params?.turn?.status !== 'completed') return fail(new Error('Codex did not complete this response.'));
        finish(null, responseText.trim());
      }
    });
    send({ method: 'initialize', id: 0, params: { clientInfo: { name: 'codex_plan_chat', title: 'Codex Plan Chat', version: '0.1.0' } } });
  });
}

const server = createServer(async (req, res) => {
  if (!authorized(req)) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="Codex Plan Chat"', 'cache-control': 'no-store' });
    return res.end('Authentication required');
  }
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true });
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      const body = JSON.parse(await readBody(req));
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      if (!prompt || prompt.length > 4000) return sendJson(res, 400, { error: '请输入 1–4000 个字符。' });
      const answer = await codexReply(prompt);
      if (!answer) return sendJson(res, 502, { error: 'Codex 返回了空回复。' });
      return sendJson(res, 200, { answer });
    }
    if (req.method === 'GET') {
      let requestedPath;
      try { requestedPath = decodeURIComponent(url.pathname); } catch { return sendJson(res, 400, { error: 'Invalid path.' }); }
      const file = requestedPath === '/' ? 'index.html' : requestedPath.slice(1);
      const path = resolve(root, file);
      const withinRoot = relative(root, path);
      if (isAbsolute(withinRoot) || withinRoot === '..' || withinRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) return sendJson(res, 404, { error: 'Not found' });
      const content = await readFile(path);
      const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
      res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' });
      return res.end(content);
    }
    return sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    const status = error.status || 500;
    sendJson(res, status, { error: status === 500 ? '服务暂时不可用，请稍后重试。' : error.message });
  }
});

server.listen(port, '127.0.0.1', () => console.log(`Codex Plan Chat listening on 127.0.0.1:${port}`));

