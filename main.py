import asyncio
import json
import os
import re
import ssl
import time
import urllib.error
import urllib.request

import decky

# Dexcom Share (the service behind the Follow app). Unofficial; same calls pydexcom makes.
APPLICATION_ID = "d8665ade-9673-4e27-9ff6-92db4ce13d13"
BASE_URLS = {
    "us": "https://share2.dexcom.com/ShareWebServices/Services",
    "ous": "https://shareous1.dexcom.com/ShareWebServices/Services",
    "jp": "https://share.dexcom.jp/ShareWebServices/Services",
}
NULL_ID = "00000000-0000-0000-0000-000000000000"
READING_INTERVAL_S = 300

TREND_BY_NUMBER = {
    1: "DoubleUp",
    2: "SingleUp",
    3: "FortyFiveUp",
    4: "Flat",
    5: "FortyFiveDown",
    6: "SingleDown",
    7: "DoubleDown",
    8: "NotComputable",
    9: "RateOutOfRange",
}

# Errors where retrying would just risk locking the account out.
FATAL_CODES = {
    "AccountPasswordInvalid",
    "AccountNotFound",
    "SSO_AuthenticateMaxAttemptsExceeded",
    "InvalidArgument",
}
SESSION_CODES = {"SessionIdNotFound", "SessionNotValid"}

FRIENDLY = {
    "AccountPasswordInvalid": "Dexcom rejected the username or password. Retries are paused so the account doesn't get locked. Fix the credentials and save.",
    "AccountNotFound": "Dexcom couldn't find that account. Use the login for the account that owns the G7 app (not a follower's). Retries are paused until you save.",
    "SSO_AuthenticateMaxAttemptsExceeded": "Dexcom temporarily locked sign-in after too many failed attempts. Wait a while, then save again.",
    "InvalidArgument": "Dexcom didn't accept the username or password format. Retries are paused until you save.",
}

DEFAULTS = {
    "enabled": True,
    "username": "",
    "password": "",
    "region": "us",
    "unit": "mgdl",
    "low": 70,
    "high": 180,
    "window_hours": 3,
}
WINDOW_CHOICES = (3, 6, 12, 24)


class DexcomError(Exception):
    def __init__(self, code, message=""):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


CA_BUNDLE_PATHS = (
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/ca-certificates/extracted/tls-ca-bundle.pem",
    "/etc/pki/tls/certs/ca-bundle.crt",
    "/etc/ssl/cert.pem",
)
_ctx_cache = None


def _ssl_context():
    """Verified TLS context. Decky's bundled Python often can't find the system
    CA bundle on its own, so point it at the SteamOS one explicitly."""
    global _ctx_cache
    if _ctx_cache is not None:
        return _ctx_cache
    candidates = []
    env_file = os.environ.get("SSL_CERT_FILE")
    if env_file:
        candidates.append(env_file)
    candidates.extend(CA_BUNDLE_PATHS)
    for path in candidates:
        if os.path.isfile(path):
            try:
                _ctx_cache = ssl.create_default_context(cafile=path)
                return _ctx_cache
            except (ssl.SSLError, OSError):
                continue
    try:
        from decky.helpers import get_ssl_context  # newer Decky versions

        _ctx_cache = get_ssl_context()
        return _ctx_cache
    except Exception:  # noqa: BLE001
        pass
    _ctx_cache = ssl.create_default_context()
    return _ctx_cache


def _post(url, body):
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "User-Agent": "Dexcom Share/3.0.2.11 CFNetwork/672.0.2 Darwin/14.0.0",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15, context=_ssl_context()) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        try:
            j = json.loads(raw)
        except ValueError:
            j = {}
        code = (j.get("Code") if isinstance(j, dict) else None) or f"HTTP{e.code}"
        msg = (j.get("Message") if isinstance(j, dict) else None) or raw[:120]
        raise DexcomError(code, msg)
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise DexcomError("Network", str(e))
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        raise DexcomError("BadResponse", raw[:120])


