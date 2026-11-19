/* =====================================================================
 * Gestor de Pagos — servidor (Node 20+, SIN dependencias externas)
 *
 *  - Sirve la app estática con cabeceras de seguridad.
 *  - API real: registro, login con scrypt, sesiones HttpOnly, datos por
 *    usuario con control de versión, historial de copias y restauración.
 *  - Todo se guarda en DATA_DIR (por defecto ./data, fuera de Git).
 *
 *  Ejecutar:  node server.mjs            (PORT=8080, HOST=0.0.0.0)
 *             DATA_DIR=/ruta/segura node server.mjs
 * ===================================================================== */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const DEFAULT_PORT = Number(process.env.PORT || 8080);
const DEFAULT_HOST = process.env.HOST || '0.0.0.0';

const BODY_LIMIT = 2 * 1024 * 1024;
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BACKUPS = 12;
const USUARIO_RE = /^[a-zA-Z0-9_]{3,32}$/;
const scrypt = promisify(crypto.scrypt);
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

// Modo «usuario único»: si se define, el registro público queda CERRADO y
// solo esa cuenta puede iniciar sesión. La cuenta se crea con
// `tools/crear-usuario.mjs`; la contraseña NUNCA se guarda en el repositorio.
const USUARIO_UNICO_RAW = String(process.env.USUARIO_UNICO || '').trim();
const USUARIO_UNICO = USUARIO_UNICO_RAW && USUARIO_RE.test(USUARIO_UNICO_RAW)
  ? USUARIO_UNICO_RAW : null;
if (USUARIO_UNICO_RAW && !USUARIO_UNICO) {
  console.warn('[gestor] USUARIO_UNICO no es válido (3-32: letras, números, guion bajo). Se ignora.');
}

const USERS_FILE = () => path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = () => path.join(DATA_DIR, 'sessions.json');
const DATA_FILE = u => path.join(DATA_DIR, 'users-data', u + '.json');
const HISTORY_DIR = u => path.join(DATA_DIR, 'history', u);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8'
};

const VENDOR_PERMITIDOS = new Set([
  'fflate.min.js', 'xlsx.full.min.js', 'jspdf.umd.min.js',
  'jspdf.plugin.autotable.min.js', 'chart.umd.min.js'
]);
const LEGALES_PERMITIDOS = new Set(['privacidad.html', 'terminos.html', 'descargo.html']);

// ------------------------------------------------------------------ utilidades
class ErrorHttp extends Error {
  constructor(estado, mensaje) { super(mensaje); this.estado = estado; }
}

function json(res, estado, cuerpo, cabeceras = {}) {
  const texto = JSON.stringify(cuerpo);
  res.writeHead(estado, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(texto),
    'Cache-Control': 'no-store',
    ...cabeceras
  });
  res.end(texto);
}

async function leerJson(ruta, defecto) {
  try { return JSON.parse(await fsp.readFile(ruta, 'utf8')); }
  catch (e) { return defecto; }
}

async function escribirAtomico(ruta, valor) {
  await fsp.mkdir(path.dirname(ruta), { recursive: true });
  const tmp = ruta + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(valor, null, 2), { mode: 0o600 });
  await fsp.rename(tmp, ruta);
}

// Solo se honran cabeceras de proxy cuando el despliegue lo declara
// explícitamente; si no, un cliente podría falsificarlas para evadir el
// rate limit o forzar el flag Secure en una conexión HTTP.
const CONFIAR_EN_PROXY = process.env.TRUST_PROXY === '1';

