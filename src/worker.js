const encoder = new TextEncoder();
const PBKDF2_ITERATIONS = 100000;

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...extra
    }
  });

const clean = (value, max = 120) =>
  String(value || '').trim().replace(/[<>]/g, '').slice(0, max);

const now = () => new Date().toISOString();

const hash = async value =>
  [...new Uint8Array(
    await crypto.subtle.digest('SHA-256', encoder.encode(value))
  )]
    .map(x => x.toString(16).padStart(2, '0'))
    .join('');

const passwordHash = async password => {
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    key,
    256
  );

  return (
    [...salt].map(x => x.toString(16).padStart(2, '0')).join('') +
    ':' +
    [...new Uint8Array(bits)]
      .map(x => x.toString(16).padStart(2, '0'))
      .join('')
  );
};

const verifyPassword = async (password, stored) => {
  const parts = String(stored || '').split(':');
  const saltHex = parts[0];
  const expected = parts[1];

  if (!saltHex || !expected) return false;

  const salt = Uint8Array.from(
    saltHex.match(/.{1,2}/g).map(x => parseInt(x, 16))
  );

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    key,
    256
  );

  const actual = [...new Uint8Array(bits)]
    .map(x => x.toString(16).padStart(2, '0'))
    .join('');

  return actual === expected;
};

const photoTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp'
]);

const unauthorized = () =>
  json({ error: 'Acceso no autorizado.' }, 401);

const publicPhoto = photo => ({
  id: photo.id,
  guest_name: photo.guest_name,
  message: photo.message,
  created_at: photo.created_at,
  url: '/api/album/photos/' + photo.id
});

async function schema(env) {
  await env.DB.exec(
    'CREATE TABLE IF NOT EXISTS guests (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      'first_name TEXT NOT NULL,' +
      'last_name TEXT NOT NULL,' +
      'created_at TEXT NOT NULL' +
    ');' +

    'CREATE TABLE IF NOT EXISTS responses (' +
      'id TEXT PRIMARY KEY,' +
      'guest_id INTEGER UNIQUE NOT NULL,' +
      'attending INTEGER NOT NULL,' +
      'attendees INTEGER NOT NULL DEFAULT 0,' +
      'comments TEXT,' +
      'created_at TEXT NOT NULL' +
    ');' +

    'CREATE TABLE IF NOT EXISTS admin_users (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      'username TEXT UNIQUE NOT NULL,' +
      'password_hash TEXT NOT NULL,' +
      'created_at TEXT NOT NULL' +
    ');' +

    'CREATE TABLE IF NOT EXISTS sessions (' +
      'token_hash TEXT PRIMARY KEY,' +
      'admin_id INTEGER NOT NULL,' +
      'expires_at TEXT NOT NULL' +
    ');' +

    'CREATE TABLE IF NOT EXISTS settings (' +
      'key TEXT PRIMARY KEY,' +
      'value TEXT NOT NULL' +
    ');' +

    'CREATE TABLE IF NOT EXISTS album_photos (' +
      'id TEXT PRIMARY KEY,' +
      'guest_name TEXT NOT NULL,' +
      'message TEXT,' +
      'filename TEXT NOT NULL,' +
      'content_type TEXT NOT NULL,' +
      'image BLOB NOT NULL,' +
      'status TEXT NOT NULL DEFAULT "pending" ' +
        'CHECK(status IN ("pending","approved","rejected")),' +
      'created_at TEXT NOT NULL,' +
      'reviewed_at TEXT' +
    ');'
  );

  const username = clean(env.ADMIN_USERNAME, 80);
  const password = String(env.ADMIN_PASSWORD || '');

  if (!username || !password) return;

  const fingerprint = await hash(username + '\0' + password);

  const saved = await env.DB
    .prepare("SELECT value FROM settings WHERE key='admin_credentials'")
    .first();

  if (saved && saved.value === fingerprint) return;

  const account = await env.DB
    .prepare('SELECT id FROM admin_users WHERE username=?')
    .bind(username)
    .first();

  const credentials = await passwordHash(password);

  if (account) {
    await env.DB
      .prepare(
        'UPDATE admin_users SET password_hash=? WHERE id=?'
      )
      .bind(credentials, account.id)
      .run();
  } else {
    const existing = await env.DB
      .prepare('SELECT id FROM admin_users LIMIT 1')
      .first();

    if (existing) {
      await env.DB
        .prepare(
          'UPDATE admin_users SET username=?,password_hash=? WHERE id=?'
        )
        .bind(username, credentials, existing.id)
        .run();
    } else {
      await env.DB
        .prepare(
          'INSERT INTO admin_users(username,password_hash,created_at) VALUES (?,?,?)'
        )
        .bind(username, credentials, now())
        .run();
    }
  }

  await env.DB
    .prepare(
      "INSERT INTO settings(key,value) VALUES ('admin_credentials',?) " +
      'ON CONFLICT(key) DO UPDATE SET value=excluded.value'
    )
    .bind(fingerprint)
    .run();
}

