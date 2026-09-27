# Git hooks

`pre-commit` — CRLF gatekeeper. Auto-normalizes any staged `.cmd`/`.bat` file to CRLF line
endings and re-stages it before the commit lands, so cmd.exe never chokes on an LF-only
launcher again (card `2ee755d4-fe86-4baf-80ec-b29072162533`). `.git/hooks` isn't version
controlled, so after cloning, install it once: `cp scripts/hooks/pre-commit .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit` (Git Bash / WSL; on native PowerShell, `chmod` isn't needed — Git for Windows treats the file as executable by shebang).
