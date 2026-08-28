# runaway

A memory watchdog for the processes your coding agent spawns.

An agent runs a build, a test suite, a language server, an MCP server, a script it
just wrote. Any of them can leak. When one does on a Mac you do not get a tidy
`ENOMEM` — you get the beachball, then the compressor saturating, then swap
growing on the boot volume, and then a machine that is either unusable or gone.
By the time you notice, the thing that could have fixed it in one signal cannot
get scheduled.

runaway is a small LaunchAgent that watches the process tree under your agent and
kills a process that has gone wrong, **early enough that killing it still works**.

**It only ever signals a process that is running as you and descended from your
agent.** Everything else on the machine — your browser, your editor, another
user, anything system-owned — is out of reach by construction, not by a list it
consults.

---

## The three rules

| Rule | Trips when | Does | Catches |
|---|---|---|---|
| **per-process cap** | one in-scope process holds more than `max_rss_mb` | SIGTERM, then SIGKILL after a grace period | the ordinary case: one leaking worker |
| **swap ceiling** | swap in use exceeds `max_swap_mb` | same, on the largest in-scope process | four processes at 6 GB each, none of them individually wrong |
| **disk floor** | free space on the swap volume falls below `min_disk_free_mb` | SIGKILL, no grace period | the failure that takes the machine with it |

Set any threshold to `0` to turn that rule off.

The disk rule skips the grace period on purpose. The other two can afford to ask
a process to leave; a boot volume with minutes of headroom cannot, because a
process that ignores SIGTERM for ten seconds has spent those minutes.

## Why it still works when the thing it is watching is eating the machine

This is the hard part, and it is the reason most watchdogs of this shape do not
work. Four decisions, in order of how much they matter:

**1. It fires early, so it never has to act under duress.** The default
per-process cap is 8 GB. On a 32 GB Mac nothing legitimate — not a compile, not a
test run, not a language server — reaches that by accident, and a leak crosses it
long before the compressor is under strain. A cap set near your machine's
capacity is the classic mistake: at 28 GB on a 32 GB machine you are already
paging, and a watchdog competing for the CPU it needs in order to act does not
act. **Everything else below is insurance for a threshold set too high.**

**2. `ProcessType: Interactive` in the LaunchAgent.** This tells launchd the job
belongs to a responsive user experience, so it is exempt from the CPU and I/O
throttling launchd applies to background work — which is exactly the throttling
that would keep it from being scheduled at the moment it is needed.

**3. It is shell and awk, not a runtime.** A tick is one `ps`, one `sysctl`, one
`df`, and two short `awk` passes. There is no interpreter with a heap of its own
to be swapped out and faulted back in, and nothing it does allocates in
proportion to how bad things are. A watchdog written in the same runtime as the
thing running away competes with it for the same pages.

**4. `KeepAlive`.** If it dies, launchd restarts it. A watchdog that is not
running is worse than no watchdog, because you think you have one.

## What is in scope

A process is in scope if it is **running as you** and is **a root or descended
from one**. A root is:

- a process whose program name matches `root_pattern` (default `^claude$`), or
- one whose full command line matches `root_cmdline_pattern` (default
  `claude-code/cli\.js`, the npm install shape), or
- one started by `runaway run` (below).

Three things are then excluded from being signalled:

- **the root itself**, by default — killing your agent ends the session, so that
  is a choice you make with `protect_roots = 0`, not the default;
- **anything matching `never_pattern`** — shells, `ssh`, `tmux`, `sudo`. Killing
  the shell a build is running in does not stop the build's runaway child, it
  just costs you the output;
- **runaway itself and anything it spawned**, including in the case where your
  agent is what started it. Otherwise the first swap spike has it kill itself.

Add your own agents by alternation: `root_pattern = ^(claude|codex|aider)$`.

Anything else that is eating your machine, runaway will **name and not touch**.
When a system-wide rule trips with nothing in scope, the log says so and reports
the largest process you own as a lead. A watchdog that widens its own scope under
pressure is one that eventually kills your editor.

## Install

```sh
./install.sh          # stages the tool, a config, and a LaunchAgent plist
./install.sh --dry-run
```

It does not load the LaunchAgent. It prints the `launchctl bootstrap` line for
you to run, because a watchdog that installs itself into your login session
without you typing anything is one you will find running months later and not
remember agreeing to.

Before you load it:

```sh
runaway status
```

which prints what it can see, what is in scope, and what it would kill right now
— and changes nothing. If the in-scope list is empty while your agent is running,
`root_pattern` does not match it, and nothing else in here matters until it does.

`dry_run = 1` in the config, or `runaway watch --dry-run`, decides and logs
everything and signals nothing. A week of that is a reasonable price for later
trusting it with SIGKILL.

Uninstall with `./install.sh --uninstall`. It leaves your config and the log
alone; the log is the answer to "what killed my build last Tuesday".

## Bringing something else into scope

```sh
runaway run -- npm test
```

