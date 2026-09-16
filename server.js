require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const https = require('https');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const db = require('./db');
const { analyzeRepo } = require('./analyzer');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';

app.use(cors());
app.use(bodyParser.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

// Все залогиненные клиенты сидят в одной комнате "board" — доска общая для всех.
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) return next(new Error('No token'));
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return next(new Error('Invalid token'));
    socket.user = user;
    next();
  });
});

io.on('connection', (socket) => {
  socket.join('board');
});

function broadcast(event, payload) {
  io.to('board').emit(event, payload);
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}

function parseRepo(url) {
  if (!url) return null;
  let s = url.trim().replace(/\.git$/, '').replace(/\/$/, '');
  s = s.replace(/^https?:\/\//, '').replace(/^git@github\.com:/, 'github.com/');
  s = s.replace(/^github\.com\//, '');
  const parts = s.split('/');
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return { owner: parts[0], repo: parts[1] };
  }
  return null;
}

function githubApi(pathname, token) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: pathname,
      method: 'GET',
      headers: {
        'User-Agent': 'todo-app',
        'Accept': 'application/vnd.github+json'
      }
    };
    if (token) options.headers['Authorization'] = 'Bearer ' + token;

    const req = https.request(options, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        try { resolve({ status: resp.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: resp.statusCode, body: {} }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    if (username.length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existing = await db.findUserByUsername(username);
    if (existing) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await db.createUser(username, passwordHash);

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, username: user.username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const user = await db.findUserByUsername(username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, username: user.username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tasks', authMiddleware, async (req, res) => {
  try {
    const tasks = await db.getAllTasks();
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function validateAttachments(files) {
  if (!files) return [];
  if (!Array.isArray(files)) throw new Error('attachments must be an array');
  if (files.length > 5) throw new Error('Максимум 5 вложений за раз');
  for (const f of files) {
    if (!f.mime_type || !f.mime_type.startsWith('image/')) throw new Error('Можно прикреплять только изображения');
    if (!f.data || typeof f.data !== 'string') throw new Error('Некорректные данные вложения');
    if (f.data.length > 12 * 1024 * 1024) throw new Error('Файл слишком большой (макс. ~8 МБ)');
  }
  return files;
}

app.post('/api/tasks', authMiddleware, async (req, res) => {
  try {
    const { text, attachments } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Task text is required' });
    }
    const files = validateAttachments(attachments);
    const task = await db.addTask(req.user.id, req.user.username, text.trim(), undefined, files);
    broadcast('task:created', task);
    res.json(task);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/tasks/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status || !['open', 'in_progress', 'closed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const result = await db.updateTaskStatus(req.user.id, req.user.username, id, status);
    broadcast('task:updated', result);
    res.json(result);
  } catch (err) {
    if (err.message === 'Task not found') {
      return res.status(404).json({ error: 'Task not found' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/tasks/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    await db.deleteTask(req.user.id, id);
    broadcast('task:deleted', { id: Number(id) });
    res.json({ success: true });
  } catch (err) {
    if (err.message === 'Task not found') {
      return res.status(404).json({ error: 'Task not found' });
    }
    if (err.code === 'FORBIDDEN') {
      return res.status(403).json({ error: 'Only the author can delete this task' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/tasks/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Task text is required' });
    }
    const result = await db.editTaskText(req.user.id, req.user.username, id, text.trim());
    broadcast('task:edited', result);
    res.json(result);
  } catch (err) {
    if (err.message === 'Task not found') {
      return res.status(404).json({ error: 'Task not found' });
    }
    if (err.code === 'FORBIDDEN') {
      return res.status(403).json({ error: 'Only the author can edit this task' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tasks/:id/comments', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const comments = await db.getComments(id);
    res.json(comments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tasks/:id/comments', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { text, attachments } = req.body;
    const files = validateAttachments(attachments);
    const trimmed = (text || '').trim();
    if (!trimmed && files.length === 0) {
      return res.status(400).json({ error: 'Нужен текст или хотя бы одно вложение' });
    }
    const comment = await db.addComment(id, req.user.id, req.user.username, trimmed, files);
    broadcast('comment:added', { task_id: Number(id), comment });
    res.json(comment);
  } catch (err) {
    if (err.message === 'Task not found') {
      return res.status(404).json({ error: 'Task not found' });
    }
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/tasks/:id/comments/read', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.markCommentRead(req.user.id, id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/notifications/unread-count', authMiddleware, async (req, res) => {
  try {
    const byTask = await db.getUnreadByTask(req.user.id);
    const count = Object.values(byTask).reduce((a, b) => a + b, 0);
    res.json({ count, by_task: byTask });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tasks/:id/attachments', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const items = await db.getTaskAttachments(id);
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/attachments/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const att = await db.getAttachmentData(id);
    if (!att) return res.status(404).json({ error: 'Not found' });
    res.set('Content-Type', att.mime_type);
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    res.send(att.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tasks/:id/history', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const history = await db.getTaskHistory(id);
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sandbox', authMiddleware, async (req, res) => {
  try {
    const items = await db.getSandboxTasks();
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sandbox/:id/promote', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const task = await db.promoteSandboxTask(req.user.id, req.user.username, id);
    broadcast('task:created', task);
    broadcast('sandbox:removed', { id: Number(id) });
    res.json(task);
  } catch (err) {
    if (err.message === 'Sandbox task not found') {
      return res.status(404).json({ error: 'Sandbox task not found' });
    }
    if (err.message === 'Already handled') {
      return res.status(409).json({ error: 'Already handled' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sandbox/:id/dismiss', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    await db.markSandboxStatus(id, 'dismissed');
    broadcast('sandbox:removed', { id: Number(id) });
    res.json({ success: true });
  } catch (err) {
    if (err.message === 'Sandbox task not found') {
      return res.status(404).json({ error: 'Sandbox task not found' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/settings', authMiddleware, async (req, res) => {
  try {
    const repoUrl = await db.getSetting('repo_url');
    const repoBranch = await db.getSetting('repo_branch');
    const token = await db.getSetting('repo_token');
    const connectedAt = await db.getSetting('connected_at');
    res.json({
      repo_url: repoUrl || '',
      repo_branch: repoBranch || 'main',
      has_token: !!token,
      connected_at: connectedAt || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings', authMiddleware, async (req, res) => {
  try {
    const { repo_url, repo_branch, repo_token } = req.body;

    if (repo_url !== undefined) {
      const parsed = parseRepo(repo_url);
      if (repo_url && !parsed) {
        return res.status(400).json({ error: 'Не похоже на GitHub-репозиторий. Пример: github.com/nikolajevs/BRIDGE' });
      }
      await db.setSetting('repo_url', repo_url || '');
    }
    if (repo_branch !== undefined) {
      await db.setSetting('repo_branch', repo_branch || 'main');
    }
    if (repo_token !== undefined && repo_token !== '') {
      await db.setSetting('repo_token', repo_token);
    }
    await db.setSetting('connected_at', new Date().toISOString());
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings/verify', authMiddleware, async (req, res) => {
  try {
    const repoUrl = await db.getSetting('repo_url');
    const token = await db.getSetting('repo_token');
    const parsed = parseRepo(repoUrl);
    if (!parsed) {
      return res.status(400).json({ error: 'Репозиторий не задан' });
    }

    const result = await githubApi(`/repos/${parsed.owner}/${parsed.repo}`, token);

    if (result.status === 200) {
      const r = result.body;
      return res.json({
        ok: true,
        full_name: r.full_name,
        private: r.private,
        default_branch: r.default_branch,
        language: r.language,
        updated_at: r.updated_at
      });
    }
    if (result.status === 404) {
      return res.status(404).json({ error: 'Репозиторий не найден (или приватный без токена)' });
    }
    if (result.status === 401 || result.status === 403) {
      return res.status(result.status).json({ error: 'Нет доступа — проверь токен' });
    }
    res.status(result.status).json({ error: result.body.message || 'GitHub вернул ошибку' });
  } catch (err) {
    res.status(500).json({ error: 'Не удалось связаться с GitHub: ' + err.message });
  }
});

app.post('/api/analyze', authMiddleware, async (req, res) => {
  try {
    const result = await analyzeRepo();
    if (result.added > 0) broadcast('sandbox:changed', result);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  try {
    await db.initDb();
    console.log('✅ Database initialized');

    httpServer.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('❌ Database error:', err);
    process.exit(1);
  }
}

start();
