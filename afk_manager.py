import json
import os
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import config

class AFKBotSession:
    """Yagona foydalanuvchining Minecraft AFK bot jarayoni (process) sessiyasi."""

    def __init__(self, user_id: str, mc_config: Dict[str, Any]):
        self.user_id = str(user_id)
        self.mc_config = mc_config
        self.process: Optional[subprocess.Popen] = None
        self.status = "stopped"  # stopped, connecting, logged_in, in_economy, afk_active, reconnecting, error
        self.last_message = ""
        self.current_server = "hub"
        self.is_afk = False
        self.started_at: Optional[float] = None
        self.recent_logs: list[str] = []
        self.health: Optional[float] = None
        self.food: Optional[float] = None
        self._reader_thread: Optional[threading.Thread] = None
        self.is_running = False
        self.manual_stopped = False

    def _read_output(self):
        """Node.js botining stdout chiqishini qatorba-qator o'qish va tahlil qilish."""
        if not self.process or not self.process.stdout:
            return

        try:
            for line in iter(self.process.stdout.readline, ''):
                if not line:
                    break
                line_str = line.strip()
                if not line_str:
                    continue

                try:
                    data = json.loads(line_str)
                    event_type = data.get("type")
                    msg = data.get("message", "")
                    self.last_message = msg

                    # Forward to Python stdout for StdoutTee -> LogBuffer -> /logs
                    print(f"[Mineflayer] [{self.user_id}] {msg}")

                    if event_type == "status":
                        self.status = msg
                        if msg == "in_economy":
                            self.current_server = data.get("data", {}).get("server", "economy")
                        elif msg == "afk_active":
                            self.is_afk = True
                            self.status = "afk_active"
                        elif msg == "reconnecting":
                            self.is_afk = False
                            self.status = "reconnecting"
                        elif msg == "stopped":
                            self.status = "stopped"
                            self.is_afk = False

                    elif event_type == "kicked":
                        self.status = "kicked"
                        self.is_afk = False

                    elif event_type == "error":
                        if self.status != "reconnecting":
                            self.status = "error"

                    elif event_type == "health":
                        d = data.get("data", {})
                        self.health = d.get("health")
                        self.food = d.get("food")

                    # Loglarga qo'shish (oxirgi 15 ta)
                    log_entry = f"[{time.strftime('%H:%M:%S')}] [{str(event_type).upper()}] {msg}"
                    self.recent_logs.append(log_entry)
                    if len(self.recent_logs) > 15:
                        self.recent_logs.pop(0)

                except json.JSONDecodeError:
                    # Agar to'g'ridan-to'g'ri matn bo'lsa
                    self.recent_logs.append(f"[{time.strftime('%H:%M:%S')}] {line_str}")
                    if len(self.recent_logs) > 15:
                        self.recent_logs.pop(0)
                    print(f"[Mineflayer] [{self.user_id}] {line_str}")
        except Exception as e:
            print(f"[AFKBotSession] Stdout o'qishda ogohlantirish: {e}")
        finally:
            if not (self.process and self.process.poll() is None):
                self.status = "stopped"
                self.is_running = False

    def start(self) -> Tuple[bool, str]:
        """Node.js mineflayer jarayonini ishga tushirish."""
        if self.is_running and self.process and self.process.poll() is None:
            return False, "Bot allaqachon ishlab turibdi."

        script_path = Path(__file__).resolve().parent / "minecraft_bot.js"
        if not script_path.is_file():
            return False, "minecraft_bot.js fayli topilmadi!"

        cmd = [
            "node",
            str(script_path),
            "--host", str(self.mc_config.get("host") or config.DEFAULT_MC_HOST),
            "--port", str(self.mc_config.get("port") or config.DEFAULT_MC_PORT),
            "--username", str(self.mc_config.get("username") or f"Bot_{self.user_id[-4:]}"),
            "--subserver", str(self.mc_config.get("subserver") or config.DEFAULT_MC_SUBSERVER)
        ]

        if self.mc_config.get("password"):
            cmd.extend(["--password", str(self.mc_config["password"])])

        if self.mc_config.get("version"):
            cmd.extend(["--version", str(self.mc_config["version"])])

        try:
            self.process = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                cwd=str(Path(__file__).resolve().parent)
            )
            self.is_running = True
            self.manual_stopped = False
            self.status = "connecting"
            self.started_at = time.time()
            self.recent_logs = [f"[{time.strftime('%H:%M:%S')}] Jarayon ishga tushirildi..."]

            self._reader_thread = threading.Thread(target=self._read_output, daemon=True)
            self._reader_thread.start()
            return True, "AFK Bot muvaffaqiyatli ishga tushirildi."
        except Exception as e:
            self.status = "error"
            self.is_running = False
            return False, f"Jarayonni ochishda xatolik: {e}"

    def stop(self) -> Tuple[bool, str]:
        """Jarayonni to'xtatish."""
        if not self.process:
            self.status = "stopped"
            self.is_running = False
            return True, "Bot to'xtatilgan."

        try:
            if self.process.stdin:
                try:
                    self.process.stdin.write(json.dumps({"command": "stop"}) + "\n")
                    self.process.stdin.flush()
                except Exception:
                    pass

            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
        except Exception as e:
            print(f"[AFKBotSession] To'xtatishda xatolik: {e}")

        self.status = "stopped"
        self.is_running = False
        self.is_afk = False
        self.manual_stopped = True
        return True, "AFK Bot to'xtatildi."

    def send_chat(self, text: str) -> bool:
        """Mineflayer jarayoniga o'yin chatida yozish uchun buyruq yuborish."""
        if not self.process or not self.is_running or not self.process.stdin:
            return False
        try:
            payload = json.dumps({"command": "chat", "text": text.strip()}) + "\n"
            self.process.stdin.write(payload)
            self.process.stdin.flush()
            self.recent_logs.append(f"[{time.strftime('%H:%M:%S')}] [CHAT_OUT] {text.strip()}")
            return True
        except Exception as e:
            print(f"[AFKBotSession] Xabar yuborishda xato: {e}")
            return False

    def get_info(self) -> Dict[str, Any]:
        """Sessiya haqida to'liq holat."""
        uptime_sec = int(time.time() - self.started_at) if (self.started_at and self.is_running) else 0
        hours = uptime_sec // 3600
        mins = (uptime_sec % 3600) // 60
        secs = uptime_sec % 60

        return {
            "user_id": self.user_id,
            "status": self.status,
            "is_afk": self.is_afk,
            "server": self.current_server,
            "health": self.health,
            "food": self.food,
            "uptime_text": f"{hours}s {mins}d {secs}sek",
            "last_message": self.last_message,
            "username": self.mc_config.get("username"),
            "host": self.mc_config.get("host"),
            "manual_stopped": self.manual_stopped,
            "recent_logs": self.recent_logs[-5:]
        }


