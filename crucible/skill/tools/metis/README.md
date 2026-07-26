# Metis integration (optional)

[Metis](https://github.com/arm/metis) is an open-source agentic security code-review framework from Arm's Product Security Team. Wired in here, it runs as **Phase 2.5** of a Crucible review: a second security opinion produced by different machinery — whole-repository retrieval plus deterministic reachability analysis — rather than another sample from the same reviewer prompts.

**It is off by default and Crucible is complete without it.** A default checkout runs no Docker, downloads nothing, and never calls this directory. Everything below is opt-in.

- **Buys:** a purpose-built security scanner with repository-wide context, answering a question no diff-scoped reviewer prompt can.
- **Costs:** Docker, a Postgres container, an index per project, and per-scan model spend.

---

## Setup

### 1. Docker

Install [Docker Desktop](https://docs.docker.com/desktop/) (macOS/Windows) or Docker Engine (Linux) and confirm it works:

```bash
docker info
```

### 2. Build the Metis image

Per [Arm's install docs](https://github.com/arm/metis#11-docker):

```bash
git clone https://github.com/arm/metis.git
cd metis
docker build -t metis .
```

The directory you clone into is your `compose_dir` — remember the path, the config needs it.

### 3. Start Postgres, with an index that survives

Metis stores its vector index in Postgres with pgvector. Arm's `docker-compose.yml` starts it:

```bash
cd /path/to/metis
docker compose up -d
```

That compose file declares a **named volume** (`pg_data`) mounted at `/var/lib/postgresql/data`, which is what makes the index durable — it lives in the volume, not in the container's writable layer. Confirm it exists:

```bash
docker volume ls | grep pg_data
```

**This matters more than it looks.** Building an index costs real embedding spend and real time, and this integration is allowed to *stop* the container and quit Docker when idle. Stopping and starting is safe; deleting the volume is not.

| Command | Effect on the index |
|---|---|
| `docker compose stop` / `start` | **Safe** — this is what `reap.sh` does |
| `docker compose down` | Safe — removes the container, keeps the named volume |
| `docker compose down -v` | **Destroys the index.** Every project must be re-indexed |
| Docker Desktop → "Clean / Purge data" | **Destroys the index** |

If your compose file was edited to use an anonymous volume or no volume at all, fix that before indexing anything — otherwise the index dies with the container and you will pay to rebuild it every time.

### 4. Model access, by environment variable only

Metis speaks the OpenAI API, so any OpenAI-compatible endpoint works: OpenAI directly, or a gateway or proxy in front of it. Export the key, and the endpoint if you use one:

```bash
export OPENAI_API_KEY="…"
export OPENAI_BASE_URL="https://your-endpoint.example/v1"   # omit for OpenAI directly
```

`config.yaml` stores only the **names** of these variables (`llm.api_key_env`, `llm.base_url_env`), never their values. The key is never read by these scripts, never written to a file, and never placed on a command line — `run.sh` forwards it to the container with `docker run -e NAME`, which passes the value through by name so it stays out of process listings. Point the config at differently-named variables if you prefer; nothing assumes the OpenAI defaults beyond the default config values.

### 5. Turn the integration on

In `config.yaml` (or a per-project `.crucible.yaml` overlay):

```yaml
integrations:
  metis:
    enabled: true
    compose_dir: "/path/to/metis"      # where docker-compose.yml lives — required
```

Everything else has a working default; see `config.yaml` for the full block. Verify the resolution:

```bash
bun tools/Config.ts integration metis     # prints true / false
bun tools/Config.ts metis-env             # resolved settings, KEY='value'
```

`false` always prints its reason on stderr — a missing `compose_dir`, or an unset environment variable — so a silent skip is never a mystery.

### 6. Index each project once

An index is per project, keyed by a Postgres **schema**: one schema per project inside the one `metis_db` database, so several projects share the container without colliding. The schema name defaults to the repository's directory name, folded to a safe identifier (`My Repo.v2` → `my_repo_v2`); pin it explicitly with `schema:` in config if you'd rather not depend on the directory name.

```bash
cd /path/to/your/repo
bash /path/to/crucible/skill/tools/metis/scan.sh --command "index"
```

This is the expensive step — it embeds the repository. Do it once per project; refresh later with `--command "update <patch.diff>"`.

Reviews work without an index (Metis falls back to source navigation), so treat indexing as an upgrade rather than a prerequisite. `run.sh` detects whether a project's schema exists and enables the index tools only when there's an index to use.

---

## Scripts

All paths are relative to this directory. Everything reads its settings from `config.yaml` through `tools/Config.ts`; nothing has a hardcoded path.

| Script | Purpose | Exit behavior |
|---|---|---|
| `scan-diff.sh <repo> <diff>` | **The review-time entry point.** Ensures Metis is up, reviews the diff, prints JSON findings | **Always 0** — a missing second opinion never breaks a review |
| `ensure-up.sh [repo]` | Starts Docker (optionally) and the Postgres container; waits until it accepts connections | 0 when ready, non-zero when it gave up |
| `run.sh <repo> [flags]` | The executor: generates the config, then runs Metis in Docker | Propagates Metis's exit code |
| `scan.sh [--repo dir] [args]` | Convenience wrapper — resolves repo root and schema, ensures up, then runs | Propagates |
| `reap.sh [repo]` | Quits an auto-started Docker after the configured idle period | Always 0 |

Only `scan-diff.sh` is meant to be called by the review. The others are for setup, maintenance, and debugging.

### Auto-start and reaping

With `autostart_docker: true` (the default), `ensure-up.sh` launches Docker Desktop when the daemon is down — **macOS only**; elsewhere it reports that Docker is down and skips.

It is safe by construction:

- A **sentinel file** records that this integration started Docker. `reap.sh` quits Docker only when that sentinel exists, so a Docker you started yourself is never touched.
- The sentinel is written **before** the launch, so a crash mid-start still leaves a marker something can clean up.
- When the daemon was already running, no sentinel is created at all.
- `reap.sh` refuses while any scan container or scan process is alive, so concurrent reviews are safe. Each run registers its PID; a live PID or a running container resets the idle clock instead of racing it.

Run it on a timer if you want the memory back automatically (`idle_reap_minutes`, default 10; `0` disables reaping):

```bash
bash /path/to/crucible/skill/tools/metis/reap.sh    # from cron, launchd, or a systemd timer
```

### State on disk

Sentinel and reaper log live under `${XDG_STATE_HOME:-$HOME/.local/state}/crucible/metis/`. Docker ownership is a per-machine fact, not a per-repository one — a sentinel inside one repo would be invisible to a reaper run from another, leaving an auto-started Docker running forever. Nothing is written into the repository under review.

---

## The macOS mount constraint

`run.sh` creates a temporary directory, writes `metis.yaml` into it, and mounts **the whole directory** at `/metis` — the container's working directory, where Metis reads its config and writes results.

The obvious simplification — bind-mounting just the config file to `/metis/metis.yaml` — **does not work on Docker Desktop for macOS.** Its virtiofs implementation validates mount destinations against the container's rootfs boundary, and mounting a single host file into a path that is itself a bind mount is rejected. Mounting the containing directory is the workaround, and the comment in `run.sh` says so. Don't optimize it away.

Two related notes:

- The repository is mounted separately at `/code` (read-only) and passed as `--codebase-path /code`. Arm's own Docker example mounts the codebase at `/metis` instead, which would require writing a `metis.yaml` into the repository being reviewed. Keeping them separate means this integration never writes into your repo.
- The generated `metis.yaml` is ephemeral: mode `600`, inside a `700` temp directory, deleted when the script exits. It is the only place the resolved endpoint is ever written, and it is never committed.

---

## Troubleshooting

**`network metis_default not found`**
Compose names the network after its project, which defaults to the directory name — clone into `metis/` and you get `metis_default`. A different directory name means a different network. Check `docker network ls` and set `integrations.metis.network` to match.

**`Unable to find image 'metis:latest'`**
The image was never built, or was built under another tag. Re-run `docker build -t metis .` in the Metis clone, or set `integrations.metis.scan_image`.

**The scan is skipped every time**
Run `bun tools/Config.ts integration metis` — it prints the reason on stderr. Usual causes: `compose_dir` unset, the environment variable named by `llm.api_key_env` not exported into the shell that runs the review, or Docker not on `PATH`.

**`Command 'index' requires tool 'index'`**
Upstream gates index-backed retrieval behind `--tools index,navigation`, off by default. `run.sh` adds it automatically for `index`, `update`, and `ask`, and for any command on an already-indexed project. If you're invoking Metis directly, pass `--tools index,navigation` yourself.

**`unrecognized arguments: --use-index`**
Current Metis does not accept `--use-index` — tooling is selected with `--tools`, and an unrecognized flag makes it exit before doing any work. Nothing here passes `--use-index`; if you see it, something else in your setup is passing it.

**The index disappeared**
Something removed the `pg_data` volume — most often `docker compose down -v`, or a Docker Desktop "purge data". Re-index each project. See the volume table above.

**Permission errors writing results**
`run.sh` runs the container as your host UID/GID so results in the mounted workspace are yours. If you've customized the image's user, that assumption may not hold.

**Docker doesn't auto-start**
Auto-start is macOS-only and requires `autostart_docker: true`. On Linux or Windows, start Docker yourself; the scan skips cleanly until then.

**Tracking issues aren't being filed**
`issue_on_unavailable` needs `enabled: true` **and** an explicit `repo: "owner/name"`. It is never inferred from the git remote — guessing where to file is exactly the wrong thing to guess. Enabled with an empty or malformed `repo`, filing stays off and the run warns. Filing also needs `gh` installed and authenticated, and labels are applied only if they already exist in that repository.

---

## What this integration does not do

- It doesn't install Metis, build the image, or create the database. Setup is yours; these scripts only use what you've set up.
- It doesn't write to the repository under review — the code is mounted read-only.
- It doesn't send anything anywhere except to the model endpoint you configured.
- It doesn't gate a review. Every failure path ends in "skipped, here's why," and the review continues.
