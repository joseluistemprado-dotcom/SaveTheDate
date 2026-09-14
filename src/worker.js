```js
const encoder = new TextEncoder();

const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...extra }
});

const clean = (value, max = 120) => String(value || '').trim().replace(/[<>]/g, '').slice(0, max);
const now = () => new Date().toISOString();

const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))]
  .map(x => x.toString(16).padStart(2, '0')).join('');

const PBKDF2_ITERATIONS = 100000;

const passwordHash = async password => {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, key, 256);
  return `${[...salt].map(x => x.toString(16).padStart(2, '0')).join('')}:${[...new Uint8Array(bits)].map(x => x.toString(16).padStart(2, '0')).join('')}`;
};

const verifyPassword = async (password, stored) => {
  if (!stored || typeof stored !== 'string') return false;
  const [saltHex, expected] = stored.split(':');
  if (!saltHex || !expected) return false;
  const saltParts = saltHex.match(/.{1,2}/g);
  if (!saltParts) return false;
  const salt = Uint8Array.from(saltParts.map(x => parseInt(x, 16)));
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, key, 256);
  const actual = [...new Uint8Array(bits)].map(x => x.toString(16).padStart(2, '0')).join('');
  return actual.length === expected.length && actual === expected;
};

async function schema(env) {
  if (!env.DB) throw new Error('La vinculación D1 "DB" no está configurada.');

  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS guests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS responses (
      id TEXT PRIMARY KEY,
      guest_id INTEGER UNIQUE NOT NULL,
      attending INTEGER NOT NULL,
      attendees INTEGER NOT NULL DEFAULT 0,
      comments TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      admin_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const username = clean(env.ADMIN_USERNAME, 80);
  const password = String(env.ADMIN_PASSWORD || '');
  if (!username || !password) return;

  const fingerprint = await hash(`${username}\0${password}`);
  const saved = await env.DB.prepare("SELECT value FROM settings WHERE key = 'admin_credentials'").first();
  if (saved?.value === fingerprint) return;

  const credentials = await passwordHash(password);
  const account = await env.DB.prepare('SELECT id FROM admin_users WHERE username = ?').bind(username).first();

  if (account) {
    await env.DB.prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').bind(credentials, account.id).run();
  } else {
    const existing = await env.DB.prepare('SELECT id FROM admin_users LIMIT 1').first();
    if (existing) {
      await env.DB.prepare('UPDATE admin_users SET username = ?, password_hash = ? WHERE id = ?').bind(username, credentials, existing.id).run();
    } else {
      await env.DB.prepare('INSERT INTO admin_users(username, password_hash, created_at) VALUES (?, ?, ?)').bind(username, credentials, now()).run();
    }
  }

  await env.DB.prepare(`
    INSERT INTO settings(key, value) VALUES ('admin_credentials', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).bind(fingerprint).run();
}

async function stats(env) {
  return env.DB.prepare(`
    SELECT
      (SELECT count(*) FROM guests) total,
      (SELECT count(*) FROM responses WHERE attending = 1) confirmed,
      (SELECT count(*) FROM responses WHERE attending = 0) declined,
      (SELECT count(*) FROM guests g WHERE NOT EXISTS (SELECT 1 FROM responses r WHERE r.guest_id = g.id)) pending,
      (SELECT coalesce(sum(attendees), 0) FROM responses WHERE attending = 1) people
  `).first();
}

async function rows(env, status = 'all', search = '', order = 'date') {
  let where = '';
  const args = [];

  if (status === 'confirmed') where = ' WHERE r.attending = 1';
  if (status === 'declined') where = ' WHERE r.attending = 0';
  if (status === 'pending') where = ' WHERE r.id IS NULL';

  if (search) {
    where += `${where ? ' AND' : ' WHERE'} lower(g.first_name || ' ' || g.last_name) LIKE ?`;
    args.push(`%${search.toLowerCase()}%`);
  }

  const ordering = order === 'name' ? 'g.last_name, g.first_name' : 'r.created_at DESC';

  return (await env.DB.prepare(`
    SELECT g.id guest_id, g.first_name, g.last_name, r.id response_id, r.attending, r.attendees, r.comments, r.created_at
    FROM guests g
    LEFT JOIN responses r ON r.guest_id = g.id
    ${where}
    ORDER BY ${ordering}
  `).bind(...args).all()).results;
}

function token(request) {
  const cookie = request.headers.get('Cookie') || '';
  return cookie.match(/(?:^|;\s*)rsvp_admin=([^;]+)/)?.[1];
}

async function admin(request, env) {
  const value = token(request);
  if (!value) return false;

  const row = await env.DB.prepare(`
    SELECT admin_id FROM sessions
    WHERE token_hash = ? AND expires_at > ?
  `).bind(await hash(value), now()).first();

  return !!row;
}

const unauthorized = () => json({ error: 'Acceso no autorizado.' }, 401);

