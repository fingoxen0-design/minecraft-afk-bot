# 🚀 Minecraft 24/7 Headless AFK Bot (Pure Node.js)

Ushbu loyiha shaxsiy kompyuterni yoqib qo'ymasdan:
1. **Minecraft serverda hisobingizni 24/7 onlayn ushlab turish** (Render bulutida avtomatik ishga tushadi);
2. **Serverga avtomatik kirish, `/login`, `/server economy` ga o'tish va `/afk` rejimida turish**;
3. **Map Captcha OCR va Anti-Kick** (xarita orqali beriladigan captcha kodlarini avtomatik yechish va kickinga tushmaslik);
4. **4 ta alohida Ovoz Berish (Vote) taymerlari va monitoringi**;
5. **Render Anti-Sleep (KeepAlive)** orqali bepul serverni 24/7 uyg'oq saqlash;
6. **Veb Dashboard va Jonli Terminal** (`/` yoki `/logs`) orqali real-vaqtda loglarni kuzatish va botni boshqarish uchun ishlab chiqilgan.

> **100% Sof JavaScript (Node.js)**: Python yoki Telegram talab etilmaydi. Yengil `node:20-alpine` konteynerida tezkor ishlaydi.

---

## ⚙️ Sozlamalar (`.env`)

```ini
# Minecraft Server & Hisob Sozlamalari
MC_HOST=allaysmp.pro
MC_PORT=25565
MC_VERSION=1.21.1
MC_SUBSERVER=economy
MC_USERNAME=Gotto
MC_PASSWORD=bunyod
AUTO_AFK_ON_BOOT=true

# 4 ta Ovoz Berish (Vote) Saytlari
VOTE_1_URL=https://minecraft-mp.com/server/350645/vote/
VOTE_2_URL=
VOTE_3_URL=
VOTE_4_URL=
COOLDOWN_HOURS=15.0

# Render Veb & Anti-Sleep
PORT=8080
RENDER_EXTERNAL_URL=https://minecraft-afk-bot-y7ak.onrender.com
ENABLE_KEEP_ALIVE=true
KEEP_ALIVE_INTERVAL=600
```

---

## 🚀 Render.com da Ishga Tushirish

1. Repozitoriyani [Render.com](https://render.com) ga **Web Service** sifatida ulang.
2. Sozlamalar:
   - **Environment**: `Docker` (yoki `Node`)
   - **Build Command**: `npm install --omit=dev`
   - **Start Command**: `node bot.js`
3. Environment Variables (Muhit o'zgaruvchilari):
   - `.env.example` dagi o'zgaruvchilarni kiriting.
4. Veb Dashboard manzili: `https://<your-service>.onrender.com/logs`

---

## 💻 Mahalliy (Local) Ishga Tushirish

```bash
npm install
npm start
```

Testlarni yurgizish:
```bash
npm test
```