Registers itself as a scope root, so the command and everything it spawns is
watched even though your agent did not start it. It also sets
`NODE_OPTIONS=--max-old-space-size=…` if you have not set one yourself.

**That heap cap is the cheapest guard here and the only real limit rather than a
reaction.** V8 refuses the allocation and the process dies with a heap OOM naming
your code, instead of growing until something else has to decide. If you take one
thing from this repo and not the daemon, take that. Its limit is that it bounds
the V8 old space only — `Buffer`, `ArrayBuffer`, and native allocations grow past
it, which is why the daemon exists too. Bun's `--smol` reduces memory use but is
not a cap; for Bun and everything non-Node, the per-process rule is the cover.

## Configuration

`$XDG_CONFIG_HOME/runaway/runaway.conf`, or `$HOME/.config/runaway/runaway.conf`.
Every key is documented in [`runaway.conf.example`](./runaway.conf.example), and
`runaway config` prints what is actually in force.

The file is **parsed, never sourced**, and values are applied by an explicit
`case`, never `eval`. A command substitution in a value is a string. A config
file that can run code turns "edit a threshold" into a way to execute something
as you, and this one is read by a process whose entire job is sending signals.

Unknown keys and malformed values are **rejected out loud** — on stderr, and in
the daemon's log at startup — rather than ignored. A silently dropped key leaves
you with a guard that looks installed and is enforcing the default.

## What this does not do

Stated plainly, because a guard whose limits you learn by being surprised is a
guard you uninstall.

**It reads RSS, and RSS under-reports a process macOS has already compressed.**
There is no cheap way to get the number Activity Monitor shows without forking a
much heavier tool on every tick. In the window that matters — a process actively
growing, before the compressor gets to it — RSS is accurate, and that is the
window this is trying to act in. The swap and disk rules exist partly because
they do not depend on per-process accounting at all.

**It is a poller, not a limit.** macOS has no kernel-enforced per-process memory
cap for an ordinary process. `ulimit -v` and `ulimit -m` are accepted and not
enforced; do not take that from me, check it on your own machine:

```sh
( ulimit -v 262144; python3 -c "b=bytearray(512*1024*1024); print('allocated', len(b))" )
```

If that prints `allocated 536870912` after being told it may have 256 MB, the
limit did nothing. That is why this is a watchdog and not a `setrlimit` call.
A process can allocate faster than `interval_seconds`, and a very fast allocator
can still take the machine before the next tick.

**It counts processes one at a time.** A hundred small processes that add up to
30 GB never trip the per-process cap. The swap and disk rules are what cover
that, and they are blunter: they kill the largest in-scope process, which may not
be the one at fault. A fork bomb is a different problem and this is not the tool.

**Between SIGTERM and SIGKILL it trusts the pid.** If a process exits during the
grace period and the kernel reuses its pid within those seconds, the SIGKILL goes
to the new process. It has to be the same user's, so the blast radius is bounded,
but it is not zero.

**launchd does not rotate the log.** It is one line per action, so it grows very
slowly, but nothing here truncates it.

**It is macOS-only.** The swap probe is `sysctl vm.swapusage` and the daemon is a
LaunchAgent. The decision logic is portable and its tests run on Linux — that is
how they run in this repo's CI — but the installer refuses anywhere else.

## Deliberately not included

**A growth-rate rule.** "Killed anything gaining more than 500 MB/min" sounds
better than it is: a linker, a test suite starting up, and a language server
indexing a large repo all do that legitimately. It would have fired on ordinary
work often enough to get switched off, and a threshold set low enough to be safe
is one the absolute cap already caught. Acting early is what the low absolute cap
is for.

**A root LaunchDaemon.** It could set itself a negative nice value and would
survive extreme pressure marginally better. A root process whose job is sending
SIGKILL is a larger blast radius than the problem it solves, and running as you
is what makes "it can only touch your own processes" a structural guarantee
instead of a promise.

**`memorystatus_control`.** macOS does have a kernel-enforced per-process
high-water mark — it is how iOS caps apps — but the interface is private,
undocumented, and not something to build a tool you rely on around.

**Isolation.** If you want a hard guarantee rather than a fast reaction, this is
not the shape of tool that gives you one. Run your agent inside a VM or a
container with a memory limit the hypervisor enforces, and a runaway hits a wall
instead of a watchdog. That is a bigger change to how you work, it costs you
something on every ordinary day, and it is genuinely stronger. runaway is for the
case where you want your agent running natively on your Mac and want the machine
to survive it.

## Tests

```sh
bun run test      # or: bash tests/run.sh
```

Ninety-odd assertions, no dependencies, and no Mac required. The tool is split so
that everything interesting is a decision — who is in scope, what is over the
cap, what an unreadable probe means — and decisions are text in and text out.
The suites pipe fixture process tables through the same functions the daemon
calls and assert the plan, including the cases you cannot stage on a real machine
on purpose: a parent-pid cycle, a probe that failed, a config regex that would
have matched more than it says.
