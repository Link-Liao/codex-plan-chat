import { createServer } from 'node:http';
import { randomBytes, createHash, randomUUID, createPublicKey, verify } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const callbackPort = Number(process.env.OAUTH_PORT || 1455);
const redirectUri = `http://127.0.0.1:${callbackPort}/auth/callback`;
const dataDir = resolve(process.env.DATA_DIR || 'data');
const credentialPath = resolve(dataDir, 'credentials.json');
const hostIdPath = resolve(dataDir, 'ext-agent-host-id');
const authBase = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const requestedScopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

const base64url = value => Buffer.from(value).toString('base64url');
const randomToken = () => base64url(randomBytes(32));
const hostId = await readFile(hostIdPath, 'utf8').catch(async error => {
  if (error.code !== 'ENOENT') throw error;
  const value = `urn:uuid:${randomUUID()}`;
  await mkdir(dirname(hostIdPath), { recursive: true });
  await writeFile(hostIdPath, `${value}\n`, { mode: 0o600, flag: 'wx' });
  return `${value}\n`;
});
const extAgentHostId = hostId.trim();
const state = randomToken();
const nonce = randomToken();
const verifier = randomToken();
const challenge = createHash('sha256').update(verifier).digest('base64url');

let resolveCallback;
let rejectCallback;
const callback = new Promise((resolvePromise, rejectPromise) => {
  resolveCallback = resolvePromise;
  rejectCallback = rejectPromise;
});
const server = createServer((req, res) => {
  const url = new URL(req.url, redirectUri);
  if (url.pathname !== '/auth/callback') {
    res.writeHead(404).end('Not found');
    return;
  }
  if (url.searchParams.get('state') !== state) {
    res.writeHead(400).end('OAuth state mismatch. You may close this window.');
    rejectCallback(new Error('OAuth state validation failed.'));
    return;
  }
  if (url.searchParams.has('error')) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Authorization was not completed. You may close this window.');
    rejectCallback(new Error(`Authorization was not completed (${url.searchParams.get('error')}).`));
    return;
  }
  const code = url.searchParams.get('code');
  const clientId = url.searchParams.get('client_id');
  if (!code || !clientId || clientId === 'dynamic_agent_client') {
    res.writeHead(400).end('Registration did not return an issued client ID. You may close this window.');
    rejectCallback(new Error('OAuth registration did not return an issued client ID.'));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end('<!doctype html><title>授权完成</title><p>ChatGPT 授权已完成。可以关闭此页面并返回 Codex。</p>');
  resolveCallback({ code, clientId });
});

await new Promise((resolveListen, rejectListen) => {
  server.once('error', rejectListen);
  server.listen(callbackPort, '127.0.0.1', resolveListen);
});

const params = new URLSearchParams({
  client_id: 'dynamic_agent_client',
  agent_name_hint: 'Codex Plan Chat',
  ext_agent_host_id: extAgentHostId,
  response_type: 'code',
  redirect_uri: redirectUri,
  scope: requestedScopes,
  resource,
  state,
  nonce,
  code_challenge_method: 'S256',
  code_challenge: challenge,
});
const authorizeUrl = `${authBase}/api/accounts/authorize?${params}`;
console.log('即将打开 OpenAI 登录页面。完成授权后此窗口会自动继续；此脚本不会显示访问令牌。');
console.log(`VM host ID: ${extAgentHostId}`);
const opener = process.platform === 'win32' ? ['cmd.exe', ['/c', 'start', '', authorizeUrl]] : process.platform === 'darwin' ? ['open', [authorizeUrl]] : ['xdg-open', [authorizeUrl]];
const browser = spawn(opener[0], opener[1], { detached: true, stdio: 'ignore', windowsHide: true });
browser.unref();

try {
  let timeout;
  let authorization;
  try {
    authorization = await Promise.race([
      callback,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Authorization timed out after 10 minutes.')), 10 * 60 * 1000); }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  const { code, clientId } = authorization;
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    resource,
  });
  const tokenResponse = await fetch(`${authBase}/api/accounts/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const tokens = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok) throw new Error(tokens.error_description || tokens.error || `Token exchange failed (${tokenResponse.status}).`);
  if (!tokens.access_token || !tokens.refresh_token || !tokens.id_token) throw new Error('The token response is missing required credentials.');
  const grantedScopes = String(tokens.scope || '').split(/\s+/).filter(Boolean);
  if (!grantedScopes.includes('chatgpt.tokens.use.direct')) throw new Error('The account did not grant ChatGPT plan usage permission.');

  const [encodedHeader, encodedClaims, encodedSignature] = tokens.id_token.split('.');
  if (!encodedHeader || !encodedClaims || !encodedSignature) throw new Error('The ID token is malformed.');
  const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
  const claims = JSON.parse(Buffer.from(encodedClaims, 'base64url').toString('utf8'));
  if (!header.kid || !['RS256', 'ES256'].includes(header.alg)) throw new Error('The ID token signing algorithm is not supported.');
  const keysResponse = await fetch(`${authBase}/.well-known/jwks.json`);
  if (!keysResponse.ok) throw new Error(`Could not fetch OpenAI signing keys (${keysResponse.status}).`);
  const keys = await keysResponse.json();
  const jwk = keys.keys?.find(key => key.kid === header.kid && (!key.alg || key.alg === header.alg));
  if (!jwk) throw new Error('The ID token signing key was not found.');
  const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
  const signatureValid = verify(header.alg === 'RS256' ? 'RSA-SHA256' : 'sha256', Buffer.from(`${encodedHeader}.${encodedClaims}`), header.alg === 'ES256' ? { key: publicKey, dsaEncoding: 'ieee-p1363' } : publicKey, Buffer.from(encodedSignature, 'base64url'));
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!signatureValid || claims.iss !== authBase || !audience.includes(clientId) || Number(claims.exp) <= Date.now() / 1000 || claims.nonce !== nonce) throw new Error('The ID token could not be validated.');

  const credentials = {
    email: claims.email || '',
    issuer: claims.iss,
    subject: claims.sub,
    client_id: clientId,
    ext_agent_host_id: extAgentHostId,
    id_token: tokens.id_token,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_type: tokens.token_type || 'Bearer',
    expires_in: tokens.expires_in,
    expires_at: Date.now() + Number(tokens.expires_in || 3600) * 1000,
    scopes: grantedScopes,
    saved_at: new Date().toISOString(),
  };
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const temporaryPath = `${credentialPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, credentialPath);
  console.log(`授权凭据已保存到 ${credentialPath}，文件不会被打印到终端。请通过 SSH/SCP 安全转移到 VM。`);
} finally {
  server.close();
}

