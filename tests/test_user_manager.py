import os
import time
import unittest
from pathlib import Path
from user_manager import UserManager
import config

class TestUserManager(unittest.TestCase):
    def setUp(self):
        self.test_db = Path(__file__).parent / "test_users.json"
        if self.test_db.exists():
            self.test_db.unlink()
        self.manager = UserManager(db_path=str(self.test_db))

    def tearDown(self):
        if self.test_db.exists():
            self.test_db.unlink()

    def test_admin_recognition(self):
        admin_id = list(config.ADMIN_USER_IDS)[0] if config.ADMIN_USER_IDS else "8580598902"
        self.assertTrue(self.manager.is_admin(admin_id))
        user = self.manager.get_or_create_user(admin_id)
        self.assertEqual(user["role"], "admin")
        self.assertIsNone(user["expires_at"])

        can_use, msg = self.manager.can_use_bot(admin_id)
        self.assertTrue(can_use)
        self.assertIn("Admin", msg)

    def test_regular_user_trial(self):
        user_id = "9988776655"
        self.assertFalse(self.manager.is_admin(user_id))
        user = self.manager.get_or_create_user(user_id, username="tester", first_name="Ali")
        self.assertEqual(user["role"], "trial")
        self.assertIsNotNone(user["expires_at"])
        self.assertGreater(user["expires_at"], time.time())

        can_use, msg = self.manager.can_use_bot(user_id)
        self.assertTrue(can_use)
        self.assertIn("Trial", msg)

    def test_trial_expiration(self):
        user_id = "5544332211"
        user = self.manager.get_or_create_user(user_id)
        # Manually expire the trial
        user["expires_at"] = time.time() - 100
        self.manager.save()

        can_use, msg = self.manager.can_use_bot(user_id)
        self.assertFalse(can_use)
        self.assertIn("tugagan", msg)

    def test_grant_premium(self):
        user_id = "7766554433"
        self.manager.get_or_create_user(user_id)
        success, msg = self.manager.grant_premium(user_id, 30)
        self.assertTrue(success)
        self.assertIn("30", msg)

        user = self.manager.get_or_create_user(user_id)
        self.assertEqual(user["role"], "premium")
        can_use, status_msg = self.manager.can_use_bot(user_id)
        self.assertTrue(can_use)
        self.assertIn("Premium", status_msg)

    def test_mc_config_update(self):
        user_id = "11223344"
        self.manager.update_mc_config(
            user_id,
            username="SuperCrafter",
            password="my_secret_pass",
            host="play.example.com",
            port=25577,
            subserver="economy"
        )
        conf = self.manager.get_mc_config(user_id)
        self.assertEqual(conf["username"], "SuperCrafter")
        self.assertEqual(conf["password"], "my_secret_pass")
        self.assertEqual(conf["host"], "play.example.com")
        self.assertEqual(conf["port"], 25577)
        self.assertEqual(conf["subserver"], "economy")

    def test_ban_and_unban_user(self):
        user_id = "88990011"
        self.manager.get_or_create_user(user_id)
        
        # Ban
        ok, res = self.manager.ban_user(user_id)
        self.assertTrue(ok)
        can_use, msg = self.manager.can_use_bot(user_id)
        self.assertFalse(can_use)
        self.assertIn("bloklangansiz", msg)

        # Unban
        ok2, res2 = self.manager.unban_user(user_id)
        self.assertTrue(ok2)
        can_use2, _ = self.manager.can_use_bot(user_id)
        self.assertTrue(can_use2)

    def test_get_stats(self):
        self.manager.get_or_create_user("u1")
        self.manager.grant_premium("u2", 10)
        self.manager.ban_user("u3")
        stats = self.manager.get_stats()
        self.assertGreaterEqual(stats["total"], 3)
        self.assertGreaterEqual(stats["premium"], 1)
        self.assertGreaterEqual(stats["banned"], 1)

if __name__ == "__main__":
    unittest.main()
