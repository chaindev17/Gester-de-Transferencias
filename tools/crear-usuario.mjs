#!/usr/bin/env node
/* Crea la cuenta del propietario en modo «usuario único».
 *
 * La contraseña se lee de stdin (o de GESTOR_PASSWORD) para que NO quede en
 * argumentos del proceso, en el historial del shell ni en ningún archivo del
 * repositorio. Solo se guarda su derivada scrypt en data/users.json (ignorado
 * por Git, permisos 0600).
 *
 *   printf '%s' 'TU_CLAVE' | DATA_DIR=./data USUARIO_UNICO=Chain \
 *     node tools/crear-usuario.mjs Chain
 *
 * Para cambiar una contraseña ya existente: añadir --reset al final.
 */
import { crearUsuario, existeUsuario } from '../server.mjs';

const usuario = process.argv[2] || process.env.USUARIO_UNICO || '';
const reset = process.argv.includes('--reset');

async function leerClave() {
  if (process.env.GESTOR_PASSWORD) return process.env.GESTOR_PASSWORD;
  const trozos = [];
  for await (const t of process.stdin) trozos.push(t);
  return Buffer.concat(trozos).toString('utf8').replace(/[\r\n]+$/, '');
}

if (!usuario) {
  console.error('Uso: printf %s \'TU_CLAVE\' | node tools/crear-usuario.mjs USUARIO [--reset]');
  process.exit(1);
}
if (await existeUsuario(usuario) && !reset) {
  console.error('La cuenta «' + usuario + '» ya existe. Añade --reset solo si quieres cambiar su contraseña.');
  process.exit(1);
}

const clave = await leerClave();
if (clave.length < 8 || clave.length > 200) {
  console.error('La contraseña debe tener entre 8 y 200 caracteres.');
  process.exit(1);
}

try {
  const { creado } = await crearUsuario(usuario, clave);
  console.log(creado
    ? '✅ Cuenta «' + usuario + '» creada. La contraseña NO se ha guardado en claro.'
    : '🔑 Contraseña de «' + usuario + '» actualizada. La anterior dejó de funcionar.');
  console.log('   Fichero: ' + (process.env.DATA_DIR || './data') + '/users.json (solo hash scrypt)');
} catch (e) {
  console.error('❌ ' + e.message);
  process.exit(1);
}
