FROM python:3.12-slim

# Node.js va npm o'rnatish (Mineflayer uchun)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python va Node.js bog'liqliklarini keshdan o'rnatish
COPY requirements.txt package*.json ./
RUN pip install --no-cache-dir -r requirements.txt \
    && npm install --omit=dev

# Loyiha fayllarini ko'chirish
COPY . .

# Healthcheck porti
EXPOSE 8080

# Standart ishga tushirish buyrug'i
CMD ["python", "bot.py"]
