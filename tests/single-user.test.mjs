/* Modo «usuario único»: registro cerrado + una sola cuenta + cliente bloqueado.
 * Ejecutar: npm run test:single
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'gestor-single-test-'));
process.env.DATA_DIR = tmp;
process.env.USUARIO_UNICO = 'Chain';
process.env.TRUST_PROXY = '0';
process.env.FRAME_ANCESTORS = "'none'";
const { iniciar, crearUsuario, existeUsuario } = await import('../server.mjs?test=single');
const server = await iniciar({ port: 0, host: '127.0.0.1' });
const base = 'http://127.0.0.1:' + server.address().port;

const CLAVE = 'claveDePrueba2026';
let cookie = '';
const ventanas = [];

after(async () => {
  ventanas.forEach(w => w.close());
  await new Promise(r => server.close(r));
  await fsp.rm(tmp, { recursive: true, force: true });
});

async function req(ruta, opts = {}) {
  const { method = 'GET', body, headers = {} } = opts;
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (cookie) h.Cookie = cookie;
  const r = await fetch(base + ruta, {
    method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, datos: ct.includes('application/json') ? await r.json() : await r.text(), headers: r.headers };
}

test('1. el health anuncia el registro cerrado y el usuario único', async () => {
  const r = await req('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.datos.registroCerrado, true);
  assert.equal(r.datos.usuarioUnico, 'Chain');
});

test('2. el registro público está cerrado', async () => {
  const r = await req('/api/register', { method: 'POST', body: { usuario: 'intruso', password: 'claveLarga123' } });
  assert.equal(r.status, 403);
  assert.match(r.datos.error, /registro está cerrado/i);
  assert.equal(await existeUsuario('intruso'), false);
});

test('3. solo se puede crear la cuenta autorizada, sin guardar la clave', async () => {
  const r = await crearUsuario('Chain', CLAVE, 'propietario@example.com');
  assert.equal(r.creado, true);
  assert.equal(await existeUsuario('Chain'), true);
  await assert.rejects(() => crearUsuario('OtroUsuario', CLAVE), /solo se permite la cuenta/);
  const disco = await fsp.readFile(path.join(tmp, 'users.json'), 'utf8');
  assert.ok(!disco.includes(CLAVE), 'la contraseña nunca se escribe en disco');
  assert.match(disco, /"salt"/);
  assert.match(disco, /"hash"/);
});

test('4. solo «Chain» con su clave puede iniciar sesión', async () => {
  assert.equal((await req('/api/login', { method: 'POST', body: { usuario: 'intruso', password: CLAVE } })).status, 401);
  assert.equal((await req('/api/login', { method: 'POST', body: { usuario: 'Chain', password: 'claveMala123' } })).status, 401);
  const ok = await req('/api/login', { method: 'POST', body: { usuario: 'Chain', password: CLAVE } });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie') || '', /HttpOnly/);
  assert.equal((await req('/api/session')).datos.usuario, 'Chain');
  assert.equal((await req('/api/data')).status, 200);
});

test('5. el cliente oculta registro y modo local, y no permite registrar', async () => {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>
    <div id="authScreen"><div class="auth-card"><p id="avisoPerfilLocal">aviso</p>
      <form id="loginForm"><input id="loginUsuario"><input id="loginPassword">
        <div class="auth-switch"><a id="switchToRegister">Regístrate</a></div>
      </form>
      <div id="registerForm"><button id="btnRegister">Registrarse</button></div>
    </div></div><header><div class="header-title"></div></header>
  </body></html>`, { url: base + '/', runScripts: 'outside-only' });
  const w = dom.window;
  ventanas.push(w);
  w.fetch = (input, init = {}) => {
    const u = typeof input === 'string' ? base + input.replace(/^\.\//, '/') : input;
    const h = new Headers(init.headers || {});
    if (cookie) h.set('Cookie', cookie);
    return fetch(u, { ...init, headers: h });
  };
  w.mostrarToast = () => {};
  w.GestorDatos = {
    cargar: () => true,
    exportar: () => ({ clientes: [], recibos: [], transferencias: [], finanzas: [], secuencia: 0 }),
    refrescar: () => {}
  };
  w.eval(await fsp.readFile(new URL('../sync.js', import.meta.url), 'utf8'));
  await w.GestorSync.listo;

  assert.equal(w.GestorSync.esExclusivo(), true);
  assert.equal(w.GestorSync.estado().usuarioUnico, 'Chain');
  assert.equal(w.GestorSync.modoServidor(), true);
  assert.equal(w.document.getElementById('loginUsuario').value, 'Chain');
  assert.equal(w.document.getElementById('loginUsuario').readOnly, true);
  assert.equal(w.document.getElementById('switchToRegister').style.display, 'none');
  assert.equal(w.document.getElementById('btnRegister').disabled, true);
  assert.equal(w.document.getElementById('modoServidorChk').disabled, true);
  assert.equal(w.document.getElementById('modoServidorChk').checked, true);
  assert.match(w.document.getElementById('avisoPerfilLocal').textContent, /Acceso restringido/);

  const registro = await w.GestorSync.autenticar('register', 'intruso', 'claveLarga123');
  assert.equal(registro.success, false);
  assert.match(registro.error, /registro está cerrado/i);
  const login = await w.GestorSync.autenticar('login', 'Chain', CLAVE);
  assert.equal(login.success, true, login.error);
});

test('6. si el backend cae, el acceso sigue cerrado (fail closed)', async () => {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>
    <div id="authScreen"><div class="auth-card"><p id="avisoPerfilLocal">aviso</p>
      <form id="loginForm"><input id="loginUsuario"><div class="auth-switch"><a id="switchToRegister">Regístrate</a></div></form>
      <div id="registerForm"><button id="btnRegister">Registrarse</button></div>
    </div></div><header></header>
  </body></html>`, { url: base + '/', runScripts: 'outside-only' });
  const w = dom.window;
  ventanas.push(w);
  w.localStorage.setItem('gestor_exclusivo', '1');
  w.fetch = async () => new Response('caído', { status: 503 });
  w.mostrarToast = () => {};
  w.eval(await fsp.readFile(new URL('../sync.js', import.meta.url), 'utf8'));
  await w.GestorSync.listo;
  assert.equal(w.GestorSync.estado().disponible, false);
  assert.equal(w.GestorSync.esExclusivo(), true, 'sin backend no se abre un perfil local');
  assert.equal(w.document.getElementById('switchToRegister').style.display, 'none');
  const intento = await w.GestorSync.autenticar('login', 'Chain', CLAVE);
  assert.equal(intento.success, false, 'no se puede entrar en modo local');
});
