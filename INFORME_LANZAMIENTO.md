# Estado del proyecto — 2026-11-19 (fases 1, 2 y 3)

> **Este bloque sustituye a las conclusiones del informe histórico que sigue.**
> El archivo analizado (`texto.html`) pasó a llamarse **`index.html`**. El análisis
> original se conserva más abajo solo como histórico: su «Fase 0» (retirar el
> generador de mensajes) **quedó sin efecto por decisión explícita del propietario**.

## Fase 2 — correcciones técnicas (completadas)

Contabilidad en centavos, comisiones enlazadas a `reciboId`, préstamos por
`operacionId`, numeración inmutable con contador persistente, comisión 0%,
`saldoAntes` histórico, fechas en hora local, listeners únicos, escapado completo
de `innerHTML`, CSP con hash + 6 SRI, fórmulas CSV/XLSX neutralizadas, PBKDF2 con
sal + migración, importador propio sin `XLSX.read()`, honestidad de red/copias,
PWA real, librerías fijadas en `vendor/`, accesibilidad y 36 pruebas jsdom.

## Fase 3 — «Hazlo todo, hazla funcionar» (completada en el repositorio)

- **Backend real y opcional** (`server.mjs`, Node 20+, sin dependencias): registro y
  login con scrypt, sesiones en cookie `HttpOnly`/`SameSite=Strict`, control de
  versión optimista con `409`, copias en servidor, restauración, exportación,
  allowlist de estáticos, rate limit, comprobación de origen y cabeceras de seguridad.
- **Cliente integrado** (`sync.js`): detecta `/api/health`; si hay backend ofrece
  cuenta y sincronización, y si no hay (GitHub Pages, servidor caído, `file://`)
  mantiene el modo 100 % local sin cambiar el comportamiento. El service worker
  excluye `/api/*` de la caché para no servir respuestas obsoletas.
- **Documentación legal** (`legal/privacidad.html`, `legal/terminos.html`,
  `legal/descargo.html`): plantillas con los límites de la herramienta y campos
  `[completar: ...]` pendientes de datos del responsable. No son asesoramiento legal.
- **Configuración de despliegue**: `Dockerfile`, `docker-compose.yml`,
  `docker-entrypoint.sh`, `Procfile`, `.env.example`, `deploy/README.md`,
  `deploy/nginx.conf.example`, `deploy/gestor-pagos.service.example` y
  `deploy/render.yaml.example`. **No se ha publicado nada**: hace falta elegir
  hosting y completar los datos legales.
- **Acceso exclusivo**: `USUARIO_UNICO` cierra el registro público, limita el
  login a una sola cuenta, oculta alta/modo local en el cliente y aplica
  *fail closed*. `tools/crear-usuario.mjs` crea la cuenta leyendo la clave por
  stdin: solo se guarda su derivada scrypt en `data/` (fuera de Git).
- **Pruebas**: `npm test` ejecuta 36 de app + 10 de API + 4 de integración
  cliente↔servidor + 6 de usuario único (**56 en total**). El detalle de
  ejecución y límites está en `README.md` y `deploy/README.md`.

## Mantenido sin cambios (decisión del usuario)

El generador de mensajes con formato de confirmación bancaria **se conservó tal
cual**: no se modificó su texto, su formato, sus datos fijos ni su funcionamiento.
El riesgo legal sigue vigente y ahora está **documentado** en los términos y en el
descargo de responsabilidad: es un texto de uso interno, **no un comprobante
bancario**, y no debe presentarse como tal a terceros.

## Riesgos residuales (decisiones de producto, no bugs)

1. El backend usa ficheros JSON con un único proceso; no hay fusión de cambios
   concurrentes (gana el primer guardado), ni recuperación de contraseña por correo.
2. Los datos **no se cifran en reposo** ni en `localStorage`; se guardan números
   completos de tarjeta/monedero. Valora guardar solo los últimos 4 dígitos.
3. Las páginas legales son plantillas: **hay que completar responsable, contacto y
   jurisdicción** antes de publicar.
