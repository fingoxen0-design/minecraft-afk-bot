import json
import time
import os
import re
import threading
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse, parse_qs

class VoteTracker:
    def __init__(self, state_file: str | Path | None = None, default_cooldown_hours: float = 15.0):
        if default_cooldown_hours <= 0:
            raise ValueError("Cooldown hours must be positive (> 0)")
        if state_file is None:
            self.state_file = Path(__file__).resolve().parent / "vote_state.json"
        else:
            self.state_file = Path(state_file)
        self.default_cooldown_hours = default_cooldown_hours
        self._lock = threading.RLock()
        self.state = {
            "last_vote_timestamp": 0,
            "next_vote_timestamp": 0,
            "cooldown_hours": default_cooldown_hours,
            "alert_sent": False,
            "total_votes_recorded": 0
        }
        self.load_state()

    def load_state(self):
        """Holatni json fayldan o'qib olish."""
        with self._lock:
            if self.state_file.is_file():
                try:
                    with open(self.state_file, "r", encoding="utf-8") as f:
                        data = json.load(f)
                        self.state.update(data)
                except Exception as e:
                    print(f"[Tracker] Holatni yuklashda xatolik: {e}")

    def save_state(self):
        """Holatni json faylga xavfsiz (atomik) saqlash."""
        with self._lock:
            temp_file = None
            try:
                self.state_file.parent.mkdir(parents=True, exist_ok=True)
                temp_file = self.state_file.with_name(f"{self.state_file.name}.tmp")
                with open(temp_file, "w", encoding="utf-8") as f:
                    json.dump(self.state, f, indent=4)
                os.replace(temp_file, self.state_file)
            except Exception as e:
                print(f"[Tracker] Holatni saqlashda xatolik: {e}")
                if temp_file and temp_file.exists():
                    try:
                        temp_file.unlink()
                    except Exception:
                        pass

    def parse_time_from_url_or_text(self, text: str) -> int | None:
        """URL yoki matndan timestamp'ni ajratib olish (masalan: ?error=2&time=1794836617)."""
        text = text.strip()
        # Agar bevosita 10 xonali son bo'lsa
        if text.isdigit() and len(text) == 10:
            return int(text)

        # Agar URL bo'lsa
        try:
            parsed = urlparse(text)
            query = parse_qs(parsed.query)
            if "time" in query:
                return int(query["time"][0])
        except Exception:
            pass

        # Regex orqali qidirish
        match = re.search(r'time=(\d{10})', text)
        if match:
            return int(match.group(1))

        return None

    def record_vote(self, custom_next_time: int | None = None, cooldown_hours: float | None = None):
        """
        Ovoz berilganini qayd etish.
        Agar custom_next_time (aniq timestamp) berilmagan bo'lsa,
        hozirgi vaqtga cooldown_hours qo'shiladi.
        """
        with self._lock:
            now = int(time.time())
            if cooldown_hours is not None:
                if cooldown_hours <= 0:
                    raise ValueError("Cooldown hours must be positive (> 0)")
                hours = cooldown_hours
            else:
                hours = self.state.get("cooldown_hours", self.default_cooldown_hours)
            
            self.state["last_vote_timestamp"] = now
            self.state["cooldown_hours"] = hours
            self.state["total_votes_recorded"] = self.state.get("total_votes_recorded", 0) + 1
            self.state["alert_sent"] = False

            if custom_next_time and custom_next_time > now:
                self.state["next_vote_timestamp"] = custom_next_time
            else:
                self.state["next_vote_timestamp"] = now + int(hours * 3600)

            self.save_state()

    def set_next_vote_time(self, next_ts: int):
        """
        Sayt xatosi yoki tashqi havoladan kelgan kelajakdagi ovoz berish vaqtini o'rnatish.
        Bu yangi ovoz berish deb hisoblanmaydi (total_votes_recorded va last_vote_timestamp o'zgarmaydi).
        """
        with self._lock:
            self.state["next_vote_timestamp"] = int(next_ts)
            self.state["alert_sent"] = False
            self.save_state()

    def get_remaining_seconds(self) -> int:
        """Keyingi ovoz berishgacha qolgan soniyalar soni."""
        with self._lock:
            now = int(time.time())
            next_time = self.state.get("next_vote_timestamp", 0)
            remaining = next_time - now
            return max(0, remaining)

    def is_time_to_vote(self) -> bool:
        """Ovoz berish vaqti yetib kelganmi?"""
        return self.get_remaining_seconds() == 0

    def should_send_alert(self) -> bool:
        """Xabar yuborish kerakmi (vaqti yetgan va hali xabar yuborilmagan)?"""
        with self._lock:
            return self.is_time_to_vote() and not self.state.get("alert_sent", False)

    def mark_alert_sent(self, status: bool = True):
        """Ogohlantirish yuborilganini belgilash."""
        with self._lock:
            self.state["alert_sent"] = status
            self.save_state()

    def set_cooldown_hours(self, hours: float):
        """Kutiladigan intervalni o'zgartirish."""
        if hours <= 0:
            raise ValueError("Cooldown hours must be positive (> 0)")
        with self._lock:
            self.state["cooldown_hours"] = float(hours)
            self.save_state()

    def format_remaining_time(self) -> str:
        """Qolgan vaqtni o'qishli formatda qaytarish."""
        rem = self.get_remaining_seconds()
        if rem <= 0:
            return "Hozir ovoz berish mumkin! 🟢"

        hours = rem // 3600
        minutes = (rem % 3600) // 60
        seconds = rem % 60

        parts = []
        if hours > 0:
            parts.append(f"{hours} soat")
        if minutes > 0:
            parts.append(f"{minutes} daqiqa")
        if not parts or (hours == 0 and minutes < 5):
            parts.append(f"{seconds} soniya")

        return " ".join(parts)

    def get_summary(self) -> dict:
        """Tizim holati bo'yicha qisqacha ma'lumot."""
        with self._lock:
            now = int(time.time())
            next_ts = self.state.get("next_vote_timestamp", 0)
            last_ts = self.state.get("last_vote_timestamp", 0)
            
            try:
                next_dt = datetime.fromtimestamp(next_ts).strftime("%Y-%m-%d %H:%M:%S") if next_ts else "Aniqlanmagan"
            except (OverflowError, ValueError, OSError):
                next_dt = "Noto'g'ri sana"
            try:
                last_dt = datetime.fromtimestamp(last_ts).strftime("%Y-%m-%d %H:%M:%S") if last_ts else "Aniqlanmagan"
            except (OverflowError, ValueError, OSError):
                last_dt = "Noto'g'ri sana"

            return {
                "status": "ready_to_vote" if self.is_time_to_vote() else "cooldown_active",
                "remaining_seconds": self.get_remaining_seconds(),
                "remaining_text": self.format_remaining_time(),
                "last_vote_time": last_dt,
                "next_vote_time": next_dt,
                "cooldown_hours": self.state.get("cooldown_hours", self.default_cooldown_hours),
                "total_votes": self.state.get("total_votes_recorded", 0)
            }

