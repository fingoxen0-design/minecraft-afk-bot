const fs = require('fs');
const path = require('path');

class ShardTracker {
  constructor(stateFilePath = null) {
    this.stateFilePath = stateFilePath || path.resolve(__dirname, 'shard_state.json');
    this.state = {
      total_shards: 6100,
      session_shards: 0,
      last_earned_time: null,
      last_sync_time: null,
      history: []
    };
    this.loadState();
  }

  loadState() {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const raw = fs.readFileSync(this.stateFilePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (typeof parsed.total_shards === 'number') {
          this.state.total_shards = parsed.total_shards;
        }
        if (typeof parsed.session_shards === 'number') {
          this.state.session_shards = parsed.session_shards;
        }
        if (parsed.last_earned_time) {
          this.state.last_earned_time = parsed.last_earned_time;
        }
        if (parsed.last_sync_time) {
          this.state.last_sync_time = parsed.last_sync_time;
        }
        if (Array.isArray(parsed.history)) {
          this.state.history = parsed.history.slice(-30);
        }
      } else {
        this.saveState();
      }
    } catch (err) {
      console.error('[ShardTracker] Holatni o\'qishda xatolik:', err.message);
    }
  }

  saveState() {
    try {
      fs.writeFileSync(this.stateFilePath, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (err) {
      console.error('[ShardTracker] Holatni saqlashda xatolik:', err.message);
    }
  }

  addShards(amount = 10, reason = 'afk_pool') {
    const num = parseInt(amount, 10);
    if (isNaN(num) || num <= 0) return this.state.total_shards;

    this.state.total_shards += num;
    this.state.session_shards += num;
    this.state.last_earned_time = Date.now();

    const timeStr = new Date().toLocaleTimeString();
    this.state.history.push({
      time: timeStr,
      amount: num,
      reason: reason,
      total: this.state.total_shards
    });
    if (this.state.history.length > 50) {
      this.state.history.shift();
    }

    this.saveState();
    return this.state.total_shards;
  }

  setTotalShards(amount, reason = 'server_sync') {
    const num = parseInt(String(amount).replace(/,/g, ''), 10);
    if (isNaN(num) || num < 0) return false;

    const diff = num - this.state.total_shards;
    this.state.total_shards = num;
    this.state.last_sync_time = Date.now();

    const timeStr = new Date().toLocaleTimeString();
    this.state.history.push({
      time: timeStr,
      amount: diff,
      reason: reason,
      total: this.state.total_shards
    });
    if (this.state.history.length > 50) {
      this.state.history.shift();
    }

    this.saveState();
    return true;
  }

  parseChat(message) {
    if (!message || typeof message !== 'string') return false;
    const clean = message.replace(/§[0-9a-fk-or]/gi, '').trim();
    const lower = clean.toLowerCase();

    // 1. Yangi shard qo'shilgandagi xabarlar: (+10 Shards, You received 10 Shards)
    const addMatch = clean.match(/(?:\+|received|olindi|added)\s*(\d+)\s*(?:shard|💎)/i) ||
                     clean.match(/(\d+)\s*shards?\s*(?:received|added|berildi)/i);
    if (addMatch && addMatch[1]) {
      const added = parseInt(addMatch[1], 10);
      if (added > 0 && added < 10000) {
        this.addShards(added, 'chat_reward');
        return { type: 'added', amount: added, total: this.state.total_shards };
      }
    }

    // 2. Balans xabari: "AFK • You have: ★6.1K Shard", "Shards: 6,150", "Balance: 6100 shards"
    const totalMatch = clean.match(/(?:you have|shards?|shard\s*balansi?|balance|sizda|jami|total):\s*[★\s]*([\d.,]+[kKmM]?)\s*(?:shard|💎)?/i);
    if (totalMatch && totalMatch[1]) {
      let rawVal = totalMatch[1].replace(/,/g, '').trim().toUpperCase();
      let total = 0;
      if (rawVal.endsWith('K')) {
        total = Math.round(parseFloat(rawVal.slice(0, -1)) * 1000);
      } else if (rawVal.endsWith('M')) {
        total = Math.round(parseFloat(rawVal.slice(0, -1)) * 1000000);
      } else {
        total = parseInt(rawVal, 10);
      }
      if (!isNaN(total) && total >= 0) {
        this.setTotalShards(total, 'chat_balance');
        return { type: 'sync', total: this.state.total_shards };
      }
    }

    return false;
  }

  formatCount(count) {
    if (count >= 1000000) {
      return (count / 1000000).toFixed(1) + 'M';
    }
    if (count >= 1000) {
      return (count / 1000).toFixed(1) + 'K';
    }
    return String(count);
  }

  getSummary() {
    return {
      total: this.state.total_shards,
      formatted_total: this.formatCount(this.state.total_shards),
      session: this.state.session_shards,
      last_earned_time: this.state.last_earned_time,
      last_sync_time: this.state.last_sync_time,
      history: this.state.history.slice(-10)
    };
  }
}

module.exports = ShardTracker;
