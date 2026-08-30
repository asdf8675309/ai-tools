# runaway

Keeps a Mac out of **"Your system has run out of application memory"** — the modal panel where the only thing you can do is force-quit something and hope.

That panel is not "RAM is full". It is the kernel finding the **compressor near its limit, or the swapper wanting to write with swap space low**, and then failing to resolve it on its own. Its first move is silent: any single process holding more than half of all compressor pages gets SIGKILLed and you never see a dialog. The panel is what happens when no one process is that dominant — when the memory is spread across several, which is exactly the shape of a machine running an agent, its build, its language server, and a browser.

By then it is too late to be clever. The machine is spending its remaining cycles paging rather than running anything, and whatever was going to fix it needed to act minutes earlier, while it could still be scheduled.

So this acts earlier. It watches the kernel's own memory-pressure signal, the compressor, and the rate you are writing to swap, and when the machine starts down that road it **pauses the largest process it is allowed to touch** — SIGSTOP, instantly, no work lost, undone with one command. If pressure clears, it puts it back. If pausing did not fix it, the process gets asked to leave and then killed.

It was built for processes a coding agent spawns, which is where this keeps happening. It is not limited to them, because the thing filling your swap very often is not one.

**It only ever signals a process running as you.** Another user's processes and anything system-owned are unreachable by construction, not by a list it consults.

---

## Start here

```sh
runaway probes
```

Every reading this tool makes, as it is on **your** machine, and which ones it could not read. That last part is not hedging for its own sake: these come from `sysctl` and `vm_stat`, and what a non-root user gets back has changed between macOS releases. A probe reading `unavailable` is a rule that will not fire, and you should know which ones before you trust any of this.

Do not try to verify the pressure sysctl by looking for it in `sysctl -a` — it is flagged hidden on release builds and will not be listed there even though reading it by name works. `runaway probes` queries by name for that reason.

```
  kern.memorystatus_vm_pressure_level  1                  trips at >= 2 (1 normal, 2 warn, 4 critical)
  compressor share of RAM              34%                trips above 60%
  swapout rate                         12 MB/s            rule off (see the README on calibrating it)
  vm.swapusage used                    2048 MB            trips above 8192 MB
  free space on the swap volume        180000 MB          trips below 10240 MB
```

Then `runaway status` for what it would do right now, and `runaway watch --dry-run` to let it decide out loud for a while without signalling anything.

## The rules

| Rule | Trips when | Does | Catches |
|---|---|---|---|
| **system pressure** | the kernel says *warn*, **or** the compressor holds more than `max_compressed_pct` of RAM, **or** swapout exceeds `max_swapout_mb_per_sec` — and stays that way for `pressure_sustain_seconds` | **SIGSTOP** the largest eligible process | the actual freeze, whatever caused it |
| **per-process cap** | one in-scope process holds more than `max_rss_mb` | SIGTERM, then SIGKILL after a grace period | one leaking worker, before the machine notices |
| **swap ceiling** | swap in use exceeds `max_swap_mb` | same, on the largest in-scope process | a blunt backstop if every pressure probe turns out unreadable |
| **disk floor** | free space on the swap volume falls below `min_disk_free_mb` | SIGKILL, no grace period | the boot volume filling — which is what stops macOS growing swap, and takes the machine with it |

Set any threshold to `0` to turn that rule off.

**Three inputs to the pressure rule, because they fail differently.** The kernel's level is the same judgment macOS acts on itself, so it needs no calibration from you — but it may not be readable. The compressor share is always computable from `vm_stat`, but the threshold is a number a person has to pick. The swapout rate is "the Mac is swapping heavily" measured directly and is the earliest signal of the three, but the right number depends on your disk and your workload, so it ships **off** with instructions to calibrate it. Any one of them tripping is enough; any one being unavailable simply means it does not vote.

## Why pause instead of kill

SIGSTOP is the right primitive for this and it is underused. The process halts between instructions. It stops allocating **immediately** — no handler to run, no cleanup, nothing to cooperate with. Nothing is lost, and `runaway resume <pid>` puts it back exactly where it was.

That matters because of what it buys: the pressure rule is allowed to reach outside your agent, at everything you own. Reaching that wide with a kill is not a trade worth making. Reaching that wide with a pause is.

It is not a complete fix on its own, and it is worth being exact about why: **a pause frees nothing at the moment you send it.** Every page the process had, it still has. What changes is that a stopped process stops referencing them, so they age off the active queue and become ordinary candidates for the compressor and the pageout daemon. Relief is real but it lags — seconds to tens of seconds, not instantly. That is the entire argument for acting at *warn* rather than *critical*: a pause is a good move with a minute in hand and close to useless with one second.

(This is also what the kernel does. Its own low-swap handler suspends processes that opted into that policy before it kills anything.)

Which is why the escalation exists:

- pressure clears → the pause cost nothing, and it is undone automatically
- pressure does not clear after `pressure_escalate_seconds` → pausing did not solve it, so the process is SIGTERM'd and then killed

