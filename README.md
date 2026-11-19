# Gestor de Pagos

Aplicación web para registrar clientes, recibos, transferencias, saldos, comisiones y
movimientos financieros, con exportación a CSV/XLSX/PDF e importación desde
JSON/XLSX/CSV. Funciona **sin servidor** (todo en `localStorage`) y, de forma
**opcional**, con un backend propio que añade cuentas reales, sincronización entre
dispositivos y copias en el servidor.

> **Archivo principal:** `index.html` (antes `texto.html`). La lógica de la app sigue
> en un único `<script>` inline; las librerías están fijadas en `vendor/` y la capa
> de sincronización en `sync.js`.

---

## 1. Límites que hay que conocer antes de publicar

- **La app no ejecuta pagos ni se conecta con bancos.** Es un registro contable
  manual. Los saldos y comisiones son el resultado de aplicar reglas a los datos que
  tú introduces: no sustituyen un estado de cuenta ni un sistema contable certificado.
- **El generador de mensajes de transferencia se mantuvo SIN MODIFICACIONES** a
  petición expresa del propietario: no se cambió su texto, su formato, sus datos
  fijos ni su funcionamiento. Ese texto **no es un comprobante bancario** y
  presentarlo como tal a terceros conlleva un riesgo legal importante. Está
  documentado en `legal/terminos.html` y `legal/descargo.html`; la herramienta lo
  conserva exclusivamente como utilidad personal de formateo de texto.
- **Dos modos, dos realidades de datos:**

  | | Modo local (por defecto en hosting estático) | Modo servidor (`npm start`) |
  |---|---|---|
  | Dónde están los datos | `localStorage` del navegador, **sin cifrar** | Ficheros JSON en `DATA_DIR` del servidor, **sin cifrar en reposo** + copia local en el navegador |
  | Cuentas | Perfil local: PBKDF2 con sal, **no es una barrera de seguridad** | Registro/login con scrypt, sesión en cookie `HttpOnly` |
  | Entre dispositivos | No | Sí, con control de versión optimista |
  | Copias | Instantánea local + exportación manual de JSON | Hasta 12 instantáneas por usuario en el servidor |

  En ambos casos conviene **exportar el JSON periódicamente** y guardarlo fuera del
  navegador. La app avisa si pasan 7 días sin exportar y ofrece restaurar la última
  instantánea local.
- **Conflicto entre dispositivos:** si dos guardan a la vez, gana el primero; el
  segundo recibe un `409` y **recarga los datos del servidor** (no hay fusión
  automática). Se avisa en pantalla.
- **Se guardan números completos de tarjeta/monedero** en las transferencias
  (necesario para el funcionamiento actual). Valora guardar solo los últimos 4
  dígitos si vas a tratar datos de terceros.
- **Las páginas legales son plantillas.** Antes de publicar, completa los campos
  `[completar: ...]` (responsable, contacto, jurisdicción) y revísalas con
  asesoramiento legal. No constituyen asesoramiento jurídico.

---

## 2. Ejecutar en local

Requiere **Node >= 20** para el backend. Para las pruebas, `npm install` (jsdom).

```bash
# A) Con backend (recomendado: cuentas + sincronización)
npm start                 # http://localhost:8080

# B) Solo estático (sin cuentas; datos únicamente en el navegador)
npm run serve             # python3 -m http.server 8080 --bind 0.0.0.0

# C) Contenedor
docker compose up -d --build
```

Variables de entorno: copia `.env.example` a `.env`. Las importantes son `PORT`,
`HOST`, `DATA_DIR` (directorio **persistente**, fuera de Git) y `TRUST_PROXY`
(`1` solo detrás de un proxy de confianza). Ver `deploy/README.md`.

Comprobación rápida del backend:

```bash
curl -s http://localhost:8080/api/health      # {"ok":true,"modo":"servidor",...}
```

