import unittest
from unittest.mock import patch, MagicMock
import os
import time
from bot import MinecraftVoteBot
import config

class TestBot(unittest.TestCase):
    def setUp(self):
        self.test_state_file = "test_bot_state.json"
        if os.path.exists(self.test_state_file):
            os.remove(self.test_state_file)

        # Patch config values for clean test isolation
        self.config_token_patch = patch.object(config, "TELEGRAM_BOT_TOKEN", "mock_bot_token")
        self.config_chat_patch = patch.object(config, "TELEGRAM_CHAT_ID", "123456789")
        self.config_url_patch = patch.object(config, "DEFAULT_VOTE_URL", "https://minecraft-mp.com/server/350645/vote/?ref=bot&tracker=1")
        self.config_port_patch = patch.object(config, "HEALTH_PORT", 0)
        self.config_admins_patch = patch.object(config, "ADMIN_USER_IDS", {"123456789"})

        self.config_token_patch.start()
        self.config_chat_patch.start()
        self.config_url_patch.start()
        self.config_port_patch.start()
        self.config_admins_patch.start()

        self.bot = MinecraftVoteBot()
        self.bot.tracker.state_file = self.bot.tracker.state_file.with_name(self.test_state_file)
        self.bot.client.send_message = MagicMock(return_value=True)
        self.bot.client.answer_callback_query = MagicMock(return_value=True)

    def tearDown(self):
        if hasattr(self, "bot") and self.bot.health_server:
            self.bot.health_server.stop()
        self.config_token_patch.stop()
        self.config_chat_patch.stop()
        self.config_url_patch.stop()
        self.config_port_patch.stop()
        self.config_admins_patch.stop()
        if os.path.exists(self.test_state_file):
            os.remove(self.test_state_file)

    def test_init(self):
        self.assertEqual(self.bot.vote_url, "https://minecraft-mp.com/server/350645/vote/?ref=bot&tracker=1")
        self.assertFalse(self.bot.is_running)

    def test_is_authorized(self):
        self.assertTrue(self.bot.is_authorized("123456789"))
        self.assertFalse(self.bot.is_authorized("987654321"))
        with patch.object(config, "TELEGRAM_CHAT_ID", ""):
            self.assertTrue(self.bot.is_authorized("any_chat_id"))

    def test_start_and_help_html_escaping(self):
        self.bot.handle_message("123456789", "/start")
        self.bot.client.send_message.assert_called_once()
        msg = self.bot.client.send_message.call_args[0][0]
        self.assertIn("?error=2&amp;time=...", msg)
        self.assertNotIn("?error=2&time=...", msg)

    def test_status_command(self):
        self.bot.handle_message("123456789", "/status")
        self.bot.client.send_message.assert_called_once()
        msg = self.bot.client.send_message.call_args[0][0]
        self.assertIn("Hozirgi holat", msg)

    def test_vote_command_html_escaping(self):
        self.bot.handle_message("123456789", "/vote")
        self.bot.client.send_message.assert_called_once()
        msg = self.bot.client.send_message.call_args[0][0]
        self.assertIn("ref=bot&amp;tracker=1", msg)

    def test_voted_command_authorized(self):
        initial_votes = self.bot.tracker.state["total_votes_recorded"]
        self.bot.handle_message("123456789", "/voted")
        self.assertEqual(self.bot.tracker.state["total_votes_recorded"], initial_votes + 1)
        self.bot.client.send_message.assert_called_once()
        msg = self.bot.client.send_message.call_args[0][0]
        self.assertIn("Ovoz qabul qilindi", msg)

    def test_voted_command_unauthorized(self):
        initial_votes = self.bot.tracker.state["total_votes_recorded"]
        self.bot.handle_message("999999", "/voted")
        self.assertEqual(self.bot.tracker.state["total_votes_recorded"], initial_votes)
        self.bot.client.send_message.assert_called_once()
        msg = self.bot.client.send_message.call_args[0][0]
        self.assertIn("Ruxsat berilmagan", msg)

    def test_setcooldown_authorized(self):
        self.bot.handle_message("123456789", "/setcooldown 12")
        self.assertEqual(self.bot.tracker.state["cooldown_hours"], 12.0)
        msg = self.bot.client.send_message.call_args[0][0]
        self.assertIn("12.0 soat", msg)

    def test_setcooldown_invalid_or_negative(self):
        # Negative hours
        self.bot.handle_message("123456789", "/setcooldown -5")
        msg = self.bot.client.send_message.call_args[0][0]
        self.assertIn("0 dan katta bo'lishi kerak", msg)

        # Non-numeric
        self.bot.handle_message("123456789", "/setcooldown abc")
        msg = self.bot.client.send_message.call_args[0][0]
        self.assertIn("Raqam kiriting", msg)

    def test_setcooldown_unauthorized(self):
        prev_cd = self.bot.tracker.state["cooldown_hours"]
        self.bot.handle_message("999999", "/setcooldown 10")
        self.assertEqual(self.bot.tracker.state["cooldown_hours"], prev_cd)
        msg = self.bot.client.send_message.call_args[0][0]
        self.assertIn("Ruxsat berilmagan", msg)

    def test_url_with_future_timestamp_authorized(self):
        future_ts = int(time.time()) + 5000
        initial_votes = self.bot.tracker.state["total_votes_recorded"]
        url = f"https://minecraft-mp.com/server/350645/vote/?error=2&time={future_ts}"
        self.bot.handle_message("123456789", url)

        # Must NOT increment total votes
        self.assertEqual(self.bot.tracker.state["total_votes_recorded"], initial_votes)
        self.assertEqual(self.bot.tracker.state["next_vote_timestamp"], future_ts)
        self.bot.client.send_message.assert_called_once()
        msg = self.bot.client.send_message.call_args[0][0]
        self.assertIn("Vaqt belgilandi", msg)

    def test_url_with_future_timestamp_unauthorized(self):
        future_ts = int(time.time()) + 5000
        url = f"https://minecraft-mp.com/server/350645/vote/?error=2&time={future_ts}"
        self.bot.handle_message("999999", url)

        self.assertNotEqual(self.bot.tracker.state["next_vote_timestamp"], future_ts)
        msg = self.bot.client.send_message.call_args[0][0]
        self.assertIn("Ruxsat berilmagan", msg)

    def test_url_with_past_timestamp_graceful_handling(self):
        # Expired timestamp (in past)
        past_ts = int(time.time()) - 300
        url = f"https://minecraft-mp.com/server/350645/vote/?error=2&time={past_ts}"
        self.bot.handle_message("123456789", url)

        # Must send message rather than silent drop
        self.bot.client.send_message.assert_called_once()
        msg = self.bot.client.send_message.call_args[0][0]
        self.assertIn("Kutilgan vaqt allaqachon o'tib bo'lgan", msg)
        self.assertIn("ref=bot&amp;tracker=1", msg)

    def test_callback_query_voted_now_authorized(self):
        initial_votes = self.bot.tracker.state["total_votes_recorded"]
        query = {
            "id": "query_1",
            "data": "voted_now",
            "message": {"chat": {"id": 123456789}}
        }
        self.bot.handle_callback_query(query)
        self.assertEqual(self.bot.tracker.state["total_votes_recorded"], initial_votes + 1)
        self.bot.client.answer_callback_query.assert_called_once()
        self.bot.client.send_message.assert_called_once()

    def test_callback_query_voted_now_unauthorized(self):
        initial_votes = self.bot.tracker.state["total_votes_recorded"]
        query = {
            "id": "query_2",
            "data": "voted_now",
            "message": {"chat": {"id": 999999}}
        }
        self.bot.handle_callback_query(query)
        self.assertEqual(self.bot.tracker.state["total_votes_recorded"], initial_votes)
        self.bot.client.answer_callback_query.assert_called_with("query_2", text="Ruxsat berilmagan!")

    def test_callback_query_check_status(self):
        query = {
            "id": "query_3",
            "data": "check_status",
            "message": {"chat": {"id": 123456789}}
        }
        self.bot.handle_callback_query(query)
        self.bot.client.answer_callback_query.assert_called_once()
        self.bot.client.send_message.assert_called_once()
        msg = self.bot.client.send_message.call_args[0][0]
        self.assertIn("Qolgan vaqt", msg)

    def test_send_vote_alert(self):
        self.bot.send_vote_alert()
        self.bot.client.send_message.assert_called_once()
        msg = self.bot.client.send_message.call_args[1]["text"]
        self.assertIn("🔔 <b>DIQQAT! Ovoz berish vaqti yetib keldi!</b>", msg)
        self.assertIn("ref=bot&amp;tracker=1", msg)
        self.assertTrue(self.bot.tracker.state["alert_sent"])

    def test_scheduler_loop_suppression_when_token_empty(self):
        with patch.object(config, "TELEGRAM_BOT_TOKEN", ""):
            # Alert is due
            self.bot.tracker.state["next_vote_timestamp"] = int(time.time()) - 100
            self.bot.tracker.state["alert_sent"] = False
            self.assertTrue(self.bot.tracker.should_send_alert())

            # Run scheduler_loop for 1 iteration safely
            self.bot.is_running = True
            with patch("time.sleep", side_effect=lambda s: setattr(self.bot, "is_running", False)):
                self.bot.scheduler_loop()

            # send_message must NOT have been called
            self.bot.client.send_message.assert_not_called()

    def test_settings_and_seturl_commands(self):
        # /settings command
        self.bot.handle_message("123456789", "/settings")
        self.bot.client.send_message.assert_called_once()
        msg = self.bot.client.send_message.call_args[0][0]
        self.assertIn("Bot Ma'lumotlari va Sozlamalari", msg)

        # /seturl command valid
        new_url = "https://custom-site.com/vote"
        self.bot.handle_message("123456789", f"/seturl {new_url}")
        self.assertEqual(self.bot.vote_url, new_url)
        self.assertEqual(self.bot.tracker.get_vote_url(), new_url)

        # /seturl unauthorized
        self.bot.handle_message("unauthorized_user", f"/seturl {new_url}")
        last_msg = self.bot.client.send_message.call_args[0][0]
        self.assertIn("Ruxsat berilmagan", last_msg)

    def test_say_and_cmd_commands(self):
        # When bot not running
        self.bot.handle_message("123456789", "/say Salom")
        last_msg = self.bot.client.send_message.call_args[0][0]
        self.assertIn("faol emas", last_msg)

        # Empty say
        self.bot.handle_message("123456789", "/say")
        last_msg = self.bot.client.send_message.call_args[0][0]
        self.assertIn("Masalan", last_msg)

        # Cmd empty
        self.bot.handle_message("123456789", "/cmd")
        last_msg = self.bot.client.send_message.call_args[0][0]
        self.assertIn("Masalan", last_msg)

    def test_ping_command(self):
        self.bot.handle_message("123456789", "/ping")
        last_msg = self.bot.client.send_message.call_args[0][0]
        self.assertIn("Pong", last_msg)

    def test_admin_stats_ban_unban(self):
        # /stats
        self.bot.handle_message("123456789", "/stats")
        last_msg = self.bot.client.send_message.call_args[0][0]
        self.assertIn("Statistikasi", last_msg)

        # /ban
        self.bot.handle_message("123456789", "/ban 998811")
        last_msg = self.bot.client.send_message.call_args[0][0]
        self.assertIn("bloklandi", last_msg)

        # /unban
        self.bot.handle_message("123456789", "/unban 998811")
        last_msg = self.bot.client.send_message.call_args[0][0]
        self.assertIn("chiqarildi", last_msg)

    def test_chat_help_callback(self):
        query = {
            "id": "q1",
            "data": "chat_help",
            "message": {"chat": {"id": "123456789"}}
        }
        self.bot.handle_callback_query(query)
        self.bot.client.answer_callback_query.assert_called_with("q1", text="O'yinga xabar yozish")
        last_msg = self.bot.client.send_message.call_args[0][0]
        self.assertIn("/say", last_msg)

    def test_setserver_command(self):
        # Full arguments
        self.bot.handle_message("123456789", "/setserver allaysmp.pro 25565 lobby")
        last_msg = self.bot.client.send_message.call_args[0][0]
        self.assertIn("allaysmp.pro", last_msg)
        self.assertIn("25565", last_msg)
        self.assertIn("lobby", last_msg)
        conf = self.bot.user_manager.get_mc_config("123456789")
        self.assertEqual(conf["host"], "allaysmp.pro")
        self.assertEqual(conf["port"], 25565)
        self.assertEqual(conf["subserver"], "lobby")

        # Empty arguments
        self.bot.handle_message("123456789", "/setserver")
        last_msg = self.bot.client.send_message.call_args[0][0]
        self.assertIn("Masalan", last_msg)

    def test_unknown_command(self):
        self.bot.handle_message("123456789", "/unknown_cmd_xyz")
        last_msg = self.bot.client.send_message.call_args[0][0]
        self.assertIn("Noma'lum buyruq", last_msg)

    def test_stop(self):
        self.bot.is_running = True
        self.bot.stop()
        self.assertFalse(self.bot.is_running)

if __name__ == "__main__":
    unittest.main()