Those two branches are the whole design. A spike gets absorbed for free; a genuine leak gets stopped, given a minute to prove the pause was enough, and then removed.

`runaway ps` lists what is paused and for how long. `runaway resume all` undoes everything.

## What it is allowed to touch

Two scope settings, because the two kinds of action are different:

```
scope = agents             # the destructive rules stay narrow
pressure_scope = user      # the reversible one may look at everything you own
```

- **`agents`** — processes descended from a root: your coding agent (matched by `root_pattern` / `root_cmdline_pattern`), or anything started by `runaway run`.
- **`user`** — every process you own.

If the freeze happens when no agent is running, set `scope = user` as well.

Whatever the scope, four things are never signalled:

- **anything in `never_pattern`** — shells, `ssh`, `tmux`; the desktop (`Finder`, `Dock`, `WindowServer`, the system agents); and things holding work you have not saved (`Terminal`, `Code`, `Xcode`, `vim`, `emacs`, `git`). This list is what makes `pressure_scope = user` safe to ship on by default: widening the scope does not widen what may be touched.
- **the agent itself**, by default — killing it ends the session, so that is `protect_roots = 0`, a choice you make.
- **runaway and anything it spawned**, including when your agent is what started it. Otherwise the first pressure spike has it pause itself.
- **anything smaller than `target_min_mb`.** Once the real offenders are protected or already paused, "the largest process I may act on" is whatever tiny thing is left. Pausing a 1 MB helper to relieve memory pressure is not a smaller version of the right action, it is the wrong action. (This one is here because running the thing did exactly that.)

Note what is deliberately **not** protected: browsers, and every language runtime. A browser is the single most common cause of this on a Mac and it restores its tabs. A `node` or `python` process is what you installed this for.

When a rule trips and nothing is eligible, it says so in the log and names the largest process you own as a lead. It does not go looking for something else. A watchdog that widens its own scope under pressure is one that eventually kills your editor.

## Why it still works while the machine is bogging down

**1. It acts early, so it never has to act under duress.** Warn-level pressure, not critical. A per-process cap of 8 GB on a 32 GB Mac. Everything is tuned to fire while the machine is merely getting worse, not once it is already unusable. This is most of the answer; the rest is insurance.

**2. `ProcessType: Interactive` in the LaunchAgent.** Tells launchd the job belongs to a responsive user experience, exempting it from the CPU and I/O throttling applied to background work — the exact throttling that would keep it from being scheduled when it matters.

**3. Shell and awk, not a runtime.** A tick is one `ps`, three `sysctl`s, one `vm_stat`, one `df`, and two short `awk` passes. There is no interpreter with a heap of its own to be swapped out and faulted back in, and nothing it does allocates in proportion to how bad things are. A watchdog written in the same runtime as the thing running away competes with it for the same pages.

**4. `KeepAlive`.** If it dies, launchd restarts it. A watchdog that is not running is worse than none, because you think you have one.

## Install

```sh
./install.sh          # stages the tool, a config, and a LaunchAgent plist
./install.sh --dry-run
```

It does not load the LaunchAgent. It prints the `launchctl bootstrap` line for you to run, because a watchdog that installs itself into your login session without you typing anything is one you will find running months later and not remember agreeing to.

Uninstall with `./install.sh --uninstall`. It leaves your config and the log alone; the log is the answer to "what paused my build last Tuesday".

## Bringing something else into scope

```sh
runaway run -- npm test
```

Registers itself as a scope root, so the command and everything it spawns is watched even though your agent did not start it. It also sets `NODE_OPTIONS=--max-old-space-size=…` if you have not set one yourself.

**That heap cap is the cheapest guard here and the only real limit rather than a reaction.** V8 refuses the allocation and the process dies with a heap OOM naming your code, instead of growing until something else has to decide. If you take one thing from this directory and not the daemon, take that. Its limit is that it bounds the V8 old space only — `Buffer`, `ArrayBuffer`, and native allocations grow past it, which is why the daemon exists too. Bun's `--smol` reduces memory use but is not a cap; for Bun and everything non-Node, the per-process rule is the cover.

## Configuration

`$XDG_CONFIG_HOME/runaway/runaway.conf`, or `$HOME/.config/runaway/runaway.conf`. Every key is documented in [`runaway.conf.example`](./runaway.conf.example), and `runaway config` prints what is actually in force.

The file is **parsed, never sourced**, and values are applied by an explicit `case`, never `eval`. A command substitution in a value is a string. A config file that can run code turns "edit a threshold" into a way to execute something as you, and this one is read by a process whose entire job is sending signals.

Unknown keys and malformed values are **rejected out loud** — on stderr, and in the daemon's log at startup — rather than ignored. A silently dropped key leaves you with a guard that looks installed and is enforcing the default.

## What this does not do

Stated plainly, because a guard whose limits you learn by being surprised is a guard you uninstall.

**It cannot promise you never see the panel.** It moves the line, it does not remove it. A process that allocates tens of gigabytes between two ticks outruns any poller, and if every pressure probe on your machine reads `unavailable`, the pressure rule is not running at all — which is what `runaway probes` is for.

