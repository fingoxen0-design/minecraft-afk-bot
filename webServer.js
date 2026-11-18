const http = require('http');
const https = require('https');
const url = require('url');
const config = require('./config');

class LogBuffer {
  constructor(maxHours = 2.0, maxEntries = 1500) {
    this.maxSeconds = maxHours * 3600;
    this.maxEntries = maxEntries;
    this.entries = [];
  }

  add(message, level = 'INFO') {
    const now = Date.now() / 1000;
    const date = new Date();
    const timeStr = date.toTimeString().split(' ')[0];
    const cutoff = now - this.maxSeconds;

    while (this.entries.length > 0 && this.entries[0].timestamp < cutoff) {
      this.entries.shift();
    }
    if (this.entries.length >= this.maxEntries) {
      this.entries.shift();
    }

    this.entries.push({
      timestamp: now,
      time: timeStr,
      level: level,
      message: String(message).trim()
    });
  }

  getLogs() {
    const now = Date.now() / 1000;
    const cutoff = now - this.maxSeconds;
    while (this.entries.length > 0 && this.entries[0].timestamp < cutoff) {
      this.entries.shift();
    }
    return [...this.entries];
  }
}

const globalLogBuffer = new LogBuffer(2.0, 1500);

// console.log va console.error ni ushlab LogBuffer ga yozish
const originalLog = console.log;
const originalError = console.error;

console.log = function (...args) {
  originalLog.apply(console, args);
  const text = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  globalLogBuffer.add(text, 'INFO');
};

console.error = function (...args) {
  originalError.apply(console, args);
  const text = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  globalLogBuffer.add(text, 'ERROR');
};