function esHttps(req) {
  if (req.socket.encrypted === true) return true;
  return CONFIAR_EN_PROXY &&
    (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function ipDe(req) {
  if (CONFIAR_EN_PROXY) {
    const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || 'desconocida';
}

function mismoOrigen(req) {
  // Sec-Fetch-Site la fija el navegador y NO puede falsificarse desde JS.
  // Es la comprobación fiable detrás de proxies que reescriben Host (PaaS,
  // vistas previas): para el navegador la petición sigue siendo same-origin.
  const sitio = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (sitio === 'same-origin' || sitio === 'none') return true;

  const origen = req.headers.origin;
  if (!origen) return true; // peticiones sin Origin (curl, mismo sitio)
  let u;
  try { u = new URL(origen); } catch { return false; }
  const host = ((CONFIAR_EN_PROXY && req.headers['x-forwarded-host']) ||
                req.headers.host || '').split(',')[0].trim().toLowerCase();
  if (u.host.toLowerCase() === host) return true;

  // Detrás de un proxy que reescribe Host a localhost, X-Forwarded-Host sigue
  // siendo el host público. Solo se acepta si el Host efectivo es local.
  const fwdHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim().toLowerCase();
  const hostLocal = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/.test(host);
  if (hostLocal && fwdHost && u.host.toLowerCase() === fwdHost) return true;

  // Origen declarado explícitamente para despliegues con proxy propio.
  if (process.env.PUBLIC_ORIGIN) {
    try { if (u.origin === new URL(process.env.PUBLIC_ORIGIN).origin) return true; } catch { /* inválido */ }
  }
  return false;
}

function leerCookie(req, nombre) {
  const crudo = req.headers.cookie || '';
  for (const parte of crudo.split(';')) {
    const i = parte.indexOf('=');
    if (i < 0) continue;
    if (parte.slice(0, i).trim() === nombre) return decodeURIComponent(parte.slice(i + 1).trim());
  }
  return null;
}

function cabeceraSesion(token, req, borrar = false) {
  let c = 'gestor_sid=' + (borrar ? '' : token) + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' +
          (borrar ? '0' : Math.floor(SESSION_MS / 1000));
  if (esHttps(req)) c += '; Secure';
  return c;
}

async function leerCuerpo(req) {
  return new Promise((resolve, reject) => {
    let size = 0, excedido = false;
    const trozos = [];
    req.on('data', t => {
      if (excedido) return; // drena el resto sin acumularlo
      size += t.length;
      if (size > BODY_LIMIT) { excedido = true; return reject(new ErrorHttp(413, 'Cuerpo demasiado grande')); }
      trozos.push(t);
    });
    req.on('end', () => {
      const texto = Buffer.concat(trozos).toString('utf8');
      if (!texto) return resolve({});
      try { resolve(JSON.parse(texto)); } catch { reject(new ErrorHttp(400, 'JSON inválido')); }
    });
    req.on('error', reject);
  });
}

async function derivar(password, saltHex) {
  const sal = Buffer.from(saltHex, 'hex');
  const hash = await scrypt(password, sal, 64, SCRYPT_OPTS);
  return hash.toString('hex');
}

function seguro(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Crea (o reprotege) una cuenta local. Pensada para el bootstrap del modo
 * usuario único: la contraseña se deriva aquí y jamás se escribe en disco.
 * Devuelve { creado: boolean }.
 */
export async function existeUsuario(usuario) {
  const usuarios = await leerJson(USERS_FILE(), {});
  return !!usuarios[String(usuario || '').trim()];
}

export async function crearUsuario(usuario, password, email = '') {
  const nombre = String(usuario || '').trim();
  if (!USUARIO_RE.test(nombre)) throw new Error('Usuario: 3-32 caracteres, solo letras, números y guion bajo.');
  const clave = String(password || '');
  if (clave.length < 8 || clave.length > 200) throw new Error('La contraseña debe tener entre 8 y 200 caracteres.');
  if (USUARIO_UNICO && nombre !== USUARIO_UNICO)
    throw new Error('En modo usuario único solo se permite la cuenta «' + USUARIO_UNICO + '».');

  const usuarios = await leerJson(USERS_FILE(), {});
  const creado = !usuarios[nombre];
  const salt = crypto.randomBytes(16).toString('hex');
  usuarios[nombre] = {
    salt,
    hash: await derivar(clave, salt),
    email: String(email || '').slice(0, 200),
    fechaRegistro: (usuarios[nombre] && usuarios[nombre].fechaRegistro) || new Date().toISOString()
  };
  await escribirAtomico(USERS_FILE(), usuarios);
  if (creado) await escribirAtomico(DATA_FILE(nombre), conjuntoVacio());
  return { creado };
}

function validarConjunto(datos) {
  const claves = ['clientes', 'recibos', 'transferencias', 'finanzas'];
  if (!datos || typeof datos !== 'object' || Array.isArray(datos)) return 'Estructura inválida.';
  for (const k of claves) {
    if (!Array.isArray(datos[k])) return 'Falta la lista «' + k + '».';
    if (datos[k].length > 50000) return 'Demasiados registros en «' + k + '».';
  }
  if (!Number.isInteger(datos.version) || datos.version < 0) return 'Versión inválida.';
  return null;
}

function conjuntoVacio() {
  return { version: 0, updatedAt: null, secuencia: 0,
           clientes: [], recibos: [], transferencias: [], finanzas: [] };
}

// Rate limit sencillo en memoria (se reinicia con el proceso).
const intentos = new Map();
function bloqueado(clave, limite, ventanaMs) {
  const ahora = Date.now();
  const reg = intentos.get(clave);
  if (!reg || reg.reset < ahora) { intentos.set(clave, { n: 1, reset: ahora + ventanaMs }); return false; }
  reg.n++;
  return reg.n > limite;
}
function limpiarIntentos(clave) { intentos.delete(clave); }

// ------------------------------------------------------------------ sesiones
async function sesionValida(req) {
  const token = leerCookie(req, 'gestor_sid');
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const sesiones = await leerJson(SESSIONS_FILE(), {});
  const s = sesiones[token];
  if (!s || !s.usuario || s.exp < Date.now()) return null;
  return { token, usuario: s.usuario };
}

// ------------------------------------------------------------------ API
async function api(req, res, url) {
  const ruta = url.pathname.replace(/\/+$/, '') || '/';
  const metodo = req.method;

  if (ruta === '/api/health') {
    return json(res, 200, {
      ok: true, modo: 'servidor', hora: new Date().toISOString(),
      registroCerrado: !!USUARIO_UNICO,
      usuarioUnico: USUARIO_UNICO
    });
  }

  if (metodo !== 'GET' && !mismoOrigen(req)) {
    return json(res, 403, { ok: false, error: 'Origen no permitido.' });
  }
  if ((metodo === 'POST' || metodo === 'PUT') &&
      !(req.headers['content-type'] || '').toLowerCase().includes('application/json')) {
    return json(res, 415, { ok: false, error: 'Se requiere Content-Type: application/json.' });
  }

  // ---- registro
  if (ruta === '/api/register' && metodo === 'POST') {
    if (USUARIO_UNICO) {
      return json(res, 403, { ok: false, error: 'El registro está cerrado: solo el propietario tiene acceso.' });
    }
    const b = await leerCuerpo(req);
    const usuario = String(b.usuario || '').trim();
    const password = String(b.password || '');
    const email = String(b.email || '').trim().slice(0, 200);
    if (!USUARIO_RE.test(usuario)) return json(res, 400, { ok: false, error: 'Usuario: 3-32 caracteres, solo letras, números y guion bajo.' });
    if (password.length < 8 || password.length > 200) return json(res, 400, { ok: false, error: 'La contraseña debe tener al menos 8 caracteres.' });
    if (bloqueado('reg:' + ipDe(req), 8, 3600000)) return json(res, 429, { ok: false, error: 'Demasiados intentos. Prueba más tarde.' });
    const usuarios = await leerJson(USERS_FILE(), {});
    if (usuarios[usuario]) return json(res, 409, { ok: false, error: 'Ese usuario ya existe.' });
    const salt = crypto.randomBytes(16).toString('hex');
    usuarios[usuario] = { salt, hash: await derivar(password, salt), email,
                          fechaRegistro: new Date().toISOString() };
    await escribirAtomico(USERS_FILE(), usuarios);
    await escribirAtomico(DATA_FILE(usuario), conjuntoVacio());
    return json(res, 201, { ok: true, usuario });
  }

  // ---- login
  if (ruta === '/api/login' && metodo === 'POST') {
    const b = await leerCuerpo(req);
    const usuario = String(b.usuario || '').trim();
    const password = String(b.password || '');
    const clave = 'login:' + ipDe(req) + ':' + usuario;
    if (bloqueado(clave, 8, 15 * 60000)) return json(res, 429, { ok: false, error: 'Demasiados intentos. Prueba en 15 minutos.' });
    // En modo usuario único, cualquier otro nombre se rechaza con el mismo
    // error genérico (y el mismo trabajo de derivación) que una clave mala.
    if (USUARIO_UNICO && usuario !== USUARIO_UNICO) {
      await derivar(password, '00'.repeat(16)).catch(() => {});
      return json(res, 401, { ok: false, error: 'Usuario o contraseña incorrectos' });
    }
    const usuarios = await leerJson(USERS_FILE(), {});
    const registro = usuarios[usuario];
    const fallo = { ok: false, error: 'Usuario o contraseña incorrectos' };
    if (!registro) {
      await derivar(password, '00'.repeat(16)).catch(() => {});
      return json(res, 401, fallo);
    }
    const calculado = await derivar(password, registro.salt);
    if (!seguro(calculado, registro.hash)) return json(res, 401, fallo);
    limpiarIntentos(clave);
    const token = crypto.randomBytes(32).toString('hex');
    const sesiones = await leerJson(SESSIONS_FILE(), {});
    for (const [t, s] of Object.entries(sesiones)) if (s.exp < Date.now()) delete sesiones[t];
    sesiones[token] = { usuario, exp: Date.now() + SESSION_MS };
    await escribirAtomico(SESSIONS_FILE(), sesiones);
    return json(res, 200, { ok: true, usuario, email: registro.email || '' },
      { 'Set-Cookie': cabeceraSesion(token, req) });
  }

  // ---- sesión actual
  if (ruta === '/api/session' && metodo === 'GET') {
    const s = await sesionValida(req);
    if (!s) return json(res, 401, { ok: false });
    return json(res, 200, { ok: true, usuario: s.usuario });
  }

  // ---- logout
  if (ruta === '/api/logout' && metodo === 'POST') {
    const s = await sesionValida(req);
    if (s) {
      const sesiones = await leerJson(SESSIONS_FILE(), {});
      delete sesiones[s.token];
      await escribirAtomico(SESSIONS_FILE(), sesiones);
    }
    return json(res, 200, { ok: true }, { 'Set-Cookie': cabeceraSesion('', req, true) });
  }

  const sesion = await sesionValida(req);
  if (!sesion) return json(res, 401, { ok: false, error: 'No hay sesión. Inicia sesión de nuevo.' });
  const usuario = sesion.usuario;
  const archivoDatos = DATA_FILE(usuario);

  // ---- leer datos
  if (ruta === '/api/data' && metodo === 'GET') {
    const datos = await leerJson(archivoDatos, conjuntoVacio());
    return json(res, 200, { ok: true, datos });
  }

  // ---- guardar datos (con control de versión optimista)
  if (ruta === '/api/data' && metodo === 'PUT') {
    const b = await leerCuerpo(req);
    const error = validarConjunto(b);
    if (error) return json(res, 400, { ok: false, error });
    const actual = await leerJson(archivoDatos, conjuntoVacio());
    if (b.version !== actual.version) {
      return json(res, 409, { ok: false, error: 'Conflicto: otro dispositivo guardó cambios.', datos: actual });
    }
    const nuevo = {
      version: actual.version + 1,
      updatedAt: new Date().toISOString(),
      secuencia: Number.isInteger(b.secuencia) ? b.secuencia : actual.secuencia,
      clientes: b.clientes, recibos: b.recibos,
      transferencias: b.transferencias, finanzas: b.finanzas
    };
    // Copia de seguridad en el servidor antes de sobrescribir.
    if (actual.version > 0) {
      const dir = HISTORY_DIR(usuario);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, String(Date.now()) + '.json'),
        JSON.stringify(actual), { mode: 0o600 });
      const ficheros = (await fsp.readdir(dir)).filter(f => f.endsWith('.json')).sort();
      for (const f of ficheros.slice(0, Math.max(0, ficheros.length - MAX_BACKUPS)))
        await fsp.unlink(path.join(dir, f)).catch(() => {});
    }
    await escribirAtomico(archivoDatos, nuevo);
    return json(res, 200, { ok: true, version: nuevo.version, updatedAt: nuevo.updatedAt });
  }

  // ---- listar copias del servidor
  if (ruta === '/api/backups' && metodo === 'GET') {
    const dir = HISTORY_DIR(usuario);
    let ficheros = [];
    try { ficheros = (await fsp.readdir(dir)).filter(f => /^\d+\.json$/.test(f)).sort().reverse(); }
    catch { /* sin copias */ }
    const lista = [];
    for (const f of ficheros.slice(0, MAX_BACKUPS)) {
      const st = await fsp.stat(path.join(dir, f)).catch(() => null);
      if (st) lista.push({ id: f.replace('.json', ''), fecha: new Date(Number(f.replace('.json', ''))).toISOString(), bytes: st.size });
    }
    return json(res, 200, { ok: true, copias: lista });
  }

  // ---- restaurar una copia del servidor
  if (ruta === '/api/restore' && metodo === 'POST') {
    const b = await leerCuerpo(req);
    const id = String(b.id || '');
    if (!/^\d{10,15}$/.test(id)) return json(res, 400, { ok: false, error: 'Copia no válida.' });
    const copia = await leerJson(path.join(HISTORY_DIR(usuario), id + '.json'), null);
    if (!copia) return json(res, 404, { ok: false, error: 'Copia no encontrada.' });
    const actual = await leerJson(archivoDatos, conjuntoVacio());
    const restaurado = { ...copia, version: actual.version + 1,
                         updatedAt: new Date().toISOString() };
    await escribirAtomico(archivoDatos, restaurado);
    return json(res, 200, { ok: true, datos: restaurado });
  }

  // ---- exportación directa
  if (ruta === '/api/export' && metodo === 'GET') {
    const datos = await leerJson(archivoDatos, conjuntoVacio());
    const texto = JSON.stringify({ ...datos, usuario, exportado: new Date().toISOString() }, null, 2);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="gestor_' + usuario + '_' +
        new Date().toISOString().slice(0, 10) + '.json"',
      'Cache-Control': 'no-store'
    });
    return res.end(texto);
  }

  return json(res, 404, { ok: false, error: 'Ruta no encontrada.' });
}

