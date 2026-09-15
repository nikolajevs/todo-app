const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.join(__dirname, 'todo.db');

let db;

function initDb() {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) { reject(err); return; }

      db.serialize(() => {
        db.run('PRAGMA foreign_keys = ON');

        db.run(`
          CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        db.run(`
          CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            author_id INTEGER NOT NULL,
            author_name TEXT NOT NULL,
            text TEXT NOT NULL,
            status TEXT DEFAULT 'open',
            worker_id INTEGER,
            worker_name TEXT,
            source TEXT,
            updated_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (author_id) REFERENCES users(id)
          )
        `);

        db.run(`
          CREATE TABLE IF NOT EXISTS history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            user_name TEXT NOT NULL,
            action TEXT NOT NULL,
            details TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        db.run('CREATE INDEX IF NOT EXISTS idx_history_task ON history(task_id)');

        db.run(`
          CREATE TABLE IF NOT EXISTS sandbox (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT,
            category TEXT DEFAULT 'improvement',
            priority TEXT DEFAULT 'medium',
            status TEXT DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        db.run(`
          CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
          )
        `, (err) => {
          if (err) reject(err);
          else resolve(db);
        });
      });
    });
  });
}

function createUser(username, passwordHash) {
  return new Promise((resolve, reject) => {
    db.run('INSERT INTO users (username, password_hash) VALUES (?, ?)',
      [username, passwordHash],
      function(err) { if (err) reject(err); else resolve({ id: this.lastID, username }); });
  });
}

function findUserByUsername(username) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM users WHERE username = ?', [username], (err, row) => {
      if (err) reject(err); else resolve(row);
    });
  });
}

function logHistory(taskId, userId, userName, action, details) {
  return new Promise((resolve, reject) => {
    db.run('INSERT INTO history (task_id, user_id, user_name, action, details) VALUES (?, ?, ?, ?, ?)',
      [taskId, userId, userName, action, details || null],
      function(err) { if (err) reject(err); else resolve({ id: this.lastID }); });
  });
}

function getTaskHistory(taskId) {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM history WHERE task_id = ? ORDER BY id DESC', [taskId],
      (err, rows) => { if (err) reject(err); else resolve(rows || []); });
  });
}

function getTaskById(id) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM tasks WHERE id = ?', [id], (err, row) => {
      if (err) reject(err); else resolve(row);
    });
  });
}

function getAllTasks() {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM tasks ORDER BY id DESC', (err, rows) => {
      if (err) reject(err); else resolve(rows || []);
    });
  });
}

async function addTask(authorId, authorName, text, source) {
  return new Promise((resolve, reject) => {
    db.run('INSERT INTO tasks (author_id, author_name, text, status, source) VALUES (?, ?, ?, ?, ?)',
      [authorId, authorName, text, 'open', source || null],
      function(err) {
        if (err) reject(err);
        else {
          const taskId = this.lastID;
          const histNote = source ? `${text} (${source})` : text;
          logHistory(taskId, authorId, authorName, 'created', histNote)
            .then(() => resolve({
              id: taskId, author_id: authorId, author_name: authorName, text,
              status: 'open', worker_id: null, worker_name: null, source: source || null,
              created_at: new Date().toISOString()
            }))
            .catch(reject);
        }
      });
  });
}

const STATUS_LABELS = { 'open': 'Открыта', 'in_progress': 'В работе', 'closed': 'Закрыта' };

async function updateTaskStatus(userId, userName, id, status) {
  const task = await getTaskById(id);
  if (!task) throw new Error('Task not found');

  let workerId, workerName;
  if (status === 'in_progress') { workerId = userId; workerName = userName; }
  else { workerId = null; workerName = null; }

  return new Promise((resolve, reject) => {
    db.run('UPDATE tasks SET status = ?, worker_id = ?, worker_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [status, workerId, workerName, id],
      function(err) {
        if (err) reject(err);
        else {
          const details = `${STATUS_LABELS[task.status] || task.status} → ${STATUS_LABELS[status] || status}`;
          logHistory(id, userId, userName, 'status_changed', details)
            .then(() => resolve({ id, status, worker_id: workerId, worker_name: workerName }))
            .catch(reject);
        }
      });
  });
}

async function deleteTask(userId, id) {
  const task = await getTaskById(id);
  if (!task) throw new Error('Task not found');
  if (task.author_id !== userId) {
    const e = new Error('Only the author can delete this task');
    e.code = 'FORBIDDEN';
    throw e;
  }
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM tasks WHERE id = ?', [id], function(err) {
      if (err) reject(err); else resolve({ id });
    });
  });
}

function getSandboxTasks() {
  return new Promise((resolve, reject) => {
    db.all("SELECT * FROM sandbox WHERE status = 'pending' ORDER BY " +
      "CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, id DESC",
      (err, rows) => { if (err) reject(err); else resolve(rows || []); });
  });
}

function getSandboxById(id) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM sandbox WHERE id = ?', [id], (err, row) => {
      if (err) reject(err); else resolve(row);
    });
  });
}

function addSandboxTask(title, description, category, priority) {
  return new Promise((resolve, reject) => {
    db.run('INSERT INTO sandbox (title, description, category, priority) VALUES (?, ?, ?, ?)',
      [title, description || null, category || 'improvement', priority || 'medium'],
      function(err) { if (err) reject(err); else resolve({ id: this.lastID }); });
  });
}

function markSandboxStatus(id, status) {
  return new Promise((resolve, reject) => {
    db.run('UPDATE sandbox SET status = ? WHERE id = ?', [status, id],
      function(err) {
        if (err) reject(err);
        else if (this.changes === 0) reject(new Error('Sandbox task not found'));
        else resolve({ id, status });
      });
  });
}

async function promoteSandboxTask(userId, userName, id) {
  const item = await getSandboxById(id);
  if (!item) throw new Error('Sandbox task not found');
  if (item.status !== 'pending') throw new Error('Already handled');

  const text = item.description ? `${item.title} — ${item.description}` : item.title;
  const task = await addTask(userId, userName, text, 'из Песочницы Claude');
  await markSandboxStatus(id, 'promoted');
  return task;
}

function countSandbox() {
  return new Promise((resolve, reject) => {
    db.get('SELECT COUNT(*) AS c FROM sandbox', (err, row) => {
      if (err) reject(err); else resolve(row.c);
    });
  });
}

function getSetting(key) {
  return new Promise((resolve, reject) => {
    db.get('SELECT value FROM settings WHERE key = ?', [key], (err, row) => {
      if (err) reject(err); else resolve(row ? row.value : null);
    });
  });
}

function setSetting(key, value) {
  return new Promise((resolve, reject) => {
    db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, value],
      function(err) { if (err) reject(err); else resolve({ key, value }); });
  });
}

module.exports = {
  initDb, createUser, findUserByUsername,
  getAllTasks, getTaskById, addTask, updateTaskStatus, deleteTask, getTaskHistory,
  getSandboxTasks, getSandboxById, addSandboxTask, markSandboxStatus, promoteSandboxTask, countSandbox,
  getSetting, setSetting
};
