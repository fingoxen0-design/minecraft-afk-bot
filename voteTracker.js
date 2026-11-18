const fs = require('fs');
const path = require('path');
const config = require('./config');

class VoteTracker {
  constructor(stateFilePath) {
    this.stateFile = stateFilePath ? path.resolve(stateFilePath) : path.resolve(__dirname, 'vote_state.json');
    this.defaultCooldownHours = config.COOLDOWN_HOURS || 15.0;

    this.defaultSlots = {
      "1": {
        id: 1,
        name: "Minecraft-MP (Server #1)",
        url: config.VOTE_1_URL || "https://minecraft-mp.com/server/350645/vote/",
        cooldown_hours: this.defaultCooldownHours,
        last_vote_timestamp: 0,
        next_vote_timestamp: 0,
        total_votes_recorded: 0,
        alert_sent: false
      },
      "2": {
        id: 2,
        name: "Vote Server #2",
        url: config.VOTE_2_URL || "",
        cooldown_hours: 24.0,
        last_vote_timestamp: 0,
        next_vote_timestamp: 0,
        total_votes_recorded: 0,
        alert_sent: false
      },
      "3": {
        id: 3,
        name: "Vote Server #3",
        url: config.VOTE_3_URL || "",
        cooldown_hours: 24.0,
        last_vote_timestamp: 0,
        next_vote_timestamp: 0,
        total_votes_recorded: 0,
        alert_sent: false
      },
      "4": {
        id: 4,
        name: "Vote Server #4",
        url: config.VOTE_4_URL || "",
        cooldown_hours: 24.0,
        last_vote_timestamp: 0,
        next_vote_timestamp: 0,
        total_votes_recorded: 0,
        alert_sent: false
      }
    };

    this.state = {
      votes: JSON.parse(JSON.stringify(this.defaultSlots))
    };

    this.loadState();
  }

  _ensureSlots() {
    if (!this.state.votes || typeof this.state.votes !== 'object') {
      this.state.votes = {};
    }
    for (const [key, defaultVal] of Object.entries(this.defaultSlots)) {
      if (!this.state.votes[key]) {
        this.state.votes[key] = { ...defaultVal };
      } else {
        for (const [subKey, subVal] of Object.entries(defaultVal)) {
          if (this.state.votes[key][subKey] === undefined) {
            this.state.votes[key][subKey] = subVal;
          }
        }
      }
    }
  }

  loadState() {
    try {
      if (fs.existsSync(this.stateFile)) {
        const raw = fs.readFileSync(this.stateFile, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          if (parsed.votes) {
            this.state.votes = parsed.votes;
          }
        }
      }
    } catch (err) {
      console.error('[VoteTracker] Holatni yuklashda xatolik:', err.message);
    }
    this._ensureSlots();
  }

