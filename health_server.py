import json
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
import threading
from typing import Callable
from urllib.parse import urlparse

class HealthHandler(BaseHTTPRequestHandler):
    get_status_callback: Callable[[], dict] = None

    def log_message(self, format, *args):
        # Konsolga ortiqcha access loglarni tiqmaslik uchun
        return

    def do_GET(self):
        parsed_url = urlparse(self.path)
        clean_path = parsed_url.path.rstrip('/') or '/'

        if clean_path in ["/health", "/ping", "/"]:
            callback = getattr(self.server, "get_status_callback", None) or HealthHandler.get_status_callback
            status_data = {}
            is_healthy = True
            error_message = None

            if callback:
                try:
                    status_data = callback()
                except Exception as e:
                    is_healthy = False
                    error_message = str(e)
                    status_data = {"error": error_message}

            start_time = getattr(self.server, "start_time", time.time())
            response = {
                "status": "healthy" if is_healthy else "unhealthy",
                "uptime": int(time.time() - start_time),
                "data": status_data
            }
            if error_message:
                response["error"] = error_message

            body = json.dumps(response, indent=2).encode("utf-8")
            status_code = 200 if is_healthy else 500
            self.send_response(status_code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            body = json.dumps({"error": "Not Found"}).encode("utf-8")
            self.send_response(404)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

class ReusableHTTPServer(HTTPServer):
    allow_reuse_address = True

class HealthServer:
    def __init__(self, host: str = "0.0.0.0", port: int = 8080, get_status_callback: Callable[[], dict] = None):
        self.host = host
        self.port = port
        self.get_status_callback = get_status_callback
        self.server = None
        self.thread = None

    def start(self):
        HealthHandler.get_status_callback = self.get_status_callback
        self.server = ReusableHTTPServer((self.host, self.port), HealthHandler)
        self.server.get_status_callback = self.get_status_callback
        self.server.start_time = time.time()
        self.port = self.server.server_port
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        print(f"[HealthServer] Server ishga tushdi: http://{self.host}:{self.port}/health")

    def stop(self):
        if self.server:
            self.server.shutdown()
            self.server.server_close()
            print("[HealthServer] Server to'xtatildi.")

