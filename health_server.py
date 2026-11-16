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
    <title>Minecraft Bot — Veb Dashboard & Jonli Terminal</title>
    <style>
        :root {
            --bg: #0d1117;
            --header-bg: #161b22;
            --border: #30363d;
            --text: #c9d1d9;
            --text-muted: #8b949e;
            --accent: #58a6ff;
            --green: #3fb950;
            --yellow: #d29922;
            --purple: #bc8cff;
            --red: #f85149;
            --card-bg: #161b22;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            background-color: var(--bg);
            color: var(--text);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            overflow: hidden;
        }
        header {
            background: var(--header-bg);
            border-bottom: 1px solid var(--border);
            padding: 10px 18px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
            gap: 10px;
        }
        .brand {
            display: flex;
            align-items: center;
            gap: 12px;
        }
        .title {
            font-size: 15px;
            font-weight: 700;
            color: var(--accent);
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .live-badge {
            background: rgba(46, 160, 67, 0.15);
            color: var(--green);
            border: 1px solid rgba(46, 160, 67, 0.4);
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
            background: var(--green);
            border-radius: 50%;
            animation: pulse 1.5s infinite;
        }
        @keyframes pulse {
            0% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.4; transform: scale(0.85); }
            100% { opacity: 1; transform: scale(1); }
        }
        .tabs {
            display: flex;
            gap: 4px;
            background: #0b0f19;
            padding: 3px;
            border-radius: 8px;
            border: 1px solid var(--border);
        }
        .tab-btn {
            background: transparent;
            color: var(--text-muted);
            border: none;
            padding: 6px 14px;
            border-radius: 6px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
        }
        .tab-btn:hover { color: #fff; }
        .tab-btn.active {
            background: #21262d;
            color: var(--accent);
            box-shadow: 0 1px 3px rgba(0,0,0,0.3);
        }
        .toolbar {
            background: #121820;
            border-bottom: 1px solid var(--border);
            padding: 8px 18px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            flex-wrap: wrap;
            gap: 8px;
        }
        .filters {
            display: flex;
            gap: 6px;
            align-items: center;
            flex-wrap: wrap;
        }
        .chip {
            background: #21262d;
            color: var(--text-muted);
            border: 1px solid var(--border);
            font-size: 11px;
            padding: 4px 10px;
            border-radius: 14px;
            cursor: pointer;
            user-select: none;
            transition: all 0.15s;
        }
        .chip:hover, .chip.active {
            background: rgba(88, 166, 255, 0.15);
            border-color: var(--accent);
            color: var(--accent);
            font-weight: 600;
        }
        .search-box {
            background: #0d1117;
            border: 1px solid var(--border);
            color: #fff;
            padding: 5px 10px;
            border-radius: 6px;
            font-size: 12px;
            outline: none;
            width: 170px;
            transition: border-color 0.2s;
        }
        .search-box:focus { border-color: var(--accent); }
        .actions {
            display: flex;
            gap: 6px;
            align-items: center;
            flex-wrap: wrap;
        }
        button.tool-btn {
            background: #21262d;
            color: var(--text);
            border: 1px solid var(--border);
            padding: 5px 11px;
            border-radius: 6px;
            font-size: 12px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 5px;
            transition: all 0.15s;
            user-select: none;
        }
        button.tool-btn:hover {
            background: #30363d;
            border-color: var(--text-muted);
        }
        button.tool-btn:active { transform: translateY(1px); }
        .btn-toggle-on {
            background: rgba(31, 111, 235, 0.2) !important;
            border-color: var(--accent) !important;
            color: var(--accent) !important;
        }
        main {
            flex: 1;
            position: relative;
            overflow: hidden;
            display: flex;
            flex-direction: column;
        }
        .view {
            display: none;
            height: 100%;
            overflow-y: auto;
        }
        .view.active { display: block; }
        #terminal-view {
            background: #090d13;
            padding: 14px 18px;
            font-family: "Cascadia Code", "Fira Code", Consolas, "Courier New", monospace;
            font-size: 12.5px;
            line-height: 1.6;
            white-space: pre-wrap;
            word-break: break-all;
        }
        .log-line {
            padding: 2px 0;
            border-bottom: 1px solid rgba(255,255,255,0.02);
        }
        .log-time { color: var(--text-muted); margin-right: 8px; user-select: none; font-size: 11px; }
        .log-system { color: var(--green); }
        .log-mineflayer { color: var(--accent); font-weight: 500; }
        .log-keepalive { color: var(--yellow); }
        .log-telegram { color: var(--purple); }
        .log-error { color: var(--red); font-weight: 600; }
        .log-default { color: #e6edf3; }
        #dash-view {
            padding: 24px;
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
            gap: 16px;
            background: var(--bg);
        }
        .card {
            background: var(--card-bg);
            border: 1px solid var(--border);
            border-radius: 10px;
            padding: 18px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        }
        .card-header {
            font-size: 12px;
            font-weight: 600;
            color: var(--text-muted);
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 10px;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        .stat-val {
            font-size: 22px;
            font-weight: 700;
            color: #fff;
            margin-bottom: 6px;
        }
        .stat-desc { font-size: 12px; color: var(--text-muted); line-height: 1.4; }
        #help-view {
            padding: 24px;
            max-width: 900px;
            margin: 0 auto;
            width: 100%;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 14px;
            font-size: 13px;
            background: var(--card-bg);
            border-radius: 8px;
            overflow: hidden;
            border: 1px solid var(--border);
        }
        th, td {
            text-align: left;
            padding: 10px 14px;
            border-bottom: 1px solid var(--border);
        }
        th { background: #161b22; color: var(--accent); font-weight: 600; }
        tr:hover { background: rgba(255,255,255,0.02); }
        code {
            background: rgba(110,118,129,0.2);
            padding: 2px 6px;
            border-radius: 4px;
            color: #79c0ff;
            font-family: monospace;
        }
        footer {
            background: var(--header-bg);
            border-top: 1px solid var(--border);
            padding: 7px 18px;
            font-size: 11px;
            color: var(--text-muted);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
    </style>
</head>
<body>
    <header>
        <div class="brand">
            <div class="title">🎮 Minecraft Vote & AFK Bot</div>
            <div class="live-badge"><span class="live-dot"></span> JONLI</div>
        </div>
        <div class="tabs">
            <button class="tab-btn active" onclick="switchTab('terminal')">📜 Terminal</button>
            <button class="tab-btn" onclick="switchTab('dashboard')">📊 Tizim & Monitor</button>
            <button class="tab-btn" onclick="switchTab('help')">📱 Buyruqlar</button>
        </div>
    </header>

    <div id="terminal-toolbar" class="toolbar">
        <div class="filters">
            <span class="chip active" onclick="setFilter('all', this)">Barchasi</span>
            <span class="chip" onclick="setFilter('mineflayer', this)">Mineflayer 🎮</span>
            <span class="chip" onclick="setFilter('telegram', this)">Telegram 💬</span>
            <span class="chip" onclick="setFilter('keepalive', this)">KeepAlive ⚡️</span>
            <span class="chip" onclick="setFilter('error', this)">Xatolar ⚠️</span>
            <input type="text" id="log-search" class="search-box" placeholder="🔎 Qidiruv..." oninput="handleSearch(this.value)">
        </div>
        <div class="actions">
            <button class="tool-btn" onclick="downloadLogs()">💾 .txt Yuklash</button>
            <button class="tool-btn" onclick="copyLogs()">📋 Nusxa olish</button>
            <button class="tool-btn" onclick="clearScreen()">🧹 Tozalash</button>
            <button id="btn-autoscroll" class="tool-btn btn-toggle-on" onclick="toggleAutoScroll()">⬇️ Avto-skroll: ON</button>
            <button class="tool-btn" onclick="fetchLogs()">🔄</button>
        </div>
    </div>

    <main>
        <!-- 1. Terminal View -->
        <div id="view-terminal" class="view active">
            <div id="terminal-view"><div class="log-line log-system">Loglar yuklanmoqda...</div></div>
        </div>

        <!-- 2. Dashboard View -->
        <div id="view-dashboard" class="view">
            <div id="dash-view">
                <div class="card">
                    <div class="card-header">Server Holati 🟢</div>
                    <div id="stat-server-status" class="stat-val">A'lo (Healthy)</div>
                    <div id="stat-server-uptime" class="stat-desc">Ish vaqti: ...</div>
                </div>
                <div class="card">
                    <div class="card-header">Ovoz Berish Taymeri 🗳</div>
                    <div id="stat-vote-status" class="stat-val">Yuklanmoqda...</div>
                    <div id="stat-vote-rem" class="stat-desc">Qolgan vaqt: ...</div>
                </div>
                <div class="card">
                    <div class="card-header">Faol AFK Botlar 🎮</div>
                    <div id="stat-afk-count" class="stat-val">0 / 2</div>
                    <div class="stat-desc">Mineflayer dvigateli 24/7 tayyor</div>
                </div>
                <div class="card">
                    <div class="card-header">Anti-Sleep (KeepAlive) ⚡️</div>
                    <div class="stat-val" style="color: var(--yellow);">Faol (10 daqiqa)</div>
                    <div class="stat-desc">Render uyqusini oldini oluvchi ikkita mustaqil zanjir (Ichki + GitHub Actions)</div>
                </div>
            </div>
        </div>

        <!-- 3. Help View -->
        <div id="view-help" class="view">
            <div id="help-view">
                <h3 style="margin-bottom: 8px; color: var(--accent);">📱 Telegram Bot Buyruqlari Qo'llanmasi</h3>
                <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 12px;">Telegram botingizga yuborishingiz mumkin bo'lgan barcha boshqaruv buyruqlari:</p>
                <table>
                    <thead>
                        <tr>
                            <th>Buyruq</th>
                            <th>Tavsif</th>
                            <th>Misol</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td><code>/start</code></td>
                            <td>Asosiy interaktiv menyu va hisob holati</td>
                            <td><code>/start</code></td>
                        </tr>
                        <tr>
                            <td><code>/afk_start</code></td>
                            <td>Minecraft AFK botni serverga kiritish va /afk qilish</td>
                            <td><code>/afk_start</code></td>
                        </tr>
                        <tr>
                            <td><code>/afk_stop</code></td>
                            <td>AFK botni serverdan chiqarish</td>
                            <td><code>/afk_stop</code></td>
                        </tr>
                        <tr>
                            <td><code>/afk_status</code></td>
                            <td>Bot jonli holati, jon/ovqat darajasi va oxirgi loglari</td>
                            <td><code>/afk_status</code></td>
                        </tr>
                        <tr>
                            <td><code>/say [matn]</code></td>
                            <td>Minecraft o'yin chatiga Telegramdan xabar yozish</td>
                            <td><code>/say Salom barchaga!</code></td>
                        </tr>
                        <tr>
                            <td><code>/cmd [buyruq]</code></td>
                            <td>Minecraft serveriga buyruq yuborish</td>
                            <td><code>/cmd /spawn</code></td>
                        </tr>
                        <tr>
                            <td><code>/logs</code></td>
                            <td>Jonli veb-terminal va qora quti havolasini olish</td>
                            <td><code>/logs</code></td>
                        </tr>
                        <tr>
                            <td><code>/settings</code></td>
                            <td>Barcha sozlamalarni ko'rish va o'zgartirish</td>
                            <td><code>/settings</code></td>
                        </tr>
                        <tr>
                            <td><code>/seturl [url]</code></td>
                            <td>Ovoz berish sayti havolasini o'zgartirish</td>
                            <td><code>/seturl https://sayt.com/vote</code></td>
                        </tr>
                        <tr>
                            <td><code>/setcooldown [h]</code></td>
                            <td>Taymer oraliq vaqtini belgilash (soatda)</td>
                            <td><code>/setcooldown 15</code></td>
                        </tr>
                        <tr>
                            <td><code>/setserver [ip]</code></td>
                            <td>Minecraft server IP, Port va Subserverini sozlash</td>
                            <td><code>/setserver mc.uz 25565 economy</code></td>
                        </tr>
                        <tr>
                            <td><code>/ping</code></td>
                            <td>Bot va server tezligini tekshirish</td>
                            <td><code>/ping</code></td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
    </main>

    <footer>
        <span id="footer-count">Ko'rsatilmoqda: 0 / Jami: 0 ta qator (Oxirgi 2 soat)</span>
        <span id="footer-uptime">Server ish vaqti: ...</span>
    </footer>

    <script>
        let autoScroll = true;
        let currentFilter = 'all';
        let searchQuery = '';
        let allLogs = [];

        function switchTab(tabId) {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            
            const toolbar = document.getElementById('terminal-toolbar');
            if (tabId === 'terminal') {
                toolbar.style.display = 'flex';
                document.getElementById('view-terminal').classList.add('active');
                event.target.classList.add('active');
            } else if (tabId === 'dashboard') {
                toolbar.style.display = 'none';
                document.getElementById('view-dashboard').classList.add('active');
                event.target.classList.add('active');
            } else if (tabId === 'help') {
                toolbar.style.display = 'none';
                document.getElementById('view-help').classList.add('active');
                event.target.classList.add('active');
            }
        }

        function setFilter(type, el) {
            currentFilter = type;
            document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
            el.classList.add('active');
            renderLogs();
        }

        function handleSearch(q) {
            searchQuery = q.toLowerCase();
            renderLogs();
        }

        function toggleAutoScroll() {
            autoScroll = !autoScroll;
            const btn = document.getElementById("btn-autoscroll");
            if (autoScroll) {
                btn.className = "tool-btn btn-toggle-on";
                btn.innerText = "⬇️ Avto-skroll: ON";
                scrollToBottom();
            } else {
                btn.className = "tool-btn";
                btn.innerText = "⬇️ Avto-skroll: OFF";
            }
        }

        function scrollToBottom() {
            const v = document.getElementById("view-terminal");
            v.scrollTop = v.scrollHeight;
        }

        function clearScreen() {
            document.getElementById("terminal-view").innerHTML = '<div class="log-line log-system">[Ekranni tozalash bajarildi] Yangi loglar kelganda ko\\'rinadi...</div>';
        }

        function copyLogs() {
            const text = document.getElementById("terminal-view").innerText;
            navigator.clipboard.writeText(text).then(() => {
                alert("Loglar buferga nusxalandi!");
            });
        }

        function downloadLogs() {
            const lines = allLogs.map(l => `[${l.time}] ${l.message}`).join("\\n");
            const blob = new Blob([lines], { type: "text/plain;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `minecraft_bot_logs_${new Date().toISOString().slice(0,19).replace(/:/g, '-')}.txt`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
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

        function renderLogs() {
            const term = document.getElementById("terminal-view");
            if (!allLogs || allLogs.length === 0) {
                term.innerHTML = '<div class="log-line log-system">Loglar mavjud emas yoki hali yozilmadi.</div>';
                document.getElementById("footer-count").innerText = "Ko'rsatilmoqda: 0 / Jami: 0 ta qator (Oxirgi 2 soat)";
                return;
            }

            const filtered = allLogs.filter(l => {
                const msg = l.message;
                if (currentFilter === 'mineflayer' && !msg.includes('[Mineflayer]')) return false;
                if (currentFilter === 'telegram' && !msg.includes('[Telegram') && !msg.includes('[Bot]')) return false;
                if (currentFilter === 'keepalive' && !msg.includes('[KeepAlive]')) return false;
                if (currentFilter === 'error' && !msg.includes('ERROR') && !msg.includes('Xatolik') && !msg.includes('Error')) return false;

                if (searchQuery && !msg.toLowerCase().includes(searchQuery) && !l.time.includes(searchQuery)) {
                    return false;
                }
                return true;
            });

            document.getElementById("footer-count").innerText = `Ko'rsatilmoqda: ${filtered.length} / Jami: ${allLogs.length} ta qator (Oxirgi 2 soat)`;

            term.innerHTML = filtered.map(l => {
                const cls = colorize(l.message);
                return `<div class="log-line"><span class="log-time">${l.time}</span><span class="${cls}">${escapeHtml(l.message)}</span></div>`;
            }).join("");

            if (autoScroll) scrollToBottom();
        }

        function fetchLogs() {
            fetch('/api/logs')
                .then(r => r.json())
                .then(data => {
                    allLogs = data.logs || [];
                    document.getElementById("footer-uptime").innerText = `Server ish vaqti: ${data.uptime}s | Holat: ${data.status}`;
                    renderLogs();

                    // Dashboard stats
                    if (data.data) {
                        const d = data.data;
                        if (d.status) {
                            document.getElementById("stat-vote-status").innerText = d.status === 'ready_to_vote' ? "Ovoz berish mumkin! 🟢" : "Taymer kutilmoqda ⏳";
                        }
                        if (d.remaining_text) {
                            document.getElementById("stat-vote-rem").innerText = `Qolgan vaqt: ${d.remaining_text}`;
                        }
                        if (d.active_afk_bots !== undefined) {
                            document.getElementById("stat-afk-count").innerText = `${d.active_afk_bots} / ${d.max_afk_bots || 2}`;
                        }
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

        if clean_path in ["/logs", "/terminal", "/dashboard"]:
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
            callback = getattr(self.server, "get_status_callback", None) or HealthHandler.get_status_callback
            status_data = {}
            if callback:
                try:
                    status_data = callback()
                except Exception:
                    pass

            response = {
                "status": "healthy",
                "uptime": int(time.time() - start_time),
                "count": len(logs),
                "window_hours": 2.0,
                "data": status_data,
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
        print(f"[HealthServer] Server ishga tushdi: http://{self.host}:{self.port}/health (Veb Dashboard: /logs)")

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