async function stats(env) {
  return env.DB
    .prepare(
      'SELECT ' +
      '(SELECT count(*) FROM guests) total,' +
      '(SELECT count(*) FROM responses WHERE attending=1) confirmed,' +
      '(SELECT count(*) FROM responses WHERE attending=0) declined,' +
      '(SELECT count(*) FROM guests g WHERE NOT EXISTS (' +
        'SELECT 1 FROM responses r WHERE r.guest_id=g.id' +
      ')) pending,' +
      '(SELECT coalesce(sum(attendees),0) FROM responses WHERE attending=1) people'
    )
    .first();
}

async function albumStats(env) {
  return env.DB
    .prepare(
      'SELECT ' +
      '(SELECT count(*) FROM album_photos) total,' +
      '(SELECT count(*) FROM album_photos WHERE status="pending") pending,' +
      '(SELECT count(*) FROM album_photos WHERE status="approved") approved,' +
      '(SELECT count(*) FROM album_photos WHERE status="rejected") rejected'
    )
    .first();
}

async function rows(env, status = 'all', search = '', order = 'date') {
  let where = '';
  const args = [];

  if (status === 'confirmed') {
    where = ' WHERE r.attending=1';
  }

  if (status === 'declined') {
    where = ' WHERE r.attending=0';
  }

  if (status === 'pending') {
    where = ' WHERE r.id IS NULL';
  }

  if (search) {
    where +=
      (where ? ' AND' : ' WHERE') +
      ' lower(g.first_name || " " || g.last_name) LIKE ?';

    args.push('%' + search.toLowerCase() + '%');
  }

  const ordering =
    order === 'name'
      ? 'g.last_name,g.first_name'
      : 'r.created_at DESC';

  const result = await env.DB
    .prepare(
      'SELECT ' +
      'g.id guest_id,' +
      'g.first_name,' +
      'g.last_name,' +
      'r.id response_id,' +
      'r.attending,' +
      'r.attendees,' +
      'r.comments,' +
      'r.created_at ' +
      'FROM guests g ' +
      'LEFT JOIN responses r ON r.guest_id=g.id' +
      where +
      ' ORDER BY ' +
      ordering
    )
    .bind(...args)
    .all();

  return result.results;
}

function token(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|; )rsvp_admin=([^;]+)/);
  return match ? match[1] : null;
}

async function admin(request, env) {
  const value = token(request);

  if (!value) return false;

  const row = await env.DB
    .prepare(
      'SELECT admin_id FROM sessions ' +
      'WHERE token_hash=? AND expires_at>?'
    )
    .bind(await hash(value), now())
    .first();

  return !!row;
}

