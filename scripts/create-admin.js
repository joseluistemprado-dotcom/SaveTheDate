import 'dotenv/config'; import Database from 'better-sqlite3'; import bcrypt from 'bcryptjs'; import path from 'node:path';
const username=process.env.ADMIN_USERNAME, password=process.env.ADMIN_PASSWORD;
if(!username||!password) throw new Error('Define ADMIN_USERNAME y ADMIN_PASSWORD en .env');
const db=new Database(path.resolve('data/save-the-date.sqlite')); db.exec('CREATE TABLE IF NOT EXISTS admin_users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
db.prepare('INSERT INTO admin_users(username,password_hash) VALUES (?,?) ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash').run(username,await bcrypt.hash(password,12)); console.log(`Administrador ${username} creado o actualizado.`);