// ------------------------------------------------------------------ estáticos
function rutaEstatica(pathname) {
  if (pathname === '/' || pathname === '/index.html') return { archivo: 'index.html', cache: 'no-cache' };
  const permitidos = {
    '/sync.js': 'sync.js', '/sw.js': 'sw.js',
    '/manifest.webmanifest': 'manifest.webmanifest',
    '/icon.svg': 'icon.svg', '/favicon.ico': 'icon.svg'
  };
  if (permitidos[pathname]) return { archivo: permitidos[pathname], cache: 'no-cache' };
  let m = /^\/vendor\/([A-Za-z0-9_.-]+)$/.exec(pathname);
  if (m && VENDOR_PERMITIDOS.has(m[1])) return { archivo: 'vendor/' + m[1], cache: 'public, max-age=86400' };
  m = /^\/icons\/([A-Za-z0-9_.-]+)$/.exec(pathname);
  if (m && /^icon-(192|512)\.png$/.test(m[1])) return { archivo: 'icons/' + m[1], cache: 'public, max-age=86400' };
  m = /^\/legal\/([A-Za-z0-9_.-]+)$/.exec(pathname);
  if (m && LEGALES_PERMITIDOS.has(m[1])) return { archivo: 'legal/' + m[1], cache: 'no-cache' };
  return null;
}

