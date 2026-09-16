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
        `);

        db.run(`
          CREATE TABLE IF NOT EXISTS comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            user_name TEXT NOT NULL,
            text TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        db.run('CREATE INDEX IF NOT EXISTS idx_comments_task ON comments(task_id)');

        db.run(`
          CREATE TABLE IF NOT EXISTS attachments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL,
            comment_id INTEGER,
            user_id INTEGER NOT NULL,
            user_name TEXT NOT NULL,
            filename TEXT,
            mime_type TEXT NOT NULL,
            size INTEGER,
            data BLOB NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        db.run('CREATE INDEX IF NOT EXISTS idx_attachments_task ON attachments(task_id)', (err) => {
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
    db.all(`
      SELECT t.*,
        (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id) AS comment_count,
        (SELECT COUNT(*) FROM attachments a WHERE a.task_id = t.id AND a.comment_id IS NULL) AS attachment_count
      FROM tasks t ORDER BY t.id DESC
    `, (err, rows) => {
      if (err) reject(err); else resolve(rows || []);
    });
  });
}

function addAttachmentRow(taskId, commentId, userId, userName, filename, mimeType, buffer) {
  return new Promise((resolve, reject) => {
    db.run('INSERT INTO attachments (task_id, comment_id, user_id, user_name, filename, mime_type, size, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [taskId, commentId, userId, userName, filename || null, mimeType, buffer.length, buffer],
      function(err) {
        if (err) reject(err);
        else resolve({ id: this.lastID, task_id: taskId, comment_id: commentId, user_id: userId, user_name: userName, filename: filename || null, mime_type: mimeType, size: buffer.length, created_at: new Date().toISOString() });
      });
  });
}

async function addAttachments(taskId, commentId, userId, userName, files) {
  const saved = [];
  for (const f of (files || [])) {
    if (!f || !f.data || !f.mime_type) continue;
    const buffer = Buffer.from(f.data, 'base64');
    const row = await addAttachmentRow(taskId, commentId, userId, userName, f.filename, f.mime_type, buffer);
    saved.push({ id: row.id, filename: row.filename, mime_type: row.mime_type, size: row.size, created_at: row.created_at, user_name: row.user_name });
  }
  return saved;
}

function getTaskAttachments(taskId) {
  return new Promise((resolve, reject) => {
    db.all('SELECT id, comment_id, user_name, filename, mime_type, size, created_at FROM attachments WHERE task_id = ? AND comment_id IS NULL ORDER BY id ASC',
      [taskId], (err, rows) => { if (err) reject(err); else resolve(rows || []); });
  });
}

function getAttachmentData(id) {
  return new Promise((resolve, reject) => {
    db.get('SELECT mime_type, data FROM attachments WHERE id = ?', [id], (err, row) => {
      if (err) reject(err); else resolve(row || null);
    });
  });
}

async function addTask(authorId, authorName, text, source, files) {
  return new Promise((resolve, reject) => {
    db.run('INSERT INTO tasks (author_id, author_name, text, status, source) VALUES (?, ?, ?, ?, ?)',
      [authorId, authorName, text, 'open', source || null],
      function(err) {
        if (err) reject(err);
        else {
          const taskId = this.lastID;
          const histNote = source ? `${text} (${source})` : text;
          logHistory(taskId, authorId, authorName, 'created', histNote)
            .then(() => addAttachments(taskId, null, authorId, authorName, files))
            .then((saved) => resolve({
              id: taskId, author_id: authorId, author_name: authorName, text,
              status: 'open', worker_id: null, worker_name: null, source: source || null,
              comment_count: 0, attachment_count: saved.length,
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

function truncate(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }

async function editTaskText(userId, userName, id, newText) {
  const task = await getTaskById(id);
  if (!task) throw new Error('Task not found');
  if (task.author_id !== userId) {
    const e = new Error('Only the author can edit this task');
    e.code = 'FORBIDDEN';
    throw e;
  }
  const oldText = task.text;
  return new Promise((resolve, reject) => {
    db.run('UPDATE tasks SET text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [newText, id],
      function(err) {
        if (err) reject(err);
        else {
          const details = `«${truncate(oldText, 60)}» → «${truncate(newText, 60)}»`;
          logHistory(id, userId, userName, 'text_edited', details)
            .then(() => resolve({ id, text: newText }))
            .catch(reject);
        }
      });
  });
}

function getComments(taskId) {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM comments WHERE task_id = ? ORDER BY id ASC', [taskId],
      async (err, rows) => {
        if (err) { reject(err); return; }
        const comments = rows || [];
        if (comments.length === 0) { resolve(comments); return; }
        const ids = comments.map(c => c.id);
        db.all(`SELECT id, comment_id, user_name, filename, mime_type, size, created_at FROM attachments WHERE comment_id IN (${ids.map(() => '?').join(',')})`, ids,
          (err2, atts) => {
            if (err2) { reject(err2); return; }
            const byComment = {};
            for (const a of (atts || [])) {
              if (!byComment[a.comment_id]) byComment[a.comment_id] = [];
              byComment[a.comment_id].push(a);
            }
            comments.forEach(c => { c.attachments = byComment[c.id] || []; });
            resolve(comments);
          });
      });
  });
}

async function addComment(taskId, userId, userName, text, files) {
  const task = await getTaskById(taskId);
  if (!task) throw new Error('Task not found');
  return new Promise((resolve, reject) => {
    db.run('INSERT INTO comments (task_id, user_id, user_name, text) VALUES (?, ?, ?, ?)',
      [taskId, userId, userName, text],
      function(err) {
        if (err) reject(err);
        else {
          const commentId = this.lastID;
          addAttachments(taskId, commentId, userId, userName, files)
            .then((saved) => resolve({
              id: commentId, task_id: taskId, user_id: userId, user_name: userName, text,
              attachments: saved, created_at: new Date().toISOString()
            }))
            .catch(reject);
        }
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
  editTaskText, getComments, addComment,
  getTaskAttachments, getAttachmentData,
  getSandboxTasks, getSandboxById, addSandboxTask, markSandboxStatus, promoteSandboxTask, countSandbox,
  getSetting, setSetting
};
