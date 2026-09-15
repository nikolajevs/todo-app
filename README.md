# To-do App (todo.lv clone)

Минималистичное приложение для управления задачами с Node.js бэком и SQLite базой данных.

## 🚀 Быстрый старт (локально)

### 1. Установка зависимостей
```bash
npm install
```

### 2. Запуск сервера
```bash
npm start
```

Сервер запустится на `http://localhost:3000`

---

## 📦 Развёртывание на dvinsk.lat

### Способ 1: Прямое развёртывание через SSH

**Шаг 1: На локальной машине упакуй проект**
```bash
zip -r todo-app.zip . --exclude "node_modules/*" "todo.db" ".git/*"
```

**Шаг 2: Залей на VPS**
```bash
scp -P 10066 todo-app.zip administrator@dvinsk.lat:/home/administrator/
```

**Шаг 3: На VPS распакуй и установи**
```bash
ssh -p 10066 administrator@dvinsk.lat
cd /home/administrator
unzip todo-app.zip -d todo-app
cd todo-app
npm install
```

**Шаг 4: Запусти сервер (для теста)**
```bash
npm start
# Должно быть: ✅ Database initialized
#             🚀 Server running on http://localhost:3000
```

Проверь: `curl http://localhost:3000` → должен вернуть HTML

---

### Способ 2: Использование PM2 (рекомендуется для production)

**На VPS:**

**1. Установи PM2**
```bash
npm install -g pm2
```

**2. Запусти приложение через PM2**
```bash
cd /home/administrator/todo-app
pm2 start server.js --name "todo-app"
pm2 save
pm2 startup
```

**3. Проверь статус**
```bash
pm2 list
pm2 logs todo-app
```

---

### Способ 3: Nginx как reverse proxy

**На VPS создай конфиг Nginx:**

```bash
sudo nano /etc/nginx/sites-available/todo
```

Вставь:
```nginx
server {
    listen 80;
    server_name todo.dvinsk.lat;
    
    client_max_body_size 10M;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

**Включи сайт:**
```bash
sudo ln -s /etc/nginx/sites-available/todo /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

**Запусти приложение (PM2 или npm start):**
```bash
cd /home/administrator/todo-app
pm2 start server.js --name "todo-app"
```

Теперь доступно на `http://todo.dvinsk.lat` 🎉

---

### Способ 4: Docker (опционально)

**Создай Dockerfile:**
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

**Собери и запусти:**
```bash
docker build -t todo-app .
docker run -d -p 3000:3000 -v $(pwd)/data:/app/data --name todo todo-app
```

---

## 📋 API Endpoints

- `GET /api/tasks` - получить все задачи
- `POST /api/tasks` - добавить новую задачу
  - Body: `{ "text": "Task text" }`
- `PUT /api/tasks/:id` - переключить статус задачи
- `DELETE /api/tasks/:id` - удалить задачу

---

## 🔧 Переменные окружения

Создай `.env` файл (опционально):
```
PORT=3000
NODE_ENV=production
```

---

## 📊 Структура файлов

```
todo-app/
├── server.js           # Express сервер
├── db.js               # SQLite логика
├── package.json        # Зависимости
├── public/
│   └── index.html      # Фронтенд
├── todo.db             # База данных (создаётся автоматически)
└── README.md           # Этот файл
```

---

## 🛠️ Troubleshooting

**Ошибка "Cannot find module":**
```bash
rm -rf node_modules package-lock.json
npm install
```

**Порт 3000 занят:**
```bash
# Найди процесс
lsof -i :3000
# Или используй другой порт
PORT=3001 npm start
```

**База данных повреждена:**
```bash
rm todo.db
npm start
# База пересоздастся автоматически
```

**PM2 не запускается:**
```bash
pm2 delete all
pm2 start server.js --name "todo-app"
pm2 save
```

---

## 📝 Развитие

Можно добавить:
- Юзеры и авторизация
- Категории и теги
- Синхронизация в реальном времени (WebSocket)
- Мобильное приложение
- Экспорт/импорт (JSON, CSV)

---

**Автор:** Igors  
**Лицензия:** MIT
