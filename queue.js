const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'queue.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    filepath TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    progress INTEGER NOT NULL DEFAULT 0,
    total_chunks INTEGER NOT NULL DEFAULT 0,
    done_chunks INTEGER NOT NULL DEFAULT 0,
    output_path TEXT,
    error TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

function createJob(filename, originalName, filepath) {
  const stmt = db.prepare(
    `INSERT INTO jobs (filename, original_name, filepath) VALUES (?, ?, ?)`
  );
  const info = stmt.run(filename, originalName, filepath);
  return getJob(info.lastInsertRowid);
}

function getJob(id) {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

function getAllJobs() {
  return db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all();
}

function updateJob(id, fields) {
  const allowed = ['status', 'progress', 'total_chunks', 'done_chunks', 'output_path', 'error'];
  const updates = Object.keys(fields)
    .filter(k => allowed.includes(k))
    .map(k => `${k} = ?`);
  updates.push('updated_at = unixepoch()');
  const values = Object.keys(fields).filter(k => allowed.includes(k)).map(k => fields[k]);
  db.prepare(`UPDATE jobs SET ${updates.join(', ')} WHERE id = ?`).run(...values, id);
}

function deleteJob(id) {
  db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
}

function resetStuckJobs() {
  db.prepare(`UPDATE jobs SET status = 'pending', progress = 0, done_chunks = 0, error = NULL WHERE status = 'processing'`).run();
}

module.exports = { createJob, getJob, getAllJobs, updateJob, deleteJob, resetStuckJobs };
