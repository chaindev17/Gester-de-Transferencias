/* Pruebas de integración del backend (Node 20+, sin dependencias externas).
 * Se levanta el servidor real en un puerto efímero con un DATA_DIR temporal.
 * Ejecutar: npm run test:server
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'gestor-server-test-'));
process.env.DATA_DIR = tmp;
process.env.TRUST_PROXY = '0';
process.env.FRAME_ANCESTORS = "'none'";
const { iniciar } = await import('../server.mjs');
const server = await iniciar({ port: 0, host: '127.0.0.1' });
const base = 'http://127.0.0.1:' + server.address().port;

after(async () => {
  await new Promise(r => server.close(r));
  await fsp.rm(tmp, { recursive: true, force: true });
});

let cookie = '';
async function req(ruta, opts = {}) {
  const { method = 'GET', body, raw, origin, sinCookie, headers = {} } = opts;
  const h = { ...headers };
  const tieneCT = Object.keys(h).some(k => k.toLowerCase() === 'content-type');
  if ((body !== undefined || raw !== undefined) && !tieneCT) h['Content-Type'] = 'application/json';
  if (origin) h.Origin = origin;
  if (!sinCookie && cookie) h.Cookie = cookie;
  const r = await fetch(base + ruta, {
    method,
    headers: h,
    body: raw !== undefined ? raw : (body !== undefined ? JSON.stringify(body) : undefined)
  });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const ct = r.headers.get('content-type') || '';
  const datos = ct.includes('application/json') ? await r.json() : await r.text();
  return { status: r.status, datos, headers: r.headers };
}

const USUARIO = 'usuario_prueba';
const PASSWORD = 'claveSegura123!';
const conjunto = (version, extra = {}) => ({
  version, secuencia: 7,
  clientes: [{ id: 'c1', nombre: 'Ana', comision: 0, saldo: 1000 }],
  recibos: [], transferencias: [], finanzas: [], ...extra
});

test('1. /api/health responde sin autenticación', async () => {
  const r = await req('/api/health', { sinCookie: true });
  assert.equal(r.status, 200);
  assert.equal(r.datos.ok, true);
  assert.equal(r.datos.modo, 'servidor');
});

test('2. estáticos permitidos y allowlist (nada de data/ ni server.mjs)', async () => {
  const index = await req('/', { sinCookie: true });
  assert.equal(index.status, 200);
  assert.match(index.datos, /Gestor de Pagos/);
  assert.doesNotMatch(index.datos, /sha384-REEMPLAZAR/);

  for (const ruta of ['/sync.js', '/sw.js', '/manifest.webmanifest', '/icon.svg',
                      '/icons/icon-192.png', '/vendor/fflate.min.js',
                      '/legal/privacidad.html', '/legal/terminos.html', '/legal/descargo.html']) {
    const r = await req(ruta, { sinCookie: true });
    assert.equal(r.status, 200, ruta + ' debe servirse');
  }
  for (const ruta of ['/server.mjs', '/data/users.json', '/package.json',
                      '/legal/../server.mjs', '/vendor/otro.js']) {
    const r = await req(ruta, { sinCookie: true });
    assert.equal(r.status, 404, ruta + ' NO debe servirse');
  }
});

test('3. cabeceras de seguridad en estáticos y API', async () => {
  const r = await req('/api/health', { sinCookie: true });
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.match(r.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('4. registro: validación, creación y duplicado', async () => {
  assert.equal((await req('/api/register', { method: 'POST', body: { usuario: 'ab', password: PASSWORD }, sinCookie: true })).status, 400);
  assert.equal((await req('/api/register', { method: 'POST', body: { usuario: 'usuario_malo', password: 'corta' }, sinCookie: true })).status, 400);
  assert.equal((await req('/api/register', { method: 'POST', body: { usuario: 'mal-espacio', password: PASSWORD }, sinCookie: true })).status, 400);

  const r = await req('/api/register', {
    method: 'POST', body: { usuario: USUARIO, password: PASSWORD, email: 'ana@example.com' }, sinCookie: true
  });
  assert.equal(r.status, 201);
  assert.equal(r.datos.usuario, USUARIO);
  assert.equal((await req('/api/register', { method: 'POST', body: { usuario: USUARIO, password: PASSWORD }, sinCookie: true })).status, 409);

  const guardado = JSON.parse(await fsp.readFile(path.join(tmp, 'users.json'), 'utf8'));
  assert.ok(guardado[USUARIO].hash);
  assert.ok(!JSON.stringify(guardado).includes(PASSWORD), 'la contraseña nunca se guarda en claro');
});

test('5. login, cookie HttpOnly y sesión', async () => {
  const malo = await req('/api/login', { method: 'POST', body: { usuario: USUARIO, password: 'incorrecta' }, sinCookie: true });
  assert.equal(malo.status, 401);
  assert.equal(malo.datos.error, 'Usuario o contraseña incorrectos');

  const r = await req('/api/login', { method: 'POST', body: { usuario: USUARIO, password: PASSWORD }, sinCookie: true });
  assert.equal(r.status, 200);
  const cruda = r.headers.get('set-cookie') || '';
  assert.match(cruda, /HttpOnly/);
  assert.match(cruda, /SameSite=Strict/);
  assert.match(cruda, /Path=\//);
  assert.match(cookie, /^gestor_sid=[a-f0-9]{64}$/);

  const s = await req('/api/session');
  assert.equal(s.status, 200);
  assert.equal(s.datos.usuario, USUARIO);
  assert.equal((await req('/api/session', { sinCookie: true })).status, 401);
});

test('6. datos: lectura inicial, guardado y control de versión optimista', async () => {
  const inicial = await req('/api/data');
  assert.equal(inicial.status, 200);
  assert.equal(inicial.datos.datos.version, 0);
  assert.deepEqual(inicial.datos.datos.clientes, []);

  assert.equal((await req('/api/data', { method: 'PUT', body: { version: 1, clientes: [] } })).status, 400);

  const primero = await req('/api/data', { method: 'PUT', body: conjunto(0) });
  assert.equal(primero.status, 200);
  assert.equal(primero.datos.version, 1);

  const leido = await req('/api/data');
  assert.equal(leido.datos.datos.version, 1);
  assert.equal(leido.datos.datos.clientes[0].nombre, 'Ana');
  assert.equal(leido.datos.datos.secuencia, 7);

  const conflicto = await req('/api/data', { method: 'PUT', body: conjunto(0, {
    clientes: [{ id: 'c2', nombre: 'Otro dispositivo', comision: 0, saldo: 5 }]
  }) });
  assert.equal(conflicto.status, 409);
  assert.equal(conflicto.datos.datos.version, 1);
  assert.equal(conflicto.datos.datos.clientes[0].nombre, 'Ana', 'el 409 devuelve el estado ganador');

  const segundo = await req('/api/data', { method: 'PUT', body: conjunto(1, {
    clientes: [{ id: 'c1', nombre: 'Ana', comision: 0, saldo: 2000 }]
  }) });
  assert.equal(segundo.status, 200);
  assert.equal(segundo.datos.version, 2);
});

test('7. copias en el servidor, restauración y exportación', async () => {
  const copias = await req('/api/backups');
  assert.equal(copias.status, 200);
  assert.ok(copias.datos.copias.length >= 1, 'se creó al menos una copia');
  assert.match(copias.datos.copias[0].id, /^\d{10,15}$/);
  assert.equal((await req('/api/restore', { method: 'POST', body: { id: '../users' } })).status, 400);
  assert.equal((await req('/api/restore', { method: 'POST', body: { id: '9999999999999' } })).status, 404);

  const restaurar = await req('/api/restore', { method: 'POST', body: { id: copias.datos.copias.at(-1).id } });
  assert.equal(restaurar.status, 200);
  assert.equal(restaurar.datos.datos.version, 3);
  assert.equal(restaurar.datos.datos.clientes[0].nombre, 'Ana');

  const exp = await req('/api/export');
  assert.equal(exp.status, 200);
  assert.match(exp.headers.get('content-disposition') || '', /attachment; filename=/);
  assert.equal(exp.datos.usuario, USUARIO);
});

test('8. CSRF, Content-Type, JSON inválido y límite de tamaño', async () => {
  const csrf = await req('/api/login', {
    method: 'POST', body: { usuario: USUARIO, password: PASSWORD }, origin: 'http://evil.example'
  });
  assert.equal(csrf.status, 403);

  const cross = await req('/api/login', {
    method: 'POST', body: { usuario: USUARIO, password: PASSWORD },
    origin: 'http://evil.example', headers: { 'Sec-Fetch-Site': 'cross-site' }
  });
  assert.equal(cross.status, 403, 'cross-site nunca habilita una petición ajena');

  // Detrás de un proxy que reescribe Host, Sec-Fetch-Site acredita el origen.
  const mismoSitio = await req('/api/login', {
    method: 'POST', body: { usuario: USUARIO, password: 'incorrecta' },
    origin: 'https://proxy.example', headers: { 'Sec-Fetch-Site': 'same-origin' }
  });
  assert.equal(mismoSitio.status, 401, 'same-origin pasa el filtro CSRF');

  const ct = await req('/api/data', {
    method: 'PUT', raw: JSON.stringify(conjunto(3)), headers: { 'Content-Type': 'text/plain' }
  });
  assert.equal(ct.status, 415);

  const roto = await req('/api/data', { method: 'PUT', raw: '{no es json' });
  assert.equal(roto.status, 400);
  assert.match(roto.datos.error, /JSON inválido/);

  const grande = await req('/api/data', { method: 'PUT', raw: '"' + 'x'.repeat(2 * 1024 * 1024 + 64) + '"' });
  assert.equal(grande.status, 413);
});

test('9. logout invalida la sesión', async () => {
  const r = await req('/api/logout', { method: 'POST', body: {} });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie') || '', /Max-Age=0/);
  assert.equal((await req('/api/data')).status, 401);
  assert.equal((await req('/api/data', { method: 'PUT', body: conjunto(3) })).status, 401);
  assert.equal((await req('/api/ruta-inexistente')).status, 401);
});

test('10. los ficheros de datos quedan fuera del árbol servido y con permisos', async () => {
  const ruta = path.join(tmp, 'users.json');
  const st = await fsp.stat(ruta);
  assert.ok(st.isFile());
  assert.equal((await req('/users.json', { sinCookie: true })).status, 404);
  assert.equal(st.mode & 0o077, 0, 'users.json no debe ser legible por otros usuarios');
});