**Sirve por HTTP/HTTPS.** Al abrir `index.html` con doble clic (`file://`) la CSP
puede bloquear los scripts de `vendor/` en algunos navegadores; hay un fallback a
jsDelivr, y el modo servidor no estará disponible.

---

## 3. Arquitectura

```
index.html            app monolítica (UI + reglas de negocio, script inline con hash CSP)
sync.js               capa OPCIONAL: detecta /api/health, login/registro, sync, 409
server.mjs            backend Node 20+ sin dependencias (API + estáticos por allowlist)
sw.js                 service worker: caché offline; NUNCA cachea /api/*
vendor/               5 UMD fijados con SRI (sin CDN en ejecución)
legal/                privacidad, términos, descargo (plantillas)
icons/, icon.svg, manifest.webmanifest   PWA
data/                 SOLO en tiempo de ejecución: usuarios, sesiones, datos, historial (en .gitignore)
tests/                app.test.mjs (36) + server.test.mjs (10) + sync.test.mjs (4)
tools/                actualizar-hashes.mjs (SRI + hash CSP)
deploy/               nginx, systemd, Render, guía de despliegue
```

### API del backend

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/health` | Sondeo público: decide si `sync.js` activa el modo servidor |
| POST | `/api/register` | Alta (usuario 3-32 `[A-Za-z0-9_]`, contraseña ≥ 8) |
| POST | `/api/login` | scrypt + sal; devuelve cookie `gestor_sid` |
| GET | `/api/session` | Usuario de la sesión activa |
| POST | `/api/logout` | Invalida la sesión y borra la cookie |
| GET/PUT | `/api/data` | Conjunto `clientes/recibos/transferencias/finanzas` + `secuencia` + `version` |
| GET | `/api/backups` | Lista de copias del servidor |
| POST | `/api/restore` | Restaura una copia (crea una versión nueva) |
| GET | `/api/export` | Descarga JSON completo |

Seguridad: scrypt N=16384/r=8/p=1 con sal de 16 B, contraseñas nunca en claro,
comparación en tiempo constante, derivación «dummy» cuando el usuario no existe,
rate limit (8 registros/hora, 8 logins/15 min), comprobación de `Origin` y
`Sec-Fetch-Site` (funciona detrás de proxies que reescriben `Host`),
`Content-Type: application/json`, límite de cuerpo 2 MB, escritura atómica con
permisos `0600`, allowlist de archivos estáticos, y cabeceras `frame-ancestors
'none'`, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`,
COOP/CORP y HSTS tras HTTPS. La CSP de recursos vive en la `<meta>` de
`index.html` (así funciona también en hosting estático); la cabecera HTTP solo
añade `frame-ancestors 'none'`, que no puede ir en una meta. **No hay conflicto**:
ambas políticas se aplican por separado y la más restrictiva gana por directiva.
Si necesitas embeber la app en un iframe (solo vistas previas), `FRAME_ANCESTORS`
permite relajar ese único valor; en producción déjalo en `'none'`.

### Acceso exclusivo (usuario único)

Para un despliegue privado, define `USUARIO_UNICO` y crea esa cuenta una sola vez:

```bash
printf '%s' 'TU_CLAVE' | DATA_DIR=./data USUARIO_UNICO=Chain \
  node tools/crear-usuario.mjs Chain
USUARIO_UNICO=Chain npm start
```

Con eso:

- `/api/register` devuelve **403** y `/api/health` anuncia `registroCerrado: true`.
- Solo esa cuenta puede iniciar sesión; cualquier otro usuario recibe el error
  genérico de credenciales (con la misma derivación scrypt, para no filtrar nombres).
- `sync.js` **oculta el alta de cuentas y el modo local**, pre-rellena el usuario y
  obliga a autenticarse. Si el backend no responde, el acceso **sigue cerrado**
  (fail closed) en ese navegador, en vez de abrir un perfil local.
- La contraseña **nunca se escribe en el repositorio**: el script la lee de stdin y
  solo guarda su derivada scrypt en `data/users.json` (permisos `0600`, ignorado por
  Git). Para cambiarla, repite el comando con `--reset`.