const HTML_DASHBOARD = `<!DOCTYPE html>
<html lang="uz">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Minecraft 24/7 AFK Bot — Render Dashboard</title>
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
        .brand { display: flex; align-items: center; gap: 12px; }
        .title { font-size: 15px; font-weight: 700; color: var(--accent); display: flex; align-items: center; gap: 8px; }
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
        .tabs { display: flex; gap: 4px; background: #0b0f19; padding: 3px; border-radius: 8px; border: 1px solid var(--border); }
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
        .tab-btn.active { background: #21262d; color: var(--accent); }
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
        .filters { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
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
        }
        .search-box:focus { border-color: var(--accent); }
        .actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
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
        }
        button.tool-btn:hover { background: #30363d; }
        .btn-toggle-on { border-color: rgba(46, 160, 67, 0.6) !important; color: var(--green) !important; }
        .btn-toggle-off { opacity: 0.6; }
        main { flex: 1; position: relative; overflow: hidden; display: flex; flex-direction: column; }
        .view { display: none; height: 100%; overflow-y: auto; }
        .view.active { display: block; }
        #terminal-view {
            background: #090d13;
            color: #e6edf3;
            font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace;
            font-size: 12.5px;
            line-height: 1.5;
            padding: 12px 18px;
            white-space: pre-wrap;
            word-break: break-all;
            height: 100%;
            overflow-y: auto;
        }
        .log-line { padding: 1px 0; display: flex; gap: 10px; }
        .log-time { color: var(--text-muted); font-size: 11px; flex-shrink: 0; user-select: none; }
        .log-info { color: #c9d1d9; }
        .log-success { color: var(--green); }
        .log-warn { color: var(--yellow); }
        .log-error { color: var(--red); font-weight: 600; }
        .log-mineflayer { color: #58a6ff; }
        .log-system { color: #d2a8ff; }
        .log-keepalive { color: #8b949e; font-style: italic; }

        #dash-view {
            padding: 18px;
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
            gap: 16px;
        }
        .card {
            background: var(--card-bg);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 16px;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .card-header {
            font-size: 13px;
            font-weight: 600;
            color: var(--text-muted);
            text-transform: uppercase;
            letter-spacing: 0.5px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .stat-val { font-size: 20px; font-weight: 700; color: #fff; }
        .stat-desc { font-size: 12px; color: var(--text-muted); }
        .vote-btn-group { display: flex; gap: 8px; margin-top: 6px; }
        .btn-vote-link {
            background: #238636;
            color: #fff;
            border: none;
            padding: 6px 12px;
            border-radius: 6px;
            font-size: 12px;
            font-weight: 600;
            text-decoration: none;
            display: inline-flex;
            align-items: center;
            gap: 5px;
        }
        .btn-vote-link:hover { background: #2ea043; }
        .btn-vote-action {
            background: #21262d;
            color: var(--text);
            border: 1px solid var(--border);
            padding: 6px 12px;
            border-radius: 6px;
            font-size: 12px;
            cursor: pointer;
        }
        .btn-vote-action:hover { background: #30363d; }

        #controls-view {
            padding: 18px;
            max-width: 800px;
            margin: 0 auto;
            display: flex;
            flex-direction: column;
            gap: 16px;
        }
        .control-box {
            background: var(--card-bg);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 16px;
        }
        .control-title { font-size: 14px; font-weight: 600; color: var(--accent); margin-bottom: 10px; }
        .chat-input-row { display: flex; gap: 8px; }
        .chat-input {
            flex: 1;
            background: #0d1117;
            border: 1px solid var(--border);
            color: #fff;
            padding: 8px 12px;
            border-radius: 6px;
            font-size: 13px;
            outline: none;
        }
        .btn-action-primary {
            background: #1f6feb;
            color: #fff;
            border: none;
            padding: 8px 16px;
            border-radius: 6px;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
        }
        .btn-action-danger {
            background: #da3633;
            color: #fff;
            border: none;
            padding: 8px 16px;
            border-radius: 6px;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
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
            <div class="title">🎮 Minecraft 24/7 AFK Bot (Node.js)</div>
            <div class="live-badge"><span class="live-dot"></span> RENDER ONLAYN</div>
        </div>
        <div class="tabs">
            <button class="tab-btn active" onclick="switchTab('terminal')">📜 Terminal (Loglar)</button>
            <button class="tab-btn" onclick="switchTab('dashboard')">🗳 4 Vote & Monitoring</button>
            <button class="tab-btn" onclick="switchTab('controls')">⚙️ Bot Boshqaruvi</button>
        </div>
    </header>

    <div id="terminal-toolbar" class="toolbar">
        <div class="filters">
            <span class="chip active" onclick="setFilter('all', this)">Barchasi</span>
            <span class="chip" onclick="setFilter('mineflayer', this)">Mineflayer 🎮</span>
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

    <!-- Live Captcha Alert Card -->
    <div id="captcha-alert-banner" style="display: none; background: #2b1117; border: 2px solid #f85149; border-radius: 8px; padding: 14px 18px; margin: 10px 18px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; flex-wrap: wrap; gap: 8px;">
            <div style="font-weight: 700; color: #ff7b72; font-size: 15px; display: flex; align-items: center; gap: 8px;">
                <span style="font-size: 18px;">🚨</span> ALLAYSMP XARITA CAPTCHA TALAB QILINDI <span id="captcha-bot-label" style="color: #58a6ff;"></span>!
            </div>
            <span style="font-size: 12px; color: #8b949e;">Server 30 soniya kutadi</span>
        </div>
        <div style="display: flex; gap: 20px; align-items: center; flex-wrap: wrap;">
            <img id="captcha-img" src="/api/captcha.png" alt="Captcha Xaritasi" style="width: 256px; height: 256px; image-rendering: pixelated; border: 2px solid #58a6ff; border-radius: 6px; background: #fff;">
            <div style="display: flex; flex-direction: column; gap: 12px; max-width: 340px;">
                <p style="font-size: 13px; color: #c9d1d9;">Xaritadagi <b>4 ta belgi</b>ni yozing va Yuborishni bosing (yoki Enter):</p>
                <div style="display: flex; gap: 8px;">
                    <input id="captcha-input" type="text" placeholder="4 ta belgi..." maxlength="6" style="padding: 10px 14px; font-size: 18px; font-weight: bold; letter-spacing: 4px; text-transform: uppercase; border-radius: 6px; border: 1px solid #30363d; background: #0d1117; color: #fff; width: 170px; text-align: center; outline: none;" onkeydown="if(event.key==='Enter') submitCaptchaCode()">
                    <button class="tool-btn" style="background: #238636; color: #fff; border-color: #2ea043; padding: 10px 18px; font-size: 14px; font-weight: 600;" onclick="submitCaptchaCode()">✅ Yuborish</button>
                </div>
                <div id="captcha-feedback" style="font-size: 12px; color: #58a6ff;"></div>
            </div>
        </div>
    </div>

    <main>
        <div id="view-terminal" class="view active">
            <div id="terminal-view"><div class="log-line log-system">Loglar yuklanmoqda...</div></div>
        </div>

        <div id="view-dashboard" class="view">
            <div id="dash-view">
                <div id="bots-cards-container" style="display: contents;">
                    <div class="card">
                        <div class="card-header">Bot #1: Gotto 🎮</div>
                        <div id="stat-bot-status" class="stat-val" style="color: var(--green);">Faol (24/7 AFK)</div>
                        <div id="stat-bot-server" class="stat-desc">Server: allaysmp.pro (economy)</div>
                        <div id="stat-bot-uptime" class="stat-desc">Ish vaqti: ...</div>
                    </div>
                </div>

                <div class="card">
                    <div class="card-header">Render Anti-Sleep ⚡️</div>
                    <div class="stat-val" style="color: var(--yellow);">Uyg'oq (10 daqiqa)</div>
                    <div class="stat-desc">Keep-alive pinger Render serverni 24/7 uxlatmaydi</div>
                </div>

                <!-- 4 ta Vote -->
                <div class="card">
                    <div class="card-header">Vote #1: Minecraft-MP 🗳</div>
                    <div id="vote-1-time" class="stat-val">Yuklanmoqda...</div>
                    <div class="vote-btn-group">
                        <a id="vote-1-link" href="#" target="_blank" class="btn-vote-link">🔗 Ovoz berish</a>
                        <button class="btn-vote-action" onclick="recordVote(1)">✅ Ovoz berdim</button>
                    </div>
                </div>

                <div class="card">
                    <div class="card-header">Vote #2 🗳</div>
                    <div id="vote-2-time" class="stat-val">Yuklanmoqda...</div>
                    <div class="vote-btn-group">
                        <a id="vote-2-link" href="#" target="_blank" class="btn-vote-link">🔗 Ovoz berish</a>
                        <button class="btn-vote-action" onclick="recordVote(2)">✅ Ovoz berdim</button>
                    </div>
                </div>

                <div class="card">
                    <div class="card-header">Vote #3 🗳</div>
                    <div id="vote-3-time" class="stat-val">Yuklanmoqda...</div>
                    <div class="vote-btn-group">
                        <a id="vote-3-link" href="#" target="_blank" class="btn-vote-link">🔗 Ovoz berish</a>
                        <button class="btn-vote-action" onclick="recordVote(3)">✅ Ovoz berdim</button>
                    </div>
                </div>

                <div class="card">
                    <div class="card-header">Vote #4 🗳</div>
                    <div id="vote-4-time" class="stat-val">Yuklanmoqda...</div>
                    <div class="vote-btn-group">
                        <a id="vote-4-link" href="#" target="_blank" class="btn-vote-link">🔗 Ovoz berish</a>
                        <button class="btn-vote-action" onclick="recordVote(4)">✅ Ovoz berdim</button>
                    </div>
                </div>
            </div>
        </div>

        <div id="view-controls" class="view">
            <div id="controls-view">
                <div class="control-box">
                    <div class="control-title">🎮 Minecraft Bot Boshqaruvi</div>
                    <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 12px;">
                        Bot avtomatik ishlaydi va uzilsa qayta ulanadi. Qo'lda to'xtatish yoki qayta ishga tushirish:
                    </p>
                    <div style="display: flex; gap: 10px;">
                        <button class="btn-action-primary" onclick="botAction('start')">▶️ Botni Yoqish (Start)</button>
                        <button class="btn-action-danger" onclick="botAction('stop')">⏹ Botni To'xtatish (Stop)</button>
                    </div>
                </div>

                <div class="control-box">
                    <div class="control-title">💬 O'yin Chatiga Xabar yoki Buyruq Yozish</div>
                    <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 12px;">
                        Minecraft chatiga xabar yoki server buyrug'i (masalan: <code>/server economy</code>, <code>/spawn</code>) yuborish:
                    </p>
                    <div class="chat-input-row">
                        <select id="chat-target" class="search-box" style="width: 140px; cursor: pointer;">
                            <option value="all">Barchasi (All)</option>
                            <option value="Gotto">Gotto</option>
                        </select>
                        <input type="text" id="chat-msg" class="chat-input" placeholder="Xabar yoki buyruq..." onkeydown="if(event.key==='Enter') sendChatMessage()">
                        <button class="btn-action-primary" onclick="sendChatMessage()">Yuborish</button>
                    </div>
                </div>
            </div>
        </div>
    </main>

    <footer>
        <div id="footer-count">Ko'rsatilmoqda: 0 ta qator (Oxirgi 2 soat)</div>
        <div id="footer-uptime">Render Server: Onlayn</div>
    </footer>

    <script>
        let allLogs = [];
        let autoScroll = true;
        let currentFilter = 'all';
        let searchQuery = '';
        let activeCaptchaBot = null;

        function switchTab(name) {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            event.target.classList.add('active');
            document.getElementById('view-' + name).classList.add('active');
            document.getElementById('terminal-toolbar').style.display = (name === 'terminal') ? 'flex' : 'none';
        }

        function setFilter(name, el) {
            currentFilter = name;
            document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
            el.classList.add('active');
            renderLogs();
        }

        function handleSearch(val) {
            searchQuery = val.trim().toLowerCase();
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
                btn.className = "tool-btn btn-toggle-off";
                btn.innerText = "⬇️ Avto-skroll: OFF";
            }
        }

        function scrollToBottom() {
            const term = document.getElementById("terminal-view");
            term.scrollTop = term.scrollHeight;
        }

        function clearScreen() {
            document.getElementById("terminal-view").innerHTML = '<div class="log-line log-system">Terminal tozalandi.</div>';
        }

        function copyLogs() {
            var txt = allLogs.map(function(l) { return '[' + l.time + '] ' + l.message; }).join('\n');
            navigator.clipboard.writeText(txt).then(function() { alert("Loglar nusxalandi!"); });
        }

        function downloadLogs() {
            var txt = allLogs.map(function(l) { return '[' + l.time + '] ' + l.message; }).join('\n');
            var blob = new Blob([txt], { type: "text/plain" });
            var url = URL.createObjectURL(blob);
            var a = document.createElement("a");
            a.href = url;
            a.download = 'mc_bot_logs_' + Date.now() + '.txt';
            a.click();
            URL.revokeObjectURL(url);
        }

        function colorize(msg) {
            if (msg.includes("[Mineflayer]")) return "log-mineflayer";
            if (msg.includes("[KeepAlive]")) return "log-keepalive";
            if (msg.includes("ERROR") || msg.includes("Xatolik") || msg.includes("Error") || msg.includes("KICK")) return "log-error";
            if (msg.includes("Muvaffaqiyatli") || msg.includes("OK") || msg.includes("tayyor") || msg.includes("active")) return "log-success";
            return "log-info";
        }

        function escapeHtml(str) {
            return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        }

        function renderLogs() {
            var term = document.getElementById("terminal-view");
            if (!allLogs || allLogs.length === 0) {
                term.innerHTML = '<div class="log-line log-system">Loglar kutilmoqda...</div>';
                document.getElementById("footer-count").innerText = "Ko'rsatilmoqda: 0 ta qator";
                return;
            }

            var filtered = allLogs.filter(function(l) {
                var msg = l.message;
                if (currentFilter === 'mineflayer' && !msg.includes('[Mineflayer]')) return false;
                if (currentFilter === 'keepalive' && !msg.includes('[KeepAlive]')) return false;
                if (currentFilter === 'error' && !msg.includes('ERROR') && !msg.includes('Xatolik') && !msg.includes('KICK')) return false;

                if (searchQuery && !msg.toLowerCase().includes(searchQuery) && !l.time.includes(searchQuery)) {
                    return false;
                }
                return true;
            });

            document.getElementById("footer-count").innerText = "Ko'rsatilmoqda: " + filtered.length + " / Jami: " + allLogs.length + " ta qator";

            term.innerHTML = filtered.map(function(l) {
                var cls = colorize(l.message);
                return '<div class="log-line"><span class="log-time">' + l.time + '</span><span class="' + cls + '">' + escapeHtml(l.message) + '</span></div>';
            }).join("");

            if (autoScroll) scrollToBottom();
        }

        function fetchLogs() {
            fetch('/api/logs')
                .then(function(r) { return r.json(); })
                .then(function(data) {
                    allLogs = data.logs || [];
                    document.getElementById("footer-uptime").innerText = 'Server ish vaqti: ' + data.uptime + 's | Holat: ' + data.status;
                    renderLogs();

                    if (data.data) {
                        var d = data.data;
                        var botsList = d.bots || (d.bot ? [d.bot] : []);

                        if (botsList.length > 0) {
                            var container = document.getElementById("bots-cards-container");
                            if (container) {
                                var cardsHtml = '';
                                for (var i = 0; i < botsList.length; i++) {
                                    var b = botsList[i];
                                    var statusColor = b.status === 'afk_active' ? 'var(--green)' : (b.status === 'in_economy' || b.status === 'logged_in' ? 'var(--yellow)' : (b.status === 'connecting' || b.status === 'reconnecting' ? '#58a6ff' : 'var(--text-muted)'));
                                    var statusLabel = b.status === 'afk_active' ? 'AFK Onlayn 🟢' : (b.status === 'in_economy' ? 'Economy Serverda 🔵' : (b.status === 'logged_in' ? 'Hub (Kirgan) 🟡' : (b.status || "Noma'lum")));
                                    cardsHtml += '<div class="card">' +
                                        '<div class="card-header">Bot #' + (i + 1) + ': ' + escapeHtml(b.username || 'Bot') + ' 🎮</div>' +
                                        '<div class="stat-val" style="color: ' + statusColor + '; font-size: 20px;">' + statusLabel + '</div>' +
                                        '<div class="stat-desc">Server: ' + escapeHtml(b.host || 'allaysmp.pro') + ' (' + escapeHtml(b.server || 'economy') + ')</div>' +
                                        '<div class="stat-desc">Ish vaqti: ' + escapeHtml(b.uptime_text || '0s') + ' | HP: ' + (b.health != null ? b.health : 20) + ' ❤️</div>' +
                                        (b.last_message ? '<div class="stat-desc" style="margin-top: 5px; font-size: 11px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="' + escapeHtml(b.last_message) + '">Oxirgi: ' + escapeHtml(b.last_message) + '</div>' : '') +
                                    '</div>';
                                }
                                container.innerHTML = cardsHtml;
                            }

                            // Dynamic target dropdown sync
                            var select = document.getElementById('chat-target');
                            if (select) {
                                var existingValues = Array.from(select.options).map(function(o) { return o.value; });
                                botsList.forEach(function(b) {
                                    if (!existingValues.includes(b.username)) {
                                        var opt = document.createElement('option');
                                        opt.value = b.username;
                                        opt.innerText = b.username;
                                        select.appendChild(opt);
                                    }
                                });
                            }

                            // Captcha detection across all bots
                            var pendingBot = botsList.find(function(b) { return b.captchaPending; });
                            var banner = document.getElementById('captcha-alert-banner');
                            if (pendingBot) {
                                activeCaptchaBot = pendingBot.username;
                                var label = document.getElementById('captcha-bot-label');
                                if (label) label.innerText = '(' + pendingBot.username + ')';
                                if (banner.style.display !== 'block') {
                                    banner.style.display = 'block';
                                    document.getElementById('captcha-img').src = '/api/captcha.png?bot=' + encodeURIComponent(pendingBot.username) + '&t=' + Date.now();
                                    setTimeout(function() { document.getElementById('captcha-input').focus(); }, 150);
                                }
                            } else {
                                activeCaptchaBot = null;
                                banner.style.display = 'none';
                            }
                        }

                        if (d.vote && d.vote.votes) {
                            d.vote.votes.forEach(function(v) {
                                var elTime = document.getElementById('vote-' + v.id + '-time');
                                var elLink = document.getElementById('vote-' + v.id + '-link');
                                if (elTime) elTime.innerText = v.remaining_text;
                                if (elLink && v.url) elLink.href = v.url;
                            });
                        }
                    }
                })
                .catch(function(err) { console.error("Logs fetch error:", err); });
        }
        }
        }

        function submitCaptchaCode() {
            const input = document.getElementById('captcha-input');
            const code = input.value.trim();
            if (!code) return;
            const fb = document.getElementById('captcha-feedback');
            fb.innerText = 'Yuborilmoqda...';
            fetch('/api/captcha/solve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: code, bot: activeCaptchaBot || null })
            }).then(r => r.json()).then(d => {
                fb.innerText = d.message || 'Yuborildi!';
                input.value = '';
                fetchLogs();
            }).catch(e => {
                fb.innerText = 'Xatolik: ' + e.message;
            });
        }

        function recordVote(slotId) {
            fetch('/api/vote/record', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ vote_id: slotId })
            }).then(() => fetchLogs());
        }

        function botAction(action) {
            fetch('/api/bot/' + action, { method: 'POST' })
                .then(r => r.json())
                .then(res => {
                    alert(res.message || "Bajarildi");
                    fetchLogs();
                });
        }

        function sendChatMessage() {
            const inp = document.getElementById("chat-msg");
            const text = inp.value.trim();
            if (!text) return;
            const targetSelect = document.getElementById("chat-target");
            const target = targetSelect ? targetSelect.value : 'all';
            fetch('/api/bot/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: text, bot: target })
            }).then(r => r.json()).then(res => {
                inp.value = '';
                fetchLogs();
            });
        }

        fetchLogs();
        setInterval(fetchLogs, 3000);
    </script>
</body>
</html>`;

