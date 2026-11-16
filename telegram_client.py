import requests
import json
import time

class TelegramClient:
    def __init__(self, token: str, default_chat_id: str = ""):
        self.token = token
        self.default_chat_id = default_chat_id
        self.base_url = f"https://api.telegram.org/bot{self.token}"

    def send_message(self, text: str, chat_id: str = None, reply_markup: dict = None, parse_mode: str = "HTML") -> bool:
        """Telegram orqali xabar jo'natish."""
        target_chat = chat_id or self.default_chat_id
        if not self.token or not target_chat:
            print(f"[TelegramClient] Ogohlantirish: Token yoki Chat ID ko'rsatilmagan! Xabar: {text[:40]}...")
            return False

        url = f"{self.base_url}/sendMessage"
        payload = {
            "chat_id": target_chat,
            "text": text,
            "parse_mode": parse_mode
        }
        if reply_markup:
            payload["reply_markup"] = json.dumps(reply_markup)

        try:
            resp = requests.post(url, data=payload, timeout=10)
            if resp.status_code == 200:
                return True
            else:
                print(f"[TelegramClient] Xatolik {resp.status_code}: {resp.text}")
                return False
        except Exception as e:
            print(f"[TelegramClient] Tarmoq xatosi: {e}")
            return False

    def get_updates(self, offset: int = 0, timeout: int = 20) -> list:
        """Yangi kelgan xabarlarni (updates) olish."""
        if not self.token:
            return []

        url = f"{self.base_url}/getUpdates"
        params = {
            "offset": offset,
            "timeout": timeout
        }
        try:
            resp = requests.get(url, params=params, timeout=timeout + 5)
            if resp.status_code == 200:
                data = resp.json()
                if data.get("ok"):
                    return data.get("result", [])
            return []
        except Exception as e:
            time.sleep(2)
            return []

    def answer_callback_query(self, callback_query_id: str, text: str = "") -> bool:
        """Inline tugma bosilganda bildirishnoma ko'rsatish."""
        if not self.token:
            return False
        url = f"{self.base_url}/answerCallbackQuery"
        try:
            resp = requests.post(url, data={"callback_query_id": callback_query_id, "text": text}, timeout=5)
            return resp.status_code == 200
        except Exception:
            return False
