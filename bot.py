import time
import sys
import threading
from datetime import datetime
from typing import Optional

import config
from vote_tracker import VoteTracker
from telegram_client import TelegramClient
from health_server import HealthServer
from user_manager import UserManager
from afk_manager import AFKManager

class MinecraftVoteBot:
    def __init__(self):
        self.tracker = VoteTracker(default_cooldown_hours=config.COOLDOWN_HOURS)
        self.client = TelegramClient(token=config.TELEGRAM_BOT_TOKEN, default_chat_id=config.TELEGRAM_CHAT_ID)
        self.vote_url = self.tracker.get_vote_url(default_url=config.DEFAULT_VOTE_URL)
        self.is_running = False

        # Yangi foydalanuvchilar va AFK bot menejerlari
        self.user_manager = UserManager()
        self.afk_manager = AFKManager()

        # Monitoring / Health serverni sozlaymiz
        self.health_server = HealthServer(
            host=config.HEALTH_HOST,
            port=config.HEALTH_PORT,
            get_status_callback=self.get_system_health_status
        )

    def _escape_html(self, text: str) -> str:
        """Telegram HTML parse_mode uchun maxsus belgilarni xavfsizlashtirish."""
        return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    def is_authorized(self, chat_id: str | int) -> bool:
        """Ovoz berish administrativ buyruqlari uchun bot egasi tekshiruvi."""
        if not config.TELEGRAM_CHAT_ID:
            return True
        return str(chat_id).strip() == str(config.TELEGRAM_CHAT_ID).strip()

    def get_system_health_status(self):
        """Health server uchun umumiy tizim holati (Ovoz + AFK botlar)."""
        summary = self.tracker.get_summary()
        summary["active_afk_bots"] = self.afk_manager.get_active_count()
        summary["max_afk_bots"] = config.MAX_ACTIVE_BOTS
        return summary

    def get_main_keyboard(self, chat_id: str):
        """Asosiy interaktiv inline tugmalar (foydalanuvchi roli hisobga olinadi)."""
        is_admin = self.user_manager.is_admin(chat_id)

        keyboard = [
            [
                {"text": "🗳 Ovoz berish sahifasini ochish", "url": self.vote_url}
            ],
            [
                {"text": "✅ Ovoz berdim (15 soat)", "callback_data": "voted_now"},
                {"text": "⏳ Qolgan vaqt", "callback_data": "check_status"}
            ],
            [
                {"text": "🎮 AFK Botni Yoqish", "callback_data": "afk_start"},
                {"text": "🛑 AFK Botni To'xtatish", "callback_data": "afk_stop"}
            ],
            [
                {"text": "📊 AFK Holati", "callback_data": "afk_status"},
                {"text": "💬 O'yinga Yozish", "callback_data": "chat_help"}
            ],
            [
                {"text": "📜 Veb Loglar", "url": "https://minecraft-afk-bot-y7ak.onrender.com/logs"},
                {"text": "⚙️ Sozlamalar", "callback_data": "bot_settings"}
            ]
        ]

        if is_admin:
            keyboard.append([
                {"text": "👑 Admin Paneli", "callback_data": "admin_panel"}
            ])

        return {"inline_keyboard": keyboard}

    def send_vote_alert(self):
        """Ovoz berish vaqti kelganda eslatma yuborish."""
        if not config.TELEGRAM_BOT_TOKEN:
            return

        text = (
            "🔔 <b>DIQQAT! Ovoz berish vaqti yetib keldi!</b>\n\n"
            "Serveringiz reytingini oshirish uchun quyidagi tugmani bosing va ovoz bering:\n"
            f"🔗 <b>Havola:</b> {self._escape_html(self.vote_url)}\n\n"
            "Ovoz berib bo'lgach, <b>«✅ Ovoz berdim»</b> tugmasini bosing, "
            "bot yangi 15 soatlik taymerni avtomatik ishga tushiradi."
        )
        success = self.client.send_message(
            text=text, 
            reply_markup=self.get_main_keyboard(config.TELEGRAM_CHAT_ID)
        )
        if success:
            self.tracker.mark_alert_sent(True)
            print("[Bot] Eslatma Telegram orqali muvaffaqiyatli jo'natildi!")

    def handle_message(self, chat_id: str, text: str, user_info: Optional[dict] = None):
        """Foydalanuvchidan kelgan buyruq va xabarlarni qayta ishlash."""
        text = text.strip()
        username = (user_info or {}).get("username", "")
        first_name = (user_info or {}).get("first_name", "")
        
        # Foydalanuvchini ro'yxatdan o'tkazish / olish
        user = self.user_manager.get_or_create_user(chat_id, username=username, first_name=first_name)
        is_admin = self.user_manager.is_admin(chat_id)

        # 1. URL yoki Timestamp kiritilgan bo'lsa (masalan error=2&time=1794836617)
        parsed_ts = self.tracker.parse_time_from_url_or_text(text)
        if parsed_ts is not None:
            if not self.is_authorized(chat_id):
                self.client.send_message(
                    "❌ <b>Ruxsat berilmagan!</b> Ushbu bot faqat uning egasi uchun sozlangan.",
                    chat_id=chat_id
                )
                return

            if parsed_ts <= int(time.time()):
                msg = (
                    "⚠️ <b>Kutilgan vaqt allaqachon o'tib bo'lgan!</b>\n\n"
                    "Iltimos, saytga kirib yangidan ovoz bering va so'nggi havolani yuboring.\n"
                    f"🔗 {self._escape_html(self.vote_url)}"
                )
                self.client.send_message(msg, chat_id=chat_id, reply_markup=self.get_main_keyboard(chat_id))
                return

            self.tracker.set_next_vote_time(parsed_ts)
            dt_str = datetime.fromtimestamp(parsed_ts).strftime("%Y-%m-%d %H:%M:%S")
            msg = (
                f"✅ <b>Vaqt belgilandi!</b>\n"
                f"Sayt bergan ma'lumotga ko'ra keyingi ovoz berish vaqti:\n"
                f"🕒 <b>{dt_str}</b>\n"
                f"⏳ Qolgan vaqt: <b>{self.tracker.format_remaining_time()}</b>"
            )
            self.client.send_message(msg, chat_id=chat_id, reply_markup=self.get_main_keyboard(chat_id))
            return

        # 2. Buyruqlar
        if text.startswith("/start") or text.startswith("/help"):
            can_access, access_msg = self.user_manager.can_use_bot(chat_id)
            mc_conf = self.user_manager.get_mc_config(chat_id)
            
            role_badge = "👑 <b>Admin</b>" if is_admin else f"👤 <b>Holatingiz:</b> {access_msg}"

            msg = (
                "👋 <b>Minecraft 24/7 Vote & AFK Botiga xush kelibsiz!</b>\n\n"
                f"{role_badge}\n\n"
                "📌 <b>Asosiy Imkoniyatlar:</b>\n"
                "1. <b>Ovoz berish eslatmasi</b>: Har 15 soatda serveringiz uchun ovoz berish vaqtini bildiradi.\n"
                "2. <b>Minecraft 24/7 AFK Bot</b>: Serverga kirib, <code>/server economy</code> ga o'tadi va <code>/afk</code> bo'lib 24/7 turadi.\n\n"
                f"🎮 <b>Hozirgi AFK Bot Niki:</b> <code>{mc_conf.get('username')}</code>\n"
                f"🌐 <b>Server:</b> <code>{mc_conf.get('host')}:{mc_conf.get('port')}</code> (Subserver: <code>{mc_conf.get('subserver')}</code>)\n\n"
                "📋 <b>Mavjud Buyruqlar:</b>\n"
                "• /logs — Jonli veb-terminal havolasini olish (Oxirgi 2 soatlik loglar)\n"
                "• /settings — Barcha bot sozlamalari va ma'lumotlarini ko'rish\n"
                "• /say [xabar] — Minecraft o'yin chatiga xabar yozish\n"
                "• /cmd [buyruq] — Minecraft serveriga buyruq yuborish (masalan: /cmd /spawn)\n"
                "• /ping — Bot va server holatini tekshirish\n"
                "• /seturl [havola] — Ovoz berish sayti havolasini o'zgartirish\n"
                "• /setcooldown [soat] — Taymer oraliq vaqtini o'zgartirish (masalan: 15)\n"
                "• /afk_start — AFK botni ishga tushirish\n"
                "• /afk_stop — AFK botni to'xtatish\n"
                "• /afk_status — Bot holati va oxirgi loglarni ko'rish\n"
                "• /setnick [nik] — O'yinchi nikini o'zgartirish\n"
                "• /setpass [parol] — /login parolini o'rnatish\n"
                "• /setserver [ip] [port] [subserver] — Server manzilini sozlash\n"
                "• /status — Ovoz berish taymeri holati\n"
                "• /voted — Ovoz berilganini tasdiqlash\n"
                "• Saytdan chiqqan havolani (?error=2&amp;time=...) to'g'ridan-to'g'ri tashlasangiz ham, bot avtomatik aniqlaydi."
            )
            if is_admin:
                msg += "\n\n👑 <b>Admin Buyruqlari:</b>\n• /admin — Admin paneli\n• /grant [chat_id] [kunlar] — Obuna muddatini berish\n• /users — Foydalanuvchilar ro'yxati"

            self.client.send_message(msg, chat_id=chat_id, reply_markup=self.get_main_keyboard(chat_id))

        # AFK Bot buyruqlari
        elif text.startswith("/afk_start"):
            can_access, access_msg = self.user_manager.can_use_bot(chat_id)
            if not can_access:
                self.client.send_message(f"❌ <b>Ruxsat berilmadi:</b>\n{access_msg}", chat_id=chat_id)
                return

            mc_conf = self.user_manager.get_mc_config(chat_id)
            success, result_msg = self.afk_manager.start_user_bot(chat_id, mc_conf)
            if success:
                msg = (
                    "🚀 <b>Minecraft AFK Bot ishga tushirilmoqda!</b>\n\n"
                    f"• O'yinchi niki: <code>{mc_conf.get('username')}</code>\n"
                    f"• Server: <code>{mc_conf.get('host')}:{mc_conf.get('port')}</code>\n"
                    f"• Maqsad: <code>/server {mc_conf.get('subserver')}</code> -> <code>/afk</code>\n\n"
                    "Holatni ko'rish uchun <b>/afk_status</b> buyrug'idan foydalaning."
                )
            else:
                msg = f"⚠️ <b>Ishga tushirib bo'lmadi:</b>\n{result_msg}"
            self.client.send_message(msg, chat_id=chat_id, reply_markup=self.get_main_keyboard(chat_id))

        elif text.startswith("/afk_stop"):
            success, result_msg = self.afk_manager.stop_user_bot(chat_id)
            self.client.send_message(f"🛑 <b>{result_msg}</b>", chat_id=chat_id, reply_markup=self.get_main_keyboard(chat_id))

        elif text.startswith("/afk_status"):
            info = self.afk_manager.get_user_status(chat_id)
            if not info or info.get("status") == "stopped":
                msg = "💤 <b>Sizning AFK botingiz hozirda to'xtatilgan.</b>\nIshga tushirish uchun: /afk_start"
            else:
                afk_icon = "🟢 Faol" if info.get("is_afk") else "🟡 Kutilmoqda / Ulanmoqda"
                logs_text = "\n".join(info.get("recent_logs", [])) or "Hozircha xabarlar yo'q."
                h_val = info.get("health")
                f_val = info.get("food")
                h_str = f"<b>{h_val:.0f}/20</b> ❤️" if h_val is not None else "Aniqlanmoqda..."
                f_str = f"<b>{f_val:.0f}/20</b> 🍗" if f_val is not None else "Aniqlanmoqda..."
                msg = (
                    "📊 <b>AFK Bot Holati:</b>\n\n"
                    f"• Bot niki: <code>{info.get('username')}</code>\n"
                    f"• Holat: <b>{info.get('status')}</b>\n"
                    f"• Server: <b>{info.get('server')}</b>\n"
                    f"• AFK rejimi: <b>{afk_icon}</b>\n"
                    f"• Jon (Health): {h_str}\n"
                    f"• To'qlik (Food): {f_str}\n"
                    f"• Ish vaqti (uptime): <b>{info.get('uptime_text')}</b>\n\n"
                    f"📝 <b>Oxirgi voqealar:</b>\n<code>{logs_text}</code>"
                )
            self.client.send_message(msg, chat_id=chat_id, reply_markup=self.get_main_keyboard(chat_id))

        elif text.startswith("/setnick"):
            parts = text.split(maxsplit=1)
            if len(parts) > 1:
                nick = parts[1].strip()
                self.user_manager.update_mc_config(chat_id, username=nick)
                msg = f"✅ Minecraft niki <code>{nick}</code> qilib belgilandi."
            else:
                msg = "❌ Masalan: <code>/setnick MegaGamer</code> ko'rinishida yuboring."
            self.client.send_message(msg, chat_id=chat_id, reply_markup=self.get_main_keyboard(chat_id))

        elif text.startswith("/setpass"):
            parts = text.split(maxsplit=1)
            if len(parts) > 1:
                pwd = parts[1].strip()
                self.user_manager.update_mc_config(chat_id, password=pwd)
                msg = "✅ Server paroli (/login) xavfsiz saqlandi."
            else:
                msg = "❌ Masalan: <code>/setpass MaxfiyParol123</code> ko'rinishida yuboring."
            self.client.send_message(msg, chat_id=chat_id)

        elif text.startswith("/settings"):
            mc_conf = self.user_manager.get_mc_config(chat_id)
            cd_hours = self.tracker.state.get('cooldown_hours', config.COOLDOWN_HOURS)
            msg = (
                "⚙️ <b>Bot Ma'lumotlari va Sozlamalari:</b>\n\n"
                f"🔗 <b>Ovoz berish / sayt havolasi:</b>\n<code>{self.vote_url}</code>\n"
                f"<i>O'zgartirish:</i> <code>/seturl https://yangi-sayt...</code>\n\n"
                f"⏱ <b>Taymer oraliq vaqti:</b> <code>{cd_hours} soat</code>\n"
                f"<i>O'zgartirish:</i> <code>/setcooldown 15</code>\n\n"
                f"🎮 <b>AFK Bot Niki:</b> <code>{mc_conf.get('username')}</code>\n"
                f"<i>O'zgartirish:</i> <code>/setnick YangiNik</code>\n\n"
                f"🔑 <b>Minecraft Paroli:</b> <code>{'O\'rnatilgan ✅' if mc_conf.get('password') else 'O\'rnatilmagan ⚠️'}</code>\n"
                f"<i>O'zgartirish:</i> <code>/setpass YangiParol</code>\n\n"
                f"🌐 <b>Server:</b> <code>{mc_conf.get('host')}:{mc_conf.get('port')}</code> (Subserver: <code>{mc_conf.get('subserver')}</code>)\n"
                f"<i>O'zgartirish:</i> <code>/setserver host port subserver</code>\n\n"
                f"⚡️ <b>Render Keep-Alive URL:</b>\n<code>https://minecraft-afk-bot-y7ak.onrender.com/health</code>\n\n"
                f"🌐 <b>Jonli Veb-Loglar (2 soatlik Qora quti):</b>\n<code>https://minecraft-afk-bot-y7ak.onrender.com/logs</code>"
            )
            self.client.send_message(msg, chat_id=chat_id, reply_markup=self.get_main_keyboard(chat_id))

        elif text.startswith("/logs"):
            logs_url = "https://minecraft-afk-bot-y7ak.onrender.com/logs"
            msg = (
                "🌐 <b>Jonli Veb-Terminal (Server Loglari):</b>\n\n"
                f"🔗 <a href=\"{logs_url}\">{logs_url}</a>\n\n"
                "• ⏱ <b>Qora quti:</b> Oxirgi 2 soatlik loglar xotirada saqlanadi.\n"
                "• 🚀 Avtomatik yangilanadi, hech qanday lag va sekinlashuv bo'lmaydi.\n"
                "• 📱 Telefon va kompyuter brauzerida ochib kuzatib turishingiz mumkin!"
            )
            keyboard = {
                "inline_keyboard": [
                    [{"text": "🚀 Veb-Terminalni Ochish", "url": logs_url}],
                    [{"text": "⏳ Qolgan vaqt", "callback_data": "check_status"}]
                ]
            }
            self.client.send_message(msg, chat_id=chat_id, reply_markup=keyboard)

        elif text.startswith("/say"):
            parts = text.split(maxsplit=1)
            if len(parts) > 1:
                msg_to_send = parts[1].strip()
                ok, res = self.afk_manager.send_user_chat(chat_id, msg_to_send)
                self.client.send_message(f"{'✅' if ok else '❌'} {res}", chat_id=chat_id)
            else:
                self.client.send_message("❌ Masalan: <code>/say Salom barchaga!</code> ko'rinishida yuboring.", chat_id=chat_id)

        elif text.startswith("/cmd"):
            parts = text.split(maxsplit=1)
            if len(parts) > 1:
                cmd_to_send = parts[1].strip()
                if not cmd_to_send.startswith("/"):
                    cmd_to_send = f"/{cmd_to_send}"
                ok, res = self.afk_manager.send_user_chat(chat_id, cmd_to_send)
                self.client.send_message(f"{'✅' if ok else '❌'} {res}", chat_id=chat_id)
            else:
                self.client.send_message("❌ Masalan: <code>/cmd /spawn</code> yoki <code>/cmd /balance</code> ko'rinishida yuboring.", chat_id=chat_id)

        elif text.startswith("/ping"):
            summary = self.tracker.get_summary()
            self.client.send_message(
                "🏓 <b>Pong!</b> Bot serverda 24/7 faol ishlamoqda.\n\n"
                f"• Server holati: 🟢 <b>A'lo</b>\n"
                f"• Taymer: <b>{summary['remaining_text']}</b>\n"
                f"• Jonli veb-terminal: <a href=\"https://minecraft-afk-bot-y7ak.onrender.com/logs\">Ko'rish</a>",
                chat_id=chat_id,
                reply_markup=self.get_main_keyboard(chat_id)
            )

        elif text.startswith("/seturl") or text.startswith("/setvoteurl"):
            if not self.is_authorized(chat_id):
                self.client.send_message(
                    "❌ <b>Ruxsat berilmagan!</b> Ushbu sozlamani faqat bot egasi o'zgartira oladi.",
                    chat_id=chat_id
                )
                return

            parts = text.split(maxsplit=1)
            if len(parts) > 1 and parts[1].strip().startswith("http"):
                new_url = parts[1].strip()
                self.vote_url = new_url
                self.tracker.set_vote_url(new_url)
                msg = (
                    "✅ <b>Ovoz berish sayti havolasi muvaffaqiyatli saqlandi!</b>\n\n"
                    f"🔗 Yangi havola:\n<code>{self._escape_html(new_url)}</code>\n\n"
                    "Barcha menyu tugmalari va eslatmalar endi shu havoladan foydalanadi."
                )
            else:
                msg = "❌ Masalan: <code>/seturl https://minecraft-mp.com/server/350645/vote/</code> ko'rinishida yuboring."
            self.client.send_message(msg, chat_id=chat_id, reply_markup=self.get_main_keyboard(chat_id))

        # Ovoz berish buyruqlari
        elif text.startswith("/status"):
            summary = self.tracker.get_summary()
            msg = (
                "📊 <b>Hozirgi holat:</b>\n\n"
                f"• Holat: <b>{summary['status']}</b>\n"
                f"• Qolgan vaqt: <b>{summary['remaining_text']}</b>\n"
                f"• Keyingi ovoz berish: <b>{summary['next_vote_time']}</b>\n"
                f"• Oxirgi ovoz: <b>{summary['last_vote_time']}</b>\n"
                f"• Jami qayd etilgan: <b>{summary['total_votes']} marta</b>\n"
                f"• Oraliq (interval): <b>{summary['cooldown_hours']} soat</b>"
            )
            self.client.send_message(msg, chat_id=chat_id, reply_markup=self.get_main_keyboard(chat_id))

        elif text.startswith("/voted"):
            if not self.is_authorized(chat_id):
                self.client.send_message(
                    "❌ <b>Ruxsat berilmagan!</b> Ushbu bot faqat uning egasi uchun sozlangan.",
                    chat_id=chat_id
                )
                return

            self.tracker.record_vote()
            msg = (
                "🎉 <b>Ajoyib! Ovoz qabul qilindi.</b>\n\n"
                f"⏱ Yangi {self.tracker.state.get('cooldown_hours')} soatlik taymer ishga tushirildi.\n"
                f"Vaqt kelganda bot sizni ogohlantiradi!"
            )
            self.client.send_message(msg, chat_id=chat_id, reply_markup=self.get_main_keyboard(chat_id))

        elif text.startswith("/vote"):
            msg = f"🗳 <b>Ovoz berish havolasi:</b>\n{self._escape_html(self.vote_url)}"
            self.client.send_message(msg, chat_id=chat_id, reply_markup=self.get_main_keyboard(chat_id))

        elif text.startswith("/setcooldown"):
            if not self.is_authorized(chat_id):
                self.client.send_message(
                    "❌ <b>Ruxsat berilmagan!</b> Ushbu bot faqat uning egasi uchun sozlangan.",
                    chat_id=chat_id
                )
                return

            parts = text.split()
            if len(parts) > 1:
                try:
                    hours = float(parts[1])
                    if hours <= 0:
                        msg = "❌ Xatolik. Oraliq vaqt 0 dan katta bo'lishi kerak."
                    else:
                        self.tracker.set_cooldown_hours(hours)
                        msg = f"✅ Taymer oraliq vaqti <b>{hours} soat</b> qilib belgilandi."
                except ValueError:
                    msg = "❌ Xatolik. Raqam kiriting. Masalan: <code>/setcooldown 15</code>"
            else:
                msg = "❌ Masalan: <code>/setcooldown 15</code> ko'rinishida yuboring."
            self.client.send_message(msg, chat_id=chat_id)

        # Admin Buyruqlari
        elif text.startswith("/admin"):
            if not is_admin:
                self.client.send_message("❌ Ushbu bo'lim faqat Admin uchun.", chat_id=chat_id)
                return
            users = self.user_manager.list_all_users()
            active_bots = self.afk_manager.get_active_count()
            msg = (
                "👑 <b>Admin Boshqaruv Paneli:</b>\n\n"
                f"• Jami foydalanuvchilar: <b>{len(users)} ta</b>\n"
                f"• Hozirda faol AFK botlar: <b>{active_bots} / {config.MAX_ACTIVE_BOTS} ta</b>\n\n"
                "<b>Mavjud buyruqlar:</b>\n"
                "• <code>/stats</code> — Tizim va obuna to'liq statistikasi\n"
                "• <code>/grant [chat_id] [kunlar]</code> — Premium obuna berish\n"
                "• <code>/ban [chat_id]</code> — Foydalanuvchini bloklash\n"
                "• <code>/unban [chat_id]</code> — Blokdan chiqarish\n"
                "• <code>/users</code> — Foydalanuvchilar ro'yxatini ko'rish"
            )
            self.client.send_message(msg, chat_id=chat_id)

        elif text.startswith("/stats"):
            if not is_admin:
                return
            st = self.user_manager.get_stats()
            active_bots = self.afk_manager.get_active_count()
            msg = (
                "📈 <b>Tizim Foydalanuvchilari Statistikasi:</b>\n\n"
                f"👥 Jami ro'yxatdan o'tganlar: <b>{st['total']} ta</b>\n"
                f"👑 Adminlar: <b>{st['admin']} ta</b>\n"
                f"⭐ Premium foydalanuvchilar: <b>{st['premium']} ta</b>\n"
                f"⏳ Sinov (Trial) foydalanuvchilari: <b>{st['trial']} ta</b>\n"
                f"⚠️ Obunasi tugaganlar: <b>{st['expired']} ta</b>\n"
                f"🚫 Bloklanganlar: <b>{st['banned']} ta</b>\n\n"
                f"🎮 Hozirda faol AFK botlar: <b>{active_bots} / {config.MAX_ACTIVE_BOTS} ta</b>"
            )
            self.client.send_message(msg, chat_id=chat_id)

        elif text.startswith("/ban"):
            if not is_admin:
                return
            parts = text.split()
            if len(parts) > 1:
                target_id = parts[1].strip()
                ok, res_msg = self.user_manager.ban_user(target_id)
                self.afk_manager.stop_user_bot(target_id)
                self.client.send_message(res_msg, chat_id=chat_id)
            else:
                self.client.send_message("❌ Masalan: <code>/ban 123456789</code>", chat_id=chat_id)

        elif text.startswith("/unban"):
            if not is_admin:
                return
            parts = text.split()
            if len(parts) > 1:
                target_id = parts[1].strip()
                ok, res_msg = self.user_manager.unban_user(target_id)
                self.client.send_message(res_msg, chat_id=chat_id)
            else:
                self.client.send_message("❌ Masalan: <code>/unban 123456789</code>", chat_id=chat_id)

        elif text.startswith("/grant"):
            if not is_admin:
                return
            parts = text.split()
            if len(parts) >= 3:
                target_id = parts[1].strip()
                try:
                    days = float(parts[2].strip())
                    success, res_msg = self.user_manager.grant_premium(target_id, days)
                    self.client.send_message(f"✅ {res_msg}", chat_id=chat_id)
                    # Foydalanuvchiga xabar yuborish
                    self.client.send_message(
                        f"🎉 <b>Tabriklaymiz!</b> Sizga Admin tomonidan {days} kunlik Premium obuna berildi!",
                        chat_id=target_id
                    )
                except ValueError:
                    self.client.send_message("❌ Kunlar soni raqam bo'lishi kerak. Masalan: <code>/grant 123456789 30</code>", chat_id=chat_id)
            else:
                self.client.send_message("❌ Masalan: <code>/grant 123456789 30</code>", chat_id=chat_id)

        elif text.startswith("/users"):
            if not is_admin:
                return
            users = self.user_manager.list_all_users()
            lines = ["👥 <b>Foydalanuvchilar Ro'yxati:</b>\n"]
            for u in users:
                cid = u.get("chat_id")
                uname = f"@{u.get('username')}" if u.get("username") else u.get("first_name", "Noma'lum")
                role = u.get("role", "trial")
                lines.append(f"• <code>{cid}</code> | {uname} | <b>{role}</b>")
            self.client.send_message("\n".join(lines), chat_id=chat_id)

    def handle_callback_query(self, query: dict):
        """Tugmalar bosilganda ishlov berish."""
        query_id = query.get("id")
        data = query.get("data")
        message = query.get("message", {})
        chat_id = str(message.get("chat", {}).get("id", ""))

        if data == "voted_now":
            if not self.is_authorized(chat_id):
                self.client.answer_callback_query(query_id, text="Ruxsat berilmagan!")
                return
            self.tracker.record_vote()
            self.client.answer_callback_query(query_id, text="Qayd etildi! 15 soat taymer boshlandi.")
            self.client.send_message(
                f"✅ Ovoz qayd etildi! Keyingi eslatma: <b>{self.tracker.format_remaining_time()}</b> so'ng yuboriladi.",
                chat_id=chat_id,
                reply_markup=self.get_main_keyboard(chat_id)
            )

        elif data == "check_status":
            rem_text = self.tracker.format_remaining_time()
            self.client.answer_callback_query(query_id, text=f"Qolgan vaqt: {rem_text}")
            self.client.send_message(
                f"⏳ Qolgan vaqt: <b>{rem_text}</b>",
                chat_id=chat_id,
                reply_markup=self.get_main_keyboard(chat_id)
            )

        elif data == "afk_start":
            self.client.answer_callback_query(query_id, text="AFK Bot ishga tushirilmoqda...")
            self.handle_message(chat_id, "/afk_start")

        elif data == "afk_stop":
            self.client.answer_callback_query(query_id, text="AFK Bot to'xtatilmoqda...")
            self.handle_message(chat_id, "/afk_stop")

        elif data == "afk_status":
            self.client.answer_callback_query(query_id, text="Holat tekshirilmoqda...")
            self.handle_message(chat_id, "/afk_status")

        elif data in ["afk_settings", "bot_settings"]:
            self.client.answer_callback_query(query_id, text="Sozlamalar")
            self.handle_message(chat_id, "/settings")

        elif data == "chat_help":
            self.client.answer_callback_query(query_id, text="O'yinga xabar yozish")
            msg = (
                "💬 <b>Minecraft o'yiniga Telegramdan xabar yozish:</b>\n\n"
                "• <b>Oddiy chat xabari:</b>\n"
                "<code>/say Salom barchaga!</code>\n\n"
                "• <b>O'yin buyrug'i:</b>\n"
                "<code>/cmd /spawn</code> yoki <code>/cmd /balance</code>\n\n"
                "<i>(Buning uchun AFK botingiz /afk_start orqali serverda bo'lishi kerak)</i>"
            )
            self.client.send_message(msg, chat_id=chat_id, reply_markup=self.get_main_keyboard(chat_id))

        elif data == "admin_panel":
            self.client.answer_callback_query(query_id, text="Admin panel")
            self.handle_message(chat_id, "/admin")

    def scheduler_loop(self):
        """Orqa fonda vaqtni tekshirib turuvchi rejalashtiruvchi."""
        print("[Scheduler] Fon monitoringi ishga tushdi.")
        while self.is_running:
            try:
                # Agar Telegram token bo'lmasa, eslatma yuborishni o'tkazib yuboramiz
                if not config.TELEGRAM_BOT_TOKEN:
                    time.sleep(20)
                    continue

                # 1. Ovoz berish vaqti
                if self.tracker.should_send_alert():
                    print("[Scheduler] Ovoz berish vaqti yetdi, xabar yuborilmoqda...")
                    self.send_vote_alert()

                # 2. Obunasi tugagan foydalanuvchilarning botini to'xtatish
                for uid, session in list(self.afk_manager.sessions.items()):
                    if session.is_running:
                        can_access, _ = self.user_manager.can_use_bot(uid)
                        if not can_access:
                            print(f"[Scheduler] Foydalanuvchi {uid} obunasi tugadi, bot to'xtatilmoqda...")
                            session.stop()
                            self.client.send_message(
                                "⚠️ <b>Obunangiz (sinov muddati) tugadi!</b>\n"
                                "Sizning Minecraft AFK botingiz avtomatik to'xtatildi. "
                                "Davom ettirish uchun obuna sotib oling.",
                                chat_id=uid
                            )
            except Exception as e:
                print(f"[Scheduler] Xatolik: {e}")
            time.sleep(20)

    def polling_loop(self):
        """Telegram xabarlarini doimiy qabul qilish sikli."""
        print("[Polling] Telegram xabarlarini qabul qilish boshlandi...")
        offset = 0
        while self.is_running:
            try:
                updates = self.client.get_updates(offset=offset, timeout=15)
                for update in updates:
                    offset = update.get("update_id", 0) + 1
                    if "message" in update:
                        msg = update["message"]
                        chat_id = str(msg.get("chat", {}).get("id", ""))
                        text = msg.get("text", "")
                        user_info = msg.get("from", {})
                        if text:
                            self.handle_message(chat_id, text, user_info=user_info)
                    elif "callback_query" in update:
                        self.handle_callback_query(update["callback_query"])
            except Exception as e:
                print(f"[Polling] Xatolik: {e}")
                time.sleep(3)

    def run(self):
        """Botni barcha modullari bilan ishga tushirish."""
        self.is_running = True
        print("[System] Minecraft Vote & AFK Bot ishga tushmoqda...")

        # 1. Healthcheck HTTP serverini yoqish
        self.health_server.start()
        self.health_server.start_keep_alive()

        # 2. Scheduler fon oqimini yoqish
        scheduler_thread = threading.Thread(target=self.scheduler_loop, daemon=True)
        scheduler_thread.start()

        # 3. Telegram polling va buyruqlar menyusini sozlash
        if config.TELEGRAM_BOT_TOKEN:
            try:
                commands = [
                    {"command": "start", "description": "Asosiy menyu va hisob holati"},
                    {"command": "status", "description": "Ovoz berish taymeri va eslatma"},
                    {"command": "voted", "description": "Ovoz berilganini tasdiqlash"},
                    {"command": "afk_start", "description": "Minecraft AFK botni yoqish"},
                    {"command": "afk_stop", "description": "AFK botni to'xtatish"},
                    {"command": "afk_status", "description": "AFK bot holati va loglar"},
                    {"command": "say", "description": "Minecraft o'yinga xabar yozish"},
                    {"command": "cmd", "description": "Minecraft o'yinga buyruq yuborish"},
                    {"command": "logs", "description": "Jonli veb-terminal havolasi"},
                    {"command": "settings", "description": "Barcha sozlamalar boshqaruvi"},
                    {"command": "ping", "description": "Bot holatini tekshirish"}
                ]
                self.client.set_my_commands(commands)
            except Exception as e:
                print(f"[Bot] Menyuni sozlashda ogohlantirish: {e}")
            self.polling_loop()
        else:
            print("[Warning] TELEGRAM_BOT_TOKEN kiritilmagan. Bot faqat Health Server rejimida ishlaydi.")
            try:
                while self.is_running:
                    time.sleep(1)
            except KeyboardInterrupt:
                self.stop()

    def stop(self):
        self.is_running = False
        self.health_server.stop()
        self.afk_manager.stop_all()
        print("[System] Bot va barcha AFK sessiyalari to'xtatildi.")

if __name__ == "__main__":
    bot = MinecraftVoteBot()
    try:
        bot.run()
    except KeyboardInterrupt:
        bot.stop()
        sys.exit(0)
