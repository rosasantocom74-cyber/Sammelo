# Sammelo · Tanda 2 — Instrucciones paso a paso

Qué incluye esta entrega:

| Archivo | Qué es | Cambió |
|---|---|---|
| `index.html` | La app completa (acceso por invitación, panel Admin, usuarios en vivo, estadísticas, publicidad, privacidad) | Sí |
| `sw.js` | Service worker (v10, cachea `privacidad.html`) | Sí |
| `mapa-mundial.js` | Mapa mundial (se descarga solo cuando el administrador abre el panel) | Nuevo |
| `privacidad.html` | Plantilla de política de privacidad (**debes completarla**) | Nuevo |
| `supabase-tanda2.sql` | Base de datos de la tanda 2, dividida en pasos | Nuevo |
| `config.js`, `manifest.webmanifest`, `iniciar-web.bat`, `icon-*.png` | Igual que antes | No |

> **Nada de esto se ha ejecutado contra tu Supabase real.** Tú ejecutas el SQL, paso a paso, y tú decides cuándo.

---

## 1. Qué modifica cada paso del SQL (léelo antes de ejecutar)

Supabase → **SQL Editor → New query**. Pega y ejecuta **un paso a la vez**.

**PASO 0 — solo lectura.** Lista tus políticas actuales. No cambia nada. Guarda el resultado por si quieres comparar.

**PASO 1 — estructura nueva (seguro, repetible).**
- *Añade* la columna `approved` (por defecto `false`) a `profiles`.
- *Añade* un disparador en `profiles` que impide que un usuario normal se cambie su propio `role`, `approved` o `blocked`.
- *Crea* tablas nuevas: `invites`, `app_settings`, `presence`, `visit_days`, `plays` — todas con RLS activada; solo el administrador puede leer las de estadísticas.
- *Crea* funciones nuevas (`claim_invite`, `heartbeat`, `go_offline`, `log_play`, `admin_live`, `admin_stats`, `admin_users`, `admin_set_user`, `admin_invite`, `is_admin`, `is_approved`). Las `admin_*` fallan si quien llama no es administrador.
- *Inserta* un ajuste `ads` con **todo apagado**.
- *Registra* la tabla `presence` en Realtime.
- **No borra ni cambia datos tuyos.** Con solo el Paso 1 la app sigue sirviendo canciones a todos.

**PASO 2 — modifica datos (comentado; tú decides).**
- 2.2 aprueba a todos los usuarios existentes (cambia solo `approved`).
- 2.3 te marca **a ti** como administrador (cambia 1 fila: tu correo).

**PASO 3 — cierra el acceso por invitación (comentado).** Añade dos políticas *restrictivas* (canciones y almacenamiento) que exigen estar aprobado. Tiene bloque de **reversa** al final. Hazlo **solo después** de probar con el Paso 2.

---

## 2. Orden de instalación

1. Ejecuta **PASO 0** y **PASO 1**.
2. En **PASO 2**, edita `TU_CORREO@ejemplo.com`, descomenta y ejecuta **2.2** y **2.3**; luego **2.4** (debe salir tu fila con `role=admin`, `approved=true`).
   *Importante:* hazlo **antes** de subir el nuevo `index.html`; si no, tus usuarios actuales verán la pantalla «Acceso por invitación» hasta que los apruebes.
3. Copia los archivos a tu carpeta (reemplaza `index.html` y `sw.js`; añade los nuevos). Abre `http://localhost:5500` con `iniciar-web.bat` y haz **Ctrl+F5** (para que se actualice el service worker v10).
4. (Pendiente de la tanda anterior, si no lo hiciste) para actualizaciones de canciones en vivo:
   `alter publication supabase_realtime add table public.songs;`
5. Haz las **pruebas de la sección 3**.
6. Cuando todo esté bien, descomenta y ejecuta el **PASO 3**.
7. Completa `privacidad.html` con tus datos y súbela junto a la app.

---

## 3. Cómo comprobar cada función

**Acceso por invitación**
1. Entra como administrador → pestaña **Admin → Invitaciones** → escribe un correo → *Invitar*.
2. Con otro navegador/ventana privada, regístrate (o entra con Google) con ese **mismo correo confirmado** → debe entrar.
3. Entra con un correo **no invitado** → debe aparecer «Acceso por invitación» y ninguna canción.
4. Tras el Paso 3: con ese usuario no invitado, en el SQL Editor no hace falta nada; en la app no debe cargar canciones ni audio.

**Panel de administración** (solo se ve la pestaña **Admin** si eres administrador)
- *Usuarios:* buscar, dar/quitar acceso, bloquear, hacer/quitar admin (pide confirmación; no puedes quitarte tu propio acceso).
- Comprueba que un usuario normal no lo ve ni abriendo `#/admin/live` a mano (vuelve a Inicio).

