#!/bin/bash
set -e

echo "=========================================="
echo "🚀 Minecraft 24/7 AFK Bot Deploy (Render / VPS)"
echo "=========================================="

if [ "$EUID" -ne 0 ]; then
  echo "⚠️ Iltimos, skriptni root huquqi bilan ishlating: sudo bash deploy.sh"
  exit 1
fi

echo "📦 Tizim paketlari tekshirilmoqda..."
apt-get update -y
apt-get install -y curl wget git

if ! command -v docker &> /dev/null; then
    echo "🐳 Docker o'rnatilmoqda..."
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
    echo "✅ Docker muvaffaqiyatli o'rnatildi."
else
    echo "✅ Docker mavjud."
fi

if ! docker compose version &> /dev/null; then
    echo "🐳 Docker Compose plagin o'rnatilmoqda..."
    apt-get install -y docker-compose-plugin
fi

if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        echo "📝 .env.example dan .env nusxalanmoqda..."
        cp .env.example .env
    fi
fi

if [ ! -f vote_state.json ] || [ ! -s vote_state.json ]; then
    echo "{}" > vote_state.json
fi

echo "🔨 Docker konteyneri yig'ilmoqda va ishga tushirilmoqda..."
docker compose down --remove-orphans 2>/dev/null || true
docker compose up -d --build mc-afk-bot

echo ""
echo "========================================================"
echo "✅ Bot 24/7 rejimida muvaffaqiyatli ishga tushdi!"
echo "========================================================"
echo "📊 Holatni tekshirish:    docker compose ps"
echo "📜 Jonli loglar:          docker compose logs -f mc-afk-bot"
echo "🔄 Qayta ishga tushirish: docker compose restart mc-afk-bot"
echo "🛑 To'xtatish:             docker compose down"
echo "========================================================"
