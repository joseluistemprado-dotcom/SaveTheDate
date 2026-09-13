import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
const db = new Database(path.join(__dirname, 'data', 'save-the-date.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS guests (id INTEGER PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS responses (id TEXT PRIMARY KEY, guest_id INTEGER UNIQUE, first_name TEXT NOT NULL, last_name TEXT NOT NULL, attending INTEGER NOT NULL CHECK(attending IN (0,1)), attendees INTEGER NOT NULL DEFAULT 0, comments TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(guest_id) REFERENCES guests(id));
CREATE TABLE IF NOT EXISTS admin_users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);

const app = express();
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) throw new Error('SESSION_SECRET es obligatorio en producción.');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '30kb' }));
app.use(session({ secret: process.env.SESSION_SECRET || 'development-only-change-me', resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 8 } }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

const clean = (value, max = 120) => String(value || '').trim().replace(/[<>]/g, '').slice(0, max);
const adminOnly = (req, res, next) => req.session.admin ? next() : res.status(401).json({ error: 'Acceso no autorizado.' });
function stats() { return db.prepare(`SELECT (SELECT count(*) FROM guests) total, (SELECT count(*) FROM responses WHERE attending=1) confirmed, (SELECT count(*) FROM responses WHERE attending=0) declined, (SELECT count(*) FROM guests g WHERE NOT EXISTS(SELECT 1 FROM responses r WHERE r.guest_id=g.id)) pending, (SELECT coalesce(sum(attendees),0) FROM responses WHERE attending=1) people`).get(); }
function rows(status = 'all', search = '', order = 'date') {
  let where = '', args = [];
  if (status === 'confirmed') where = ' WHERE r.attending=1';
  if (status === 'declined') where = ' WHERE r.attending=0';
  if (status === 'pending') where = ' WHERE r.id IS NULL';
  if (search) { where += `${where ? ' AND' : ' WHERE'} lower(g.first_name || ' ' || g.last_name) LIKE ?`; args.push(`%${search.toLowerCase()}%`); }
  const ordering = order === 'name' ? 'g.last_name, g.first_name' : 'r.created_at DESC';
  return db.prepare(`SELECT g.id guest_id,g.first_name,g.last_name,r.id response_id,r.attending,r.attendees,r.comments,r.created_at FROM guests g LEFT JOIN responses r ON r.guest_id=g.id${where} ORDER BY ${ordering}`).all(...args);
}

app.post('/api/respond', rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false }), async (req, res) => {
  const { firstName, lastName, attending, attendees, comments, website } = req.body || {};
  if (website) return res.status(400).json({ error: 'No ha sido posible enviar la confirmación.' });
  const first = clean(firstName, 60), last = clean(lastName, 100), note = clean(comments, 700);
  const yes = attending === true || attending === 'yes'; const number = Number(attendees);
  if (!first || !last || typeof attending === 'undefined' || (yes && (!Number.isInteger(number) || number < 1 || number > 20))) return res.status(400).json({ error: 'Revisa los campos indicados antes de enviar.' });
  let guest = db.prepare('SELECT * FROM guests WHERE lower(first_name)=lower(?) AND lower(last_name)=lower(?)').get(first, last);
  if (!guest) { const result = db.prepare('INSERT INTO guests(first_name,last_name) VALUES (?,?)').run(first, last); guest = { id: result.lastInsertRowid }; }
  const id = randomUUID();
  db.prepare('INSERT INTO responses(id,guest_id,first_name,last_name,attending,attendees,comments) VALUES (?,?,?,?,?,?,?) ON CONFLICT(guest_id) DO UPDATE SET id=excluded.id,first_name=excluded.first_name,last_name=excluded.last_name,attending=excluded.attending,attendees=excluded.attendees,comments=excluded.comments,created_at=CURRENT_TIMESTAMP').run(id, guest.id, first, last, yes ? 1 : 0, yes ? number : 0, note || null);
  sendEmail().catch(console.error);
  res.status(201).json({ id, attending: yes });
});

app.post('/api/admin/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10 }), async (req, res) => { const user = clean(req.body?.username, 80); const candidate = String(req.body?.password || ''); const record = db.prepare('SELECT * FROM admin_users WHERE username=?').get(user); if (!record || !(await bcrypt.compare(candidate, record.password_hash))) return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' }); req.session.admin = record.id; res.json({ ok: true }); });
app.post('/api/admin/logout', (req,res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/admin/me', (req,res) => res.json({ authenticated: !!req.session.admin }));
app.get('/api/admin/dashboard', adminOnly, (req,res) => res.json({ stats: stats(), pending: rows('pending').slice(0, 10), recent: db.prepare('SELECT * FROM responses ORDER BY created_at DESC LIMIT 8').all() }));
app.get('/api/admin/guests', adminOnly, (req,res) => res.json({ stats: stats(), rows: rows(req.query.status, clean(req.query.search, 100), req.query.order) }));
app.post('/api/admin/import', adminOnly, (req,res) => { const csv = String(req.body?.csv || '').replace(/^\uFEFF/, ''); const lines = csv.split(/\r?\n/).filter(Boolean); if (!lines.length) return res.status(400).json({error:'El CSV está vacío.'}); const insert = db.prepare('INSERT INTO guests(first_name,last_name) SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM guests WHERE lower(first_name)=lower(?) AND lower(last_name)=lower(?))'); let count=0; const tx=db.transaction(()=>lines.slice(1).forEach(line=>{ const [f,...rest]=line.split(','); const l=rest.join(','); const first=clean(f,60),last=clean(l,100); if(first&&last) count+=insert.run(first,last,first,last).changes; })); tx(); res.json({count}); });
app.get('/api/admin/export.csv', adminOnly, (req,res) => { const esc=v=>`"${String(v??'').replaceAll('"','""')}"`; const data=rows().map(r=>[r.first_name,r.last_name,r.response_id?(r.attending?'Sí':'No'):'Pendiente',r.attendees||'',r.comments||'',r.created_at||''].map(esc).join(',')); res.set({'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="confirmaciones.csv"'}).send('\uFEFFNombre,Apellidos,Asistencia,Número de asistentes,Comentarios,Fecha de respuesta\n'+data.join('\n')); });
async function sendEmail() { if (!process.env.ADMIN_EMAIL || !process.env.SMTP_HOST) return; const transporter=nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),secure:Number(process.env.SMTP_PORT)===465,auth:{user:process.env.SMTP_USER,password:process.env.SMTP_PASSWORD}}); const s=stats(), latest=db.prepare('SELECT first_name,last_name,attending,attendees FROM responses ORDER BY created_at DESC LIMIT 20').all(); await transporter.sendMail({from:process.env.SMTP_FROM||process.env.SMTP_USER,to:process.env.ADMIN_EMAIL,subject:'Actualización de asistencia - Vanessa & Raúl',text:`Confirmados: ${s.confirmed}\nNo asistirán: ${s.declined}\nPendientes: ${s.pending}\nPersonas confirmadas: ${s.people}\n\nRespuestas recientes:\n${latest.map(x=>`${x.first_name} ${x.last_name}: ${x.attending?'Confirmada — '+x.attendees+' personas':'No asistirá'}`).join('\n')}`}); }
const port=process.env.PORT||3000; app.listen(port,()=>console.log(`Invitación disponible en http://localhost:${port}`));