// Por defecto la app NO puede embeberse (anti-clickjacking). Algunos
// entornos de vista previa muestran el servidor dentro de un iframe; en ese
// caso se puede relajar SOLO allí con FRAME_ANCESTORS (nunca en producción).
const FRAME_ANCESTORS = process.env.FRAME_ANCESTORS || "'none'";
const PERMITIR_EMBED = FRAME_ANCESTORS !== "'none'";

function cabecerasSeguridad(req, res) {
  // La CSP de recursos la define la meta de index.html (funciona también en
  // hosting estático). Aquí solo añadimos lo que NO puede ir en una meta.
  res.setHeader('Content-Security-Policy', 'frame-ancestors ' + FRAME_ANCESTORS);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!PERMITIR_EMBED) res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=(), microphone=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (esHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

async function servirEstatico(req, res, url) {
  const destino = rutaEstatica(url.pathname);
  if (!destino) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
  const absoluta = path.join(ROOT, destino.archivo);
  if (!absoluta.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end('403'); }
  try {
    const st = await fsp.stat(absoluta);
    if (!st.isFile()) throw new Error('no es archivo');
    cabecerasSeguridad(req, res);
    res.setHeader('Content-Type', MIME[path.extname(absoluta)] || 'application/octet-stream');
    res.setHeader('Cache-Control', destino.cache);
    res.setHeader('Content-Length', st.size);
    if (req.method === 'HEAD') { res.writeHead(200); return res.end(); }
    res.writeHead(200);
    fs.createReadStream(absoluta).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}

// ------------------------------------------------------------------ servidor
export function createAppServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        cabecerasSeguridad(req, res);
        return await api(req, res, url);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end('405');
      }
      return await servirEstatico(req, res, url);
    } catch (err) {
      console.error('[gestor] error:', err.message);
      if (!res.headersSent) {
        json(res, err.estado || 500,
          { ok: false, error: err.estado ? err.message : 'Error interno del servidor.' });
      } else res.end();
    }
  });
}

export async function iniciar({ port = DEFAULT_PORT, host = DEFAULT_HOST } = {}) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(path.join(DATA_DIR, 'users-data'), { recursive: true });
  const server = createAppServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  if (USUARIO_UNICO) {
    const usuarios = await leerJson(USERS_FILE(), {});
    if (!usuarios[USUARIO_UNICO]) {
      console.warn(`[gestor] AVISO: modo usuario único «${USUARIO_UNICO}» pero la cuenta aún no existe.`);
      console.warn('[gestor] Créala con: printf %s \'TU_CLAVE\' | node tools/crear-usuario.mjs ' + USUARIO_UNICO);
    } else {
      console.log(`[gestor] Acceso restringido a un solo usuario: ${USUARIO_UNICO}`);
    }
  }
  console.log(`Gestor de Pagos en http://${host}:${port}  (datos: ${DATA_DIR})`);
  return server;
}

const ejecutadoDirectamente = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (ejecutadoDirectamente) {
  iniciar().catch(err => { console.error('No se pudo iniciar:', err); process.exit(1); });
}