4. Falta elegir hosting, configurar HTTPS y verificar copias externas. No se ha
   autorizado ni realizado ningún despliegue externo.
5. En `file://` la CSP puede bloquear los scripts locales; servir por HTTP/HTTPS.

---

# Informe de análisis previo al lanzamiento — `texto.html`

**Fecha:** 2026-11-19 · **Archivo analizado:** `texto.html` (3.902 líneas, 181 KB, aplicación de una sola página)
**Repositorio:** `chaindev17/Gester-de-Transferencias` (antes del análisis solo contenía `README.md`)

---

## 1. Veredicto

**No lo publiques todavía.** Es una aplicación visualmente completa y funcional para uso personal en un solo navegador, pero tiene **tres bloqueantes** para un lanzamiento público:

| # | Bloqueante | Por qué impide lanzar |
|---|---|---|
| 1 | **Generador de falsos comprobantes bancarios** | `copiarMensajeTransferencia()` fabrica un SMS de "Banco Popular de Ahorro"/ETECSA diciendo *"La Transferencia fue completada"* sin que exista ninguna transacción ni integración bancaria. Riesgo legal, reputacional y de facilitación de estafa. |
| 2 | **Seguridad y privacidad** | El "sistema de autenticación seguro" no es autenticación: todo vive en `localStorage` en texto plano, hay XSS almacenado ejecutable y se guardan números de tarjeta/monedero completos sin cifrar. |
| 3 | **El producto promete cosas que no hace** | No hay backend, ni sincronización, ni copias de seguridad reales, ni modo offline. Los datos se pierden al limpiar el navegador y no existen en otros dispositivos. |

Además hay **6 defectos contables reproducidos** que hacen que los saldos y los informes de comisiones sean incorrectos.

---

## 2. Qué es la aplicación

HTML único con CSS embebido (~1.240 líneas) y JS embebido (~2.200 líneas), sin build, sin módulos, sin tests. Carga 4 librerías por CDN en el `<head>` (XLSX 0.18.5, jsPDF 2.5.1, jspdf-autotable 3.5.31, Chart.js **sin versión fijada**).

Funcionalidades: registro/login de usuarios, alta de clientes con % de comisión, recibos (monto − comisión = neto), transferencias a tarjeta/monedero, saldos por cliente (incluye "préstamos" cuando el saldo queda negativo), finanzas (ingresos/gastos/comisiones), historial filtrable, exportación CSV/XLSX/PDF, importación JSON/Excel, gráfico doughnut, dictado por voz, modo oscuro, detector de tarjetas cubanas (BANDEC/BPA/Metropolitano, prefijo `92`, monederos `+53`), y un indicador Online/Offline.

Todo el estado son 4 arrays en memoria (`clientes`, `recibos`, `transferencias`, `finanzas`) persistidos en `localStorage` con claves `gestor_<usuario>_<tipo>`.

---

## 3. Hallazgo crítico: generador de mensajes que simulan ser del banco

**Ubicación:** `copiarMensajeTransferencia()` (líneas 2167–2203), botón `📋 "Copiar mensaje BPA"` (línea 2962), constantes `TRANSACCION_OCULTA` y `formatearTarjeta()` (2150–2160).

El botón copia al portapapeles textos como:

```
Banco Popular de Ahorro:  La Transferencia fue completada.
Fecha: 19/11/2026
Beneficiario: 9212XXXXXXXX5427
Ordenante: 9212XXXXXXXX3852
Monto: 1,000.00 CUP
Nro. Transaccion: XXXXXXXXXXXXX
Saldo restante: CR 900 CUP.
```

y la variante de monedero con `"Gracias por utilizar nuestros servicios, ETECSA."`, `"Id Monedero: TMW182078006"` e `"Id Transaccion: XXXXXXXXXXXXX"`.

La app **no se conecta con ningún banco**: registrar una transferencia solo hace `transferencias.push(...)` y resta el saldo local. El texto, sin embargo, imita el formato de un SMS de confirmación de una entidad financiera real, con datos de ordenante e identificadores hardcodeados de terceros.

