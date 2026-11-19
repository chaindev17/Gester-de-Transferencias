#!/usr/bin/env node
/* Recalcula los hashes SRI de vendor/*.js y el hash CSP del <script> inline.
 * Ejecuta `npm run hashes` DESPUÉS de editar index.html o actualizar vendor/. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const htmlPath = path.join(root, 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');

const sha384 = (buf) => 'sha384-' + crypto.createHash('sha384').update(buf).digest('base64');
const sha256 = (buf) => 'sha256-' + crypto.createHash('sha256').update(buf).digest('base64');

// 1) SRI de las librerías locales
let sriCambios = 0;
html = html.replace(/(<script\s+src="\.\/((?:vendor\/)?[^"/]+\.js)"[^>]*\bintegrity=")[^"]*(")/g, (m, antes, archivo, despues) => {
  const ruta = path.join(root, archivo);
  if (!fs.existsSync(ruta)) throw new Error('No existe ' + ruta);
  sriCambios++;
  return antes + sha384(fs.readFileSync(ruta)) + despues;
});

// 2) Hash CSP del script inline de la aplicación (el último sin src)
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
if (scripts.length === 0) throw new Error('No se encontró el <script> inline de la app.');
const contenido = scripts[scripts.length - 1][1];
const hashCsp = sha256(Buffer.from(contenido, 'utf8'));

const reCsp = /(script-src[^"]*'sha256-)[^']*(')/;
if (!reCsp.test(html)) throw new Error('No se encontró el placeholder sha256 en la meta CSP.');
html = html.replace(reCsp, (m, a, b) => a + hashCsp.replace(/^sha256-/, '') + b);

fs.writeFileSync(htmlPath, html, 'utf8');
console.log(`SRI actualizados: ${sriCambios}`);
console.log(`CSP script hash : ${hashCsp}`);