**A pause is not a fix, it is time.** The paused process still holds every page it had. What you get is a machine that responds while you decide, and an escalation that decides for you if you do not.

**It reads RSS, and RSS under-reports a process macOS has already compressed.** `ps` reports resident pages; compressed pages are by definition no longer resident, so a squeezed process looks small while costing exactly as much. The number Activity Monitor shows is `phys_footprint`, which includes them — and no stock command prints it. Getting it means calling `proc_pid_rusage` from compiled code, which is a C dependency this does not want. In the window that matters, though — a process actively growing, before the compressor gets to it — RSS is accurate, and that is the window this acts in. The pressure, swap and disk rules exist partly because they do not depend on per-process accounting at all.

**It is a poller, not a limit — but the reason is subtler than "macOS has no rlimits".** It does, now. `RLIMIT_AS` became genuinely enforced in macOS 12 (`vm_map_enter` fails the mapping once the map exceeds it); through Big Sur it was accepted and ignored. Check which side of that line you are on:

```sh
( ulimit -v 262144; python3 -c "b=bytearray(512*1024*1024); print('allocated', len(b))" )
```

`MemoryError` means it is enforced; `allocated 536870912` means it is not.

It is still the wrong knob, for two reasons. It caps **address space**, not memory held: a Mac process reserves enormous virtual address space it never touches — the dyld shared cache, malloc zones, Metal — so a `ulimit -v` set anywhere near actual usage breaks ordinary programs, and one set high enough not to is far above the footprint you meant to cap. And on Darwin `RLIMIT_RSS` is a `#define` alias for `RLIMIT_AS`, so `ulimit -m` and `ulimit -v` are one limit that clobber each other. There is no independent resident-set limit to set.

**Pausing something can hang something else.** A paused process holding a lock, a socket, or a pipe the other end is waiting on will stall whatever is waiting. It is reversible and you are told about it, but it is not free.

**It counts processes one at a time.** A hundred small processes that add up to 30 GB never trip the per-process cap. The pressure rule covers that case but bluntly: it pauses the largest eligible process, which may not be the one at fault. A fork bomb is a different problem and this is not the tool.

**launchd does not rotate the log.** One line per action, so it grows very slowly, but nothing here truncates it.

**It is macOS-only.** The probes are `sysctl` and `vm_stat` and the daemon is a LaunchAgent. The decision logic is portable and its tests run on Linux — that is how they run in this repo's CI — but the installer refuses anywhere else.

## Deliberately not included

**A growth-rate rule per process.** "Kill anything gaining more than 500 MB/min" sounds better than it is: a linker, a test suite starting up, and a language server indexing all do that legitimately. It would have fired on ordinary work often enough to get switched off. The system-wide swapout rate is the same idea measured where it actually means something.

**A root LaunchDaemon.** It could set itself a negative nice value and would survive extreme pressure marginally better. A root process whose job is sending SIGKILL is a larger blast radius than the problem it solves, and running as you is what makes "it can only touch your own processes" structural instead of a promise.

**A compiled helper for `phys_footprint`.** `proc_pid_rusage(pid, RUSAGE_INFO_V6, …)` returns the real number, cheaply, and works non-root for your own processes. It is fifteen lines of C. It is not here because it would make this the one thing in this repo that needs a compiler, and the system-wide rules — which are what actually keep you out of the panel — do not need per-process accounting at all.

**`kern.memorystatus_level`.** It looks like exactly the signal you want, a percentage of memory available. Its only writer in the kernel sits inside jetsam code macOS does not compile, so on a Mac it very likely reads a constant zero. A probe that is always calm is worse than no probe.

**`memorystatus_control`.** macOS does have a kernel-enforced per-process high-water mark — it is how iOS caps apps — but the interface is private and undocumented, and not something to build a tool you rely on around.

**Isolation.** If you want a hard guarantee rather than a fast reaction, this is not the shape of tool that gives you one. Run your agent inside a VM or a container with a memory limit the hypervisor enforces, and a runaway hits a wall instead of a watchdog. That is a bigger change to how you work, it costs you something on every ordinary day, and it is genuinely stronger. runaway is for the case where you want things running natively on your Mac and want the machine to survive them.

## Tests

```sh
bun run test      # or: bash tests/run.sh
```

Five suites, no dependencies, no Mac required.

The tool is split so that everything interesting is a decision, and every decision is text in and text out. `lib/policy.sh` probes nothing and signals nothing; the suites pipe fixture process tables and fixture `vm_stat` output through the same functions the daemon calls and assert the plan. That covers the cases you cannot stage on a real machine on purpose: a parent-pid cycle, a `sysctl` a non-root user could not read, a swap counter that went backwards across a reboot, a config regex that would have matched wider than it reads.

`tests/cli.test.sh` covers the half that is not pure, against real processes: pausing one and confirming it is stopped, resuming it, and the escalation path — which had a real bug before it was tested, because **a stopped process cannot act on SIGTERM.** It is not running, so it never reaches its handler, and the grace period expires against a process that was never given the chance. Escalation has to SIGCONT first.
