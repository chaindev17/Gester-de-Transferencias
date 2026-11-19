/* Integración real cliente (sync.js) ↔ backend (server.mjs).
 * sync.js corre dentro de jsdom con un fetch que mantiene la cookie de sesión;
 * el servidor es el mismo que se despliega, sobre un DATA_DIR temporal.
 * Ejecutar: npm run test:sync
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'gestor-sync-test-'));
process.env.DATA_DIR = tmp;
const { iniciar } = await import('../server.mjs?test=sync');
const server = await iniciar({ port: 0, host: '127.0.0.1' });
const base = 'http://127.0.0.1:' + server.address().port;

const ventanas = [];
let estadoSync = null;
after(async () => {
  ventanas.forEach(w => w.close());
  await new Promise(r => server.close(r));
  await fsp.rm(tmp, { recursive: true, force: true });
});

const HTML = `<!DOCTYPE html><html><body>
  <div id="authScreen"><div class="auth-card"><form id="loginForm">
    <input id="loginUsuario"><input id="loginPassword">
  </form></div></div>
  <header></header><div id="appContent"></div>
</body></html>`;

// fetch con jar de cookies, compartido por el "navegador" y las comprobaciones.
let cookie = '';
async function fetchNavegador(input, init = {}) {
  const u = typeof input === 'string'
    ? (input.startsWith('http') ? input : base + input.replace(/^\.\//, '/'))
    : input;
  const headers = new Headers(init.headers || {});
  if (cookie) headers.set('Cookie', cookie);
  const resp = await fetch(u, { ...init, headers });
  const sc = resp.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return resp;
}

function crearVentana({ preferencia = true, fetchImpl = fetchNavegador } = {}) {
  const dom = new JSDOM(HTML, { url: base + '/', runScripts: 'outside-only' });
  const w = dom.window;
  ventanas.push(w);
  w.fetch = fetchImpl;
  w.mostrarToast = () => {};
  if (preferencia) w.localStorage.setItem('gestor_modo_servidor', '1');
  return w;
}

async function cargarSync(w, datosLocales) {
  let locales = { ...datosLocales };
  const contador = { cargas: 0, refrescos: 0 };
  w.GestorDatos = {
    cargar(d) {
      contador.cargas++;
      if (!d || !Array.isArray(d.clientes)) return false;
      locales = { clientes: d.clientes, recibos: d.recibos,
                  transferencias: d.transferencias, finanzas: d.finanzas,
                  secuencia: d.secuencia || 0 };
      return true;
    },
    exportar: () => ({ ...locales }),
    refrescar: () => { contador.refrescos++; }
  };
  const codigo = await fsp.readFile(new URL('../sync.js', import.meta.url), 'utf8');
  w.eval(codigo);
  await w.GestorSync.listo;
  return { contador, locales: () => locales, cambiar: (nombre) => { locales = { ...locales, clientes: [{ id: 'c1', nombre, comision: 0, saldo: 10 }] }; } };
}

const datos = nombre => ({
  clientes: [{ id: 'c1', nombre, comision: 0, saldo: 100 }],
  recibos: [], transferencias: [], finanzas: [], secuencia: 4
});
const espera = ms => new Promise(r => setTimeout(r, ms));
const USUARIO = 'sync_usuario';
const PASSWORD = 'claveDePrueba2026';

test('A. sin backend, sync.js cae a modo local sin romper nada', async () => {
  const w = crearVentana({
    preferencia: false,
    fetchImpl: async () => new Response('<!doctype html><h1>404</h1>', {
      status: 404, headers: { 'content-type': 'text/html' }
    })
  });
  const st = await cargarSync(w, datos('Local'));
  assert.equal(w.GestorSync.estado().disponible, false);
  assert.equal(w.GestorSync.modoServidor(), false);
  assert.equal(w.GestorSync.estado().modo, 'local');
  assert.equal(st.locales().clientes[0].nombre, 'Local', 'no toca los datos locales');
  assert.equal(w.document.getElementById('bloqueModoServidor').style.display, 'none');
});

test('B. registro, login, subida inicial y guardado posterior', async () => {
  const w = crearVentana();
  const st = await cargarSync(w, datos('Datos iniciales'));
  assert.equal(w.GestorSync.estado().disponible, true);
  assert.equal(w.GestorSync.modoServidor(), true);
  assert.notEqual(w.document.getElementById('bloqueModoServidor').style.display, 'none');
  assert.equal(w.document.getElementById('modoServidorChk').checked, true);

  const reg = await w.GestorSync.autenticar('register', USUARIO, PASSWORD, 'sync@example.com');
  assert.equal(reg.success, true, reg.error);

  await w.GestorSync.alEntrar(USUARIO);
  assert.equal(w.GestorSync.estado().pendiente, false);
  assert.match(w.document.getElementById('syncEstado').textContent, /Sincronizado/);

  let r = await fetchNavegador(base + '/api/data');
  let j = await r.json();
  assert.equal(j.datos.version, 1);
  assert.equal(j.datos.clientes[0].nombre, 'Datos iniciales');
  assert.equal(j.datos.secuencia, 4);

  st.cambiar('Cambio local');
  w.GestorSync.programarEnvio();
  await espera(1200);
  r = await fetchNavegador(base + '/api/data');
  j = await r.json();
  assert.equal(j.datos.version, 2);
  assert.equal(j.datos.clientes[0].nombre, 'Cambio local');
  assert.equal(w.GestorSync.estado().pendiente, false);

  estadoSync = { w, st };
});

test('C. conflicto 409: gana el servidor y se refresca la UI', async () => {
  const { w, st } = estadoSync;
  const externo = await fetchNavegador(base + '/api/data', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...datos('Otro dispositivo'), version: 2 })
  });
  assert.equal(externo.status, 200);

  st.cambiar('Cambio que debe perder');
  w.GestorSync.programarEnvio();
  await espera(1200);

  assert.equal(st.locales().clientes[0].nombre, 'Otro dispositivo');
  assert.ok(st.contador.cargas >= 1, 'se cargaron los datos del servidor');
  assert.ok(st.contador.refrescos >= 1, 'se refrescó la interfaz');
  assert.equal(w.GestorSync.estado().pendiente, false);

  const r = await fetchNavegador(base + '/api/data');
  const j = await r.json();
  assert.equal(j.datos.version, 3, 'el 409 no crea una versión extra');
  assert.equal(j.datos.clientes[0].nombre, 'Otro dispositivo');
});

test('D. logout cierra la sesión del servidor', async () => {
  const { w } = estadoSync;
  await w.GestorSync.alSalir();
  assert.equal(w.GestorSync.estado().pendiente, false);
  assert.match(w.document.getElementById('syncEstado').textContent, /local/i);
  const r = await fetchNavegador(base + '/api/session');
  assert.equal(r.status, 401);
});
