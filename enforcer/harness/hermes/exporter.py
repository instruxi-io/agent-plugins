"""Batched, asynchronous, bounded, fail-open OTLP/HTTP export.

Hook callbacks only append to a bounded queue (no I/O, no locks held across
I/O). One daemon thread drains it every `interval` seconds, or sooner when a
batch fills or a session ends, encodes the batch and POSTs it to governance.
Every failure is counted and dropped: a full queue drops the newest record,
an unreachable or refusing governance drops the batch after a bounded retry,
and a missing key pauses export. Nothing here ever raises into Hermes.
"""

from __future__ import annotations

import gzip
import logging
import queue
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Optional

from . import otlp, settings

logger = logging.getLogger(__name__)

SCOPE = ("enforcer.hermes", "1")
# A key failure (missing CLI, signed out) is retried this often, not per batch.
KEY_RETRY_S = 300.0
HTTP_TIMEOUT_S = 10.0
RETRIES = 2  # per batch, for 429/5xx/network errors; then the batch is dropped


@dataclass
class Stats:
    queued: int = 0
    exported_logs: int = 0
    exported_points: int = 0
    dropped_queue_full: int = 0
    dropped_no_key: int = 0
    dropped_export: int = 0
    last_status: Optional[int] = None
    last_error: str = ""
    last_export_at: float = 0.0
    key_error: str = ""
    key_source: str = ""
    credential_id: str = ""
    key_expires_at: float = 0.0
    endpoints: dict[str, str] = field(default_factory=dict)


Poster = Callable[[str, bytes, Mapping[str, str]], int]


