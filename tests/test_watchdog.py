import unittest
from unittest.mock import patch, MagicMock
from watchdog import ServerWatchdog

class TestWatchdog(unittest.TestCase):
    def setUp(self):
        self.watchdog = ServerWatchdog()
        self.watchdog.max_failures = 2

    @patch("requests.get")
    def test_server_healthy(self, mock_get):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"status": "healthy"}
        mock_get.return_value = mock_resp

        result = self.watchdog.run_once()
        self.assertTrue(result)
        self.assertEqual(self.watchdog.failure_count, 0)

    @patch("requests.get")
    def test_server_unhealthy_status_fails(self, mock_get):
        mock_resp = MagicMock()
        mock_resp.status_code = 500
        mock_resp.json.return_value = {"status": "unhealthy", "error": "Internal Error"}
        mock_get.return_value = mock_resp

        self.assertFalse(self.watchdog.check_server())

    @patch("requests.get")
    @patch.object(ServerWatchdog, "send_alert")
    def test_server_failure_alert(self, mock_alert, mock_get):
        mock_get.side_effect = Exception("Connection refused")

        # 1-xatolik: hali alert jo'natilmaydi (chunki max_failures = 2)
        res1 = self.watchdog.run_once()
        self.assertFalse(res1)
        self.assertEqual(self.watchdog.failure_count, 1)
        mock_alert.assert_not_called()

        # 2-xatolik: endi alert chaqirilishi kerak!
        res2 = self.watchdog.run_once()
        self.assertFalse(res2)
        self.assertEqual(self.watchdog.failure_count, 2)
        self.assertTrue(self.watchdog.alert_triggered)
        mock_alert.assert_called_once()

    @patch("requests.get")
    @patch.object(ServerWatchdog, "send_alert")
    def test_server_recovery(self, mock_alert, mock_get):
        self.watchdog.alert_triggered = True
        self.watchdog.failure_count = 2

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"status": "healthy"}
        mock_get.return_value = mock_resp

        res = self.watchdog.run_once()
        self.assertTrue(res)
        self.assertEqual(self.watchdog.failure_count, 0)
        self.assertFalse(self.watchdog.alert_triggered)
        # Recovery xabari jo'natilishi kerak
        mock_alert.assert_called_once()

    def test_send_alert_html_escaping(self):
        with patch.object(self.watchdog.client, "send_message") as mock_send:
            self.watchdog.target_url = "http://127.0.0.1:8080/health?foo=1&bar=2"
            self.watchdog.send_alert(
                title="Error <Crash> & Warning",
                details="Traceback: line <123> & more"
            )
            mock_send.assert_called_once()
            call_text = mock_send.call_args[1]["text"]
            self.assertIn("&lt;Crash&gt;", call_text)
            self.assertIn("&amp; Warning", call_text)
            self.assertIn("foo=1&amp;bar=2", call_text)
            self.assertNotIn("<Crash>", call_text)

if __name__ == "__main__":
    unittest.main()