  saveState() {
    try {
      this._ensureSlots();
      const tmpFile = `${this.stateFile}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify(this.state, null, 2), 'utf-8');
      fs.renameSync(tmpFile, this.stateFile);
    } catch (err) {
      console.error('[VoteTracker] Holatni saqlashda xatolik:', err.message);
    }
  }

  parseTimeFromUrlOrText(text) {
    if (!text || typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (/^\d{10}$/.test(trimmed)) {
      return parseInt(trimmed, 10);
    }
    const match = trimmed.match(/[?&]time=(\d{10})/i) || trimmed.match(/time=(\d{10})/i);
    if (match && match[1]) {
      return parseInt(match[1], 10);
    }
    return null;
  }

  recordVote(slotId = 1, customNextTime = null, cooldownHours = null) {
    const key = String(slotId || 1);
    this._ensureSlots();
    const slot = this.state.votes[key] || this.state.votes["1"];
    const now = Math.floor(Date.now() / 1000);

    const hours = (cooldownHours !== null && cooldownHours > 0)
      ? parseFloat(cooldownHours)
      : parseFloat(slot.cooldown_hours || this.defaultCooldownHours);

    slot.last_vote_timestamp = now;
    slot.cooldown_hours = hours;
    slot.total_votes_recorded = (slot.total_votes_recorded || 0) + 1;
    slot.alert_sent = false;

    if (customNextTime && customNextTime > now) {
      slot.next_vote_timestamp = Math.floor(customNextTime);
    } else {
      slot.next_vote_timestamp = now + Math.floor(hours * 3600);
    }

    this.saveState();
    return slot;
  }

  setNextVoteTime(slotId = 1, nextTs) {
    const key = String(slotId || 1);
    this._ensureSlots();
    const slot = this.state.votes[key] || this.state.votes["1"];
    slot.next_vote_timestamp = Math.floor(nextTs);
    slot.alert_sent = false;
    this.saveState();
  }

  getRemainingSeconds(slotId = 1) {
    const key = String(slotId || 1);
    this._ensureSlots();
    const slot = this.state.votes[key];
    const nextTime = slot ? (slot.next_vote_timestamp || 0) : 0;
    const now = Math.floor(Date.now() / 1000);
    return Math.max(0, nextTime - now);
  }

  isTimeToVote(slotId = 1) {
    return this.getRemainingSeconds(slotId) === 0;
  }

  setVoteUrl(slotId = 1, url, name = null) {
    const key = String(slotId || 1);
    this._ensureSlots();
    const slot = this.state.votes[key];
    if (slot) {
      slot.url = (url || '').trim();
      if (name) slot.name = name.trim();
      this.saveState();
    }
  }

  getVoteUrl(slotId = 1, defaultUrl = "") {
    const key = String(slotId || 1);
    this._ensureSlots();
    const slot = this.state.votes[key];
    return (slot && slot.url) ? slot.url : defaultUrl;
  }

  formatRemainingTime(slotId = 1) {
    const rem = this.getRemainingSeconds(slotId);
    if (rem <= 0) return "Hozir ovoz berish mumkin! 🟢";

    const hours = Math.floor(rem / 3600);
    const minutes = Math.floor((rem % 3600) / 60);
    const seconds = rem % 60;

    const parts = [];
    if (hours > 0) parts.push(`${hours} soat`);
    if (minutes > 0) parts.push(`${minutes} daqiqa`);
    if (parts.length === 0 || (hours === 0 && minutes < 5)) {
      parts.push(`${seconds} soniya`);
    }
    return parts.join(" ");
  }

  formatTimestamp(ts) {
    if (!ts) return "Aniqlanmagan";
    try {
      const d = new Date(ts * 1000);
      return d.toISOString().replace('T', ' ').slice(0, 19);
    } catch {
      return "Noto'g'ri sana";
    }
  }

  getSlotSummary(slotId) {
    const key = String(slotId || 1);
    this._ensureSlots();
    const slot = this.state.votes[key] || {};
    const rem = this.getRemainingSeconds(key);

    return {
      id: parseInt(key, 10) || key,
      name: slot.name || `Vote #${key}`,
      url: slot.url || '',
      status: rem === 0 ? "ready_to_vote" : "cooldown_active",
      remaining_seconds: rem,
      remaining_text: this.formatRemainingTime(key),
      last_vote_time: this.formatTimestamp(slot.last_vote_timestamp),
      next_vote_time: this.formatTimestamp(slot.next_vote_timestamp),
      cooldown_hours: slot.cooldown_hours || this.defaultCooldownHours,
      total_votes: slot.total_votes_recorded || 0
    };
  }

  getAllVotes() {
    this._ensureSlots();
    return Object.keys(this.state.votes)
      .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
      .map(k => this.getSlotSummary(k));
  }

  getSummary() {
    const all = this.getAllVotes();
    const readyCount = all.filter(v => v.status === 'ready_to_vote').length;
    const slot1 = all[0] || {};

    return {
      status: slot1.status || 'ready_to_vote',
      remaining_seconds: slot1.remaining_seconds || 0,
      remaining_text: slot1.remaining_text || 'Hozir ovoz berish mumkin! 🟢',
      last_vote_time: slot1.last_vote_time,
      next_vote_time: slot1.next_vote_time,
      cooldown_hours: slot1.cooldown_hours,
      total_votes: all.reduce((sum, v) => sum + (v.total_votes || 0), 0),
      ready_count: readyCount,
      total_slots: all.length,
      votes: all
    };
  }
}

module.exports = VoteTracker;
VoteTracker.VoteTracker = VoteTracker;

