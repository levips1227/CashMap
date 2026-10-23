import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import net from 'node:net';

// Exercise production Express/auth against disposable data, never the local database.
const directory = await mkdtemp(path.join(tmpdir(), 'cashmap-smoke-'));
const password = randomBytes(24).toString('hex');
const probe = net.createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, PORT: String(port), NODE_ENV: 'production', DB_PATH: path.join(directory, 'db.json'),
    JWT_SECRET: randomBytes(32).toString('hex'), ADMIN_USERNAME: 'SmokeAdmin', ADMIN_PASSWORD: password,
    RESET_ADMIN_ON_START: 'false', COOKIE_SECURE: 'false' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
server.stdout.on('data', chunk => { output += chunk; });
server.stderr.on('data', chunk => { output += chunk; });
try {
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(output);
    try {
      const response = await fetch(`${base}/api/health`);
      assert.deepEqual(await response.json(), { ok: true });
      ready = true;
      break;
    } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(ready, `Server did not start: ${output}`);
  assert.equal((await fetch(base)).status, 200);
  const invalid = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'SmokeAdmin', password: 'wrong' }) });
  assert.equal(invalid.status, 401);
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'SmokeAdmin', password }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  assert.ok(cookie);
  assert.equal((await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie.split(';')[0] } })).status, 200);
  console.log('Server smoke checks passed: production startup, frontend, health, rejected login, login and session.');
} finally {
  if (server.exitCode === null) {
    const closed = once(server, 'exit');
    server.kill();
    await closed;
  }
  await rm(directory, { recursive: true, force: true });
}