class AFKManager:
    """Barcha foydalanuvchilarning AFK bot sessiyalarini boshqaruvchi markaziy menejer."""

    def __init__(self, user_manager: Optional[Any] = None):
        self.sessions: Dict[str, AFKBotSession] = {}
        self._lock = threading.Lock()
        if user_manager is None:
            try:
                from user_manager import UserManager
                self.user_manager = UserManager()
            except Exception:
                self.user_manager = None
        else:
            self.user_manager = user_manager

    def get_active_count(self) -> int:
        """Hozirda faol botlar soni."""
        with self._lock:
            return sum(1 for s in self.sessions.values() if s.is_running)

    def start_user_bot(self, user_id: str | int, mc_config: Dict[str, Any]) -> Tuple[bool, str]:
        """Foydalanuvchi botini ishga tushirish (limitlarni inobatga olgan holda)."""
        uid = str(user_id)
        with self._lock:
            # Agar mavjud bot ishlayotgan bo'lsa
            if uid in self.sessions and self.sessions[uid].is_running:
                return False, "Sizning AFK botingiz allaqachon ishlab turibdi."

            # Max faol botlar cheklovi (1-2 ta) (Adminlar cheklovdan ozod)
            is_admin = False
            if hasattr(self, 'user_manager') and self.user_manager:
                try:
                    is_admin = self.user_manager.is_admin(uid)
                except Exception:
                    is_admin = False

            active_cnt = sum(1 for s in self.sessions.values() if s.is_running)
            if not is_admin and active_cnt >= config.MAX_ACTIVE_BOTS:
                return False, f"Serverda maksimal faol botlar soni ({config.MAX_ACTIVE_BOTS} ta) to'lgan. Birozdan so'ng urinib ko'ring."

            session = AFKBotSession(uid, mc_config)
            self.sessions[uid] = session

        success, msg = session.start()
        return success, msg

    def stop_user_bot(self, user_id: str | int) -> Tuple[bool, str]:
        """Foydalanuvchi botini to'xtatish."""
        uid = str(user_id)
        with self._lock:
            session = self.sessions.get(uid)
            if not session or not session.is_running:
                return True, "Sizning AFK botingiz ishlab turgani yo'q."

        return session.stop()

    def get_user_status(self, user_id: str | int) -> Optional[Dict[str, Any]]:
        """Foydalanuvchi botining holatini olish."""
        uid = str(user_id)
        with self._lock:
            session = self.sessions.get(uid)
            if session:
                return session.get_info()
            return None

    def is_manually_stopped(self, user_id: str | int) -> bool:
        """Foydalanuvchi botni o'zi qo'lda to'xtatganmi?"""
        uid = str(user_id)
        with self._lock:
            session = self.sessions.get(uid)
            return session.manual_stopped if session else False

    def send_user_chat(self, user_id: str | int, text: str) -> Tuple[bool, str]:
        """Foydalanuvchi nomidan Minecraft serveriga xabar yoki buyruq yuborish."""
        uid = str(user_id)
        with self._lock:
            session = self.sessions.get(uid)
            if not session or not session.is_running:
                return False, "Sizning AFK botingiz hozirda faol emas. Avval /afk_start buyrug'ini bering."

        ok = session.send_chat(text)
        if ok:
            return True, f"Xabar o'yinga yuborildi: <code>{text}</code>"
        return False, "O'yinga xabar yuborishda xatolik yuz berdi."

    def stop_all(self):
        """Barcha botlarni to'xtatish (tizim o'chganda)."""
        with self._lock:
            for s in self.sessions.values():
                if s.is_running:
                    s.stop()
