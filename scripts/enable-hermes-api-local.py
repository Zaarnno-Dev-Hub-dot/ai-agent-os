"""Enable Hermes API server using Hermes's own env writer (not chat)."""
from __future__ import annotations

import secrets
import sys
from pathlib import Path

# Run from Hermes install venv: hermes-agent on PYTHONPATH via cwd
from hermes_cli.config import get_env_path, save_env_value
from hermes_constants import get_hermes_home

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    home = get_hermes_home()
    env_path = get_env_path()
    print(f"HERMES_HOME={home}")
    print(f"ENV_PATH={env_path}")
    if env_path.resolve() != (home / ".env").resolve():
        print("WARN: env path does not match HERMES_HOME/.env", file=sys.stderr)

    api_key = secrets.token_urlsafe(32)
    save_env_value("API_SERVER_ENABLED", "true")
    save_env_value("API_SERVER_PORT", "8642")
    save_env_value("API_SERVER_HOST", "127.0.0.1")
    save_env_value("API_SERVER_KEY", api_key)

    print("API server env written; restart Hermes gateway (see scripts/Restart-Hermes-LLM-Gateway-8642.cmd).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())