async function albumImageResponse(request, env, id) {
  const photo = await env.DB
    .prepare(
      'SELECT id,filename,content_type,image,status ' +
      'FROM album_photos WHERE id=?'
    )
    .bind(id)
    .first();

  if (!photo) {
    return json({ error: 'Imagen no encontrada.' }, 404);
  }

  if (
    photo.status !== 'approved' &&
    !(await admin(request, env))
  ) {
    return unauthorized();
  }

  const image =
    photo.image instanceof ArrayBuffer ||
    photo.image instanceof Uint8Array
      ? photo.image
      : new Uint8Array(photo.image || []);

  return new Response(image, {
    headers: {
      'content-type': photo.content_type,
      'cache-control': 'no-store',
      'content-disposition':
        'inline; filename="' +
        String(photo.filename || 'recuerdo.jpg').replaceAll('"', '') +
        '"'
    }
  });
}

async function uploadAlbumPhotos(request, env) {
  const form = await request.formData().catch(() => null);

  if (!form) {
    return json(
      { error: 'No se han podido leer las imágenes.' },
      400
    );
  }

  const name = clean(form.get('name'), 100);
  const message = clean(form.get('message'), 280);
  const website = clean(form.get('website'), 20);

  if (website) {
    return json(
      { error: 'No se han podido enviar las imágenes.' },
      400
    );
  }

  const files = form
    .getAll('photos')
    .filter(file => file && typeof file === 'object' && file.size > 0);

  if (!name || !files.length) {
    return json(
      {
        error:
          'Indica tu nombre y adjunta al menos una imagen.'
      },
      400
    );
  }

  if (files.length > 6) {
    return json(
      {
        error:
          'Puedes enviar hasta 6 imágenes cada vez.'
      },
      400
    );
  }

  for (const file of files) {
    if (!photoTypes.has(file.type)) {
      return json(
        {
          error:
            'Solo se aceptan imágenes JPG, PNG o WEBP.'
        },
        400
      );
    }

    if (file.size > 1800000) {
      return json(
        {
          error:
            'Cada imagen debe pesar menos de 1,8 MB.'
        },
        400
      );
    }
  }

  for (const file of files) {
    const id = crypto.randomUUID();

    const filename =
      clean(file.name, 140) || 'recuerdo.jpg';

    await env.DB
      .prepare(
        'INSERT INTO album_photos(' +
        'id,guest_name,message,filename,content_type,image,status,created_at' +
        ') VALUES (?,?,?,?,?,?,?,?)'
      )
      .bind(
        id,
        name,
        message || null,
        filename,
        file.type,
        await file.arrayBuffer(),
        'pending',
        now()
      )
      .run();
  }

  return json(
    { count: files.length },
    201
  );
}