async function api(request, env, url) {
  await schema(env);
  const path = url.pathname;

  if (path === '/api/respond' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    if (body.website) return json({ error: 'No ha sido posible enviar la confirmación.' }, 400);

    const first = clean(body.firstName, 60);
    const last = clean(body.lastName, 100);
    const note = clean(body.comments, 700);
    const yes = body.attending === true || body.attending === 'yes';
    const count = Number(body.attendees);

    if (!first || !last || typeof body.attending === 'undefined' || (yes && (!Number.isInteger(count) || count < 1 || count > 20))) {
      return json({ error: 'Revisa los campos indicados antes de enviar.' }, 400);
    }

    let guest = await env.DB.prepare(`
      SELECT id FROM guests
      WHERE lower(first_name) = lower(?) AND lower(last_name) = lower(?)
    `).bind(first, last).first();

    if (!guest) {
      const result = await env.DB.prepare(`
        INSERT INTO guests(first_name, last_name, created_at)
        VALUES (?, ?, ?)
      `).bind(first, last, now()).run();

      guest = { id: result.meta.last_row_id };
    }

    const id = crypto.randomUUID();

    await env.DB.prepare(`
      INSERT INTO responses(id, guest_id, attending, attendees, comments, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(guest_id) DO UPDATE SET
        id = excluded.id,
        attending = excluded.attending,
        attendees = excluded.attendees,
        comments = excluded.comments,
        created_at = excluded.created_at
    `).bind(id, guest.id, yes ? 1 : 0, yes ? count : 0, note || null, now()).run();

    return json({ id, attending: yes }, 201);
  }

  if (path === '/api/admin/login' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const user = clean(body.username, 80);
    const password = String(body.password || '');

    const record = await env.DB.prepare(`
      SELECT * FROM admin_users WHERE username = ?
    `).bind(user).first();

    if (!record || !(await verifyPassword(password, record.password_hash))) {
      return json({ error: 'Usuario o contraseña incorrectos.' }, 401);
    }

    const value = crypto.randomUUID() + crypto.randomUUID();
    const expiry = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();

    await env.DB.prepare(`
      INSERT INTO sessions(token_hash, admin_id, expires_at)
      VALUES (?, ?, ?)
    `).bind(await hash(value), record.id, expiry).run();

    return json({ ok: true }, 200, {
      'Set-Cookie': `rsvp_admin=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`
    });
  }

  if (path === '/api/admin/logout' && request.method === 'POST') {
    const value = token(request);

    if (value) {
      await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await hash(value)).run();
    }

    return json({ ok: true }, 200, {
      'Set-Cookie': 'rsvp_admin=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'
    });
  }

  if (path === '/api/admin/me') {
    return json({ authenticated: await admin(request, env) });
  }

  if (!(await admin(request, env))) return unauthorized();

  if (path === '/api/admin/dashboard') {
    const recent = await env.DB.prepare(`
      SELECT g.first_name, g.last_name, r.attending, r.attendees, r.created_at
      FROM responses r
      JOIN guests g ON r.guest_id = g.id
      ORDER BY r.created_at DESC
      LIMIT 8
    `).all();

    return json({
      stats: await stats(env),
      pending: (await rows(env, 'pending')).slice(0, 10),
      recent: recent.results
    });
  }

  if (path === '/api/admin/guests') {
    return json({
      stats: await stats(env),
      rows: await rows(
        env,
        url.searchParams.get('status') || 'all',
        clean(url.searchParams.get('search'), 100),
        url.searchParams.get('order') || 'date'
      )
    });
  }

  if (path === '/api/admin/import' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const csv = String(body.csv || '').replace(/^\uFEFF/, '');
    const lines = csv.split(/\r?\n/).filter(Boolean);

    if (!lines.length) return json({ error: 'El CSV está vacío.' }, 400);

    let count = 0;

    for (const line of lines.slice(1)) {
      const [f, ...rest] = line.split(',');
      const first = clean(f, 60);
      const last = clean(rest.join(','), 100);

      if (!first || !last) continue;

      const exists = await env.DB.prepare(`
        SELECT id FROM guests
        WHERE lower(first_name) = lower(?) AND lower(last_name) = lower(?)
      `).bind(first, last).first();

      if (!exists) {
        await env.DB.prepare(`
          INSERT INTO guests(first_name, last_name, created_at)
          VALUES (?, ?, ?)
        `).bind(first, last, now()).run();

        count++;
      }
    }

    return json({ count });
  }

  if (path === '/api/admin/export.csv') {
    const esc = value => `"${String(value ?? '').replaceAll('"', '""')}"`;

    const data = (await rows(env)).map(r => [
      r.first_name,
      r.last_name,
      r.response_id ? (r.attending ? 'Sí' : 'No') : 'Pendiente',
      r.attendees || '',
      r.comments || '',
      r.created_at || ''
    ].map(esc).join(','));

    return new Response(
      '\uFEFFNombre,Apellidos,Asistencia,Número de asistentes,Comentarios,Fecha de respuesta\n' + data.join('\n'),
      {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="confirmaciones.csv"'
        }
      }
    );
  }

  return json({ error: 'No encontrado.' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      try {
        return await api(request, env, url);
      } catch (error) {
        console.error('API error:', error);
        return json({ error: 'No se ha podido completar la acción.' }, 500);
      }
    }

    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);

    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'same-origin');

    return new Response(response.body, {
      status: response.status,
      headers
    });
  }
};
```