def _date_ms(value):
    m = re.search(r"Date\((-?\d+)", value or "")
    return int(m.group(1)) if m else None


class ShareClient:
    def __init__(self, region, username, password):
        self.base = BASE_URLS.get(region, BASE_URLS["us"])
        self.username = username
        self.password = password
        self.account_id = None
        self.session_id = None

    def _login(self):
        if not self.account_id:
            acct = _post(
                self.base + "/General/AuthenticatePublisherAccount",
                {
                    "accountName": self.username,
                    "password": self.password,
                    "applicationId": APPLICATION_ID,
                },
            )
            if not isinstance(acct, str) or acct == NULL_ID:
                raise DexcomError("AccountNotFound", "no account id returned")
            self.account_id = acct
        sess = _post(
            self.base + "/General/LoginPublisherAccountById",
            {
                "accountId": self.account_id,
                "password": self.password,
                "applicationId": APPLICATION_ID,
            },
        )
        if not isinstance(sess, str) or sess == NULL_ID:
            self.account_id = None
            raise DexcomError("AccountPasswordInvalid", "no session returned")
        self.session_id = sess

    def latest(self):
        """Return the newest reading plus up to 24 h of history, or None."""
        data = None
        for attempt in (0, 1):
            if not self.session_id:
                self._login()
            try:
                data = _post(
                    f"{self.base}/Publisher/ReadPublisherLatestGlucoseValues"
                    f"?sessionId={self.session_id}&minutes=1440&maxCount=288",
                    {},
                )
                break
            except DexcomError as e:
                if e.code in SESSION_CODES and attempt == 0:
                    self.session_id = None
                    continue
                raise
        if not data:
            return None
        points = []
        for item in data:
            try:
                ts = _date_ms(item.get("ST")) or _date_ms(item.get("WT"))
                value = int(item["Value"])
            except (KeyError, TypeError, ValueError):
                continue
            if ts is None:
                continue
            trend = item.get("Trend")
            if isinstance(trend, int):
                trend = TREND_BY_NUMBER.get(trend, "None")
            points.append((ts, value, trend or "None"))
        if not points:
            return None
        points.sort()
        ts, value, trend = points[-1]
        return {
            "value": value,
            "trend": trend,
            "ts": ts,
            "history": [[t, v] for t, v, _ in points],
        }


