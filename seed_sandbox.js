const db = require('./db');

const SUGGESTIONS = [
  {
    title: 'Защитить JWT_SECRET',
    description: 'Сейчас есть дефолтный секрет-фолбэк в server.js. Если .env не настроен, токены можно подделать. В production сервер должен отказываться стартовать без заданного JWT_SECRET.',
    category: 'security',
    priority: 'high'
  },
  {
    title: 'Рейт-лимит на логин и регистрацию',
    description: 'Нет защиты от перебора паролей. Добавить express-rate-limit на /api/auth/* — например 10 попыток за 15 минут с одного IP.',
    category: 'security',
    priority: 'high'
  },
  {
    title: 'Real-time через WebSocket вместо polling',
    description: 'Доска опрашивает сервер каждые 5 секунд. При росте числа юзеров это лишняя нагрузка и задержка. Socket.io даст мгновенные обновления, когда кто-то берёт задачу.',
    category: 'performance',
    priority: 'medium'
  },
  {
    title: 'Токен в httpOnly cookie вместо localStorage',
    description: 'Токен в localStorage уязвим к краже при XSS. httpOnly-cookie не доступна из JS и безопаснее хранит сессию.',
    category: 'security',
    priority: 'medium'
  },
  {
    title: 'Ограничить длину текста задачи',
    description: 'Нет лимита на длину text — можно сохранить огромную строку и раздуть БД. Добавить проверку, например максимум 500 символов.',
    category: 'bug',
    priority: 'low'
  },
  {
    title: 'Пагинация списка задач',
    description: 'GET /api/tasks отдаёт все задачи разом. При сотнях задач страница будет тормозить. Добавить пагинацию или ленивую подгрузку.',
    category: 'performance',
    priority: 'medium'
  },
  {
    title: 'Фильтр и архив закрытых задач',
    description: 'Закрытые задачи копятся на доске без предела. Добавить фильтр по статусу и возможность скрывать/архивировать закрытые.',
    category: 'feature',
    priority: 'medium'
  },
  {
    title: 'Дедлайны и подсветка просроченных',
    description: 'У задач нет срока выполнения. Добавить поле due_date и визуально подсвечивать просроченные задачи красным.',
    category: 'feature',
    priority: 'medium'
  },
  {
    title: 'Подтверждение перед удалением',
    description: 'Удаление срабатывает мгновенно по клику — легко удалить задачу случайно. Добавить confirm-диалог.',
    category: 'feature',
    priority: 'low'
  },
  {
    title: 'Автотесты API',
    description: 'В проекте нет тестов. Добавить Jest + supertest на регистрацию, логин, CRUD задач и проверку прав доступа.',
    category: 'refactor',
    priority: 'medium'
  }
];

async function seed() {
  await db.initDb();
  const existing = await db.countSandbox();
  if (existing > 0) {
    console.log(`Sandbox уже содержит ${existing} записей — пропускаю сидинг.`);
    process.exit(0);
  }
  for (const s of SUGGESTIONS) {
    await db.addSandboxTask(s.title, s.description, s.category, s.priority);
  }
  console.log(`✅ Добавлено ${SUGGESTIONS.length} предложений в Песочницу Claude.`);
  process.exit(0);
}

seed().catch(err => { console.error(err); process.exit(1); });
