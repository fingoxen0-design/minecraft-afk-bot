import json
import os
import sys
import time
import collections
import urllib.request
from datetime import datetime
from http.server import HTTPServer, BaseHTTPRequestHandler
import threading
from typing import Callable
from urllib.parse import urlparse

class LogBuffer:
    """Oxirgi 2 soatlik loglarni xotirada xavfsiz (qora quti sifatida) saqlovchi bufer."""
    def __init__(self, max_hours: float = 2.0, max_entries: int = 1000):
        self.max_seconds = max_hours * 3600
        self.max_entries = max_entries
        self._entries = collections.deque(maxlen=max_entries)
        self._lock = threading.Lock()

    def add(self, message: str, level: str = "INFO"):
        now = time.time()
        time_str = datetime.fromtimestamp(now).strftime("%H:%M:%S")
        with self._lock:
            cutoff = now - self.max_seconds
            while self._entries and self._entries[0]["timestamp"] < cutoff:
                self._entries.popleft()
            self._entries.append({
                "timestamp": now,
                "time": time_str,
                "level": level,
                "message": message.strip()
            })

    def get_logs(self) -> list[dict]:
        now = time.time()
        cutoff = now - self.max_seconds
        with self._lock:
            while self._entries and self._entries[0]["timestamp"] < cutoff:
                self._entries.popleft()
            return list(self._entries)

global_log_buffer = LogBuffer(max_hours=2.0, max_entries=1000)

class StdoutTee:
    """Konsol chiqishlarini bir vaqtning o'zida ham ekranga, ham xotiradagi LogBuffer'ga yozish."""
    def __init__(self, original_stream, buffer: LogBuffer, level: str = "INFO"):
        self.original = original_stream
        self.buffer = buffer
        self.level = level

    def write(self, s: str):
        if self.original:
            try:
                self.original.write(s)
            except Exception:
                pass
        stripped = s.strip()
        if stripped:
            for line in stripped.splitlines():
                if line.strip():
                    self.buffer.add(line.strip(), self.level)

    def flush(self):
        if self.original and hasattr(self.original, "flush"):
            try:
                self.original.flush()
            except Exception:
                pass

    def __getattr__(self, name):
        return getattr(self.original, name)

# Faqat 1 marta ulaymiz
if not isinstance(sys.stdout, StdoutTee):
    sys.stdout = StdoutTee(sys.stdout, global_log_buffer, "INFO")
if not isinstance(sys.stderr, StdoutTee):
    sys.stderr = StdoutTee(sys.stderr, global_log_buffer, "ERROR")