class Plugin:
    async def _main(self):
        self.settings = self._load_settings()
        self.client = None
        self.auth_blocked = False
        self.latest = self._blank("idle")
        self._lock = asyncio.Lock()
        self._last_fetch = 0.0
        self._task = asyncio.create_task(self._poll_loop())
        decky.logger.info("GlucoDeck started")

    async def _unload(self):
        task = getattr(self, "_task", None)
        if task:
            task.cancel()
        decky.logger.info("GlucoDeck unloaded")

    # ---- settings -------------------------------------------------------

    def _settings_path(self):
        return os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "settings.json")

    def _load_settings(self):
        s = dict(DEFAULTS)
        try:
            with open(self._settings_path(), "r") as f:
                s.update(json.load(f))
        except (OSError, ValueError):
            pass
        return s

    def _persist_settings(self):
        os.makedirs(decky.DECKY_PLUGIN_SETTINGS_DIR, exist_ok=True)
        tmp = self._settings_path() + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.settings, f)
        os.chmod(tmp, 0o600)
        os.replace(tmp, self._settings_path())

    def _public_settings(self):
        s = self.settings
        return {
            "enabled": s["enabled"],
            "username": s["username"],
            "password": "",
            "password_set": bool(s["password"]),
            "region": s["region"],
            "unit": s["unit"],
            "low": s["low"],
            "high": s["high"],
            "window_hours": s["window_hours"],
        }

    # ---- state ----------------------------------------------------------

    def _blank(self, state, message=""):
        return {
            "state": state,
            "value": None,
            "trend": "None",
            "ts": None,
            "checked": int(time.time() * 1000),
            "message": message,
            "history": [],
        }

    async def _refresh(self):
        async with self._lock:
            s = self.settings
            if not s["enabled"]:
                self.latest = self._blank("disabled")
                return
            if not s["username"] or not s["password"]:
                self.latest = self._blank("no_credentials")
                return
            if self.auth_blocked:
                return
            if self.client is None:
                self.client = ShareClient(s["region"], s["username"], s["password"])
            loop = asyncio.get_running_loop()
            self._last_fetch = time.time()
            now_ms = int(time.time() * 1000)
            try:
                reading = await loop.run_in_executor(None, self.client.latest)
            except DexcomError as e:
                if e.code in FATAL_CODES:
                    self.auth_blocked = True
                    self.client = None
                    self.latest = self._blank(
                        "auth_error", FRIENDLY.get(e.code, e.message)
                    )
                else:
                    kept = dict(self.latest)
                    kept.update(
                        state="network_error" if e.code == "Network" else "error",
                        message=e.message[:160],
                        checked=now_ms,
                    )
                    self.latest = kept
                decky.logger.warning(f"GlucoDeck fetch failed: {e.code}")
                return
            except Exception as e:  # noqa: BLE001
                decky.logger.exception("GlucoDeck unexpected error")
                kept = dict(self.latest)
                kept.update(state="error", message=str(e)[:160], checked=now_ms)
                self.latest = kept
                return
            if reading is None:
                self.latest = self._blank(
                    "no_data",
                    "No readings in the last 24 hours. Is the sensor active and the phone connected?",
                )
            else:
                self.latest = {
                    "state": "ok",
                    "value": reading["value"],
                    "trend": reading["trend"],
                    "ts": reading["ts"],
                    "checked": now_ms,
                    "message": "",
                    "history": reading["history"],
                }

    def _next_delay(self):
        ts = self.latest.get("ts")
        if self.latest.get("state") == "ok" and ts:
            age = time.time() - ts / 1000
            if age < READING_INTERVAL_S:
                # Next reading is due about 5 min after the last one.
                return max(20, min(READING_INTERVAL_S - age + 15, READING_INTERVAL_S))
        return 60

    async def _poll_loop(self):
        while True:
            try:
                await self._refresh()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                decky.logger.exception("GlucoDeck poll loop error")
            await asyncio.sleep(self._next_delay())

    # ---- callable from the frontend ------------------------------------

    async def get_settings(self):
        return self._public_settings()

    async def get_reading(self):
        return self.latest

    async def refresh_now(self):
        if time.time() - self._last_fetch >= 10:
            await self._refresh()
        return self.latest

    async def save_settings(self, settings):
        s = self.settings
        s["enabled"] = bool(settings.get("enabled", True))
        s["username"] = str(settings.get("username", "")).strip()
        pw = str(settings.get("password", ""))
        if pw:
            s["password"] = pw
        region = settings.get("region", "us")
        s["region"] = region if region in BASE_URLS else "us"
        unit = settings.get("unit", "mgdl")
        s["unit"] = unit if unit in ("mgdl", "mmol") else "mgdl"
        try:
            s["low"] = max(40, min(120, int(settings.get("low", 70))))
            s["high"] = max(120, min(400, int(settings.get("high", 180))))
        except (TypeError, ValueError):
            pass
        try:
            hours = int(settings.get("window_hours", s["window_hours"]))
            s["window_hours"] = hours if hours in WINDOW_CHOICES else 3
        except (TypeError, ValueError):
            pass
        self.client = None
        self.auth_blocked = False
        self._persist_settings()
        await self._refresh()
        return self.latest

    async def set_window_hours(self, hours):
        try:
            hours = int(hours)
        except (TypeError, ValueError):
            hours = 3
        self.settings["window_hours"] = hours if hours in WINDOW_CHOICES else 3
        self._persist_settings()
        return self.settings["window_hours"]

    async def forget_credentials(self):
        self.settings["username"] = ""
        self.settings["password"] = ""
        self.client = None
        self.auth_blocked = False
        self._persist_settings()
        self.latest = self._blank("no_credentials")
        return self.latest