**Por qué es un bloqueante:** es un generador de comprobantes de pago falsos con apariencia oficial. Publicado, puede usarse para engañar a terceros (suplantación de entidad financiera / estafa), y el nombre del banco y de ETECSA se usan sin autorización. Es el primer punto a resolver, por encima de cualquier bug técnico.

**Recomendación:** eliminar la función o sustituirla por un **comprobante interno** explícitamente etiquetado, p. ej. *"REGISTRO INTERNO — NO ES UN COMPROBANTE BANCARIO"*, con folio propio de la app, sin nombres de bancos, sin números de tarjeta enmascarados, sin "Id Transaccion" y sin textos que imiten SMS. Quitar también las constantes hardcodeadas `9212XXXXXXXX3852`, `9206XXXXXXXX0000` y `TMW182078006`.

> Nota: puedo ayudar a eliminar esa función o a convertirla en un recibo interno honesto; no voy a ayudar a hacer el mensaje más parecido a un SMS bancario real.

---

## 4. Seguridad y datos personales

### 4.1 La autenticación no es autenticación (líneas 1701–1738)
- `hashPassword()` es un hash Java de 32 bits (`((hash<<5)-hash)+char`, `hash & hash`), sin sal, sin KDF. Verificado: la contraseña `123456` produce `hash_nzmv6r_6`.
- Usuarios, contraseñas hasheadas y emails se guardan en `localStorage` (`gestor_usuarios`), legibles desde la consola sin iniciar sesión.
- `mostrarAuth()` solo oculta/muestra con CSS (`display:none` / `.show`). Con `ocultarAuth()` desde la consola se entra sin contraseña; con `cargarDatosUsuario('otro_usuario')` se leen los datos de **cualquier otro usuario** del mismo navegador.
- No hay sesión, expiración, rate-limiting, verificación de email ni recuperación de contraseña. El registro permite contraseñas de 6 caracteres y el login revela si el usuario existe (*"Usuario no encontrado"* vs *"Contraseña incorrecta"*).

**Verificado en ejecución:** tras `cerrarSesion()`, `localStorage` sigue exponiendo `gestor_juan_clientes`, `gestor_juan_recibos`, `gestor_juan_transferencias`, `gestor_juan_finanzas` con saldos y nombres en claro.

### 4.2 XSS almacenado (confirmado)
Los renderizados usan `innerHTML` con datos sin escapar: `${c.nombre}` (2415, 2481, 2655), `${nombre}` (2601, 2629, 2722, 2864, 2946), `${desc}` / `${m.descripcion}` (2771), `${numeroMostrado}` (2957), `${texto}` dentro de `<pre>` (2239), y un `onclick` inline (2240). No hay CSP ni sanitización.

**Prueba realizada:** registrar un cliente con nombre `<img src=x onerror="window.__PWNED=1">` → el `<img>` se inyecta en el DOM y el manejador **se ejecuta**. Vector real: importar un JSON/Excel con un nombre malicioso (líneas 3595–3690) compromete toda la información financiera del navegador.

### 4.3 Datos sensibles sin protección
`numeroDestino` se guarda **completo** (16 dígitos de tarjeta o teléfono) en cada transferencia, en `localStorage`, sin cifrar y sin política de retención. Combinado con el XSS anterior, es un escenario de exfiltración directa. Conviene guardar solo los últimos 4 dígitos.

### 4.4 Inyección de fórmulas en exportaciones (confirmado)
`exportarCSV()` (2387) y la exportación XLSX (3731–3743) insertan el nombre del cliente sin neutralizar. **Prueba:** un cliente llamado `=1+1&cmd|calc` genera `99,"=1+1&cmd|calc",recibo,...`. Las comillas no impiden que Excel evalúe la celda como fórmula. Hay que prefijar con `'` o escapar `= + - @`.

