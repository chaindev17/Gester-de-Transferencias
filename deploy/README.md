# Despliegue

**Estado:** estas son plantillas listas para usar, **no se ha publicado nada** en ningún
servicio externo. Elegir hosting y desplegar requiere tu decisión (y, si procede,
conectar la app correspondiente desde Arena).

Hay dos formas de servir la app:

| Modo | Comando | Cuentas / sync | Cuándo usarlo |
|---|---|---|---|
| **Estático** | `npm run serve` o cualquier hosting de archivos | No. Solo `localStorage`. | GitHub Pages, Netlify estático, S3, uso personal en un solo dispositivo. |
| **Con backend** | `npm start` (o Docker / systemd / PaaS) | Sí. Registro, login, sync y copias en servidor. | Varios dispositivos, datos compartidos, recuperación desde el servidor. |

La misma `index.html` sirve para ambos: `sync.js` detecta `/api/health` y, si no hay
backend, se queda en modo local sin cambiar el comportamiento.

---

## Antes de publicar (obligatorio)

1. **HTTPS.** Necesario para las cookies `Secure`, el service worker, el portapapeles
   y `crypto.subtle`. Nunca expongas el backend por HTTP plano a Internet.
2. **Completa los documentos legales.** `legal/privacidad.html`, `legal/terminos.html`
   y `legal/descargo.html` son **plantillas**: sustituye `[completar: ...]` por el
   responsable real, el correo de contacto y la jurisdicción, y revísalos con
   asesoramiento legal.
3. **Persistencia.** `DATA_DIR` debe apuntar a un volumen/disco persistente y
   **fuera del árbol servido**. Sin volumen, cada despliegue borra usuarios y datos.
   Está en `.gitignore`; no lo versiones nunca.
4. **Copias externas.** El servidor guarda hasta 12 instantáneas por usuario, pero
   no sustituyen un backup fuera de la plataforma. Programa una copia de `DATA_DIR`.
5. **`FRAME_ANCESTORS`.** Por defecto `'none'`: se envían
   `frame-ancestors 'none'` y `X-Frame-Options: DENY`. Solo si un panel o vista
   previa embebe la app en un iframe, usa `FRAME_ANCESTORS=*` **en ese entorno**;
   nunca en producción con usuarios reales.
6. **`TRUST_PROXY`.** Pon `1` **solo** si el puerto 8080 NO es accesible
   directamente y todo el tráfico pasa por un proxy de confianza que reescribe
   `X-Forwarded-*`. Si queda expuesto, déjalo en `0` (si no, cualquiera podría
   falsificar la IP y evadir el límite de intentos).
7. **Revisa el generador de mensajes.** Se conservó intacto por instrucción del
   propietario. El descargo de responsabilidad explica que **no es un comprobante
   bancario**; no lo presentes como tal a terceros.

---

## Opción A — Node directo

```bash
node --version          # >= 20
cp .env.example .env    # ajusta DATA_DIR / TRUST_PROXY
npm start               # http://0.0.0.0:8080
```

### Solo para ti: un único usuario

Si quieres que nadie más pueda entrar, activa `USUARIO_UNICO` y crea esa cuenta
una vez (la clave va por **stdin**, nunca a un archivo ni a los argumentos):

```bash
printf '%s' 'TU_CLAVE' | DATA_DIR=./data USUARIO_UNICO=Chain \
  node tools/crear-usuario.mjs Chain
USUARIO_UNICO=Chain npm start
```

El registro queda cerrado (403), el cliente oculta el alta de cuentas y el modo
local, y solo esa cuenta inicia sesión. Si el backend cae, el acceso sigue cerrado.
Para cambiar la clave, repite el comando con `--reset`. Detalles en el README
principal, sección «Acceso exclusivo».

Comprobación rápida:

```bash
curl -i http://localhost:8080/api/health
curl -i http://localhost:8080/ | head -20
```

## Opción B — Docker Compose (recomendado en VPS)

```bash
docker compose up -d --build
docker compose logs -f
curl http://localhost:8080/api/health
```

El volumen `gestor-data` conserva `users.json`, `sessions.json`, `users-data/` e
`history/`. El `docker-entrypoint.sh` ajusta permisos y ejecuta la app como usuario
sin privilegios.

Para HTTPS, pon delante `deploy/nginx.conf.example` (o Caddy) y cambia en
`docker-compose.yml` el puerto a `127.0.0.1:8080:8080` y `TRUST_PROXY: "1"`.

## Opción C — systemd en un VPS

Instala Node 20, copia el repo a `/opt/gestor`, crea `/var/lib/gestor` propiedad de
`gestor`, y usa `deploy/gestor-pagos.service.example` con nginx delante. El servicio
ya incluye `ProtectSystem=strict` y `ReadWritePaths=/var/lib/gestor`.

## Opción D — PaaS (Render u otro con disco persistente)

`Procfile` y `deploy/render.yaml.example` son puntos de partida. Lo crítico es el
**disco montado en `/app/data`** y `TRUST_PROXY=1`. Sin disco, los datos se pierden
en cada reinicio. En plataformas sin disco persistente, usa el modo estático.

## Modo estático (sin backend)

Sube `index.html`, `sync.js`, `sw.js`, `manifest.webmanifest`, `icon.svg`, `icons/`,
`vendor/` y `legal/` a cualquier hosting HTTPS. `sync.js` intentará `/api/health`,
recibirá un 404 y mostrará «Solo en este dispositivo (sin servidor)». Todo lo demás
funciona igual; los datos siguen siendo locales.

> Si pasas de estático a backend (o al revés), **sube `CACHE_VERSION` en `sw.js`**
> para que los clientes no sigan usando la versión cacheada.

---

## Verificación posterior al despliegue

```bash
npm test                       # 56: 36 app + 10 API + 4 sync + 6 usuario único
curl -s https://TU_DOMINIO/api/health
curl -sI https://TU_DOMINIO/ | grep -iE 'content-security|x-frame|referrer'
```

Comprueba además en el navegador: registro → login → alta de un cliente → recarga
de la página (debe conservarse) → cierre de sesión → login desde otro navegador con
la misma cuenta (deben aparecer los mismos datos).

## Límites conocidos del backend

- Almacenamiento en ficheros JSON con escritura atómica: **un solo proceso**.
  Para varios réplicas hace falta una base de datos y bloqueo distribuido.
- El control de versión es optimista: si dos dispositivos guardan a la vez,
  **gana el primero** y el segundo recarga los datos del servidor (no fusiona).
  Está avisado en el descargo y en la interfaz.
- Rate limit y sesiones viven en memoria/fichero del proceso; se reinician al
  reiniciar. No hay recuperación de contraseña por correo (no hay SMTP).
- Las contraseñas se derivan con scrypt, pero los **datos no se cifran en reposo**.
  Protege el volumen a nivel de disco y restringe el acceso al servidor.
