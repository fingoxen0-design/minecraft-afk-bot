const EventEmitter = require('events');

class ChatManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.botUsername = (options.botUsername || 'Gotto').toLowerCase();
    this.owners = (options.owners || ['fingoxenpro', 'fingoxen', 'bunyod']).map(s => s.toLowerCase());

    // Duplicate xabarlar filtri (500ms oyna)
    this.dedupCache = new Map();
    this.dedupWindowMs = options.dedupWindowMs || 600;
  }

  setBotUsername(name) {
    this.botUsername = String(name || '').toLowerCase();
  }

  setOwners(ownersList) {
    this.owners = (ownersList || []).map(s => String(s).trim().toLowerCase());
  }

  isOwner(username) {
    if (!username) return false;
    const clean = String(username).trim().toLowerCase();
    return this.owners.includes(clean);
  }

  stripColors(str) {
    if (!str) return '';
    return String(str).replace(/§[0-9a-fk-or]/gi, '').trim();
  }

  stripRanks(senderRaw) {
    if (!senderRaw) return '';
    let name = String(senderRaw).trim();
    // [OWNER], [VIP], [MVP+], [MEDIA], [ADMIN], <RANK> larni tozalash
    name = name.replace(/^\[[^\]]+\]\s*/i, '');
    name = name.replace(/^<[^>]+>\s*/i, '');
    name = name.replace(/[»:]/g, '').trim();
    return name;
  }

  isDuplicate(signature) {
    const now = Date.now();
    // Eskirganlarni tozalash
    for (const [key, ts] of this.dedupCache.entries()) {
      if (now - ts > this.dedupWindowMs) {
        this.dedupCache.delete(key);
      }
    }

    if (this.dedupCache.has(signature)) {
      return true;
    }
    this.dedupCache.set(signature, now);
    return false;
  }

  parseMessage(rawText, sourceEvent = 'messagestr') {
    const clean = this.stripColors(rawText);
    if (!clean) return null;

    // Deduplikatsiya imzosi
    const signature = `${clean.slice(0, 100)}`;
    if (this.isDuplicate(signature)) {
      return { isDuplicate: true, clean };
    }

    // 1. Shaxsiy xabar (Private message / whisper) aniqlash
    // Masalan: [MSG] Fingoxenpro » Gotto: !afk  yoki  Fingoxenpro whispers: !afk  yoki  [Fingoxenpro -> Gotto] !afk
    let pmMatch = clean.match(/\[MSG\]\s*([^»:]+)\s*»\s*([^:]+):\s*(.*)$/i) ||
                  clean.match(/\[([^\]]+)\s*->\s*([^\]]+)\]\s*(.*)$/i) ||
                  clean.match(/^([a-zA-Z0-9_]+)\s+whispers(?:\s+to\s+you)?:\s*(.*)$/i);

    if (pmMatch) {
      const rawSender = pmMatch[1];
      const cleanSender = this.stripRanks(rawSender);
      const content = pmMatch[3] !== undefined ? pmMatch[3].trim() : pmMatch[2].trim();
      const isOwnerSender = this.isOwner(cleanSender);
      const isSelf = cleanSender.toLowerCase() === this.botUsername;

      const parsed = {
        type: 'whisper',
        sender: cleanSender,
        rawSender,
        content,
        isOwner: isOwnerSender,
        isSelf,
        clean
      };

      this.processParsedMessage(parsed);
      return parsed;
    }

    // 2. Umumiy chat (Public chat) aniqlash
    // Masalan: [OWNER] Fingoxenpro » salom  yoki  Fingoxenpro: salom
    let chatMatch = clean.match(/^(\[[^\]]+\]\s*)?([a-zA-Z0-9_]{3,16})\s*[»:]\s*(.*)$/i);
    if (chatMatch) {
      const cleanSender = chatMatch[2].trim();
      const content = chatMatch[3].trim();
      const isOwnerSender = this.isOwner(cleanSender);
      const isSelf = cleanSender.toLowerCase() === this.botUsername;

      const parsed = {
        type: 'public_chat',
        sender: cleanSender,
        rawSender: chatMatch[1] ? (chatMatch[1] + cleanSender) : cleanSender,
        content,
        isOwner: isOwnerSender,
        isSelf,
        clean
      };

      this.processParsedMessage(parsed);
      return parsed;
    }

    // 3. TPA so'rovi (Teleport request)
    // Masalan: Fingoxenpro has requested to teleport to you. /tpaccept
    let tpaMatch = clean.match(/([a-zA-Z0-9_]{3,16})\s+(?:has requested to teleport|wants to teleport)/i);
    if (tpaMatch) {
      const requester = tpaMatch[1].trim();
      const isOwnerSender = this.isOwner(requester);
      const parsed = {
        type: 'tpa_request',
        sender: requester,
        isOwner: isOwnerSender,
        clean
      };
      this.emit('tpaRequest', parsed);
      return parsed;
    }

    // 4. Practice / Hub xabari aniqlash (Fallback detektori uchun)
    if (/has been killed by|mace ffa|kitpvp|duel ended|practice/i.test(clean)) {
      const parsed = {
        type: 'practice_signal',
        clean
      };
      this.emit('practiceSignal', parsed);
      return parsed;
    }

    // 5. Tizim xabari (System message)
    const parsed = {
      type: 'system',
      clean
    };
    this.emit('systemMessage', parsed);
    return parsed;
  }

  processParsedMessage(parsed) {
    if (parsed.isSelf) {
      // Botning o'z xabarlarini e'tiborsiz qoldirish
      return;
    }

    // Egasi buyrug'ini tekshirish
    if (parsed.isOwner) {
      const msg = parsed.content.trim();
      // Buyruqlar: !afk, !tp, kel, !tpa, !tpaccept, !status, !help
      const cmdMatch = msg.match(/^!([a-zA-Z0-9_-]+)(?:\s+(.*))?$/i);
      if (cmdMatch) {
        const command = cmdMatch[1].toLowerCase();
        const args = cmdMatch[2] ? cmdMatch[2].split(/\s+/) : [];
        this.emit('ownerCommand', {
          command,
          args,
          raw: msg,
          sender: parsed.sender,
          type: parsed.type
        });
      } else if (/^kel$/i.test(msg)) {
        this.emit('ownerCommand', {
          command: 'tp',
          args: [parsed.sender],
          raw: msg,
          sender: parsed.sender,
          type: parsed.type
        });
      }
    }

    this.emit('message', parsed);
  }
}

module.exports = ChatManager;
