/* =====================================================================
 * GestorSync — capa OPCIONAL de servidor.
 *
 * Si existe un backend (/api/health responde JSON), ofrece cuentas reales,
 * sesión HttpOnly y sincronización de datos entre dispositivos.
 * Si NO existe (GitHub Pages, Netlify estático, file://, servidor caído),
 * la app sigue funcionando exactamente igual en modo 100 % local.
 *
 * No modifica el generador de mensajes ni ninguna regla de negocio.
 * ===================================================================== */
(function () {
    'use strict';

    const PREF = 'gestor_modo_servidor';
    const EXCL = 'gestor_exclusivo';
    const RETRASO_ENVIO = 900;
    const state = {
        disponible: false,
        modo: 'local',
        registroCerrado: false,
        exclusivoPersistido: false,
        usuarioUnico: null,
        usuario: null,
        version: 0,
        listo: false,
        pendiente: false,
        timer: null,
        sesion: null
    };

    const $ = id => document.getElementById(id);
    const guardarPreferencia = v => { try { localStorage.setItem(PREF, v ? '1' : '0'); } catch (e) {} };
    // null = el usuario nunca eligió; true/false = elección explícita que se respeta.
    const leerPreferencia = () => {
        try { const v = localStorage.getItem(PREF); return v === null ? null : v === '1'; }
        catch (e) { return null; }
    };
    const leerExclusivo = () => { try { return localStorage.getItem(EXCL) === '1'; } catch (e) { return false; } };
    const guardarExclusivo = v => {
        try { if (v) localStorage.setItem(EXCL, '1'); else localStorage.removeItem(EXCL); } catch (e) {}
    };

    function toast(texto, tipo) {
        if (typeof window.mostrarToast === 'function') window.mostrarToast(texto, tipo || 'info');
    }

    function setEstado(texto, tipo) {
        const color = tipo === 'error' ? 'var(--danger)' : tipo === 'ok' ? 'var(--success)' : 'var(--text-muted)';
        ['syncEstadoLogin', 'syncEstado'].forEach(id => {
            const el = $(id);
            if (!el) return;
            el.textContent = texto;
            el.style.color = color;
        });
    }

    async function peticion(ruta, metodo, cuerpo) {
        const opciones = {
            method: metodo || 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: {}
        };
        if (cuerpo !== undefined) {
            opciones.headers['Content-Type'] = 'application/json';
            opciones.body = JSON.stringify(cuerpo);
        }
        const r = await fetch(ruta, opciones);
        let datos = null;
        const ct = r.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
            try { datos = await r.json(); } catch (e) { datos = null; }
        }
        return { ok: r.ok, status: r.status, datos: datos };
    }

    function crearUI() {
        const tarjeta = document.querySelector('#authScreen .auth-card');
        const loginForm = $('loginForm');
        if (tarjeta && loginForm && !$('bloqueModoServidor')) {
            const bloque = document.createElement('div');
            bloque.id = 'bloqueModoServidor';
            bloque.style.cssText = 'display:none; margin:0 0 12px; padding:9px 10px; border-radius:8px; background:var(--bg-input); font-size:0.75rem; line-height:1.45;';
            const etiqueta = document.createElement('label');
            etiqueta.style.cssText = 'display:flex; gap:7px; align-items:flex-start; cursor:pointer; font-weight:600; color:var(--text-primary);';
            const chk = document.createElement('input');
            chk.type = 'checkbox'; chk.id = 'modoServidorChk'; chk.style.marginTop = '2px';
            const txt = document.createElement('span');
            txt.textContent = '☁️ Usar cuenta en el servidor (sincroniza entre dispositivos)';
            etiqueta.appendChild(chk); etiqueta.appendChild(txt);
            const estado = document.createElement('div');
            estado.id = 'syncEstadoLogin';
            estado.setAttribute('role', 'status');
            estado.style.cssText = 'margin-top:6px; color:var(--text-muted); font-size:0.72rem;';
            bloque.appendChild(etiqueta); bloque.appendChild(estado);
            tarjeta.insertBefore(bloque, loginForm);
            chk.addEventListener('change', function () {
                state.modo = this.checked ? 'servidor' : 'local';
                guardarPreferencia(this.checked);
                setEstado(this.checked ? '☁️ Se usarán los datos del servidor al entrar.' : '💻 Modo local: datos solo en este navegador.', 'info');
            });
        }
        const header = document.querySelector('header');
        if (header && !$('syncEstado')) {
            const badge = document.createElement('span');
            badge.id = 'syncEstado';
            badge.setAttribute('role', 'status');
            badge.style.cssText = 'font-size:0.68rem; font-weight:600; margin-left:8px; white-space:nowrap; color:var(--text-muted);';
            badge.textContent = '💻 Local';
            (header.querySelector('.header-title') || header).appendChild(badge);
        }
    }

    function modoServidor() {
        return state.disponible && state.modo === 'servidor';
    }

    // Si algún día el backend no responde, se sigue bloqueando el acceso local
    // en este navegador (fail closed) en vez de abrir un perfil local.
    function esExclusivo() {
        return !!(state.registroCerrado || (state.exclusivoPersistido && !state.disponible));
    }

    async function comprobarServidor() {
        try {
            const r = await peticion('./api/health', 'GET');
            if (!r.ok || !r.datos || r.datos.ok !== true) return null;
            return r.datos;
        } catch (e) { return null; }
    }

    // En despliegues de usuario único no se ofrece registro ni modo local:
    // sin la cuenta del propietario la app no entra (fail closed).
    function aplicarModoExclusivo() {
        const campo = $('loginUsuario');
        if (campo && state.usuarioUnico) {
            campo.value = state.usuarioUnico;
            campo.readOnly = true;
            campo.setAttribute('aria-label', 'Usuario del propietario');
        }
        const sw = $('switchToRegister');
        if (sw) {
            sw.style.display = 'none';
            if (sw.parentElement) sw.parentElement.style.display = 'none';
        }
        const btnReg = $('btnRegister');
        if (btnReg) btnReg.disabled = true;
        const formReg = $('registerForm');
        if (formReg) formReg.style.display = 'none';
        const aviso = $('avisoPerfilLocal');
        if (aviso) aviso.textContent = '🔒 Acceso restringido al propietario. El registro está cerrado; inicia sesión con la cuenta autorizada.';
        const chk = $('modoServidorChk');
        if (chk) {
            chk.checked = true;
            chk.disabled = true;
            const etiqueta = chk.parentElement && chk.parentElement.querySelector('span');
            if (etiqueta) etiqueta.textContent = '🔒 Cuenta única del propietario (sin modo local)';
        }
        state.modo = 'servidor';
        guardarPreferencia(true);
    }

    async function autenticar(accion, usuario, password, email) {
        if (accion === 'register' && state.registroCerrado) {
            return { success: false, error: 'El registro está cerrado: solo el propietario tiene acceso.' };
        }
        try {
            if (accion === 'register') {
                const reg = await peticion('./api/register', 'POST', { usuario, password, email: email || '' });
                if (!reg.ok) return { success: false, error: (reg.datos && reg.datos.error) || 'No se pudo crear la cuenta.' };
            }
            const r = await peticion('./api/login', 'POST', { usuario, password });
            if (!r.ok) return { success: false, error: (r.datos && r.datos.error) || 'No se pudo iniciar sesión.' };
            state.usuario = usuario;
            state.listo = false;
            state.pendiente = false;
            return { success: true };
        } catch (e) {
            return { success: false, error: 'No se pudo contactar con el servidor. Puedes usar el modo local.' };
        }
    }

    async function alEntrar(usuario) {
        state.usuario = usuario;
        state.listo = false;
        try {
            const r = await peticion('./api/data', 'GET');
            if (r.status === 401) {
                setEstado('⚠️ La sesión del servidor caducó. Vuelve a entrar.', 'error');
                toast('⚠️ Sesión del servidor caducada', 'error');
                return;
            }
            if (!r.ok || !r.datos || !r.datos.datos) throw new Error('sin datos');
            const datos = r.datos.datos;
            state.version = Number(datos.version) || 0;
            if (state.version > 0 && window.GestorDatos && window.GestorDatos.cargar(datos)) {
                // El servidor gana: no se fusionan los datos locales previos.
                state.listo = true;
                state.pendiente = false;
                setEstado('☁️ Sincronizado', 'ok');
                toast('☁️ Datos del servidor cargados (no se fusionaron datos locales)', 'info');
                return; // ya estamos al día: no crear una versión nueva en cada entrada
            }
            // Servidor vacío: subir el estado local existente.
            state.version = 0;
            state.listo = true;
            setEstado('☁️ Subiendo datos iniciales…', 'info');
            await enviar();
        } catch (e) {
            state.listo = true;
            state.pendiente = true;
            setEstado('⚠️ Sin conexión · datos locales', 'error');
        }
    }

    function programarEnvio() {
        if (!modoServidor() || !state.listo) return;
        clearTimeout(state.timer);
        state.pendiente = true;
        setEstado('⏳ Guardando en el servidor…', 'info');
        state.timer = setTimeout(enviar, RETRASO_ENVIO);
    }

    async function enviar() {
        if (!modoServidor() || !state.listo || !window.GestorDatos) return;
        clearTimeout(state.timer);
        try {
            const conjunto = window.GestorDatos.exportar();
            const r = await peticion('./api/data', 'PUT', { ...conjunto, version: state.version });
            if (r.ok && r.datos && r.datos.ok) {
                state.version = r.datos.version;
                state.pendiente = false;
                setEstado('☁️ Sincronizado', 'ok');
                return;
            }
            if (r.status === 409 && r.datos && r.datos.datos) {
                // Otro dispositivo guardó primero: el servidor gana.
                const servidor = r.datos.datos;
                state.version = Number(servidor.version) || 0;
                if (window.GestorDatos.cargar(servidor)) {
                    window.GestorDatos.refrescar();
                    toast('☁️ Se aplicaron cambios de otro dispositivo', 'info');
                }
                state.pendiente = false;
                setEstado('☁️ Sincronizado', 'ok');
                return;
            }
            throw new Error((r.datos && r.datos.error) || 'fallo');
        } catch (e) {
            state.pendiente = true;
            setEstado('⚠️ Sin conexión · cambios pendientes', 'error');
        }
    }

    async function alSalir() {
        if (state.pendiente) await enviar().catch(() => {});
        clearTimeout(state.timer);
        if (state.disponible && state.usuario) {
            try { await peticion('./api/logout', 'POST', {}); } catch (e) {}
        }
        state.usuario = null; state.listo = false; state.pendiente = false; state.version = 0;
        setEstado(state.registroCerrado ? '🔒 Sesión cerrada · acceso restringido'
            : (state.disponible ? '💻 Modo local' : '💻 Solo en este dispositivo'), 'info');
    }

    async function iniciar() {
        crearUI();
        state.exclusivoPersistido = leerExclusivo();
        const info = await comprobarServidor();
        state.disponible = !!info;
        state.registroCerrado = !!(info && info.registroCerrado);
        state.usuarioUnico = (info && typeof info.usuarioUnico === 'string') ? info.usuarioUnico : null;
        const bloque = $('bloqueModoServidor');
        const chk = $('modoServidorChk');
        if (!state.disponible) {
            if (state.exclusivoPersistido) {
                state.registroCerrado = true;
                aplicarModoExclusivo();
                setEstado('🔒 Servidor no disponible · acceso restringido', 'error');
            } else {
                setEstado('💻 Solo en este dispositivo (sin servidor)', 'info');
            }
            return;
        }
        guardarExclusivo(state.registroCerrado);
        state.exclusivoPersistido = state.registroCerrado;
        if (bloque) bloque.style.display = 'block';
        const aviso = $('avisoPerfilLocal');
        if (aviso && !state.registroCerrado) aviso.textContent = 'ℹ️ Hay un servidor disponible. Activa la casilla para usar cuenta y sincronización; sin ella, tus datos siguen solo en este navegador, sin cifrar.';
        // ¿Hay ya una sesión en el servidor?
        try {
            const s = await peticion('./api/session', 'GET');
            state.sesion = (s.ok && s.datos && s.datos.usuario) ? s.datos.usuario : null;
        } catch (e) { state.sesion = null; }

        if (state.registroCerrado) {
            aplicarModoExclusivo();
        } else {
            const preferencia = leerPreferencia();
            if (preferencia === true || (preferencia === null && state.sesion)) {
                state.modo = 'servidor';
                if (chk) chk.checked = true;
                if (state.sesion && $('loginUsuario')) $('loginUsuario').value = state.sesion;
            }
        }
        setEstado(state.sesion && modoServidor()
            ? (state.registroCerrado ? '🔒 Sesión activa: ' : '☁️ Sesión activa en el servidor: ') + state.sesion
            : (state.registroCerrado ? '🔒 Acceso restringido al propietario'
               : (modoServidor() ? '☁️ Se usarán los datos del servidor al entrar.' : '💻 Modo local: datos solo en este navegador.')),
            state.sesion && modoServidor() ? 'ok' : 'info');

        window.addEventListener('online', async () => {
            const info2 = await comprobarServidor();
            state.disponible = !!info2;
            state.registroCerrado = state.registroCerrado || !!(info2 && info2.registroCerrado);
            if (state.registroCerrado) aplicarModoExclusivo();
            if (state.pendiente) await enviar();
        });
        setInterval(() => { if (state.pendiente && navigator.onLine) enviar(); }, 30000);
    }

    window.GestorSync = {
        iniciar, modoServidor, esExclusivo, autenticar, alEntrar, alSalir, programarEnvio,
        estado: () => ({
            disponible: state.disponible, modo: state.modo, pendiente: state.pendiente,
            registroCerrado: state.registroCerrado, usuarioUnico: state.usuarioUnico
        })
    };

    // Se expone la promesa para que las pruebas (y quien integre la capa)
    // puedan esperar a que se haya detectado el backend antes de usarlo.
    window.GestorSync.listo = iniciar();
})();