> Esto protege el acceso a **este despliegue**. Una copia suelta de `index.html`
> abierta desde otro hosting o desde `file://` seguirá siendo una app local vacía:
> no contiene tus datos, que solo viven en `DATA_DIR`.

---

## 4. Publicar

Hay dos caminos. **No se ha publicado nada**: elegir hosting y desplegar requiere tu
decisión. Guía completa en `deploy/README.md`.

**Estático (GitHub Pages, Netlify, S3…):** sube `index.html`, `sync.js`, `sw.js`,
`manifest.webmanifest`, `icon.svg`, `icons/`, `vendor/` y `legal/` por HTTPS.
`sync.js` recibirá un 404 en `/api/health` y mostrará «Solo en este dispositivo
(sin servidor)». Todo lo demás funciona igual. Ya hay un workflow listo en
`.github/workflows/pages.yml` que publica `main` en GitHub Pages con
`tools/preparar-pages.mjs`. **Requiere que el repo sea público** (el token de
integración no puede cambiar la visibilidad) y, al ser estático, **no aplica
`USUARIO_UNICO`**: ver la advertencia en `deploy/README.md`, opción E.

**Con backend (VPS / Docker / PaaS):** usa `Dockerfile` + `docker-compose.yml`, o
`deploy/gestor-pagos.service.example`, o `deploy/render.yaml.example`. Imprescindible:
HTTPS delante, volumen persistente en `/app/data`, `TRUST_PROXY=1` detrás del proxy,
y completar los documentos legales. `Procfile` cubre PaaS con `web: node server.mjs`.

Las rutas son relativas: funciona también en un subdirectorio (p. ej. GitHub Pages
`/Gester-de-Transferencias/`) **en modo estático**. El backend espera estar en la
raíz del dominio.

---

## 5. Mantenimiento

- **Después de editar `index.html`** (cualquier cambio en el `<script>` inline),
  **`sync.js`** o un archivo de `vendor/`, ejecuta:

  ```bash
  npm run hashes
  ```

  Recalcula el hash `sha256` de la CSP y los 6 `integrity` (SRI). Si no lo haces,
  el navegador bloqueará el script y la app no arrancará.
- **Si cambias archivos cacheados**, sube `CACHE_VERSION` en `sw.js` (actualmente
  `gestor-pagos-v3`) para que los clientes reciban la versión nueva.
- **Pruebas:**

  ```bash
  npm test              # 56 pruebas: app + API + integración + usuario único
  npm run test:app      # 36 jsdom: contabilidad, XSS, fórmulas, fechas, perfiles…
  npm run test:server   # 10 HTTP reales: auth, 409, copias, CSRF, estáticos…
  npm run test:sync     # 4 jsdom + servidor real: detección, subida, 409, logout
  npm run test:single   # 6: registro cerrado, cuenta única, UI bloqueada, fail closed
  ```

### Dependencias fijadas (servidas localmente, sin CDN en ejecución)

| Archivo | Versión | Uso |
|---|---|---|
| `vendor/fflate.min.js` | 0.8.3 | descomprimir XLSX en la importación |
| `vendor/xlsx.full.min.js` | 0.18.5 | **solo escritura** de XLSX |
| `vendor/jspdf.umd.min.js` | 4.2.1 | PDF |
| `vendor/jspdf.plugin.autotable.min.js` | 3.5.31 | tablas del PDF |
| `vendor/chart.umd.min.js` | 4.6.1 | gráfico de finanzas |

