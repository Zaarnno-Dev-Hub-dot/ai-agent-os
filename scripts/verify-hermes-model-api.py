"""Verify Hermes local model API after key rotation (no secrets printed)."""
from __future__ import annotations

import re
import sys
import urllib.error
import urllib.request

from hermes_cli.config import get_env_path


def main() -> int:
    env_path = get_env_path()
    text = env_path.read_text(encoding="utf-8-sig")
    m = re.search(r"^API_SERVER_KEY=(.+)$", text, re.M)
    if not m:
        print("VERIFY_FAIL: API_SERVER_KEY missing in", env_path)
        return 1
    key = m.group(1).strip().strip('"').strip("'")

    req = urllib.request.Request(
        "http://127.0.0.1:8642/v1/models",
        headers={"Authorization": f"Bearer {key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            print(f"auth /v1/models HTTP {r.status}")
    except Exception as e:
        print("VERIFY_FAIL: authenticated /v1/models:", type(e).__name__, e)
        return 1

    try:
        urllib.request.urlopen("http://127.0.0.1:8642/v1/models", timeout=10)
        print("VERIFY_FAIL: unauthenticated request should not succeed")
        return 1
    except urllib.error.HTTPError as e:
        print(f"unauth /v1/models HTTP {e.code} (want 401)")

    print("VERIFY_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())