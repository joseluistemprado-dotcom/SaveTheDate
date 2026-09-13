# Bodas de Plata — Vanessa & Raúl

Invitación digital personal con confirmaciones persistentes y panel privado de organización. Esta versión se publica gratuitamente con **Cloudflare Pages/Workers + D1**: GitHub guarda el proyecto, Cloudflare sirve la página y D1 conserva las confirmaciones.

## Publicar gratis en Cloudflare

No se usa Render, SMTP ni servidor de pago. El despliegue requiere una cuenta gratuita de Cloudflare conectada con GitHub.

1. En el panel de Cloudflare, abre **Workers & Pages** → **D1 SQL Database** → **Create** y crea la base de datos con el nombre `bodas-de-plata`.
2. Copia el **Database ID** que muestra Cloudflare.
3. En GitHub, edita `wrangler.jsonc`: sustituye `REPLACE_WITH_YOUR_D1_DATABASE_ID` por ese identificador. Es el único dato de infraestructura que no puede conocerse antes de crear la cuenta/base de datos.
4. Guarda y sube el cambio a la rama `main`.
5. En Cloudflare, abre **Workers & Pages** → **Create** → **Import a repository**, elige el repositorio y confirma el despliegue. Cloudflare detectará `wrangler.jsonc`, el Worker y la carpeta `public`.
6. En el proyecto recién creado, abre **Settings** → **Variables and Secrets** y crea estos secretos de producción:

   ```text
   ADMIN_USERNAME=el-usuario-privado-que-elijas
   ADMIN_PASSWORD=una-contrasena-larga-y-unica
   ```

7. Pulsa **Deploy**. La primera petición crea las tablas y el usuario administrador. La URL pública se verá como `https://bodas-de-plata-vanessa-raul.<tu-cuenta>.workers.dev` o la URL `pages.dev` que Cloudflare asigne.

Comparte únicamente la URL principal con los invitados. El panel privado está en `/admin`.

> Cloudflare solo puede crear el proyecto, la base de datos y los secretos después de que su propietario autorice la cuenta. Nunca guardes estas contraseñas en GitHub ni las compartas en mensajes.

## Cómo funciona

- `src/worker.js`: API segura, autenticación, datos persistentes en D1 y archivos públicos.
- `public/index.html`: invitación y confirmación pública.
- `public/admin.html`: panel con resumen, filtros, pendientes, importación CSV, exportación e impresión.
- `wrangler.jsonc`: configuración de Cloudflare, assets y vínculo a D1.

Las tablas `guests`, `responses`, `admin_users` y `sessions` se crean automáticamente. El primer usuario administrador se genera con PBKDF2 y la sesión usa una cookie `HttpOnly`, `Secure` y `SameSite=Strict`.

## Ejecutar localmente

1. Instala Node.js 20 o superior y ejecuta `npm install`.
2. Crea una base D1 local con `npx wrangler d1 create bodas-de-plata --local` (o deja que la aplicación cree las tablas al abrirla).
3. Crea `.dev.vars` —no se publica en GitHub— con `ADMIN_USERNAME` y `ADMIN_PASSWORD`.
4. Ejecuta `npm run dev` y abre la URL local indicada por Wrangler.

## Fotos

Al recibirlas, añade `vanessa-raul-1.jpg` y `vanessa-raul-2.jpg` en `public/images/` y sigue `public/images/README.md` para reemplazar los placeholders.
