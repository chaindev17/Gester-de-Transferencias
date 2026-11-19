/* Pruebas de regresión de la app con jsdom.
 * Ejecutar: npm install && npm test
 * Nota: el generador de mensajes se conserva intacto; estas pruebas solo
 * verifican que NO se haya roto y el resto de la app funcione. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { TextEncoder, TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const VENDOR = [
  'fflate.min.js', 'xlsx.full.min.js', 'jspdf.umd.min.js',
  'jspdf.plugin.autotable.min.js', 'chart.umd.min.js'
];

const errores = [];
const blobs = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => { if (!/Not implemented/.test(e.message)) errores.push('jsdomError: ' + e.message); });
vc.on('error', (...a) => errores.push('console.error: ' + a.join(' ')));

const dom = new JSDOM(html, {
  url: 'https://gestor.example.test/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(win) {
    win.TextEncoder = TextEncoder;
    win.TextDecoder = TextDecoder;
    Object.defineProperty(win, 'crypto', {
      value: { getRandomValues: a => webcrypto.getRandomValues(a), subtle: webcrypto.subtle },
      configurable: true
    });
    win.confirm = () => true;
    win.alert = () => {};
    win.open = () => null;
    win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    win.HTMLCanvasElement.prototype.getContext = () => ({ canvas: {} });
    win.URL.createObjectURL = b => { blobs.push(b); return 'blob:fake'; };
    win.URL.revokeObjectURL = () => {};
    win.HTMLAnchorElement.prototype.click = function () {};
    win.document.execCommand = () => true;
    const OriginalBlob = win.Blob;
    win.Blob = class extends OriginalBlob {
      constructor(parts, opts) {
        super(parts, opts);
        blobs.push(parts.map(p => typeof p === 'string' ? p : '').join(''));
      }
    };
  }
});

const w = dom.window;
const d = w.document;
for (const f of VENDOR) w.eval(fs.readFileSync(path.join(root, 'vendor', f), 'utf8'));
// Chart real necesita un canvas completo; para las pruebas basta un stub.
w.Chart = class { constructor() {} destroy() {} };

const $ = id => d.getElementById(id);
const ev = expr => w.eval(expr);
const jev = expr => JSON.parse(w.eval('JSON.stringify(' + expr + ')'));
const set = (id, v) => { $(id).value = v; };
const click = id => $(id).dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const inputEv = id => $(id).dispatchEvent(new w.Event('input', { bubbles: true }));
const espera = ms => new Promise(r => setTimeout(r, ms));
const fechaHoy = () => {
  const d2 = new Date();
  return new Date(d2.getTime() - d2.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

let pasadas = 0;
function check(nombre, fn) {
  try { fn(); pasadas++; console.log('  ✓ ' + nombre); }
  catch (e) { console.error('  ✗ ' + nombre + '\n    ' + e.message); throw e; }
}
async function checkAsync(nombre, fn) {
  try { await fn(); pasadas++; console.log('  ✓ ' + nombre); }
  catch (e) { console.error('  ✗ ' + nombre + '\n    ' + e.message); throw e; }
}

async function login(usuario = 'juan', password = 'secreto123') {
  click('btnLogout');
  set('loginUsuario', usuario); set('loginPassword', password);
  click('btnLogin');
  await espera(300);
}

async function main() {
  console.log('\n== 1. Arranque ==');
  check('carga sin errores JS', () => assert.deepEqual(errores, []));
  check('pantalla de login visible', () => assert.equal($('authScreen').style.display, 'flex'));
  check('librerías locales cargadas', () => {
    assert.equal(typeof w.XLSX, 'object');
    assert.equal(typeof w.fflate.unzipSync, 'function');
    assert.equal(typeof w.jspdf.jsPDF, 'function');
    assert.equal(typeof new w.jspdf.jsPDF().autoTable, 'function');
  });
  check('el generador de mensajes sigue presente', () => {
    assert.equal(typeof w.copiarMensajeTransferencia, 'function');
    assert.match(html, /Banco Popular de Ahorro/);
  });
  check('código muerto y falsas funciones eliminados', () => {
    assert.equal(ev('typeof reordenarNumerosOperaciones'), 'undefined');
    assert.equal(ev('typeof sincronizarOffline'), 'undefined');
    assert.equal(ev('typeof renderUltimosRecibos'), 'undefined');
    assert.equal(ev('typeof operacionesPendientes'), 'undefined');
  });

  console.log('\n== 2. Perfiles locales ==');
  set('registerUsuario', 'juan'); set('registerEmail', 'j@x.com');
  set('registerPassword', 'secreto123'); set('registerConfirm', 'secreto123');
  click('btnRegister');
  await espera(300);
  check('registro con PBKDF2 + sal (no hash débil)', () => {
    const u = JSON.parse(w.localStorage.getItem('gestor_usuarios')).juan;
    assert.equal(u.password, undefined);
    assert.match(u.salt, /^[0-9a-f]{32}$/);
    assert.match(u.hash, /^[0-9a-f]{64}$/);
  });
  await checkAsync('login correcto', async () => {
    set('loginUsuario', 'juan'); set('loginPassword', 'secreto123');
    click('btnLogin');
    await espera(350);
    assert.equal($('appContent').classList.contains('show'), true);
  });
  await checkAsync('login fallido: error genérico', async () => {
    await login('juan', 'incorrecta99');
    assert.equal($('authScreen').style.display, 'flex');
    assert.match($('loginError').textContent, /Usuario o contraseña incorrectos/);
  });
  await checkAsync('migración de cuenta antigua', async () => {
    const usuarios = JSON.parse(w.localStorage.getItem('gestor_usuarios'));
    usuarios.viejo = { password: 'hash_x_6', email: '', fechaRegistro: '' };
    // hash legado de "abc123" (6 caracteres)
    w.localStorage.setItem('gestor_usuarios', JSON.stringify(usuarios));
    const legado = ev('hashPasswordLegado("abc123")');
    const u2 = JSON.parse(w.localStorage.getItem('gestor_usuarios'));
    u2.viejo.password = legado;
    w.localStorage.setItem('gestor_usuarios', JSON.stringify(u2));
    await login('viejo', 'abc123');
    assert.equal($('appContent').classList.contains('show'), true);
    const migrado = JSON.parse(w.localStorage.getItem('gestor_usuarios')).viejo;
    assert.equal(migrado.password, undefined);
    assert.match(migrado.hash, /^[0-9a-f]{64}$/);
  });
  await login(); // volver a juan
  assert.equal($('appContent').classList.contains('show'), true);

  console.log('\n== 3. Contabilidad ==');
  check('alta de cliente', () => {
    set('clienteNombre', 'Juan Perez'); set('clienteComision', '3');
    click('btnAgregarCliente');
    assert.equal(ev('clientes.length'), 1);
    assert.equal(ev('clientes[0].nombre'), 'Juan Perez');
  });
  check('recibo 33,33 al 3%: sin deriva de coma flotante', () => {
    set('recibirMonto', '33.33'); inputEv('recibirMonto');
    click('btnRegistrarRecibo');
    assert.deepEqual(jev('recibos.map(r=>({monto:r.monto,comision:r.comision,neto:r.neto}))'),
      [{ monto: 33.33, comision: 1, neto: 32.33 }]);
    assert.equal(ev('clientes[0].saldo'), 32.33);
  });
  check('comisión enlazada al recibo', () =>
    assert.equal(ev('finanzas.length === 1 && finanzas[0].reciboId === recibos[0].id'), true));
  check('borrar recibo elimina también su comisión', () => {
    const btn = d.querySelector('.btn-eliminar-recibo-op');
    assert.ok(btn, 'debe existir el botón de borrar');
    btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    assert.equal(ev('recibos.length'), 0);
    assert.equal(ev('finanzas.length'), 0);
    assert.equal(ev('clientes[0].saldo'), 0);
  });
  check('numeración inmutable (no se reasigna al borrar)', () => {
    ['10', '20', '30'].forEach(m => { set('recibirMonto', m); click('btnRegistrarRecibo'); });
    assert.deepEqual(jev('recibos.map(r=>r.numeroOp)'), [2, 3, 4]);
    const id3 = ev('recibos.find(r=>r.numeroOp===3).id');
    const btn = Array.from(d.querySelectorAll('.btn-eliminar-recibo-op')).find(b => b.dataset.id === id3);
    btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    assert.deepEqual(jev('recibos.map(r=>r.numeroOp)'), [2, 4]);
    set('recibirMonto', '40'); click('btnRegistrarRecibo');
    assert.equal(ev('recibos[recibos.length-1].numeroOp'), 5);
  });
  check('el contador sobrevive a un borrado total', () => {
    ev('btnBorrarTodo'); // no se usa; se limpia por código para no depender del DOM
    w.eval('recibos=[]; transferencias=[]; finanzas=[]; persistAll();');
    assert.equal(ev('obtenerSiguienteNumeroOperacion()'), 6);
  });
  check('edición con comisión 0% y comisión enlazada', () => {
    set('recibirMonto', '100'); click('btnRegistrarRecibo');
    const rid = ev('recibos[recibos.length-1].id');
    ev(`abrirModalEdicion(${JSON.stringify(rid)}, 'recibo')`);
    $('modalMonto').value = '100';
    $('modalComisionPorcentaje').value = '0';
    click('modalGuardar');
    const r = ev(`JSON.stringify(recibos.find(x=>x.id===${JSON.stringify(rid)}))`);
    const obj = JSON.parse(r);
    assert.equal(obj.comision, 0);
    assert.equal(obj.neto, 100);
    assert.equal(ev(`finanzas.some(f=>f.reciboId===${JSON.stringify(rid)})`), false);
  });
  check('saldoAntes histórico se conserva al editar transferencia', () => {
    set('numeroDestino', '9212 1299 3867 5427'); inputEv('numeroDestino');
    set('transferirMonto', '25'); click('btnRegistrarTransferencia');
    const tid = ev('transferencias[transferencias.length-1].id');
    const antes = ev(`transferencias.find(t=>t.id===${JSON.stringify(tid)}).saldoAntes`);
    ev(`abrirModalEdicion(${JSON.stringify(tid)}, 'transferencia')`);
    $('modalMonto').value = '30';
    click('modalGuardar');
    assert.equal(ev(`transferencias.find(t=>t.id===${JSON.stringify(tid)}).saldoAntes`), antes);
  });

  console.log('\n== 4. Seguridad ==');
  check('escape de HTML', () =>
    assert.equal(ev('esc(\'<b a="1">&\')'), '&lt;b a=&quot;1&quot;&gt;&amp;'));
  check('XSS almacenado: nombre de cliente NO ejecuta HTML', () => {
    w.eval('clientes.push({id:"evil",nombre:"<img src=x onerror=\\"window.__PWNED=1\\">",comision:0,saldo:0}); recargarTodo();');
    assert.equal(d.querySelector('#listaClientesResumen img'), null);
    assert.equal(w.__PWNED, undefined);
    assert.match($('listaClientesResumen').textContent, /<img/);
    ev('clientes = clientes.filter(c=>c.id!=="evil"); persistAll(); recargarTodo();');
  });
  check('modal de copia manual escapa el texto', () => {
    w.eval("mostrarMensajeManual('<svg onload=\"window.__PWNED2=1\">')");
    assert.equal(d.querySelector('.modal-mensaje-manual svg'), null);
    assert.equal(w.__PWNED2, undefined);
    const m = d.querySelector('.modal-mensaje-manual'); if (m) m.remove();
  });
  check('inyección de fórmulas neutralizada en CSV', () => {
    ev("clientes[0].nombre = '=1+1&cmd|calc'; persistAll(); recargarTodo();");
    blobs.length = 0;
    click('btnExportarCSVHistorial');
    const csv = blobs.filter(b => String(b).includes('N° Op')).pop();
    assert.ok(csv, 'se generó el CSV');
    assert.match(csv, /"'=1\+1&cmd\|calc"/);
    ev("clientes[0].nombre = 'Juan Perez'; persistAll(); recargarTodo();");
  });
  check('cabeceras de importación usan lista blanca', () => {
    const f = ev("JSON.stringify(filasAObjetos([['tipo','cliente','monto','fecha','__proto__'],['recibo','Ana',50,'19/11/2026','x']]))");
    const obj = JSON.parse(f)[0];
    assert.equal(obj.tipo, 'recibo');
    assert.equal(Object.prototype.hasOwnProperty.call(obj, '__proto__'), false);
    assert.equal({}.polluted, undefined);
  });
  check('no se usa XLSX.read sobre archivos del usuario', () => {
    const lineas = html.split('\n').filter(l => /XLSX\.read\s*\(/.test(l));
    assert.equal(lineas.length, 1);
    assert.match(lineas[0].trim(), /^\/\//, 'la única mención debe ser el comentario');
  });

  console.log('\n== 5. Fechas, importación y exportaciones ==');
  check('fecha por defecto en hora local', () => assert.equal(ev('hoyLocal()'), fechaHoy()));
  check('fechas estables (mediodía local, sin desplazamiento UTC)', () => {
    assert.equal(ev("fechaLocalStr(fechaATimestamp('2026-11-19'))"), '2026-11-19');
    assert.equal(ev("new Date(fechaATimestamp('2026-11-19')).getHours()"), 12);
  });
  check('lector XLSX seguro lee un archivo real', () => {
    const wb = w.XLSX.utils.book_new();
    const ws = w.XLSX.utils.json_to_sheet([
      { tipo: 'recibo', cliente: 'Ana', monto: 50, fecha: '19/11/2026' },
      { tipo: 'transferencia', cliente: 'Ana', monto: 10, fecha: '19/11/2026' }
    ]);
    w.XLSX.utils.book_append_sheet(wb, ws, 'Datos');
    const arr = w.XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    w.__buffer = arr.buffer
      ? arr.buffer.slice(arr.byteOffset || 0, (arr.byteOffset || 0) + arr.byteLength)
      : arr;
    const filas = JSON.parse(w.eval('JSON.stringify(leerFilasXlsx(window.__buffer))'));
    assert.equal(filas.length, 2);
    assert.equal(filas[0].tipo, 'recibo');
    assert.equal(filas[0].cliente, 'Ana');
    assert.equal(filas[0].monto, 50);
  });
  check('parser CSV respeta comillas y separadores', () => {
    const f = JSON.parse(w.eval(`JSON.stringify(filasAObjetos(parsearCsv('tipo,cliente,monto,fecha\\nrecibo,"Ana, S.L.",50,19/11/2026\\n')))`));
    assert.equal(f[0].cliente, 'Ana, S.L.');
  });
  check('numeroDestino solo acepta dígitos', () => {
    assert.equal(ev("detectarTipoNumero('5abcdefgh').tipo"), 'desconocido');
    assert.equal(ev("detectarTipoNumero('9212 1299 3867 5427').tipo"), 'tarjeta');
  });
  check('exportaciones XLSX/PDF no lanzan errores', () => {
    assert.doesNotThrow(() => click('btnExportarExcelHistorial'));
    assert.doesNotThrow(() => click('btnExportarPDFHistorial'));
    assert.doesNotThrow(() => click('btnExportarJSON'));
  });

  console.log('\n== 6. Persistencia honesta y UX ==');
  check('existe instantánea local y se puede restaurar', () => {
    const snap = JSON.parse(w.localStorage.getItem('gestor_juan_snapshot'));
    assert.ok(Array.isArray(snap.clientes));
    assert.doesNotThrow(() => click('btnRestaurarSnapshot'));
  });
  check('aviso de copia de seguridad visible si nunca se exportó', () => {
    w.localStorage.removeItem('gestor_ultimo_respaldo');
    ev('verificarRespaldo()');
    assert.match($('avisoRespaldo').textContent, /Exportar JSON/);
  });
  check('labels asociados y aria-labels en botones', () => {
    assert.ok(d.querySelectorAll('label[for]').length >= 20);
    assert.ok(d.querySelectorAll('button[aria-label]').length >= 5);
  });
  await checkAsync('re-login NO duplica listeners', async () => {
    await login();
    const antes = ev('clientes.length');
    set('clienteNombre', 'Maria'); set('clienteComision', '5');
    click('btnAgregarCliente');
    assert.equal(ev('clientes.length'), antes + 1);
    assert.match($('toast').textContent, /agregado/);
  });
  check('indicador de red no promete sincronización', () => {
    assert.match(html, /NO hay nada que sincronizar/);
    assert.equal(/Datos sincronizados correctamente/.test(html), false);
  });
  check('service worker con ruta relativa', () => assert.match(html, /register\('\.\/sw\.js'/));
  check('sin errores JS durante toda la ejecución', () => assert.deepEqual(errores, []));

  console.log(`\n✅ ${pasadas} pruebas superadas\n`);
}

try {
  await main();
  w.close();
  process.exitCode = 0;
} catch (e) {
  console.error('\n❌ Falló la suite:', e.message);
  w.close();
  process.exitCode = 1;
}
