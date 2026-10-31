\# Learning Log



A running record of what I built, the key idea behind it, and how I would explain it in an interview.



\---



\## Phase 0, Step 1: Checked my tools



\*\*What we built:\*\* Nothing yet. We checked Node, npm, pnpm, Git, Docker and Docker Compose.



\*\*Key idea:\*\* A tool can be installed but unusable. `docker --version` only checks the command-line tool; `docker info` checks that the Docker engine is actually running. Postgres and Redis need the engine.



\*\*Interview line:\*\* "I run Postgres and Redis in Docker so every developer and CI run gets identical versions without installing databases on their machine."



\---



\## Phase 0, Step 2: Created the repo



\*\*What we built:\*\* The `payment-orchestrator` folder, a Git repo on `main`, a `.gitignore`, a `.gitattributes` and this log.



\*\*Key idea:\*\* `.gitignore` is a security control. `.env` holds secrets (gateway keys, database passwords). Once a secret is committed it lives in Git history forever, so we ignore `.env` from the first commit. We commit a `.env.example` with fake values instead, so others know which variables exist.



\*\*Interview line:\*\* "I normalise line endings to LF with `.gitattributes` because our code runs in Linux containers, and mixed CRLF/LF causes noisy diffs and broken shell scripts."



\*\*Debugging lesson:\*\* A PowerShell here-string (`@'` ... `'@`) needs `@'` at the end of its own line and `'@` at the start of its own line. If pasting removes the line breaks, it fails with "No characters are allowed after a here-string header".

