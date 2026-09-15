#!/bin/bash
# Первичная настройка VPS для todo-app. Запускать ОДИН РАЗ на сервере.
# Использование: ./setup_vps.sh git@github.com:nikolajevs/todo-app.git

set -e

REPO_URL="${1:?Укажи URL репозитория, например: ./setup_vps.sh git@github.com:nikolajevs/todo-app.git}"
APP_DIR="/home/administrator/todo-app"

echo "📦 Клонирую репозиторий в $APP_DIR ..."
if [ -d "$APP_DIR" ]; then
    echo "⚠️  Папка $APP_DIR уже существует. Останавливаюсь, чтобы не перезаписать."
    exit 1
fi

git clone "$REPO_URL" "$APP_DIR"
cd "$APP_DIR"

echo "📦 Устанавливаю зависимости..."
npm install --production

echo "⚙️  Создаю .env (заполни его перед запуском!)"
cp .env.example .env
echo ""
echo "   >>> ОБЯЗАТЕЛЬНО отредактируй .env: nano $APP_DIR/.env"
echo "       - JWT_SECRET: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
echo "       - ANTHROPIC_API_KEY: с console.anthropic.com"
echo ""
read -p "Нажми Enter, когда заполнишь .env (или Ctrl+C, чтобы сделать это позже)..."

echo "🔧 Устанавливаю PM2 (если ещё не установлен)..."
if ! command -v pm2 &> /dev/null; then
    sudo npm install -g pm2
fi

echo "🚀 Запускаю приложение через PM2..."
pm2 start server.js --name "todo-app"
pm2 save
pm2 startup | tail -n 1 || true

echo "🌐 Настраиваю Nginx..."
sudo cp deploy/nginx-todo.conf /etc/nginx/sites-available/todo
sudo ln -sf /etc/nginx/sites-available/todo /etc/nginx/sites-enabled/todo
sudo nginx -t
sudo systemctl reload nginx

echo ""
echo "✅ Готово! Приложение работает на http://todo.dvinsk.lat"
echo ""
echo "Следующие шаги:"
echo "  1. Проверь, что DNS-запись todo.dvinsk.lat указывает на этот сервер"
echo "  2. Для HTTPS: sudo apt install certbot python3-certbot-nginx && sudo certbot --nginx -d todo.dvinsk.lat"
echo "  3. Настрой GitHub Actions секреты (см. DEPLOY_GITHUB.md) для автодеплоя"