LOGS_HTML = """<!DOCTYPE html>
<html lang="uz">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Minecraft Bot — Jonli Veb Loglar</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            background-color: #0b0f19;
            color: #c9d1d9;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
            display: flex;
            flex-direction: column;
            height: 100vh;
            overflow: hidden;
        }
        header {
            background: #161b22;
            border-bottom: 1px solid #30363d;
            padding: 12px 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
            gap: 10px;
        }
        .header-left {
            display: flex;
            align-items: center;
            gap: 12px;
        }
        .header-title {
            font-size: 16px;
            font-weight: 600;
            color: #58a6ff;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .live-badge {
            background: rgba(46, 160, 67, 0.2);
            color: #3fb950;
            border: 1px solid #238636;
            font-size: 11px;
            font-weight: 600;
            padding: 2px 8px;
            border-radius: 12px;
            display: flex;
            align-items: center;
            gap: 5px;
        }
        .live-dot {
            width: 7px;
            height: 7px;
            background: #3fb950;
            border-radius: 50%;
            animation: pulse 1.5s infinite;
        }
        @keyframes pulse {
            0% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.4; transform: scale(0.85); }
            100% { opacity: 1; transform: scale(1); }
        }
        .header-meta {
            font-size: 12px;
            color: #8b949e;
        }
        .header-actions {
            display: flex;
            gap: 8px;
            align-items: center;
            flex-wrap: wrap;
        }
        button {
            background: #21262d;
            color: #c9d1d9;
            border: 1px solid #30363d;
            padding: 6px 12px;
            border-radius: 6px;
            font-size: 12px;
            cursor: pointer;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            gap: 5px;
            user-select: none;
        }
        button:hover {
            background: #30363d;
            border-color: #8b949e;
        }
        button:active { transform: translateY(1px); }
        .btn-active {
            background: #1f6feb !important;
            color: #fff !important;
            border-color: #388bfd !important;
        }
        #terminal {
            flex: 1;
            padding: 16px 20px;
            overflow-y: auto;
            font-family: "Cascadia Code", "Fira Code", Consolas, "Courier New", monospace;
            font-size: 13px;
            line-height: 1.6;
            background: #0d1117;
            white-space: pre-wrap;
            word-break: break-all;
        }
        .log-line {
            padding: 2px 0;
            border-bottom: 1px solid rgba(255,255,255,0.02);
        }
        .log-time { color: #8b949e; margin-right: 8px; user-select: none; }
        .log-system { color: #3fb950; }
        .log-mineflayer { color: #58a6ff; font-weight: 500; }
        .log-keepalive { color: #d29922; }
        .log-telegram { color: #bc8cff; }
        .log-error { color: #f85149; font-weight: 600; }
        .log-default { color: #e6edf3; }
        footer {
            background: #161b22;
            border-top: 1px solid #30363d;
            padding: 8px 20px;
            font-size: 11px;
            color: #8b949e;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
    </style>
</head>
<body>
    <header>
        <div class="header-left">
            <div class="header-title">🎮 Minecraft Bot Terminal</div>
            <div class="live-badge"><span class="live-dot"></span> JONLI</div>
            <span class="header-meta">⏱ Qora quti: Oxirgi 2 soat</span>
        </div>
        <div class="header-actions">
            <button id="btn-copy" onclick="copyLogs()">📋 Nusxa olish</button>
            <button id="btn-clear" onclick="clearScreen()">🧹 Tozalash</button>
            <button id="btn-autoscroll" class="btn-active" onclick="toggleAutoScroll()">⬇️ Avto-skroll: ON</button>
            <button id="btn-refresh" onclick="fetchLogs()">🔄 Yangilash</button>
        </div>
    </header>
    <div id="terminal"><div class="log-line log-system">Yuklanmoqda...</div></div>
    <footer>
        <span id="footer-count">Qatorlar: 0 ta</span>
        <span id="footer-uptime">Server ish vaqti: ...</span>
    </footer>
    <script>
        let autoScroll = true;
        let lastLogsLength = -1;

        function toggleAutoScroll() {
            autoScroll = !autoScroll;
            const btn = document.getElementById("btn-autoscroll");
            if (autoScroll) {
                btn.className = "btn-active";
                btn.innerText = "⬇️ Avto-skroll: ON";
                scrollToBottom();
            } else {
                btn.className = "";
                btn.innerText = "⬇️ Avto-skroll: OFF";
            }
        }

        function scrollToBottom() {
            const term = document.getElementById("terminal");
            term.scrollTop = term.scrollHeight;
        }

        function clearScreen() {
            document.getElementById("terminal").innerHTML = '<div class="log-line log-system">[Ekranni tozalash bajarildi] Yangi loglar kelganda ko\'rinadi...</div>';
            lastLogsLength = -1;
        }

        function copyLogs() {
            const text = document.getElementById("terminal").innerText;
            navigator.clipboard.writeText(text).then(() => {
                const btn = document.getElementById("btn-copy");
                const old = btn.innerText;
                btn.innerText = "✅ Nusxalandi!";
                setTimeout(() => btn.innerText = old, 1500);
            });
        }

        function colorize(msg) {
            if (msg.includes("[Mineflayer]")) return "log-mineflayer";
            if (msg.includes("[KeepAlive]")) return "log-keepalive";
            if (msg.includes("[Telegram") || msg.includes("[Bot]")) return "log-telegram";
            if (msg.includes("[System]") || msg.includes("[HealthServer]")) return "log-system";
            if (msg.includes("ERROR") || msg.includes("Xatolik") || msg.includes("Error") || msg.includes("failed")) return "log-error";
            return "log-default";
        }

        function escapeHtml(str) {
            return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        }

        function fetchLogs() {
            fetch('/api/logs')
                .then(r => r.json())
                .then(data => {
                    const term = document.getElementById("terminal");
                    document.getElementById("footer-count").innerText = `Qatorlar: ${data.count} ta (Oxirgi 2 soat)`;
                    document.getElementById("footer-uptime").innerText = `Server ish vaqti: ${data.uptime}s | Holat: ${data.status}`;

                    if (!data.logs || data.logs.length === 0) {
                        term.innerHTML = '<div class="log-line log-system">Loglar mavjud emas yoki hali yozilmadi.</div>';
                        return;
                    }

                    if (data.logs.length !== lastLogsLength) {
                        term.innerHTML = data.logs.map(l => {
                            const cls = colorize(l.message);
                            return `<div class="log-line"><span class="log-time">${l.time}</span><span class="${cls}">${escapeHtml(l.message)}</span></div>`;
                        }).join("");
                        lastLogsLength = data.logs.length;
                        if (autoScroll) scrollToBottom();
                    }
                })
                .catch(err => {
                    console.error("Logs fetch error:", err);
                });
        }

        fetchLogs();
        setInterval(fetchLogs, 2500);
    </script>
</body>
</html>
"""