def _post(url: str, body: bytes, headers: Mapping[str, str]) -> int:
    req = urllib.request.Request(url, data=body, headers=dict(headers), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as resp:
            resp.read()
            return resp.status
    except urllib.error.HTTPError as e:
        return e.code


class Exporter:
    def __init__(
        self,
        resource: Mapping[str, Any],
        origin: str,
        key_source: Callable[[], settings.IngestKey],
        *,
        max_queue: int = 2048,
        batch_size: int = 256,
        interval: float = 5.0,
        poster: Poster = _post,
        clock: Callable[[], float] = time.time,
    ):
        self.resource = dict(resource)
        self.origin = origin
        self._key_source = key_source
        self._poster = poster
        self._clock = clock
        self.batch_size = max(1, batch_size)
        self.interval = interval
        self._q: "queue.Queue[tuple[str, dict]]" = queue.Queue(maxsize=max(1, max_queue))
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._key: Optional[settings.IngestKey] = None
        self._key_retry_at = 0.0
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()  # guards start and the export pass
        self.stats = Stats()

    # --- called from hook callbacks: never blocks, never raises -------------
    def emit_log(self, record: dict) -> None:
        self._put("log", record)

    def emit_point(self, point: dict) -> None:
        self._put("metric", point)

    def flush_soon(self) -> None:
        self._wake.set()

    def _put(self, kind: str, item: dict) -> None:
        try:
            self._q.put_nowait((kind, item))
            self.stats.queued += 1
            if self._q.qsize() >= self.batch_size:
                self._wake.set()
            self._ensure_thread()
        except queue.Full:
            self.stats.dropped_queue_full += 1
        except Exception:  # pragma: no cover - fail open
            pass

    # --- the worker ---------------------------------------------------------
    def _ensure_thread(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        with self._lock:
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._loop, name="enforcer-otlp", daemon=True)
                self._thread.start()

    def _loop(self) -> None:
        while not self._stop.is_set():
            self._wake.wait(self.interval)
            self._wake.clear()
            try:
                self.export_once()
            except Exception as e:  # pragma: no cover - fail open
                self.stats.last_error = f"export pass failed: {type(e).__name__}"

    def shutdown(self, timeout: float = 2.0) -> None:
        """Best-effort final flush, bounded by `timeout` seconds."""
        self._stop.set()
        self._wake.set()
        t = self._thread
        if t is not None and t.is_alive():
            t.join(timeout)
        deadline = self._clock() + timeout
        while not self._q.empty() and self._clock() < deadline:
            if not self.export_once():
                break

    def _drain(self) -> tuple[list[dict], list[dict]]:
        logs: list[dict] = []
        points: list[dict] = []
        while len(logs) + len(points) < self.batch_size:
            try:
                kind, item = self._q.get_nowait()
            except queue.Empty:
                break
            (logs if kind == "log" else points).append(item)
        return logs, points

    def _current_key(self, force: bool = False) -> Optional[settings.IngestKey]:
        now = self._clock()
        if not force and self._key is not None and self._key.fresh(now):
            return self._key
        if not force and self._key is None and now < self._key_retry_at:
            return None
        try:
            k = self._key_source()
        except settings.KeyError_ as e:
            self._fail_key(str(e), now)
            return self._key if self._key is not None and not force else None
        except Exception as e:
            self._fail_key(f"could not get an ingest key: {type(e).__name__}", now)
            return None
        if self._key is None or k.key != self._key.key:
            logger.info("enforcer: telemetry key %s (%s)", "loaded" if self._key is None else "changed", k.source)
        self._key = k
        self.stats.key_error = ""
        self.stats.key_source = k.source
        self.stats.credential_id = k.credential_id
        self.stats.key_expires_at = k.expires_at
        return k

    def _fail_key(self, msg: str, now: float) -> None:
        if msg != self.stats.key_error:
            logger.warning("enforcer: Hermes telemetry paused: %s", msg)
        self.stats.key_error = msg
        self._key_retry_at = now + KEY_RETRY_S

    def export_once(self) -> bool:
        """Send one batch. Returns True when anything was taken off the queue."""
        with self._lock:
            logs, points = self._drain()
            if not logs and not points:
                return False
            key = self._current_key()
            if key is None:
                self.stats.dropped_no_key += len(logs) + len(points)
                return True
            if logs:
                body = otlp.encode_logs(self.resource, SCOPE, logs)
                if self._send("logs", body, key):
                    self.stats.exported_logs += len(logs)
                else:
                    self.stats.dropped_export += len(logs)
            if points:
                body = otlp.encode_metrics(self.resource, SCOPE, points)
                if self._send("metrics", body, self._key or key):
                    self.stats.exported_points += len(points)
                else:
                    self.stats.dropped_export += len(points)
            self.stats.last_export_at = self._clock()
            return True

    def _send(self, signal: str, body: bytes, key: settings.IngestKey) -> bool:
        payload = gzip.compress(body)
        refreshed = False
        for attempt in range(RETRIES + 1):
            url = settings.otlp_endpoint(self.origin, signal, key.otlp_base)
            self.stats.endpoints[signal] = url
            headers = {
                "Content-Type": "application/x-protobuf",
                "Content-Encoding": "gzip",
                settings.KEY_HEADER: key.key,
            }
            try:
                status = self._poster(url, payload, headers)
            except Exception as e:
                status = None
                self.stats.last_error = f"{signal}: {type(e).__name__}"
            self.stats.last_status = status
            if status is not None and 200 <= status < 300:
                self.stats.last_error = ""
                return True
            if status in (401, 403) and not refreshed:
                # Revoked, rotated, or expired: ask the CLI once, then retry with whatever it gives.
                refreshed = True
                fresh = self._current_key(force=True)
                if fresh is None:
                    self.stats.last_error = f"{signal}: governance refused the key ({status}) and no new key is available"
                    return False
                key = fresh
                continue
            if status is not None:
                self.stats.last_error = f"{signal}: HTTP {status}"
                if status != 429 and status < 500:
                    return False  # a 4xx other than 429 will not succeed on retry
            if attempt < RETRIES and not self._stop.is_set():
                time.sleep(min(0.5 * (2**attempt), 2.0))
        return False
