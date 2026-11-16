import unittest
import urllib.request
import urllib.error
import json
import time
from health_server import HealthServer, ReusableHTTPServer

class TestHealthServer(unittest.TestCase):
    def setUp(self):
        # Use ephemeral port (0) to eliminate port collisions
        self.server = HealthServer(
            host="127.0.0.1", 
            port=0, 
            get_status_callback=lambda: {"test": "ok"}
        )
        self.server.start()
        time.sleep(0.1)

    def tearDown(self):
        self.server.stop()

    def test_health_endpoint(self):
        url = f"http://127.0.0.1:{self.server.port}/health"
        req = urllib.request.urlopen(url, timeout=2)
        self.assertEqual(req.status, 200)
        data = json.loads(req.read().decode("utf-8"))
        self.assertEqual(data["status"], "healthy")
        self.assertEqual(data["data"]["test"], "ok")

    def test_query_parameters_and_trailing_slash(self):
        # /health?test=1
        url_query = f"http://127.0.0.1:{self.server.port}/health?test=1&foo=bar"
        req = urllib.request.urlopen(url_query, timeout=2)
        self.assertEqual(req.status, 200)
        data = json.loads(req.read().decode("utf-8"))
        self.assertEqual(data["status"], "healthy")

        # /health/
        url_slash = f"http://127.0.0.1:{self.server.port}/health/"
        req_slash = urllib.request.urlopen(url_slash, timeout=2)
        self.assertEqual(req_slash.status, 200)
        data_slash = json.loads(req_slash.read().decode("utf-8"))
        self.assertEqual(data_slash["status"], "healthy")

    def test_ping_and_root_endpoints(self):
        for path in ["/ping", "/"]:
            url = f"http://127.0.0.1:{self.server.port}{path}"
            req = urllib.request.urlopen(url, timeout=2)
            self.assertEqual(req.status, 200)

    def test_not_found_endpoint(self):
        url = f"http://127.0.0.1:{self.server.port}/non_existent"
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(url, timeout=2)
        self.assertEqual(ctx.exception.code, 404)
        self.assertEqual(ctx.exception.headers.get("Content-Type"), "application/json")
        body = json.loads(ctx.exception.read().decode("utf-8"))
        self.assertEqual(body.get("error"), "Not Found")

    def test_status_callback_failure_returns_500(self):
        # Create server with failing callback
        failing_server = HealthServer(
            host="127.0.0.1",
            port=0,
            get_status_callback=lambda: (_ for _ in ()).throw(RuntimeError("Service internal failure"))
        )
        failing_server.start()
        time.sleep(0.1)
        try:
            url = f"http://127.0.0.1:{failing_server.port}/health"
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                urllib.request.urlopen(url, timeout=2)
            self.assertEqual(ctx.exception.code, 500)
            data = json.loads(ctx.exception.read().decode("utf-8"))
            self.assertEqual(data["status"], "unhealthy")
            self.assertIn("Service internal failure", data["data"]["error"])
        finally:
            failing_server.stop()

    def test_logs_web_terminal_endpoint(self):
        url = f"http://127.0.0.1:{self.server.port}/logs"
        req = urllib.request.urlopen(url, timeout=2)
        self.assertEqual(req.status, 200)
        self.assertIn("text/html", req.headers.get("Content-Type", ""))
        content = req.read().decode("utf-8")
        self.assertIn("Minecraft Bot", content)
        self.assertIn("Oxirgi 2 soat", content)

    def test_api_logs_endpoint(self):
        url = f"http://127.0.0.1:{self.server.port}/api/logs"
        req = urllib.request.urlopen(url, timeout=2)
        self.assertEqual(req.status, 200)
        self.assertIn("application/json", req.headers.get("Content-Type", ""))
        data = json.loads(req.read().decode("utf-8"))
        self.assertEqual(data["status"], "healthy")
        self.assertEqual(data["window_hours"], 2.0)
        self.assertIsInstance(data["logs"], list)

    def test_socket_reuse_flag(self):
        self.assertTrue(ReusableHTTPServer.allow_reuse_address)

if __name__ == "__main__":
    unittest.main()

