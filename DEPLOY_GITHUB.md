# 🚀 Деплой на todo.dvinsk.lat + автодеплой через GitHub Actions

## Часть 1. Публикуем репозиторий на GitHub

### 1.1 Создай репозиторий
На GitHub: **New repository** → имя `todo-app` → **Private** (рекомендую, там ключи в .env.example как пример, но лучше не светить) → без README/gitignore (они уже есть) → Create.

### 1.2 Запушь код с локальной машины

```cmd
cd todo-app
git add .
git commit -m "Initial commit: todo app with sandbox and repo analyzer"
git branch -M main
git remote add origin https://github.com/nikolajevs/todo-app.git
git push -u origin main
```

Если просит логин — используй Personal Access Token вместо пароля
(GitHub → Settings → Developer settings → Personal access tokens).

---

## Часть 2. Первичная настройка VPS (один раз)

### 2.1 Сгенерируй SSH-ключ для деплоя (отдельный, не личный!)

На своей машине (или на самом VPS):

```bash
ssh-keygen -t ed25519 -f deploy_key -C "github-actions-deploy" -N ""
```

Это создаст `deploy_key` (приватный) и `deploy_key.pub` (публичный).

### 2.2 Добавь публичный ключ на VPS

```bash
ssh -p 10066 administrator@dvinsk.lat "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys" < deploy_key.pub
```

### 2.3 Дай GitHub доступ клонировать приватный репозиторий с VPS

Проще всего — **Deploy Key** на стороне репозитория:

1. GitHub → репозиторий → Settings → Deploy keys → Add deploy key
2. Сгенерируй ещё один ключ **на VPS** (для клонирования, не для входа):
   ```bash
   ssh -p 10066 administrator@dvinsk.lat
   ssh-keygen -t ed25519 -f ~/.ssh/todo_deploy_key -N ""
   cat ~/.ssh/todo_deploy_key.pub
   ```
3. Вставь публичный ключ в GitHub Deploy Keys (без права записи — только чтение)
4. На VPS пропиши в `~/.ssh/config`:
   ```
   Host github.com
     IdentityFile ~/.ssh/todo_deploy_key
   ```

### 2.4 Клонируй проект и настрой сервер

Скопируй `deploy/setup_vps.sh` на VPS и запусти:

```bash
scp -P 10066 deploy/setup_vps.sh administrator@dvinsk.lat:~/
ssh -p 10066 administrator@dvinsk.lat
chmod +x setup_vps.sh
./setup_vps.sh git@github.com:nikolajevs/todo-app.git
```

Скрипт клонирует репо, поставит зависимости, попросит заполнить `.env`,
запустит через PM2 и настроит Nginx.

### 2.5 DNS

Убедись, что `todo.dvinsk.lat` резолвится на IP твоего VPS (A-запись).
Проверить: `nslookup todo.dvinsk.lat`

### 2.6 HTTPS (рекомендуется)

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d todo.dvinsk.lat
```

Certbot сам допишет SSL-блок в конфиг Nginx и настроит автообновление.

---

## Часть 3. Автодеплой через GitHub Actions

Файл `.github/workflows/deploy.yml` уже в репозитории. При каждом
`git push` в ветку `main` он подключается к VPS по SSH и делает:
`git pull` → `npm install` → `pm2 restart`.

### 3.1 Добавь секреты в GitHub

Репозиторий → **Settings → Secrets and variables → Actions → New repository secret**.
Добавь четыре секрета:

| Имя секрета | Значение | Пример |
|---|---|---|
| `VPS_HOST` | адрес сервера | `dvinsk.lat` |
| `VPS_PORT` | SSH-порт | `10066` |
| `VPS_USER` | пользователь | `administrator` |
| `VPS_SSH_KEY` | **приватный** ключ из шага 2.1 | содержимое файла `deploy_key` целиком |
| `VPS_APP_PATH` | путь к проекту на сервере | `/home/administrator/todo-app` |

Для `VPS_SSH_KEY` — вставляй весь файл, включая строки
`-----BEGIN OPENSSH PRIVATE KEY-----` и `-----END...-----`.

⚠️ Это ключ из шага **2.1** (для входа GitHub Actions на сервер по SSH),
не путай с ключом из шага **2.3** (для клонирования репо на самом VPS) —
это два разных ключа с разными задачами.

### 3.2 Проверка

Сделай любое изменение и запушь:

```cmd
git add .
git commit -m "test auto-deploy"
git push
```

Открой вкладку **Actions** в GitHub — увидишь запущенный workflow
"Deploy to VPS". Зелёная галочка = задеплоилось. Проверь
`http://todo.dvinsk.lat`.

Можно также запустить деплой вручную: Actions → Deploy to VPS → Run workflow
(это работает благодаря `workflow_dispatch` в файле).

---

## Как это работает дальше

```
git push → GitHub Actions → SSH на VPS → git pull → npm install → pm2 restart
```

`.env` и `todo.db` на сервере **не тронутся** — они в `.gitignore`,
`git pull` их не видит и не перезаписывает.

## Troubleshooting

**Workflow падает на "Permission denied (publickey)"**
Проверь, что `VPS_SSH_KEY` — это приватный ключ (не .pub), и что его
публичная пара реально в `~/.ssh/authorized_keys` на VPS (шаг 2.2).

**`git pull` на сервере просит пароль**
Значит Deploy Key (шаг 2.3) не настроен или SSH config не подхватывается.
Проверь `~/.ssh/config` на VPS.

**pm2: command not found**
```bash
sudo npm install -g pm2
```

**Изменения задеплоились, но сайт не обновился**
```bash
pm2 logs todo-app --lines 30
pm2 restart todo-app --update-env
```
