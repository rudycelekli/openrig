import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { Hono } from 'hono';
const [, , , sourceRoot] = process.argv;
const daemon = sourceRoot ? pathToFileURL(`${sourceRoot}/packages/daemon/src/`) : new URL('../../dist/', import.meta.url);
const { apiOriginProtection } = await import(new URL(`middleware/origin-guard.${sourceRoot ? 'ts' : 'js'}`, daemon));
const { terminalAuthMiddleware } = await import(new URL(`routes/terminal-ws.${sourceRoot ? 'ts' : 'js'}`, daemon));
delete process.env.OPENRIG_ALLOWED_ORIGINS;
const cases = [
  ['same-ipv6', 'http://[fd7a::1]:7433', '[fd7a::1]:7433', 200],
  ['same-ipv6-no-port', 'https://[fd7a::1]', '[fd7a::1]', 200],
  ['different-ipv6', 'http://[fd7a::2]:7433', '[fd7a::1]:7433', 403],
  ['same-dns', 'https://rig.example.com', 'rig.example.com:7433', 200],
  ['same-ipv4', 'http://192.0.2.1:7433', '192.0.2.1:7433', 200],
  ['loopback', 'http://[::1]:7433', '[::1]:7433', 200],
];
for (const [name, origin, host, status] of cases) {
  const rest = new Hono();
  rest.use('/api/*', apiOriginProtection());
  rest.get('/api/test', c => c.json({ ok: true }));
  const restResponse = await rest.request('/api/test', { headers: { Origin: origin, Host: host } });
  assert.equal(restResponse.status, status, `${name}: REST`);
  const terminal = new Hono();
  terminal.use('/api/terminal/*', terminalAuthMiddleware({ bearerToken: 'test-token' }));
  terminal.get('/api/terminal/seat', c => c.json({ ok: true }));
  const terminalResponse = await terminal.request('/api/terminal/seat', { headers: { Origin: origin, Host: host,
    Upgrade: 'websocket', Authorization: 'Bearer test-token' } });
  assert.equal(terminalResponse.status, status, `${name}: terminal`);
}
const terminal = new Hono();
terminal.use('/api/terminal/*', terminalAuthMiddleware({ bearerToken: 'test-token' }));
terminal.get('/api/terminal/seat', c => c.json({ ok: true }));
assert.equal((await terminal.request('/api/terminal/seat', { headers: { Origin: 'http://[fd7a::1]:7433',
  Host: '[fd7a::1]:7433', Upgrade: 'websocket' } })).status, 401, 'same IPv6 still needs bearer');
const unauthenticated = new Hono();
unauthenticated.use('/api/terminal/*', terminalAuthMiddleware({ bearerToken: null }));
unauthenticated.get('/api/terminal/seat', c => c.json({ ok: true }));
assert.equal((await unauthenticated.request('/api/terminal/seat', { headers: { Origin: 'http://[fd7a::1]:7433',
  Host: '[fd7a::1]:7433', Upgrade: 'websocket' } })).status, 403, 'unauthenticated remote remains refused');
console.log(JSON.stringify({ scenarios: cases.map(([name]) => name), bearerRequired: true, unauthenticatedRemoteRefused: true }));
