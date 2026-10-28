"""A fake governance OTLP endpoint on 127.0.0.1: records every POST (gunzipped)
and answers with whatever status the test scripts per request."""

from __future__ import annotations

import gzip
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Sink:
    def __init__(self):
        self.requests: list[dict] = []
        self.statuses: list[int] = []  # popped per request; 200 when empty
        self.delay = 0.0
        sink = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                if self.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                if sink.delay:
                    time.sleep(sink.delay)
                sink.requests.append({"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}, "body": raw})
                status = sink.statuses.pop(0) if sink.statuses else 200
                self.send_response(status)
                self.send_header("Content-Length", "0")
                self.end_headers()

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.origin = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
