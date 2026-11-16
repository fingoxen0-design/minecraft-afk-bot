import time
import requests
import sys
import html
import signal
from datetime import datetime

import config
from telegram_client import TelegramClient

class ServerWatchdog:
    def __init__(self):
        self.target_url = config.PRIMARY_SERVER_URL
        self.check_interval = config.WATCHDOG_CHECK_INTERVAL
        self.timeout = config.WATCHDOG_TIMEOUT
        self.max_failures = config.WATCHDOG_MAX_FAILURES
        self.client = TelegramClient(token=config.TELEGRAM_BOT_TOKEN, default_chat_id=config.TELEGRAM_CHAT_ID)
        
        self.failure_count = 0
        self.alert_triggered = False

    def send_alert(self, title: str, details: str, is_recovery: bool = False):
        """Telegram orqali favqulodda xabar yuborish."""
        emoji = "✅" if is_recovery else "🚨"
        safe_title = html.escape(title)
        safe_url = html.escape(self.target_url)
        safe_details = html.escape(str(details))
        msg = (
            f"{emoji} <b>WATCHDOG MONITORING OGOHLANTIRISHI</b>\n\n"
            f"<b>Holat:</b> {safe_title}\n"
            f"<b>Tekshirilgan server:</b> <code>{safe_url}</code>\n"
            f"<b>Vaqt:</b> {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n"
            f"<b>Tafsilot:</b> {safe_details}"
        )
        return self.client.send_message(text=msg)

    def check_server(self) -> bool:
        """Asosiy serverning /health endpointini tekshirish."""
        try:
            resp = requests.get(self.target_url, timeout=self.timeout)
            if resp.status_code == 200:
                data = resp.json()
                if data.get("status") == "healthy":
                    return True
            print(f"[Watchdog] Server javobi noto'g'ri (Status: {resp.status_code})")
            return False
        except Exception as e:
            print(f"[Watchdog] Serverga ulanishda xato: {e}")
            return False

    def run_once(self) -> bool:
        """Bitta tekshiruv sikli (Cron uchun ham mos)."""
        is_healthy = self.check_server()
        if is_healthy:
            if self.alert_triggered:
                # Agar oldin to'xtab qolgan bo'lsa va endi tiklansa:
                print("[Watchdog] Server qayta tiklandi!")
                self.send_alert(
                    title="Asosiy bot serveri qayta ishga tushdi va aloqada!",
                    details="Server yana sog'lom holatda ishlamoqda.",
                    is_recovery=True
                )
                self.alert_triggered = False
            self.failure_count = 0
            return True
        else:
            self.failure_count += 1
            print(f"[Watchdog] Server javob bermadi ({self.failure_count}/{self.max_failures})")
            if self.failure_count >= self.max_failures and not self.alert_triggered:
                print("[Watchdog] Xavf signali yuborilmoqda!")
                self.send_alert(
                    title="ASOSIY BOT SERVERI TO'XTAB QOLDI!",
                    details=f"Asosiy server {self.failure_count} marta ketma-ket javob bermadi. Iltimos, server holatini tekshiring!"
                )
                self.alert_triggered = True
            return False

    def run_forever(self):
        """Doimiy 24/7 monitoring sikli (Server B da ishlash uchun)."""
        print(f"[Watchdog] Monitoring boshlandi: {self.target_url}")
        print(f"[Watchdog] Tekshirish oraliq vaqti: har {self.check_interval} soniyada.")
        
        while True:
            try:
                self.run_once()
            except Exception as e:
                print(f"[Watchdog] Ichki xatolik: {e}")
            time.sleep(self.check_interval)

def _signal_handler(sig, frame):
    print("[Watchdog] Monitoring to'xtatildi.")
    sys.exit(0)

if __name__ == "__main__":
    signal.signal(signal.SIGINT, _signal_handler)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _signal_handler)

    watchdog = ServerWatchdog()
    if len(sys.argv) > 1 and sys.argv[1] == "--once":
        # Cron orqali ishlatish uchun
        watchdog.run_once()
    else:
        # Doimiy fonda ishlatish uchun
        try:
            watchdog.run_forever()
        except KeyboardInterrupt:
            print("[Watchdog] Monitoring to'xtatildi.")

