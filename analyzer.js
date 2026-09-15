require('dotenv').config();
const https = require('https');
const db = require('./db');

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

const CODE_EXTENSIONS = ['.js', '.ts', '.jsx', '.tsx', '.py', '.html', '.css', '.json', '.md', '.sql', '.sh', '.yml', '.yaml', '.ino', '.cpp', '.h', '.c'];
const SKIP_DIRS = ['node_modules', 'dist', 'build', '.git', 'vendor', 'coverage', '.next'];
const SKIP_FILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'];

const MAX_FILES = 40;
const MAX_TOTAL_BYTES = 120 * 1024;
const MAX_FILE_BYTES = 30 * 1024;

function parseRepo(url) {
  if (!url) return null;
  let s = url.trim().replace(/\.git$/, '').replace(/\/$/, '');
  s = s.replace(/^https?:\/\//, '').replace(/^git@github\.com:/, 'github.com/');
  s = s.replace(/^github\.com\//, '');
  const parts = s.split('/');
  if (parts.length >= 2 && parts[0] && parts[1]) return { owner: parts[0], repo: parts[1] };
  return null;
}

function githubApi(pathname, token) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com', path: pathname, method: 'GET',
      headers: { 'User-Agent': 'todo-app', 'Accept': 'application/vnd.github+json' }
    };
    if (token) options.headers['Authorization'] = 'Bearer ' + token;
    const req = https.request(options, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        try { resolve({ status: resp.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: resp.statusCode, body: {} }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    if (!ANTHROPIC_API_KEY) {
      reject(new Error('ANTHROPIC_API_KEY не задан в окружении'));
      return;
    }
    const payload = JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }]
    });
    const options = {
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    const req = https.request(options, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        if (resp.statusCode !== 200) {
          let msg = 'Claude API вернул ' + resp.statusCode;
          try { const b = JSON.parse(data); if (b.error && b.error.message) msg += ': ' + b.error.message; } catch (e) {}
          reject(new Error(msg));
          return;
        }
        try {
          const body = JSON.parse(data);
          const text = (body.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n');
          resolve(text);
        } catch (e) { reject(new Error('Не удалось разобрать ответ Claude')); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function fetchRepoFiles(owner, repo, branch, token) {
  const tree = await githubApi(`/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, token);
  if (tree.status !== 200) {
    if (tree.status === 404) throw new Error('Репозиторий или ветка не найдены');
    if (tree.status === 401 || tree.status === 403) throw new Error('Нет доступа к репозиторию — проверь токен');
    throw new Error('GitHub вернул ' + tree.status);
  }

  const items = (tree.body.tree || [])
    .filter(t => t.type === 'blob')
    .filter(t => !SKIP_DIRS.some(d => t.path.split('/').includes(d)))
    .filter(t => !SKIP_FILES.includes(t.path.split('/').pop()))
    .filter(t => CODE_EXTENSIONS.some(ext => t.path.toLowerCase().endsWith(ext)))
    .filter(t => t.size && t.size <= MAX_FILE_BYTES)
    .sort((a, b) => a.size - b.size);

  const files = [];
  let totalBytes = 0;

  for (const item of items) {
    if (files.length >= MAX_FILES) break;
    if (totalBytes + item.size > MAX_TOTAL_BYTES) continue;

    const content = await githubApi(`/repos/${owner}/${repo}/contents/${encodeURIComponent(item.path).replace(/%2F/g, '/')}?ref=${branch}`, token);
    if (content.status === 200 && content.body.content) {
      const decoded = Buffer.from(content.body.content, 'base64').toString('utf-8');
      files.push({ path: item.path, content: decoded });
      totalBytes += item.size;
    }
  }
  return files;
}

function buildPrompt(repoName, files) {
  const fileBlocks = files.map(f => `--- ФАЙЛ: ${f.path} ---\n${f.content}`).join('\n\n');
  return `Ты — старший инженер, проводящий код-ревью репозитория "${repoName}".

Проанализируй код ниже и найди КОНКРЕТНЫЕ улучшения: баги, уязвимости безопасности, проблемы производительности, недостающие фичи, места для рефакторинга.

Требования к ответу:
- Только конкретика, привязанная к реальному коду (упоминай файлы/функции). Никаких общих советов вроде "добавьте документацию".
- От 5 до 12 предложений.
- Каждое предложение: title (кратко, до 60 симв.), description (что не так и что сделать, 1-3 предложения), category (одно из: security, performance, feature, bug, refactor), priority (одно из: high, medium, low).

Верни СТРОГО валидный JSON-массив без markdown-разметки и без пояснений до или после. Формат:
[{"title":"...","description":"...","category":"...","priority":"..."}]

=== КОД РЕПОЗИТОРИЯ ===
${fileBlocks}`;
}

function parseSuggestions(text) {
  let clean = text.trim();
  clean = clean.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = clean.indexOf('[');
  const end = clean.lastIndexOf(']');
  if (start !== -1 && end !== -1) clean = clean.slice(start, end + 1);

  const arr = JSON.parse(clean);
  if (!Array.isArray(arr)) throw new Error('Ответ не является массивом');

  const validCat = ['security', 'performance', 'feature', 'bug', 'refactor', 'improvement'];
  const validPrio = ['high', 'medium', 'low'];

  return arr
    .filter(s => s && s.title)
    .map(s => ({
      title: String(s.title).slice(0, 120),
      description: s.description ? String(s.description).slice(0, 600) : '',
      category: validCat.includes(s.category) ? s.category : 'improvement',
      priority: validPrio.includes(s.priority) ? s.priority : 'medium'
    }));
}

async function analyzeRepo() {
  const repoUrl = await db.getSetting('repo_url');
  const branch = (await db.getSetting('repo_branch')) || 'main';
  const token = await db.getSetting('repo_token');

  const parsed = parseRepo(repoUrl);
  if (!parsed) throw new Error('Репозиторий не подключён. Задай его в Настройках.');

  const files = await fetchRepoFiles(parsed.owner, parsed.repo, branch, token);
  if (files.length === 0) throw new Error('Не удалось получить исходный код из репозитория');

  const prompt = buildPrompt(`${parsed.owner}/${parsed.repo}`, files);
  const answer = await callClaude(prompt);
  const suggestions = parseSuggestions(answer);

  const existing = await db.getSandboxTasks();
  const existingTitles = new Set(existing.map(e => e.title.toLowerCase().trim()));

  let added = 0;
  for (const s of suggestions) {
    if (existingTitles.has(s.title.toLowerCase().trim())) continue;
    await db.addSandboxTask(s.title, s.description, s.category, s.priority);
    added++;
  }

  return { analyzed_files: files.length, suggestions_total: suggestions.length, added };
}

module.exports = { analyzeRepo, parseRepo, parseSuggestions, fetchRepoFiles };

if (require.main === module) {
  (async () => {
    await db.initDb();
    console.log('🔍 Анализирую подключённый репозиторий...');
    try {
      const result = await analyzeRepo();
      console.log(`✅ Готово. Проанализировано файлов: ${result.analyzed_files}, предложений от Claude: ${result.suggestions_total}, добавлено новых в песочницу: ${result.added}`);
    } catch (err) {
      console.error('❌ ' + err.message);
      process.exit(1);
    }
    process.exit(0);
  })();
}
