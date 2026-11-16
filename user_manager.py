import json
import time
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import config

class UserManager:
    """Foydalanuvchilar, rollar (Admin, Trial, Premium) va Minecraft sozlamalarini boshqarish."""

    def __init__(self, db_path: Optional[str] = None):
        if db_path:
            self.db_path = Path(db_path)
        else:
            self.db_path = Path(__file__).resolve().parent / "users.json"
        self.users: Dict[str, Dict[str, Any]] = {}
        self.load()

    def load(self):
        """Foydalanuvchilar bazasini json fayldan o'qish."""
        if self.db_path.is_file():
            try:
                with open(self.db_path, "r", encoding="utf-8") as f:
                    self.users = json.load(f)
            except Exception as e:
                print(f"[UserManager] Bazani o'qishda xatolik: {e}")
                self.users = {}
        else:
            self.users = {}

    def save(self):
        """Ma'lumotlarni xavfsiz (atomar) yozish."""
        temp_file = self.db_path.with_suffix(".tmp")
        try:
            with open(temp_file, "w", encoding="utf-8") as f:
                json.dump(self.users, f, indent=2, ensure_ascii=False)
            temp_file.replace(self.db_path)
        except Exception as e:
            print(f"[UserManager] Saqlashda xatolik: {e}")
            if temp_file.is_file():
                temp_file.unlink(missing_ok=True)

    def is_admin(self, chat_id: str | int) -> bool:
        """Foydalanuvchi Admin ekanligini tekshirish."""
        cid = str(chat_id).strip()
        return cid in config.ADMIN_USER_IDS

    def get_or_create_user(self, chat_id: str | int, username: str = "", first_name: str = "") -> Dict[str, Any]:
        """Foydalanuvchini olish yoki yangi ro'yxatdan o'tkazish (Trial 24 soat berish)."""
        cid = str(chat_id).strip()
        now = time.time()

        if cid not in self.users:
            role = "admin" if self.is_admin(cid) else "trial"
            trial_duration_sec = config.TRIAL_DURATION_HOURS * 3600
            expires_at = None if role == "admin" else (now + trial_duration_sec)

            default_username = config.DEFAULT_MC_USERNAME if role == "admin" else f"Player_{cid[-4:]}"
            default_password = config.DEFAULT_MC_PASSWORD if role == "admin" else ""

            self.users[cid] = {
                "chat_id": cid,
                "username": username,
                "first_name": first_name,
                "role": role,
                "created_at": now,
                "trial_start": now,
                "expires_at": expires_at,
                "mc_config": {
                    "username": default_username,
                    "password": default_password,
                    "host": config.DEFAULT_MC_HOST,
                    "port": config.DEFAULT_MC_PORT,
                    "version": config.DEFAULT_MC_VERSION,
                    "subserver": config.DEFAULT_MC_SUBSERVER
                }
            }
            self.save()
        else:
            # Username yoki first_name yangilangan bo'lsa
            user = self.users[cid]
            if username and user.get("username") != username:
                user["username"] = username
            if first_name and user.get("first_name") != first_name:
                user["first_name"] = first_name
            # Admin ro'yxatida bo'lsa rolni admin qilish
            if self.is_admin(cid):
                if user.get("role") != "admin":
                    user["role"] = "admin"
                    user["expires_at"] = None
                mc_conf = user.setdefault("mc_config", {})
                if not mc_conf.get("username") or mc_conf.get("username").startswith("Player_"):
                    mc_conf["username"] = config.DEFAULT_MC_USERNAME
                if not mc_conf.get("password"):
                    mc_conf["password"] = config.DEFAULT_MC_PASSWORD
                if not mc_conf.get("host") or mc_conf.get("host") == "127.0.0.1":
                    mc_conf["host"] = config.DEFAULT_MC_HOST
                if not mc_conf.get("subserver"):
                    mc_conf["subserver"] = config.DEFAULT_MC_SUBSERVER
                self.save()

        return self.users[cid]

    def can_use_bot(self, chat_id: str | int) -> Tuple[bool, str]:
        """
        Foydalanuvchi AFK botdan foydalanish huquqiga egami?
        Qaytaradi: (Ruxsat_bormi: bool, Xabar/Sabab: str)
        """
        cid = str(chat_id).strip()
        user = self.get_or_create_user(cid)
        role = user.get("role", "trial")

        if role == "admin" or self.is_admin(cid):
            return True, "Admin (Cheksiz kirish huquqi)"

        if role == "banned":
            return False, "Siz admin tomonidan bloklangansiz."

        now = time.time()
        expires_at = user.get("expires_at")

        if expires_at and now > expires_at:
            if role != "expired":
                user["role"] = "expired"
                self.save()
            return False, (
                "⚠️ <b>Sizning bepul sinov muddatingiz (24 soat) tugagan!</b>\n\n"
                "AFK bot xizmatidan foydalanishni davom ettirish uchun pulli obuna sotib oling.\n"
                "Murojaat uchun Admin: @bunyod_dev yoki /admin orqali bog'laning."
            )

        # Hali muddati bor (trial yoki premium)
        rem_sec = int(expires_at - now) if expires_at else 0
        rem_hours = rem_sec // 3600
        rem_mins = (rem_sec % 3600) // 60

        role_name = "Premium Obuna" if role == "premium" else "Bepul Sinov (Trial)"
        return True, f"{role_name} (Qolgan vaqt: {rem_hours} soat {rem_mins} daqiqa)"

    def grant_premium(self, chat_id: str | int, days: float) -> Tuple[bool, str]:
        """Admin tomonidan foydalanuvchiga obuna muddatini berish yoki uzaytirish."""
        cid = str(chat_id).strip()
        user = self.get_or_create_user(cid)

        now = time.time()
        current_expiry = user.get("expires_at") or now
        base_time = max(now, current_expiry)
        new_expiry = base_time + (days * 86400)

        user["role"] = "premium"
        user["expires_at"] = new_expiry
        self.save()

        rem_days = round((new_expiry - now) / 86400, 1)
        return True, f"Foydalanuvchi {cid} ga {days} kun obuna berildi. Jami muddat: {rem_days} kun."

    def update_mc_config(self, chat_id: str | int, **kwargs) -> Dict[str, Any]:
        """Foydalanuvchining Minecraft sozlamalarini yangilash."""
        cid = str(chat_id).strip()
        user = self.get_or_create_user(cid)
        mc_conf = user.setdefault("mc_config", {})

        allowed_keys = {"username", "password", "host", "port", "version", "subserver"}
        for k, v in kwargs.items():
            if k in allowed_keys and v is not None:
                if k == "port":
                    try:
                        mc_conf[k] = int(v)
                    except ValueError:
                        pass
                else:
                    mc_conf[k] = str(v).strip()

        self.save()
        return mc_conf

    def get_mc_config(self, chat_id: str | int) -> Dict[str, Any]:
        """Foydalanuvchining Minecraft sozlamalarini olish."""
        cid = str(chat_id).strip()
        user = self.get_or_create_user(cid)
        return user.get("mc_config", {})

    def ban_user(self, chat_id: str | int) -> Tuple[bool, str]:
        """Foydalanuvchini bloklash."""
        cid = str(chat_id).strip()
        user = self.get_or_create_user(cid)
        if self.is_admin(cid):
            return False, "Adminni bloklab bo'lmaydi."
        user["role"] = "banned"
        self.save()
        return True, f"Foydalanuvchi <code>{cid}</code> bloklandi."

    def unban_user(self, chat_id: str | int) -> Tuple[bool, str]:
        """Foydalanuvchini blokdan chiqarish."""
        cid = str(chat_id).strip()
        user = self.get_or_create_user(cid)
        if user.get("role") == "banned":
            user["role"] = "trial"
            self.save()
            return True, f"Foydalanuvchi <code>{cid}</code> blokdan chiqarildi."
        return False, "Ushbu foydalanuvchi bloklanmagan."

    def get_stats(self) -> Dict[str, int]:
        """Foydalanuvchilar toifalari statistikasi."""
        stats = {
            "total": len(self.users),
            "admin": 0,
            "premium": 0,
            "trial": 0,
            "expired": 0,
            "banned": 0
        }
        now = time.time()
        for u in self.users.values():
            role = u.get("role", "trial")
            exp = u.get("expires_at")
            if role == "admin" or self.is_admin(u.get("chat_id", "")):
                stats["admin"] += 1
            elif role == "banned":
                stats["banned"] += 1
            elif role == "premium":
                if exp and now > exp:
                    stats["expired"] += 1
                else:
                    stats["premium"] += 1
            else:
                if exp and now > exp:
                    stats["expired"] += 1
                else:
                    stats["trial"] += 1
        return stats

    def list_all_users(self) -> list[Dict[str, Any]]:
        """Barcha foydalanuvchilar ro'yxati."""
        return list(self.users.values())