async function api(request, env, url) {
  await schema(env);

  const path = url.pathname;

  if (
    path === '/api/respond' &&
    request.method === 'POST'
  ) {
    const body = await request.json().catch(() => ({}));

    if (body.website) {
      return json(
        {
          error:
            'No ha sido posible enviar la confirmación.'
        },
        400
      );
    }

    const first = clean(body.firstName, 60);
    const last = clean(body.lastName, 100);
    const note = clean(body.comments, 700);
    const yes =
      body.attending === true ||
      body.attending === 'yes';
    const count = Number(body.attendees);

    if (
      !first ||
      !last ||
      typeof body.attending === 'undefined' ||
      (
        yes &&
        (
          !Number.isInteger(count) ||
          count < 1 ||
          count > 20
        )
      )
    ) {
      return json(
        {
          error:
            'Revisa los campos indicados antes de enviar.'
        },
        400
      );
    }

    let guest = await env.DB
      .prepare(
        'SELECT id FROM guests ' +
        'WHERE lower(first_name)=lower(?) ' +
        'AND lower(last_name)=lower(?)'
      )
      .bind(first, last)
      .first();

    if (!guest) {
      const result = await env.DB
        .prepare(
          'INSERT INTO guests(first_name,last_name,created_at) ' +
          'VALUES (?,?,?)'
        )
        .bind(first, last, now())
        .run();

      guest = {
        id: result.meta.last_row_id
      };
    }

    const id = crypto.randomUUID();

    await env.DB
      .prepare(
        'INSERT INTO responses(' +
        'id,guest_id,attending,attendees,comments,created_at' +
        ') VALUES (?,?,?,?,?,?) ' +
        'ON CONFLICT(guest_id) DO UPDATE SET ' +
        'id=excluded.id,' +
        'attending=excluded.attending,' +
        'attendees=excluded.attendees,' +
        'comments=excluded.comments,' +
        'created_at=excluded.created_at'
      )
      .bind(
        id,
        guest.id,
        yes ? 1 : 0,
        yes ? count : 0,
        note || null,
        now()
      )
      .run();

    return json(
      {
        id,
        attending: yes
      },
      201
    );
  }

  if (
    path === '/api/album' &&
    request.method === 'GET'
  ) {
    const photos = (
      await env.DB
        .prepare(
          'SELECT id,guest_name,message,created_at ' +
          'FROM album_photos ' +
          'WHERE status="approved" ' +
          'ORDER BY created_at DESC'
        )
        .all()
    ).results;

    return json({
      photos: photos.map(publicPhoto)
    });
  }

  if (
    path === '/api/album/photos' &&
    request.method === 'POST'
  ) {
    return uploadAlbumPhotos(request, env);
  }

  const photoMatch =
    path.match(
      /^\/api\/album\/photos\/([0-9a-f-]{36})$/
    );

  if (
    photoMatch &&
    request.method === 'GET'
  ) {
    return albumImageResponse(
      request,
      env,
      photoMatch[1]
    );
  }

  if (
    path === '/api/admin/login' &&
    request.method === 'POST'
  ) {
    const body = await request.json().catch(() => ({}));
    const user = clean(body.username, 80);

    const record = await env.DB
      .prepare(
        'SELECT * FROM admin_users WHERE username=?'
      )
      .bind(user)
      .first();

    if (
      !record ||
      !(await verifyPassword(
        String(body.password || ''),
        record.password_hash
      ))
    ) {
      return json(
        {
          error:
            'Usuario o contraseña incorrectos.'
        },
        401
      );
    }

    const value =
      crypto.randomUUID() +
      crypto.randomUUID();

    const expiry =
      new Date(
        Date.now() + 8 * 3600000
      ).toISOString();

    await env.DB
      .prepare(
        'INSERT INTO sessions(' +
        'token_hash,admin_id,expires_at' +
        ') VALUES (?,?,?)'
      )
      .bind(
        await hash(value),
        record.id,
        expiry
      )
      .run();

    return json(
      { ok: true },
      200,
      {
        'Set-Cookie':
          'rsvp_admin=' +
          value +
          '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800'
      }
    );
  }

  if (
    path === '/api/admin/logout' &&
    request.method === 'POST'
  ) {
    const value = token(request);

    if (value) {
      await env.DB
        .prepare(
          'DELETE FROM sessions WHERE token_hash=?'
        )
        .bind(await hash(value))
        .run();
    }

    return json(
      { ok: true },
      200,
      {
        'Set-Cookie':
          'rsvp_admin=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'
      }
    );
  }

  if (path === '/api/admin/me') {
    return json({
      authenticated:
        await admin(request, env)
    });
  }

  if (!(await admin(request, env))) {
    return unauthorized();
  }

  if (
    path === '/api/admin/dashboard'
  ) {
    return json({
      stats: await stats(env),
      album: await albumStats(env),
      pending:
        (
          await rows(env, 'pending')
        ).slice(0, 10),
      recent:
        (
          await env.DB
            .prepare(
              'SELECT g.first_name,g.last_name,' +
              'r.attending,r.attendees,r.created_at ' +
              'FROM responses r ' +
              'JOIN guests g ON r.guest_id=g.id ' +
              'ORDER BY r.created_at DESC LIMIT 8'
            )
            .all()
        ).results
    });
  }

  if (
    path === '/api/admin/guests'
  ) {
    return json({
      stats: await stats(env),
      rows: await rows(
        env,
        url.searchParams.get('status') || 'all',
        clean(
          url.searchParams.get('search'),
          100
        ),
        url.searchParams.get('order') || 'date'
      )
    });
  }

  if (
    path === '/api/admin/album'
  ) {
    const status =
      url.searchParams.get('status') ||
      'all';

    const args = [];
    let where = '';

    if (
      ['pending', 'approved', 'rejected']
        .includes(status)
    ) {
      where = ' WHERE status=?';
      args.push(status);
    }

    const photos = (
      await env.DB
        .prepare(
          'SELECT id,guest_name,message,filename,' +
          'content_type,status,created_at,reviewed_at ' +
          'FROM album_photos' +
          where +
          ' ORDER BY created_at DESC'
        )
        .bind(...args)
        .all()
    ).results;

    return json({
      stats: await albumStats(env),
      photos: photos.map(photo => ({
        ...photo,
        url:
          '/api/album/photos/' +
          photo.id
      }))
    });
  }

  const albumAction =
    path.match(
      /^\/api\/admin\/album\/([0-9a-f-]{36})\/(approve|reject)$/
    );

  if (
    albumAction &&
    request.method === 'POST'
  ) {
    const status =
      albumAction[2] === 'approve'
        ? 'approved'
        : 'rejected';

    await env.DB
      .prepare(
        'UPDATE album_photos ' +
        'SET status=?,reviewed_at=? ' +
        'WHERE id=?'
      )
      .bind(
        status,
        now(),
        albumAction[1]
      )
      .run();

    return json({ ok: true });
  }

  if (
    path === '/api/admin/import' &&
    request.method === 'POST'
  ) {
    const body =
      await request.json().catch(() => ({}));

    const csv =
      String(body.csv || '')
        .replace(/^\uFEFF/, '');

    const lines =
      csv
        .split(/\r?\n/)
        .filter(Boolean);

    if (!lines.length) {
      return json(
        { error: 'El CSV está vacío.' },
        400
      );
    }

    let count = 0;

    for (const line of lines.slice(1)) {
      const parts = line.split(',');
      const first = clean(parts.shift(), 60);
      const last = clean(parts.join(','), 100);

      if (first && last) {
        const exists = await env.DB
          .prepare(
            'SELECT id FROM guests ' +
            'WHERE lower(first_name)=lower(?) ' +
            'AND lower(last_name)=lower(?)'
          )
          .bind(first, last)
          .first();

        if (!exists) {
          await env.DB
            .prepare(
              'INSERT INTO guests(' +
              'first_name,last_name,created_at' +
              ') VALUES (?,?,?)'
            )
            .bind(
              first,
              last,
              now()
            )
            .run();

          count++;
        }
      }
    }

    return json({ count });
  }

  if (
    path === '/api/admin/export.csv'
  ) {
    const esc = value =>
      '"' +
      String(value ?? '')
        .replaceAll('"', '""') +
      '"';

    const data =
      (
        await rows(env)
      )
        .map(row =>
          [
            row.first_name,
            row.last_name,
            row.response_id
              ? row.attending
                ? 'Sí'
                : 'No'
              : 'Pendiente',
            row.attendees || '',
            row.comments || '',
            row.created_at || ''
          ]
            .map(esc)
            .join(',')
        );

    return new Response(
      '\uFEFFNombre,Apellidos,Asistencia,Número de asistentes,Comentarios,Fecha de respuesta\n' +
      data.join('\n'),
      {
        headers: {
          'content-type':
            'text/csv; charset=utf-8',
          'content-disposition':
            'attachment; filename="confirmaciones.csv"'
        }
      }
    );
  }

  return json(
    { error: 'No encontrado.' },
    404
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      return api(request, env, url);
    }

    const response =
      await env.ASSETS.fetch(request);

    const headers =
      new Headers(response.headers);

    headers.set(
      'X-Content-Type-Options',
      'nosniff'
    );

    headers.set(
      'Referrer-Policy',
      'same-origin'
    );

    return new Response(
      response.body,
      {
        status: response.status,
        headers
      }
    );
  }
};
