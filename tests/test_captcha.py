import unittest
import re
import os
import subprocess
import json

def extract_captcha_from_packet(packet_name: str, clean_text: str) -> str | None:
    """
    Simulates the safe captcha extraction logic.
    Kick/disconnect packets and kick/error messages must be ignored.
    """
    if not packet_name or not clean_text:
        return None

    # 1. Explicitly ignore kick/disconnect packets
    ignored_packets = {'kick_disconnect', 'disconnect', 'system_kick', 'kicked'}
    if packet_name.lower() in ignored_packets:
        return None

    # 2. Reject messages containing kick or error phrases
    negative_phrases = [
        'incorrect',
        'wrong',
        'kicked',
        'banned',
        'failed',
        'too long',
        'timed out',
        'chiqarildi',
        'attempts remaining'
    ]
    for phrase in negative_phrases:
        if phrase in clean_text.lower():
            return None

    # 3. Clean extraction regex:
    # 3a. Explicit commands: /captcha <code> or /code <code>
    m = re.search(r'(?:/captcha|/code)\s+([0-9a-zA-Z]+)', clean_text, re.IGNORECASE)
    if m:
        val = m.group(1).strip()
        if val.lower() not in ('code', 'captcha'):
            return val

    # 3b. Key-value style: Captcha Code: 1234, Code: 1234, Kod: 1234, Captcha: 1234
    m = re.search(r'(?:captcha\s+code|kod|code|captcha)\s*[:=]\s*([0-9a-zA-Z]{3,8})', clean_text, re.IGNORECASE)
    if m:
        val = m.group(1).strip()
        if val.lower() not in ('code', 'captcha'):
            return val

    # 3c. Word followed by pure digits: code 1234, kod 1234, captcha 1234 (avoids English words like 'code for')
    m = re.search(r'(?:captcha\s+code|kod|code|captcha)\s+([0-9]{3,8})\b', clean_text, re.IGNORECASE)
    if m:
        return m.group(1).strip()

    # 3d. Standalone code string
    m = re.match(r'^\s*([0-9a-zA-Z]{4,8})\s*$', clean_text)
    if m:
        val = m.group(1).strip()
        if val.lower() not in ('code', 'captcha'):
            return val

    return None


class TestCaptchaExtraction(unittest.TestCase):
    def test_kick_disconnect_packets_ignored(self):
        """Kick and disconnect packets must never extract captcha codes."""
        kick_packets = ['kick_disconnect', 'disconnect', 'system_kick', 'KICK_DISCONNECT']
        test_messages = [
            "You have entered the incorrect captcha code 3 times!",
            "/captcha 12345",
            "code: 9988",
            "58219"
        ]
        for pkt in kick_packets:
            for msg in test_messages:
                res = extract_captcha_from_packet(pkt, msg)
                self.assertIsNone(res, f"Packet '{pkt}' with msg '{msg}' should NOT extract captcha, got: {res}")

    def test_kick_and_error_messages_ignored(self):
        """Messages indicating incorrect captcha, kick, or timeout must not extract codes."""
        error_messages = [
            "You have entered the incorrect captcha code 3 times!",
            "You have entered the incorrect captcha code",
            "Incorrect captcha code! Please try again.",
            "Kicked: You have entered the incorrect captcha code 3 times!",
            "Connection lost: You took too long to log in",
            "Serverdan chiqarildi: Captcha/Login vaqti o'tib ketdi",
            "Timed out waiting for captcha verification",
            "You have 3 attempts remaining"
        ]
        for msg in error_messages:
            res = extract_captcha_from_packet('system_chat', msg)
            self.assertIsNone(res, f"Error message '{msg}' must not trigger captcha extraction, got: {res}")
            res_player = extract_captcha_from_packet('player_chat', msg)
            self.assertIsNone(res_player, f"Error message in player_chat '{msg}' must not trigger, got: {res_player}")

    def test_valid_captcha_extraction(self):
        """Valid captcha prompts and commands must extract the clean code."""
        valid_cases = [
            ("/captcha 12345", "12345"),
            ("/code 9876", "9876"),
            ("kod: 7491", "7491"),
            ("code: 58219", "58219"),
            ("captcha: 3948", "3948"),
            ("Enter captcha: 4821", "4821"),
            ("KOD: 8472", "8472"),
            ("Captcha Code: 9382", "9382"),
            ("94827", "94827"),
            ("A9bX2", "A9bX2"),
            ("code 6821", "6821")
        ]
        for text, expected in valid_cases:
            res = extract_captcha_from_packet('system_chat', text)
            self.assertEqual(res, expected, f"Expected '{expected}' for '{text}', got: '{res}'")

    def test_negative_false_positives_not_matching(self):
        """Random chat or sentences containing 'code' or 'captcha' without valid token must not match."""
        invalid_cases = [
            "The code of conduct is available on our website",
            "Please enter the captcha",
            "Connected to economy server",
            "AFK status active",
            "Hello everyone, what is the code for the door?",
            "code",
            "captcha"
        ]
        for text in invalid_cases:
            res = extract_captcha_from_packet('player_chat', text)
            self.assertIsNone(res, f"False positive matched for '{text}', got: {res}")

    def test_node_regex_behavior(self):
        """Verify Node.js regex execution matches desired behavior."""
        node_script = """
        const testCases = [
          { text: "You have entered the incorrect captcha code 3 times!", isKick: true, expected: null },
          { text: "You have entered the incorrect captcha code", isKick: false, expected: null },
          { text: "/captcha 12345", isKick: false, expected: "12345" },
          { text: "/code 9876", isKick: false, expected: "9876" },
          { text: "kod: 7491", isKick: false, expected: "7491" },
          { text: "code: 58219", isKick: false, expected: "58219" },
          { text: "captcha: 3948", isKick: false, expected: "3948" },
          { text: "Captcha Code: 9382", isKick: false, expected: "9382" },
          { text: "49285", isKick: false, expected: "49285" },
          { text: "The code of conduct is available on our website", isKick: false, expected: null },
          { text: "Hello everyone, what is the code for the door?", isKick: false, expected: null }
        ];

        function parse(cleanText, isKickPacket) {
          if (isKickPacket) return null;
          if (/incorrect|wrong|kicked|banned|failed|too long|timed out/i.test(cleanText)) return null;

          const codeMatch = cleanText.match(/(?:\\/captcha|\\/code)\\s+([0-9a-zA-Z]+)/i) ||
                            cleanText.match(/(?:captcha\\s+code|kod|code|captcha)\\s*[:=]\\s*([0-9a-zA-Z]{3,8})/i) ||
                            cleanText.match(/(?:captcha\\s+code|kod|code|captcha)\\s+([0-9]{3,8})\\b/i) ||
                            cleanText.match(/^\\s*([0-9a-zA-Z]{4,8})\\s*$/);
          if (codeMatch && codeMatch[1]) {
            const val = codeMatch[1].trim();
            if (/^(code|captcha)$/i.test(val)) return null;
            return val;
          }
          return null;
        }

        const results = testCases.map(tc => ({
          text: tc.text,
          got: parse(tc.text, !!tc.isKick),
          expected: tc.expected
        }));
        console.log(JSON.stringify(results));
        """
        proc = subprocess.run(["node", "-e", node_script], capture_output=True, text=True, check=True)
        results = json.loads(proc.stdout.strip())
        for r in results:
            self.assertEqual(r['got'], r['expected'], f"Node.js eval mismatch for '{r['text']}': got {r['got']} != {r['expected']}")


if __name__ == '__main__':
    unittest.main()
