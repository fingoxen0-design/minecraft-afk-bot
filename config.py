import os
from pathlib import Path

def _get_int(key: str, default: int) -> int:
    val = os.getenv(key, "")
    if not val.strip():
        return default
    try:
        return int(val.strip())
    except ValueError:
        return default

def _get_float(key: str, default: float) -> float:
    val = os.getenv(key, "")
    if not val.strip():
        return default
    try:
        return float(val.strip())
    except ValueError:
        return default

def load_env_file(filepath: str | None = None):
    """Oddiy .env faylini parse qilish (tashqi kutubxonalarsiz)."""
    if filepath is None:
        env_path = Path(__file__).resolve().parent / ".env"
    else:
        p = Path(filepath)
        env_path = p if p.is_absolute() else Path(__file__).resolve().parent / p

    if not env_path.is_file():
        return
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                key, val = line.split("=", 1)
                key = key.strip()
                val = val.strip().strip('"').strip("'")
                if key not in os.environ:
                    os.environ[key] = val

# .env faylini yuklaymiz
load_env_file()

# Telegram sozlamalari
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")

# Admin sozlamalari
_admin_raw = os.getenv("ADMIN_USER_IDS", "")
ADMIN_USER_IDS: set[str] = set()
if _admin_raw:
    for aid in _admin_raw.split(","):
        aid = aid.strip()
        if aid:
            ADMIN_USER_IDS.add(aid)
if TELEGRAM_CHAT_ID:
    ADMIN_USER_IDS.add(TELEGRAM_CHAT_ID.strip())

# Obuna va limitlar
TRIAL_DURATION_HOURS = _get_float("TRIAL_DURATION_HOURS", 24.0)
MAX_ACTIVE_BOTS = _get_int("MAX_ACTIVE_BOTS", 2)

# Minecraft AFK Bot sozlamalari
DEFAULT_MC_HOST = os.getenv("DEFAULT_MC_HOST", "allaysmp.pro")
DEFAULT_MC_PORT = _get_int("DEFAULT_MC_PORT", 25565)
DEFAULT_MC_VERSION = os.getenv("DEFAULT_MC_VERSION", "1.21.1")
DEFAULT_MC_SUBSERVER = os.getenv("DEFAULT_MC_SUBSERVER", "economy")
DEFAULT_MC_USERNAME = os.getenv("DEFAULT_MC_USERNAME", "Gotto")
DEFAULT_MC_PASSWORD = os.getenv("DEFAULT_MC_PASSWORD", "bunyod")
AUTO_AFK_ON_BOOT = os.getenv("AUTO_AFK_ON_BOOT", "true").lower() in ("true", "1", "yes")

# Ovoz berish sozlamalari
DEFAULT_VOTE_URL = os.getenv(
    "VOTE_URL", 
    "https://minecraft-mp.com/server/350645/vote/"
)
COOLDOWN_HOURS = _get_float("COOLDOWN_HOURS", 15.0)

# Monitoring / Health sozlamalari (Render yoki boshqa bulut platformalaridagi PORT ni ham qo'llab-quvvatlaydi)
HEALTH_PORT = _get_int("HEALTH_PORT", _get_int("PORT", 8080))
HEALTH_HOST = os.getenv("HEALTH_HOST", "0.0.0.0")

# Watchdog (boshqa server) sozlamalari
PRIMARY_SERVER_URL = os.getenv(
    "PRIMARY_SERVER_URL", 
    f"http://127.0.0.1:{HEALTH_PORT}/health"
)
WATCHDOG_CHECK_INTERVAL = _get_int("WATCHDOG_CHECK_INTERVAL", 60)
WATCHDOG_TIMEOUT = _get_int("WATCHDOG_TIMEOUT", 10)
WATCHDOG_MAX_FAILURES = _get_int("WATCHDOG_MAX_FAILURES", 2)