class WebServer {
  constructor(port = config.PORT, host = config.HOST, getStatusCallback = null, actionCallback = null, supervisor = null) {
    this.port = port;
    this.host = host;
    this.getStatusCallback = getStatusCallback;
    this.actionCallback = actionCallback;
    this.supervisor = supervisor;
    this.server = null;
    this.startTime = Date.now();
    this.keepAliveTimer = null;
  }

  start() {
    this.server = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const cleanPath = parsedUrl.pathname.replace(/\/$/, '') || '/';

      const sendJson = (status, data) => {
        const body = Buffer.from(JSON.stringify(data, null, 2), 'utf-8');
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Content-Length': body.length
        });
        res.end(body);
      };

      // GET so'rovlar
      if (req.method === 'GET') {
        if (cleanPath === '/' || cleanPath === '/logs' || cleanPath === '/dashboard') {
          const body = Buffer.from(HTML_DASHBOARD, 'utf-8');
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': body.length
          });
          res.end(body);
          return;
        }

        if (cleanPath === '/api/raw_map.bin') {
          const raw = (this.supervisor && this.supervisor.lastRawMap) ? this.supervisor.lastRawMap : Buffer.alloc(0);
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': raw.length
          });
          res.end(raw);
          return;
        }

        if (cleanPath === '/api/captcha.png' || cleanPath === '/api/captcha/image') {
          const botParam = parsedUrl.searchParams.get('bot');
          let png = null;
          if (this.supervisor) {
            if (botParam && this.supervisor.bots) {
              const targetBot = this.supervisor.bots.find(b => b.username.toLowerCase() === botParam.toLowerCase());
              if (targetBot && targetBot.lastCaptchaPng) png = targetBot.lastCaptchaPng;
            }
            if (!png && this.supervisor.lastCaptchaPng) {
              png = this.supervisor.lastCaptchaPng;
            }
          }
          if (png) {
            res.writeHead(200, {
              'Content-Type': 'image/png',
              'Content-Length': png.length,
              'Cache-Control': 'no-cache, no-store, must-revalidate'
            });
            res.end(png);
            return;
          }
          const blankPng = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2d0000000049454e44ae426082', 'hex');
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': blankPng.length,
            'Cache-Control': 'no-cache'
          });
          res.end(blankPng);
          return;
        }

        if (cleanPath === '/api/logs') {
          const uptime = Math.floor((Date.now() - this.startTime) / 1000);
          const logs = globalLogBuffer.getLogs();
          const data = this.getStatusCallback ? this.getStatusCallback() : {};
          sendJson(200, {
            status: 'healthy',
            uptime: uptime,
            count: logs.length,
            window_hours: 2.0,
            data: data,
            logs: logs
          });
          return;
        }

        if (cleanPath === '/health' || cleanPath === '/ping') {
          const uptime = Math.floor((Date.now() - this.startTime) / 1000);
          const data = this.getStatusCallback ? this.getStatusCallback() : {};
          sendJson(200, {
            status: 'healthy',
            uptime: uptime,
            data: data
          });
          return;
        }

        sendJson(404, { error: 'Not Found' });
        return;
      }

      // POST so'rovlar
      if (req.method === 'POST') {
        let bodyRaw = '';
        req.on('data', chunk => { bodyRaw += chunk; });
        req.on('end', () => {
          let payload = {};
          if (bodyRaw) {
            try { payload = JSON.parse(bodyRaw); } catch (_) {}
          }

          if (this.actionCallback) {
            try {
              const result = this.actionCallback(cleanPath, payload);
              sendJson(200, result);
              return;
            } catch (err) {
              sendJson(500, { success: false, error: err.message });
              return;
            }
          }

          sendJson(400, { success: false, error: 'Action handler topilmadi' });
        });
        return;
      }

      sendJson(405, { error: 'Method Not Allowed' });
    });

    this.server.listen(this.port, this.host, () => {
      console.log(`[WebServer] Veb Dashboard ishga tushdi: http://${this.host}:${this.port} (Health: /health)`);
    });
  }

  startKeepAlive(externalUrl = config.SERVER_PUBLIC_URL, intervalSec = config.KEEP_ALIVE_INTERVAL) {
    if (!externalUrl) return;
    const target = `${externalUrl.replace(/\/$/, '')}/health`;
    console.log(`[KeepAlive] Render anti-sleep tizimi yoqildi: ${target} (har ${Math.floor(intervalSec / 60)} daqiqada)`);

    const ping = () => {
      try {
        const client = target.startsWith('https') ? https : http;
        client.get(target, { headers: { 'User-Agent': 'Render-KeepAlive/1.0' }, timeout: 15000 }, (res) => {
          if (res.statusCode === 200) {
            console.log('[KeepAlive] Render uyg\'oq saqlandi (Status: 200 OK)');
          } else {
            console.log(`[KeepAlive] Kutilmagan status: ${res.statusCode}`);
          }
        }).on('error', (err) => {
          console.log(`[KeepAlive] Ping ogohlantirishi: ${err.message}`);
        });
      } catch (err) {
        console.log(`[KeepAlive] Xatolik: ${err.message}`);
      }
    };

    setTimeout(ping, 20000);
    this.keepAliveTimer = setInterval(ping, intervalSec * 1000);
  }

  stop() {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    if (this.server) {
      this.server.close();
      console.log('[WebServer] Veb server to\'xtatildi.');
    }
  }
}

module.exports = { WebServer, globalLogBuffer };