### 4.5 Dependencias externas
- Sin `integrity` (SRI) en ningún `<script>`, y `https://cdn.jsdelivr.net/npm/chart.js` **sin versión**: un cambio de major puede romper el gráfico sin previo aviso.
- XLSX 0.18.5 es la última versión publicada en npm y está afectada por **CVE-2023-30533** (prototype pollution) y **CVE-2024-22363** (ReDoS), corregidos en 0.19.3, que solo se distribuye por el CDN oficial de SheetJS [1](https://safeguard.sh/resources/blog/npm-xlsx) [2](https://web.archive.org/web/20231129100639/https:/security.snyk.io/vuln/SNYK-JS-XLSX-5457926). **Aquí el vector aplica especialmente**: `btnImportarExcel` llama a `XLSX.read()` sobre un archivo subido por el usuario.
- jsPDF 2.5.1 acumula múltiples avisos de seguridad (DoS vía `addImage`/`html`, ReDoS, inyección de objetos PDF), con versión corregida 4.2.1 [1](https://secure.software/npm/packages/jspdf/vulnerabilities/2.5.1) [2](https://www.versioneye.com/NodeJS/jspdf/2.5.1). No todos los vectores aplican a este uso (solo `text`/`autoTable`), pero la versión está claramente desactualizada.
- Los handlers de exportación XLSX/PDF no tienen `try/catch`: si un CDN falla o se bloquea, lanzan `ReferenceError` sin mensaje al usuario.
- Sin `<meta name="description">`, favicon, `manifest`, `robots`, OG tags ni licencia.

---

## 5. Defectos contables y de lógica (todos reproducidos)

| Severidad | Hallazgo | Evidencia |
|---|---|---|
| **Alta** | **Comisiones huérfanas.** `agregarMovimientoFinanciero('comision', ..., clienteId, null, fecha)` pasa `reciboId = null` (3446, 3514, 3678), pero `eliminarMovimientoPorRecibo()` (1990) y `guardarEdicion()` (3132) buscan `f.reciboId === id`. Resultado: borrar/editar un recibo (o borrar un cliente, 2501) **no borra ni ajusta su comisión**. Prueba: recibo de $1.000 al 10% → tras borrarlo, `recibos = 0` pero `finanzas = 1` ($100). Los totales de comisiones quedan inflados para siempre. | Ejecutado |
| **Alta** | **Dinero en coma flotante.** `monto * (comision / 100)` sin redondeo a centavos. Prueba: 33,33 al 3% → comisión `0.9998999999999999`, neto `32.3301`; saldo acumulado `42.369600000000005` mostrado como `$42.37`. Deriva contable con el tiempo. Usar enteros en centavos. | Ejecutado |
| **Alta** | **Numeración de operaciones mutable.** `reordenarNumerosOperaciones()` reasigna `#` correlativos en cada borrado, edición, importación **y en cada `initApp()`** (3831). Prueba: `[1,2,3,4]` → al borrar el #1 quedan `[1,2,3]`, es decir el antiguo #2 pasa a ser #1. Inadmisible para recibos/auditoría: el número debe ser inmutable y consecutivo, con anulación en vez de borrado físico. | Ejecutado |
| **Media** | **Listeners duplicados en cada login.** `initApp()` (3846+) registra de nuevo los listeners de `btnAgregarCliente`, `recibirCliente` y `transferirCliente` sin limpiarlos. Prueba: tras cerrar sesión y volver a entrar, agregar un cliente funciona pero además muestra el toast `"⚠️ Ingresa un nombre para el cliente."` (el 2º listener lee el input ya vacío). En el 3º login se acumulan tres. | Ejecutado |
| **Media** | **Comisión 0% imposible al editar.** `parseFloat(...) \|\| cliente.comision` (3124) trata el `0` como falso y restaura la comisión del cliente. | Código |
| **Media** | **Fechas y zona horaria.** `initApp()` usa `new Date().toISOString().split('T')[0]` (UTC) para la fecha por defecto; en Montevideo (UTC−3), entre las 21:00 y la medianoche propone **el día siguiente**, mientras que las listas "de hoy" filtran en hora local → la operación recién cargada no aparece. `new Date(fechaStr + 'T00:00:00')` depende de la zona; `guardarEdicion()` puede desplazar la fecha un día. | Código + TZ |
| **Media** | **Editar una transferencia reescribe el histórico.** `guardarEdicion()` pone `saldoAntes = saldo actual`, no el saldo original, y no conserva/actualiza `tipoDestino` ni `numeroDestino`; el "saldo restante" del historial deja de reflejar lo ocurrido. El ajuste de "Préstamo" busca un movimiento por `descripcion.includes('Préstamo a')` (texto libre) y puede pisar el préstamo de otro cliente. | Código |
| **Baja** | **Importación Excel frágil.** `row.tipo.toString()` / `row.cliente.toString()` lanzan si la celda está vacía (se captura por fila, pero el mensaje es críptico); no valida tipos; crea clientes con comisión 0; las transferencias importadas **no tienen** `tipoDestino`/`numeroDestino`, por lo que el botón de copiar usa la tarjeta falsa por defecto `9206XXXXXXXX0000`. | Código |
| **Baja** | `copiarConFallback()` muestra "✅ Mensaje copiado" aunque `document.execCommand('copy')` devuelva `false`. | Código |

---

## 6. Funcionalidad que se anuncia pero no existe

- **"💾 Copia de seguridad automática"** (3345): un `setInterval` de 60 s que reescribe **el mismo `localStorage`**. No es una copia, no hay exportación ni redundancia. Si se borra el almacenamiento del navegador, se pierde todo.
- **"🔄 Sincronización offline"** (3354–3362): `operacionesPendientes` se declara, **nunca se le añade nada**, y `sincronizarOffline()` solo vacía el array y muestra `"✅ Datos sincronizados correctamente"`. Prueba: `operacionesPendientes.length === 0`. Es un mensaje engañoso.
- **Indicador Online/Offline** (1932): solo lee `navigator.onLine`; no hay servidor con el que estar "online".
- **PWA / Service Worker** (3898): registra `/sw.js`, pero **el archivo no existe** en el repo (solo hay `README.md` y `texto.html`), no hay `manifest.json` ni iconos, y el `.catch(() => {})` oculta el error. Además, la ruta absoluta `/sw.js` falla si se publica en un subpath (GitHub Pages `/Gester-de-Transferencias/`). Las 4 librerías por CDN se descargan en cada carga, así que **sin internet la app ni siquiera arranca completa**.
- **Sin backend**: datos por navegador/dispositivo, sin sincronización, sin recuperación de cuenta, sin multiusuario real, límite típico de ~5 MB en `localStorage`, y pérdida total en modo incógnito o al limpiar caché. Si se lanza como web pública, los usuarios asumirán que sus datos "están en la nube" y no lo están.
- **Código muerto**: `renderUltimosRecibos()` / `renderUltimasTransferencias()` se llaman en cada `recargarTodo()` pero referencian `listaRecibos`, `listaTransferencias`, `contadorRecibos`, `contadorTransferencias`, IDs que **no existen** en el HTML (retornan antes de tiempo). Del total, 10 IDs referenciados no existen estáticamente (6 se crean dinámicamente en el modal, 4 son restos de una UI eliminada).
- **Despliegue**: no hay `index.html` (GitHub Pages / Netlify lo esperan), ni README de instrucciones, ni configuración de hosting.
- **Accesibilidad**: 26 `<input>` y 7 `<select>`, **0** `<label for>`, **0** atributos `aria-*`, solo 2 reglas `@media`. Sin asociación etiqueta-control ni soporte completo de teclado/lector de pantalla.
- **Mantenibilidad**: ~2.200 líneas de JS en un `<script>` global, 139 IDs, funciones y listeners repartidos, sin módulos, sin lint, sin tests, sin separación de datos/vista.

---

## 7. Cumplimiento y documentación que falta

Para una app que maneja **dinero de terceros, nombres, teléfonos y números de tarjeta**:

- Aviso de privacidad / política de datos: qué se guarda, dónde (dispositivo del usuario), por cuánto tiempo, y que no hay copia en servidor. En Uruguay aplica la Ley 18.331 de protección de datos personales; si los usuarios están en Cuba u otra jurisdicción, revisar la normativa local.
- Términos de uso y descargo de responsabilidad: la app **no ejecuta transferencias**, es un registro contable manual.
- Si se cobran comisiones o se gestionan fondos de terceros, revisar si la actividad encuadra en regulación financiera / de remesas (BCU u organismo equivalente).
- Consentimiento explícito antes de guardar datos financieros y antes de usar el micrófono (`SpeechRecognition`); hoy el dictado por voz se inicia sin explicar que el audio se procesa fuera del dispositivo según el navegador.
- Aclarar en la UI que **no hay conexión con BPA/ETECSA** ni con ningún banco, y que la app no es un comprobante de pago.

---

## 8. Plan de trabajo recomendado

**Fase 0 — Bloqueantes (antes de cualquier publicación)**
1. Eliminar o rediseñar el generador de mensajes bancarios (§3) y los datos hardcodeados de terceros.
2. Decidir el modelo: **(A)** app 100 % local sin cuentas → quitar registro/login y el wording "seguro/sincronizado/copia de seguridad", y avisar claramente que los datos viven en ese navegador; o **(B)** servicio real → backend con autenticación server-side (Argon2id/bcrypt), HTTPS, base de datos, backups verificables y sincronización.
3. Redactar aviso de privacidad, términos y descargo de "no ejecutamos transferencias".

**Fase 1 — Seguridad**
4. Escapar todo el contenido dinámico (`textContent` o sanitizador) y añadir CSP estricta; eliminar el `onclick` inline.
5. SRI + versiones fijadas; actualizar XLSX a la build oficial de SheetJS ≥ 0.20.x y jsPDF a versión corregida; sustituir Chart.js sin versión por una versión concreta. Considerar **vendorizar** las librerías para no depender de CDNs.
6. No almacenar números completos de tarjeta/monedero (solo últimos 4); neutralizar fórmulas en CSV/XLSX; `try/catch` en importaciones/exportaciones.

**Fase 2 — Corrección contable**
7. Enteros en centavos en todo el flujo; enlazar `reciboId` en las comisiones y borrar/ajustar en cascada al editar o eliminar (y al borrar cliente).
8. Números de operación inmutables + anulación lógica; dejar de reordenar en cada login.
9. Mover los listeners de `initApp()` a un registro único; arreglar el `|| cliente.comision`, las fechas (fecha local explícita, no `toISOString`), y `saldoAntes` histórico.
10. Tests automatizados de los cálculos (hoy no hay ninguno).

**Fase 3 — Producto y despliegue**
11. PWA real (crear `sw.js` + `manifest` + iconos, con ruta relativa) **o** eliminar por completo las afirmaciones de offline/sync/backup.
12. Renombrar a `index.html`, añadir favicon/meta/licencia/README con instrucciones, limpiar el código muerto y mejorar accesibilidad (labels, aria, foco).
13. Publicar con HTTPS (GitHub Pages, Netlify, Vercel…) y probar en móvil + escritorio + varios navegadores.

---

## 9. Cómo se verificó este análisis

- Lectura completa del HTML, CSS y JS (3.902 líneas) y contraste estático de los 137 `getElementById()` usados frente a los 139 IDs definidos.
- Ejecución del archivo en un DOM simulado (jsdom, Node 22) con `Chart`, `XLSX`, `jsPDF` y `URL` simulados, recorriendo: registro → login → alta de cliente → registro de recibo → borrado → cierre de sesión → nuevo login → inyección de nombre malicioso → exportación CSV. **No se capturaron errores JS al cargar**, pero sí se reprodujeron todos los defectos listados arriba (comisión huérfana, listeners duplicados, XSS ejecutado, renumeración, deriva de coma flotante, fórmula en CSV, cola de sincronización vacía, datos legibles sin sesión).

## 10. Cambios realizados en este repositorio

- Se copió el adjunto `texto.html` a la raíz del repo para poder analizarlo y versionarlo.
- Se añadió este informe (`INFORME_LANZAMIENTO.md`).
- **No se modificó `texto.html`**: este turno es solo análisis, a la espera de que decidas qué arreglos encarar primero.
