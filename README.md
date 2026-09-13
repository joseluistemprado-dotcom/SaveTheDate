# Bodas de Plata — Vanessa & Raúl

Invitación digital personal con confirmaciones persistentes y un panel privado de organización. Está creada como una aplicación Node.js completa, no como un sitio estático: **GitHub Pages no puede alojar la base de datos, la autenticación ni el envío de correo**, por lo que debe desplegarse íntegramente en un servicio con Node.js (por ejemplo Render, Railway o Fly.io) y con un volumen persistente para `data/`.

## Tecnología y estructura

- **Node.js + Express**: interfaz pública, API, sesión privada y cabeceras de seguridad.
- **SQLite (`better-sqlite3`)**: base de datos persistente local en `data/save-the-date.sqlite` (tablas `guests`, `responses`, `admin_users`).
- **Nodemailer**: aviso de correo por SMTP, configurado exclusivamente por variables de entorno.
- `public/index.html`: invitación pública y formulario.
- `public/admin.html`: acceso, resumen, filtros, importación CSV y exportación.
- `public/images/`: ubicación preparada para las dos fotografías.

## Ejecutar localmente

1. Instala Node.js 20 o superior.
2. Ejecuta `npm install`.
3. Copia `.env.example` como `.env` y completa al menos `SESSION_SECRET`, `ADMIN_USERNAME` y `ADMIN_PASSWORD`.
4. Inicia la aplicación con `npm run dev` y abre `http://localhost:3000`. Al primer inicio, el administrador se crea automáticamente a partir de esas dos variables. El comando `npm run create-admin` continúa disponible para cambiarlo manualmente más adelante.

La web pública está en `/` y el panel protegido, en `/admin`.

## Variables de entorno

| Variable | Uso |
| --- | --- |
| `PORT` | Puerto HTTP (por defecto, 3000). |
| `SESSION_SECRET` | Cadena larga, aleatoria y secreta para firmar las sesiones. |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Se usan **solo** al ejecutar `npm run create-admin`; la contraseña se guarda con hash bcrypt. |
| `ADMIN_EMAIL` | Destinatario del resumen de asistencia. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` | Credenciales SMTP del proveedor de correo. |
| `SMTP_FROM` | Remitente opcional, por ejemplo `Bodas de Plata <hola@dominio.es>`. |
| `NODE_ENV=production` | Activa cookies de sesión seguras en producción HTTPS. |

Si no se configura SMTP, las confirmaciones se siguen guardando correctamente; simplemente no se envían avisos por correo.

## Base de datos e invitados

SQLite se crea automáticamente al iniciar el servidor. Para que los pendientes sean reales, accede a `/admin`, inicia sesión e importa un CSV con la cabecera exacta `nombre,apellidos`. Cada invitado importado aparece como pendiente hasta que haya una respuesta con el mismo nombre y apellidos (la comparación no distingue mayúsculas/minúsculas). El panel permite filtrar, buscar, ordenar, copiar pendientes, imprimir y descargar el CSV de respuestas.

En producción, monta un disco/volumen persistente en el directorio `data/`; sin él, el proveedor puede eliminar las confirmaciones al reiniciar. Para despliegues con varios procesos o sin almacenamiento persistente, sustituye SQLite por una base de datos gestionada antes de escalar.

## Despliegue público

1. Sube este repositorio a GitHub.
2. En Render, crea un **Blueprint** desde el repositorio: el archivo `render.yaml` incluido crea el servicio, el disco persistente, el health check y genera automáticamente `SESSION_SECRET`.
3. Render solicitará los valores secretos marcados como manuales: define `ADMIN_USERNAME`, `ADMIN_PASSWORD` y, si quieres avisos de correo, las variables `ADMIN_EMAIL` y `SMTP_*`.
4. Publica con HTTPS y visita la URL asignada; el enlace de invitados será la raíz del dominio (o el subpath que configure el proveedor). El nombre propuesto produce una URL similar a `https://bodas-de-plata-vanessa-raul.onrender.com` si está disponible.

> El despliegue se puede dejar totalmente definido en este repositorio, como ahora, pero crear una URL pública requiere autorizar el acceso a una cuenta de Render y a un repositorio GitHub. Nunca debemos crear ni usar esas cuentas, ni recibir sus contraseñas, desde el código.

## Fotografías

No hay fotografías inventadas. Cuando se reciban, añade `vanessa-raul-1.jpg` y `vanessa-raul-2.jpg` a `public/images/` y sigue la nota de `public/images/README.md` para reemplazar los dos placeholders de `public/index.html`.

## Seguridad incluida

El formulario valida y limita los datos en servidor, usa honeypot y rate limit contra envíos automatizados; las consultas de panel requieren una sesión con contraseña bcrypt; las cookies son `httpOnly` y los secretos nunca se entregan al navegador. Antes de publicar, usa un `SESSION_SECRET` único y robusto, credenciales SMTP reales y HTTPS.
