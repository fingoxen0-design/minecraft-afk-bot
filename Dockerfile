FROM node:20-alpine

WORKDIR /app

# Paket bog'liqliklarini o'rnatish
COPY package*.json ./
RUN npm install --omit=dev

# Loyiha fayllarini nusxalash
COPY . .

# Render Veb Porti
EXPOSE 8080

# 24/7 Node.js Bot va Veb Serverni ishga tushirish
CMD ["node", "bot.js"]