SheetJS 0.18.5 (última versión publicada en npm) tiene CVE-2023-30533 y
CVE-2024-22363 **al leer** archivos. Por eso la importación **no usa `XLSX.read()`**:
descomprime con `fflate`, interpreta el XML con `DOMParser` y filtra las cabeceras
por lista blanca. `XLSX` solo se usa para escribir, uso no afectado por esos avisos
[1](https://nvd.nist.gov/vuln/detail/CVE-2023-30533) [2](https://safeguard.sh/resources/blog/npm-xlsx).
Si en el futuro necesitas leer formatos más exóticos, sustituye la librería por la
build oficial parcheada de `cdn.sheetjs.com`.

---

## 6. Qué se corrigió (2026-11-19)

| Área | Corrección |
|---|---|
| Contabilidad | Importes normalizados a centavos (`cent()`); se elimina la deriva de coma flotante. |
| Contabilidad | Comisiones **enlazadas** al recibo (`reciboId`); borrar/editar un recibo o cliente ajusta su comisión. Migración automática. |
| Contabilidad | Préstamos enlazados por `operacionId` (antes se buscaban por texto libre). |
| Auditoría | Números de operación **inmutables** y monotónicos con contador persistente (`secuencia`), también al sincronizar. |
| Edición | Comisión 0% permitida; `saldoAntes` histórico respetado. |
| Fechas | `hoyLocal()`, `fechaATimestamp()` (mediodía local), `rangoDiaLocal()`: sin desfase UTC. |
| Arranque | Listeners registrados **una sola vez**; fin del duplicado en cada login. |
| Seguridad | Escapado de todo dato dinámico en `innerHTML`, sin manejadores inline, CSP con hash + 6 SRI. |
| Seguridad | Neutralización de fórmulas (`= + - @`) en CSV/XLSX y escape de comillas en CSV. |
| Seguridad | Perfiles PBKDF2-SHA256 (150.000 iteraciones) + sal, error genérico, migración del hash débil anterior. |
| Seguridad | Validación de montos, porcentajes, longitudes y números de destino; importador XLSX/CSV propio con lista blanca y límites. |
| Honestidad | Eliminadas la «sincronización offline» y la «copia automática» falsas; guardado honesto, instantánea local y aviso de respaldo. |
| Offline | `sw.js` real + manifest + iconos, rutas relativas; **`/api/*` excluido de la caché**. |
| **Backend** | `server.mjs`: scrypt, sesiones HttpOnly, control de versión con `409`, copias/restauración/exportación, allowlist, rate limit, CSRF y cabeceras de seguridad. |
| **Sincronización** | `sync.js`: detección automática del backend, login/registro remotos, subida diferida, resolución de conflictos y **fallback total a modo local** si no hay servidor. |
| **Legal** | `legal/privacidad.html`, `legal/terminos.html`, `legal/descargo.html` enlazados desde el login y el pie de la app. |
| **Despliegue** | Dockerfile con usuario sin privilegios, Compose con volumen, nginx/systemd/Render de ejemplo, `.env.example`, `Procfile`, guía en `deploy/README.md`. |
| **Acceso exclusivo** | `USUARIO_UNICO` cierra el registro, limita el login a una cuenta, oculta alta/modo local en el cliente y aplica *fail closed*; `tools/crear-usuario.mjs` crea la cuenta sin guardar la clave en claro. |
| Robustez | `try/catch` en exportaciones, errores globales, validación de JSON importado, comprobación de `execCommand('copy')`. |
| Calidad | Código muerto eliminado, refs a IDs inexistentes corregidas, accesibilidad, README, informe y 56 pruebas. |

El análisis original y su estado están en `INFORME_LANZAMIENTO.md`.

---

## 7. Pendiente (decisiones de producto, no bugs)

1. **Completar y revisar los documentos legales** con los datos reales del
   responsable, el correo de contacto y la jurisdicción aplicable.
2. **Elegir hosting, configurar HTTPS y verificar copias externas** de `DATA_DIR`.
   No hay ningún despliegue externo autorizado ni realizado.
3. **Cifrado / minimización de datos** para tarjetas y teléfonos si la app va a
   usarse con datos de terceros.
4. **Escalado:** el backend usa ficheros JSON con un único proceso. Para varias
   réplicas, recuperación de contraseña por correo o fusión de cambios concurrentes
   haría falta una base de datos y un servicio de correo.
