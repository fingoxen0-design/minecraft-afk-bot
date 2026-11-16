import unittest
import time
import os
import threading
from pathlib import Path
from vote_tracker import VoteTracker

class TestVoteTracker(unittest.TestCase):
    def setUp(self):
        self.test_file = "test_vote_state.json"
        if os.path.exists(self.test_file):
            os.remove(self.test_file)
        self.tracker = VoteTracker(state_file=self.test_file, default_cooldown_hours=15.0)

    def tearDown(self):
        if os.path.exists(self.test_file):
            os.remove(self.test_file)
        tmp = f"{self.test_file}.tmp"
        if os.path.exists(tmp):
            os.remove(tmp)

    def test_parse_time_from_url(self):
        url = "https://minecraft-mp.com/server/350645/vote/?error=2&time=1794836617"
        ts = self.tracker.parse_time_from_url_or_text(url)
        self.assertEqual(ts, 1794836617)

    def test_parse_plain_timestamp(self):
        text = "1794836617"
        ts = self.tracker.parse_time_from_url_or_text(text)
        self.assertEqual(ts, 1794836617)

    def test_parse_invalid_text(self):
        self.assertIsNone(self.tracker.parse_time_from_url_or_text("invalid"))
        self.assertIsNone(self.tracker.parse_time_from_url_or_text("12345"))  # Not 10 digits

    def test_record_vote_and_cooldown(self):
        self.tracker.record_vote(cooldown_hours=15.0)
        self.assertFalse(self.tracker.is_time_to_vote())
        rem = self.tracker.get_remaining_seconds()
        self.assertTrue(14 * 3600 < rem <= 15 * 3600)
        self.assertIn("soat", self.tracker.format_remaining_time())
        self.assertEqual(self.tracker.state["total_votes_recorded"], 1)

    def test_record_vote_with_custom_timestamp(self):
        future_ts = int(time.time()) + 3600
        self.tracker.record_vote(custom_next_time=future_ts)
        self.assertFalse(self.tracker.is_time_to_vote())
        self.assertAlmostEqual(self.tracker.get_remaining_seconds(), 3600, delta=5)
        self.assertEqual(self.tracker.state["total_votes_recorded"], 1)

    def test_set_next_vote_time_does_not_increment_votes_or_alter_last_vote(self):
        # Setting future vote time from error url must not increment votes
        future_ts = int(time.time()) + 7200
        initial_votes = self.tracker.state["total_votes_recorded"]
        initial_last_ts = self.tracker.state["last_vote_timestamp"]
        
        self.tracker.set_next_vote_time(future_ts)
        self.assertEqual(self.tracker.state["next_vote_timestamp"], future_ts)
        self.assertEqual(self.tracker.state["total_votes_recorded"], initial_votes)
        self.assertEqual(self.tracker.state["last_vote_timestamp"], initial_last_ts)
        self.assertAlmostEqual(self.tracker.get_remaining_seconds(), 7200, delta=5)

    def test_cooldown_validation(self):
        with self.assertRaises(ValueError):
            VoteTracker(state_file="temp_invalid.json", default_cooldown_hours=0)
        with self.assertRaises(ValueError):
            VoteTracker(state_file="temp_invalid.json", default_cooldown_hours=-5)
        with self.assertRaises(ValueError):
            self.tracker.set_cooldown_hours(0)
        with self.assertRaises(ValueError):
            self.tracker.set_cooldown_hours(-1.5)
        with self.assertRaises(ValueError):
            self.tracker.record_vote(cooldown_hours=-10)

    def test_persistence(self):
        self.tracker.record_vote(cooldown_hours=8.0)
        tracker2 = VoteTracker(state_file=self.test_file, default_cooldown_hours=15.0)
        self.assertEqual(tracker2.state["cooldown_hours"], 8.0)
        self.assertEqual(tracker2.state["total_votes_recorded"], 1)

    def test_thread_safety_concurrent_access(self):
        errors = []
        def worker(idx):
            try:
                for i in range(10):
                    if idx % 2 == 0:
                        self.tracker.record_vote(cooldown_hours=1.0)
                    else:
                        self.tracker.set_next_vote_time(int(time.time()) + 500)
                    _ = self.tracker.get_summary()
                    _ = self.tracker.get_remaining_seconds()
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(len(errors), 0)
        self.assertTrue(self.tracker.state["total_votes_recorded"] > 0)

    def test_format_remaining_time_cases(self):
        # 0 remaining
        self.tracker.state["next_vote_timestamp"] = int(time.time()) - 10
        self.assertEqual(self.tracker.format_remaining_time(), "Hozir ovoz berish mumkin! 🟢")

        # seconds only (< 5 min)
        self.tracker.state["next_vote_timestamp"] = int(time.time()) + 45
        self.assertIn("soniya", self.tracker.format_remaining_time())

        # hours and minutes
        self.tracker.state["next_vote_timestamp"] = int(time.time()) + 3720
        formatted = self.tracker.format_remaining_time()
        self.assertIn("soat", formatted)
        self.assertIn("daqiqa", formatted)

    def test_get_and_set_vote_url(self):
        default = "https://default.com"
        self.assertEqual(self.tracker.get_vote_url(default), default)
        
        new_url = "https://new-vote-site.com/vote"
        self.tracker.set_vote_url(new_url)
        self.assertEqual(self.tracker.get_vote_url(), new_url)

        # Check persistence
        tracker2 = VoteTracker(state_file=self.test_file)
        self.assertEqual(tracker2.get_vote_url(), new_url)

if __name__ == "__main__":
    unittest.main()

