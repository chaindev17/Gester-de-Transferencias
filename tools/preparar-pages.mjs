#!/usr/bin/env node
/* Prepara el artefacto estático que se publica en GitHub Pages.
 *
 * - Copia SOLO lo que la app necesita (nunca server.mjs, tests/, data/…).
 * - Inserta, únicamente en la copia, un aviso honesto de que esta versión es
 *   pública y estática: no hay backend, no hay sincronización y NO se aplica
 *   el control de usuario único.
 * - Comprueba que el <script> inline no cambió, de modo que el hash sha256
 *   de la CSP sigue siendo válido sin tener que recalcularlo.
 *
 * Uso: node tools/preparar-pages.mjs   → genera ./_site
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const salida = path.join(root, '_site');

const AVISO = '<p role="note" style="margin:0 0 14px; padding:9px 10px; border-radius:8px; ' +
  'background:#fff3cd; color:#6b5200; font-size:0.72rem; line-height:1.5; text-align:center;">' +
  '🌐 <strong>Versión pública estática (GitHub Pages).</strong> Funciona solo en este navegador: ' +
  'sin servidor, sin sincronización y sin la cuenta privada del propietario. ' +
  'No contiene datos de nadie.' +
  '</p>';

const ANCLA = '<div class="auth-card">';
const copiar = (rel) => {
  const destino = path.join(salida, rel);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.copyFileSync(path.join(root, rel), destino);
};

fs.rmSync(salida, { recursive: true, force: true });
fs.mkdirSync(salida, { recursive: true });

for (const f of ['index.html', 'sync.js', 'sw.js', 'manifest.webmanifest', 'icon.svg']) copiar(f);
for (const dir of ['icons', 'vendor', 'legal']) {
  const origen = path.join(root, dir);
  for (const f of fs.readdirSync(origen)) {
    if (fs.statSync(path.join(origen, f)).isFile()) copiar(dir + '/' + f);
  }
}

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
if ((html.match(/<div class="auth-card">/g) || []).length !== 1) {
  throw new Error('No se encontró exactamente un <div class="auth-card">.');
}
const modificado = html.replace(ANCLA, ANCLA + '\n            ' + AVISO);

// Seguridad: el aviso va FUERA del script inline. Si algo tocase el script,
// el hash CSP dejaría de coincidir y el navegador bloquearía la app.
const scripts = s => [...s.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const antes = scripts(html), despues = scripts(modificado);
if (antes.length !== despues.length || antes.some((x, i) => x !== despues[i])) {
  throw new Error('El script inline cambió: ejecuta `npm run hashes` antes de publicar.');
}
const hashMeta = /'(sha256-[^']+)'/.exec(modificado);
if (!hashMeta) throw new Error('No se encontró el hash sha256 en la meta CSP.');

fs.writeFileSync(path.join(salida, 'index.html'), modificado, 'utf8');
fs.writeFileSync(path.join(salida, '.nojekyll'), '');

const total = fs.readdirSync(salida, { recursive: true })
  .filter(f => fs.statSync(path.join(salida, f)).isFile()).length;
console.log(`Artefacto listo en _site/: ${total} archivos. Aviso insertado, CSP intacta (${hashMeta[1]}).`);
