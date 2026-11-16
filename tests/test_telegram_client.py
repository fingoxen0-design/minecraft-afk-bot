import unittest
from unittest.mock import patch, MagicMock
import json
import requests
from telegram_client import TelegramClient

class TestTelegramClient(unittest.TestCase):
    def setUp(self):
        self.client = TelegramClient(token="fake_token_123", default_chat_id="999999")

    def test_init(self):
        self.assertEqual(self.client.token, "fake_token_123")
        self.assertEqual(self.client.default_chat_id, "999999")
        self.assertEqual(self.client.base_url, "https://api.telegram.org/botfake_token_123")

    def test_send_message_missing_token_or_chat_id(self):
        # Missing token
        c1 = TelegramClient(token="", default_chat_id="123")
        self.assertFalse(c1.send_message("hello"))

        # Missing chat_id
        c2 = TelegramClient(token="token123", default_chat_id="")
        self.assertFalse(c2.send_message("hello"))

    @patch("requests.post")
    def test_send_message_success(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_post.return_value = mock_resp

        markup = {"inline_keyboard": [[{"text": "Btn", "url": "http://example.com"}]]}
        result = self.client.send_message("Test message", chat_id="8888", reply_markup=markup, parse_mode="HTML")

        self.assertTrue(result)
        mock_post.assert_called_once()
        args, kwargs = mock_post.call_args
        self.assertEqual(args[0], "https://api.telegram.org/botfake_token_123/sendMessage")
        payload = kwargs["data"]
        self.assertEqual(payload["chat_id"], "8888")
        self.assertEqual(payload["text"], "Test message")
        self.assertEqual(payload["parse_mode"], "HTML")
        self.assertEqual(payload["reply_markup"], json.dumps(markup))

    @patch("requests.post")
    def test_send_message_failure_status(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.status_code = 400
        mock_resp.text = "Bad Request: can't parse entities"
        mock_post.return_value = mock_resp

        result = self.client.send_message("Invalid HTML <unclosed")
        self.assertFalse(result)

    @patch("requests.post")
    def test_send_message_network_exception(self, mock_post):
        mock_post.side_effect = requests.RequestException("DNS lookup failed")
        result = self.client.send_message("Hello")
        self.assertFalse(result)

    def test_get_updates_missing_token(self):
        c = TelegramClient(token="")
        self.assertEqual(c.get_updates(), [])

    @patch("requests.get")
    def test_get_updates_success(self, mock_get):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "ok": True,
            "result": [
                {"update_id": 1, "message": {"text": "/start", "chat": {"id": 999999}}}
            ]
        }
        mock_get.return_value = mock_resp

        updates = self.client.get_updates(offset=10, timeout=5)
        self.assertEqual(len(updates), 1)
        self.assertEqual(updates[0]["update_id"], 1)

    @patch("requests.get")
    def test_get_updates_not_ok(self, mock_get):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"ok": False, "error_code": 401}
        mock_get.return_value = mock_resp

        updates = self.client.get_updates()
        self.assertEqual(updates, [])

    @patch("requests.get")
    def test_get_updates_exception(self, mock_get):
        mock_get.side_effect = requests.RequestException("Timeout")
        updates = self.client.get_updates()
        self.assertEqual(updates, [])

    def test_answer_callback_query_missing_token(self):
        c = TelegramClient(token="")
        self.assertFalse(c.answer_callback_query("cb_123"))

    @patch("requests.post")
    def test_answer_callback_query_success(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_post.return_value = mock_resp

        res = self.client.answer_callback_query("cb_123", text="Alert!")
        self.assertTrue(res)
        mock_post.assert_called_once()
        _, kwargs = mock_post.call_args
        self.assertEqual(kwargs["data"]["callback_query_id"], "cb_123")
        self.assertEqual(kwargs["data"]["text"], "Alert!")

if __name__ == "__main__":
    unittest.main()
