# contrib

Templates for keeping an archive built ahead of time, so the first checkout after a
lockfile change restores instead of installing. Everything here is an example; change
paths, users and schedules to fit the host.

| File | Purpose |
|---|---|
| `dep-archive-refresh.sh` | Fetches a branch tip from a repository into a private working copy and runs `dep-archive verify`, then `build` if needed. Takes `<repo> <branch> [workdir]`. Covered by `test/run.sh`. |
| `dep-archive-refresh@.service`, `dep-archive-refresh@.timer`, `example.env` | systemd template units, one instance per repository. Not tested. |
| `crontab.example` | The same poll from cron. Not tested. |
| `github-actions.yml` | Job steps that combine `actions/cache` with `dep-archive`. Not tested. |

Install the systemd units:

```bash
sudo install -m 755 bin/dep-archive /usr/local/bin/dep-archive
sudo install -m 755 contrib/dep-archive-refresh.sh /usr/local/bin/dep-archive-refresh.sh
sudo install -m 644 contrib/dep-archive-refresh@.service contrib/dep-archive-refresh@.timer /etc/systemd/system/
sudo install -D -m 644 contrib/example.env /etc/dep-archive/example.env   # then edit it, and User= in the service
sudo systemctl daemon-reload
sudo systemctl enable --now dep-archive-refresh@example.timer
```

## Example: a self-hosted agent platform

This tool started inside one repository on a VM that runs several coding agents, each
in its own fresh checkout. The agent platform kept a bare mirror of the repository and
refreshed it itself, and it garbage-collected its workspaces directory while skipping
dot directories. The refresh ran from a systemd timer every 15 minutes against that
local mirror, so it needed no credential and made no network request of its own. It
read the mirror's remote-tracking ref (`DEP_ARCHIVE_SOURCE_REF=refs/remotes/origin/main`)
because the mirror's local branch lagged. Archives went in a dot directory under the
workspaces root (`DEP_ARCHIVE_DOT_ROOT`), so the platform's cleanup left them alone. Each
agent ran `dep-archive ensure` after checkout, and the repository's agent instructions
told it to do so instead of `npm ci`. With the build throttled by the unit's `Nice`,
`IOSchedulingClass` and `CPUQuota`, a lockfile change cost one low-priority install on
the host rather than one full-speed install per agent.
