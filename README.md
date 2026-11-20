# Agenda Digital

Agenda por día (nota libre + actividades con hora), sincronizada con Google Drive y con avisos por Telegram.

- **Frontend:** PWA estática en GitHub Pages (celular y PC). Funciona sin conexión; sube los cambios cuando vuelve la red.
- **Backend:** Google Apps Script en tu cuenta Google. Guarda en `Drive/AgendaDigital/agenda.json`, backup diario en `AgendaDigital/backups` (últimos 14).
- **Sincronización:** al editar (1,2 s), cada 60 s con la app abierta, al volver a la app y al recuperar conexión. Fusión por ítem: gana la edición más reciente.
- **Avisos:** trigger cada 1 min. Aviso por ítem (a la hora, 5/10/15/30 min, 1 h, 2 h, 1 día antes) + resumen diario (06:00 por defecto). Zona horaria: `America/Asuncion`.

## 1. Bot de Telegram

1. En Telegram abrí **@BotFather** → `/newbot` → nombre y usuario (debe terminar en `bot`).
2. Copiá el **token** (`123456789:AA...`).
3. Abrí tu bot nuevo y enviale `hola` (necesario para obtener tu chat ID).

## 2. Backend (Google Apps Script)

1. Entrá a <https://script.google.com> con tu cuenta Google → **Nuevo proyecto** → nombre: `Agenda Digital`.
2. Borrá el contenido de `Código.gs` y pegá todo `apps-script/Codigo.gs`.
3. En la función `configurar()`, reemplazá `PEGAR_AQUI_TOKEN_DE_BOTFATHER` por tu token. Opcional: cambiá `HORA_RESUMEN` (`'HH:MM'` o `'off'`).
4. Guardá (Ctrl+S). Seleccioná `configurar` en el desplegable y **Ejecutar**. Autorizá los permisos (Drive, servicios externos, triggers).
   - Aviso "Google no verificó esta app": **Configuración avanzada → Ir a Agenda Digital (no seguro)**. Es tu propio script.
5. Te llega "✅ Agenda Digital conectada" por Telegram. En **Registro de ejecución** copiá la `CLAVE_API`.
6. Volvé a poner `PEGAR_AQUI_TOKEN_DE_BOTFATHER` en el código y guardá (el token ya quedó guardado en las propiedades del script).
7. **Implementar → Nueva implementación** → tipo **Aplicación web**:
   - Ejecutar como: **Yo**
   - Quién tiene acceso: **Cualquier usuario**
   - **Implementar** → copiá la **URL** que termina en `/exec`.

> "Cualquier usuario" es necesario para que la app llame al script sin login de Google. Toda petición sin la `CLAVE_API` correcta se rechaza.

## 3. Frontend (GitHub Pages)

1. GitHub → **New repository** → nombre `agenda-digital`, **Public** → Create.
2. **Add file → Upload files** → subí todo el contenido de esta carpeta (incluida `icons/`; `apps-script/` es opcional) → Commit.
3. **Settings → Pages** → Source: **Deploy from a branch** → Branch `main`, carpeta `/ (root)` → Save.
4. En 1–2 min queda en `https://TU_USUARIO.github.io/agenda-digital/`.

## 4. Conectar cada dispositivo (celular y PC del trabajo)

1. Abrí la URL de GitHub Pages → **⚙** → pegá la URL `/exec` y la `CLAVE_API`.
2. **Probar conexión** → **Enviar prueba a Telegram** → **Guardar**.
3. Celular (Chrome Android): menú ⋮ → **Agregar a pantalla principal** / **Instalar app**.

## Uso

- `‹` `›` o deslizar horizontal: cambiar de día. Tocar la fecha: calendario del mes (punto = día con contenido).
- Barra inferior: hora (opcional) + texto + aviso (requiere hora) → `＋`.
- Tocar una actividad: editar, cambiar hora/aviso, **mover a otra fecha**, marcar hecho, eliminar.
- Marcar hecho antes del aviso lo cancela.
- Estado arriba a la derecha: `✓ Drive hh:mm` sincronizado · `● pendiente` · `⚠ error`.

## Mantenimiento

- **Cambios en `Codigo.gs`:** Implementar → **Gestionar implementaciones** → ✏️ → Versión: **Nueva versión** → Implementar. Así la URL `/exec` no cambia.
- **Clave perdida:** ejecutá `verClave()`. **Clave comprometida:** `regenerarClave()` y actualizala en cada dispositivo.
- **Cambiar hora del resumen:** editá `HORA_RESUMEN` en `configurar()` y ejecutala de nuevo (no duplica nada).
- **Cambios en el frontend:** subí los archivos al repo; la app toma la versión nueva al recargar con conexión.
- **Restaurar backup:** copiá el contenido de `backups/agenda-AAAA-MM-DD.json` en `agenda.json`, y en cada dispositivo ⚙ → **Descargar todo desde Drive**.

## Límites conocidos

- Precisión de avisos: ±1 min (trigger de Apps Script). Si un aviso no pudo enviarse, se reintenta hasta 15 min después; luego se descarta.
- Cuotas Apps Script (cuenta gratuita): 90 min/día de ejecución de triggers. El trigger de 1 min usa una fracción (no lee Drive en cada ejecución).
- Dos dispositivos editando **el mismo ítem** sin conexión: queda la edición con hora más reciente.
- Ítems eliminados se purgan del servidor a los 30 días.
