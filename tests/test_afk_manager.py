import unittest
from unittest.mock import MagicMock, patch
from afk_manager import AFKManager, AFKBotSession
import config

class TestAFKManager(unittest.TestCase):
    def setUp(self):
        self.manager = AFKManager()

    def tearDown(self):
        self.manager.stop_all()

    def test_session_init(self):
        conf = {
            "username": "TestBot",
            "host": "127.0.0.1",
            "port": 25565,
            "subserver": "economy"
        }
        session = AFKBotSession("12345", conf)
        self.assertEqual(session.status, "stopped")
        self.assertFalse(session.is_running)
        info = session.get_info()
        self.assertEqual(info["username"], "TestBot")
        self.assertEqual(info["status"], "stopped")

    @patch.object(AFKBotSession, "_read_output", lambda self: None)
    @patch("subprocess.Popen")
    def test_start_and_stop_bot(self, mock_popen):
        mock_proc = MagicMock()
        mock_proc.poll.return_value = None
        mock_popen.return_value = mock_proc

        conf = {
            "username": "TestPlayer",
            "host": "127.0.0.1",
            "port": 25565,
            "subserver": "economy"
        }
        success, msg = self.manager.start_user_bot("user_1", conf)
        self.assertTrue(success)
        self.assertEqual(self.manager.get_active_count(), 1)

        # Duplicate start should fail
        dup_success, dup_msg = self.manager.start_user_bot("user_1", conf)
        self.assertFalse(dup_success)

        # Stop bot
        stop_success, stop_msg = self.manager.stop_user_bot("user_1")
        self.assertTrue(stop_success)
        self.assertEqual(self.manager.get_active_count(), 0)

    @patch.object(AFKBotSession, "_read_output", lambda self: None)
    @patch("subprocess.Popen")
    def test_max_active_bots_limit(self, mock_popen):
        mock_proc = MagicMock()
        mock_proc.poll.return_value = None
        mock_popen.return_value = mock_proc

        with patch.object(config, "MAX_ACTIVE_BOTS", 2):
            s1, _ = self.manager.start_user_bot("u1", {"username": "B1"})
            s2, _ = self.manager.start_user_bot("u2", {"username": "B2"})
            self.assertTrue(s1)
            self.assertTrue(s2)
            self.assertEqual(self.manager.get_active_count(), 2)

            # Third bot should be rejected due to limit 2
            s3, msg3 = self.manager.start_user_bot("u3", {"username": "B3"})
            self.assertFalse(s3)
            self.assertIn("to'lgan", msg3)

    @patch.object(AFKBotSession, "_read_output", lambda self: None)
    @patch("subprocess.Popen")
    def test_send_chat_functionality(self, mock_popen):
        mock_proc = MagicMock()
        mock_proc.poll.return_value = None
        mock_stdin = MagicMock()
        mock_proc.stdin = mock_stdin
        mock_popen.return_value = mock_proc

        self.manager.start_user_bot("u_chat", {"username": "ChatBot"})
        ok, res = self.manager.send_user_chat("u_chat", "Salom dunyo!")
        self.assertTrue(ok)
        mock_stdin.write.assert_called_once()
        self.assertIn("Salom dunyo!", mock_stdin.write.call_args[0][0])

        # Test non-active user chat
        fail_ok, fail_res = self.manager.send_user_chat("u_offline", "Salom")
        self.assertFalse(fail_ok)

if __name__ == "__main__":
    unittest.main()