class HealthHandler(BaseHTTPRequestHandler):
    get_status_callback: Callable[[], dict] = None

    def log_message(self, format, *args):
        # Konsolga ortiqcha HTTP access loglarini tiqmaslik uchun
        return

    def do_GET(self):
        parsed_url = urlparse(self.path)
        clean_path = parsed_url.path.rstrip('/') or '/'

        if clean_path in ["/logs", "/terminal"]:
            body = LOGS_HTML.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if clean_path == "/api/logs":
            start_time = getattr(self.server, "start_time", time.time())
            logs = global_log_buffer.get_logs()
            response = {
                "status": "healthy",
                "uptime": int(time.time() - start_time),
                "count": len(logs),
                "window_hours": 2.0,
                "logs": logs
            }
            body = json.dumps(response).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if clean_path in ["/health", "/ping", "/"]:
            callback = getattr(self.server, "get_status_callback", None) or HealthHandler.get_status_callback
            status_data = {}
            is_healthy = True
            error_message = None

            if callback:
                try:
                    status_data = callback()
                except Exception as e:
                    is_healthy = False
                    error_message = str(e)
                    status_data = {"error": error_message}

            start_time = getattr(self.server, "start_time", time.time())
            response = {
                "status": "healthy" if is_healthy else "unhealthy",
                "uptime": int(time.time() - start_time),
                "data": status_data
            }
            if error_message:
                response["error"] = error_message

            body = json.dumps(response, indent=2).encode("utf-8")
            status_code = 200 if is_healthy else 500
            self.send_response(status_code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            body = json.dumps({"error": "Not Found"}).encode("utf-8")
            self.send_response(404)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

class ReusableHTTPServer(HTTPServer):
    allow_reuse_address = True

class HealthServer:
    def __init__(self, host: str = "0.0.0.0", port: int = 8080, get_status_callback: Callable[[], dict] = None):
        self.host = host
        self.port = port
        self.get_status_callback = get_status_callback
        self.server = None
        self.thread = None
        self.keep_alive_running = False
        self.keep_alive_thread = None

    def start(self):
        HealthHandler.get_status_callback = self.get_status_callback
        self.server = ReusableHTTPServer((self.host, self.port), HealthHandler)
        self.server.get_status_callback = self.get_status_callback
        self.server.start_time = time.time()
        self.port = self.server.server_port
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        print(f"[HealthServer] Server ishga tushdi: http://{self.host}:{self.port}/health (Loglar: /logs)")

    def start_keep_alive(self, external_url: str | None = None, interval: int = 600):
        """Render bepul serverini uxlab qolmasligi uchun har `interval` (10 daqiqa) soniyada avtomatik ping yuborish."""
        url = external_url or os.getenv("RENDER_EXTERNAL_URL") or os.getenv("KEEP_ALIVE_URL") or "https://minecraft-afk-bot-y7ak.onrender.com"
        if not url:
            return

        def _ping_loop():
            time.sleep(20)  # Dastlabki ishga tushishni kutamiz
            target = url.rstrip('/') + '/health'
            print(f"[KeepAlive] Render anti-sleep tizimi yoqildi: {target} (har {interval // 60} daqiqada)")
            while getattr(self, "keep_alive_running", True):
                try:
                    req = urllib.request.Request(
                        target,
                        headers={"User-Agent": "Render-KeepAlive/1.0"}
                    )
                    with urllib.request.urlopen(req, timeout=20) as res:
                        if res.status == 200:
                            print(f"[KeepAlive] Render uyg'oq saqlandi (Status: 200 OK)")
                except Exception as e:
                    print(f"[KeepAlive] Ping ogohlantirishi: {e}")
                time.sleep(interval)

        self.keep_alive_running = True
        self.keep_alive_thread = threading.Thread(target=_ping_loop, daemon=True)
        self.keep_alive_thread.start()

    def stop(self):
        self.keep_alive_running = False
        if self.server:
            self.server.shutdown()
            self.server.server_close()
            print("[HealthServer] Server to'xtatildi.")