**Usuarios en vivo**
1. La primera vez cada usuario ve un aviso de **consentimiento**. Acepta con 2 usuarios/dispositivos.
2. En **Admin → Usuarios en vivo** verás: conectados, activos, escuchando, navegando, mapa, por país, por dispositivo, entradas hoy/7/30 días y la lista con última actividad. Se actualiza solo (Realtime + consulta cada 5 s).
3. Cierra una pestaña: desaparece en segundos (aviso de salida) y, como máximo, en ~70 s si el navegador murió sin avisar.
4. Pon música en un dispositivo: pasa de «Navegando» a «Escuchando».

Definiciones: **Conectado** = app abierta (latido <70 s). **Activo** = interactuó en los últimos 2 min. **Escuchando** = reproduciendo audio.

**Estadísticas por país y reproducciones**
- **Admin → Estadísticas**: mapa (visitantes o reproducciones), países, canciones más escuchadas con su número. Una reproducción cuenta tras **20 s** de escucha, con límites anti-abuso.

**Seguridad (compruébalo tú en el SQL Editor / consola)**
- Como usuario normal, `select * from presence;` debe devolver 0 filas, y `select admin_live();` debe fallar con «No autorizado».
- La app solo usa la clave **publishable**; nunca pegues la *secret/service* en `config.js`.
- No se guarda IP, contraseña ni correo en `presence`, `visit_days` ni `plays`.

---

## 4. Publicidad de Google

**AdSense o AdMob:** tu app web/PWA usa **AdSense** (anuncios web). **AdMob** es para apps nativas; en tu app Android con WebView, Google solo permite anuncios web dentro de la WebView si se integra la API oficial de WebView de AdMob/AdSense. Por eso el interruptor «WebView» está **apagado por defecto**: actívalo solo cuando tu app Android esté configurada así y Google lo permita para tu cuenta. Revisa las políticas vigentes en la ayuda de AdSense y en la documentación de AdMob antes de activarlo.

**Cómo está hecho:** recuadro «Publicidad» con espacio reservado dentro de la página (no flotante), nunca sobre el reproductor/menús/navegación, sin ventanas emergentes, sin autorrecarga, sin sonido automático, y no toca el audio. Si no hay anuncio, el espacio se oculta. Solo en Inicio, Biblioteca, Favoritos y Listas (nunca en Perfil ni Admin). No se piden anuncios desde `localhost`.

**Para activarlos:**
1. Ten cuenta de **AdSense aprobada** para tu dominio (no sirve `localhost`).
2. Publica el archivo **`ads.txt`** en la raíz de tu dominio (AdSense te da la línea).
3. En AdSense crea 2 bloques de anuncios (banner superior y biblioteca) y copia sus IDs numéricos y tu ID `ca-pub-…`.
4. En **Admin → Publicidad** pega los IDs, activa los interruptores y guarda. Los usuarios lo reciben al recargar o en ≤10 min.
5. En AdSense → **Privacidad y mensajes** configura el mensaje de consentimiento (obligatorio para Espacio Económico Europeo, Reino Unido y Suiza).

**Riesgos que debes conocer (sin dramatizar):**
- AdSense **prohíbe monetizar contenido protegido por derechos de autor sin licencia**. Si la música de tu biblioteca no es tuya o no tienes licencia, Google puede cerrar tu cuenta de anuncios.
- Contenido detrás de inicio de sesión: Google puede no poder revisarlo y limitar los anuncios.
- Usuarios con bloqueadores de anuncios simplemente no verán el espacio.

---

## 5. Qué se probó y qué NO

**Probado (63 comprobaciones automáticas en un navegador Chromium real, con un Supabase *simulado*):** pantalla de invitación, entrada tras invitación, app sin el SQL instalado, aviso de consentimiento, latidos (sin IP), estado escuchando, registro de reproducción a los 20 s, aviso de salida al cerrar/cerrar sesión, panel (en vivo con actualización automática, estadísticas, usuarios, invitaciones, publicidad con validaciones), usuario normal sin acceso al panel, publicidad (visible/oculta, no pausa la música, sin solaparse con el reproductor, WebView, sin relleno, localhost), y regresión básica (Inicio, Biblioteca, Favoritos, Listas, Perfil, reproducir, tema, siguiente). Los datos de esas pruebas eran ficticios y **no se usaron en producción**.

**NO probado (no tuve acceso):** tu Supabase real (RLS, funciones SQL y Realtime reales), Google/AdSense reales, el servicio de país de Cloudflare real, una app Android WebView real ni iPhone. Por eso las pruebas de la sección 3 son importantes: son la verificación real.

**Limitaciones honestas:** el país es aproximado y puede falsearse (vale para estadísticas, no para seguridad); sin consentimiento un usuario no aparece en las estadísticas.
