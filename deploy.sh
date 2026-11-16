#!/bin/bash
set -e

echo "=========================================="
echo "🚀 Minecraft Vote & AFK Bot Server Deploy"
echo "=========================================="

# 1. Root huquqini tekshirish
if [ "$EUID" -ne 0 ]; then
  echo "⚠️ Iltimos, skriptni root huquqi bilan ishlating: sudo bash deploy.sh"
  exit 1
fi

# 2. Tizim paketlarini yangilash
echo "📦 Tizim paketlari tekshirilmoqda..."
apt-get update -y
apt-get install -y curl wget git nano

# 3. Docker o'rnatilganligini tekshirish
if ! command -v docker &> /dev/null; then
    echo "🐳 Docker o'rnatilmoqda..."
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
    echo "✅ Docker muvaffaqiyatli o'rnatildi."
else
    echo "✅ Docker mavjud."
fi

# 4. Docker Compose tekshirish
if ! docker compose version &> /dev/null; then
    echo "🐳 Docker Compose plagin o'rnatilmoqda..."
    apt-get install -y docker-compose-plugin
fi

# 5. .env konfiguratsiyasini tekshirish
if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        echo "📝 .env fayli topilmadi. .env.example dan nusxa olinmoqda..."
        cp .env.example .env
        echo "⚠️ Iltimos, .env faylini ochib, bot tokeni va admin ID'larini kiriting!"
        read -p ".env faylini hozir tahrirlashni xohlaysizmi? (ha/yoq): " edit_env
        if [[ "$edit_env" =~ ^[HhYy] ]]; then
            nano .env
        fi
    else
        echo "❌ .env.example topilmadi!"
        exit 1
    fi
fi

# 6. JSON ma'lumotlar bazalarini tayyorlash (Docker papka qilib olmasligi uchun)
if [ ! -f vote_state.json ] || [ ! -s vote_state.json ]; then
    echo "{}" > vote_state.json
fi

if [ ! -f users.json ] || [ ! -s users.json ]; then
    echo "{}" > users.json
fi

# 7. Konteynerni yig'ish va ishga tushirish
echo "🔨 Docker konteyneri yig'ilmoqda va ishga tushirilmoqda..."
docker compose down --remove-orphans 2>/dev/null || true
docker compose up -d --build vote-bot

echo ""
echo "========================================================"
echo "✅ Bot serverda 24/7 rejimida muvaffaqiyatli ishga tushdi!"
echo "========================================================"
echo "📊 Holatni tekshirish:  docker compose ps"
echo "📜 Jonli loglar:        docker compose logs -f vote-bot"
echo "🔄 Qayta ishga tushirish: docker compose restart vote-bot"
echo "🛑 To'xtatish:           docker compose down"
echo "========================================================"
