#!/usr/bin/env bash
#
# rg_pressure — is the machine in trouble.
#
# Three independent inputs, any one of which trips it. They are here because
# they fail differently: the kernel's own level needs no calibration but may not
# be readable by a non-root user on your macOS version; the compressor share is
# always computable from vm_stat but is a number a person has to pick; the
# swapout rate matches "the Mac is swapping heavily" most directly and is the
# most machine-specific.
#
# The failure that matters most in here is an unreadable probe voting. -1 means
# "could not read this", and read as a number it is less than every threshold
# and greater than none — get the comparison wrong in either direction and you
# get a rule that never fires, or one that fires forever.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=harness.sh
. "$HERE/harness.sh"
# shellcheck source=../lib/policy.sh
. "$HERE/../lib/policy.sh"

# Every input available, everything comfortable.
CALM='level=1 max_level=2 comp_pct=20 max_comp_pct=60 swapout=5 max_swapout=100'

eq 'a comfortable machine is not under pressure' '0 -' "$(rg_pressure "$CALM")"

eq 'the kernel saying "warn" is enough on its own' \
  '1 kernel-pressure' "$(rg_pressure 'level=2 max_level=2 comp_pct=20 max_comp_pct=60')"
eq 'so is critical' \
  '1 kernel-pressure' "$(rg_pressure 'level=4 max_level=2 comp_pct=20 max_comp_pct=60')"
eq 'normal is not' \
  '0 -' "$(rg_pressure 'level=1 max_level=2 comp_pct=20 max_comp_pct=60')"

eq 'the compressor holding more than its share is enough on its own' \
  '1 compressor' "$(rg_pressure 'level=1 max_level=2 comp_pct=61 max_comp_pct=60')"
eq 'exactly at the share is not' \
  '0 -' "$(rg_pressure 'level=1 max_level=2 comp_pct=60 max_comp_pct=60')"

eq 'so is a swapout rate past its ceiling' \
  '1 swapout-rate' "$(rg_pressure 'swapout=250 max_swapout=100')"

eq 'and every reason it tripped for is reported, in probe order' \
  '1 kernel-pressure+compressor+swapout-rate' \
  "$(rg_pressure 'level=4 max_level=2 comp_pct=90 max_comp_pct=60 swapout=900 max_swapout=100')"

# ── unavailable is not zero ──────────────────────────────────────────────────
eq 'a kernel level that could not be read does not vote' \
  '0 -' "$(rg_pressure 'level=-1 max_level=2 comp_pct=20 max_comp_pct=60')"
eq 'nor does an unreadable compressor share' \
  '0 -' "$(rg_pressure 'level=1 max_level=2 comp_pct=-1 max_comp_pct=60')"
eq 'nor a swapout rate that does not exist yet (the first tick has no rate)' \
  '0 -' "$(rg_pressure 'swapout=-1 max_swapout=100')"
eq 'with every probe unavailable the rule is simply off, not permanently tripped' \
  '0 -' "$(rg_pressure 'level=-1 max_level=2 comp_pct=-1 max_comp_pct=60 swapout=-1 max_swapout=100')"
eq 'and one readable probe still works while the others are unavailable' \
  '1 compressor' "$(rg_pressure 'level=-1 max_level=2 comp_pct=90 max_comp_pct=60 swapout=-1 max_swapout=100')"

# ── thresholds off ───────────────────────────────────────────────────────────
eq 'max_pressure_level = 0 turns off the kernel input' \
  '0 -' "$(rg_pressure 'level=4 max_level=0 comp_pct=20 max_comp_pct=60')"
eq 'max_compressed_pct = 0 turns off the compressor input' \
  '0 -' "$(rg_pressure 'level=1 max_level=2 comp_pct=99 max_comp_pct=0')"
eq 'max_swapout_mb_per_sec = 0 turns off the rate input — which is the default' \
  '0 -' "$(rg_pressure 'swapout=99999 max_swapout=0')"
eq 'and with no facts at all nothing trips' '0 -' "$(rg_pressure '')"

# ── the arithmetic behind the compressor input ───────────────────────────────
eq 'compressor pages become a whole percent of RAM'  25 "$(rg_pct 8589934592 34359738368)"
eq 'a share that rounds down stays down'             33 "$(rg_pct 1 3)"
eq 'an unreadable numerator disables the input'      -1 "$(rg_pct -1 34359738368)"
eq 'so does an unreadable total — no dividing by a missing hw.memsize' \
  -1 "$(rg_pct 8589934592 -1)"
eq 'and a zero total does not divide by zero'        -1 "$(rg_pct 100 0)"

# ── the arithmetic behind the swapout input ──────────────────────────────────
eq 'a counter that advanced becomes a per-second rate' 50 "$(rg_rate 1000 1500 10)"
eq 'a counter that did not move is a rate of zero'      0 "$(rg_rate 1000 1000 10)"
# Both of these are a reboot or a first tick, not a spike. Reporting a rate for
# either invents pressure out of a restart.
eq 'a counter that went backwards is not a rate'       -1 "$(rg_rate 5000 1000 10)"
eq 'and neither is one with no previous reading'       -1 "$(rg_rate -1 1000 10)"
eq 'nor one with no elapsed time'                      -1 "$(rg_rate 1000 2000 0)"

# ── vm_stat parsing ──────────────────────────────────────────────────────────
VMSTAT='Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                 123456.
Pages active:                              1000000.
Pages occupied by compressor:               524288.
Swapins:                                       42.
Swapouts:                                    99999.'
eq 'the page size, compressor pages and swapout counter come out of vm_stat' \
  'pagesize=16384 compressor=524288 swapouts=99999 free=123456' "$(printf '%s\n' "$VMSTAT" | rg_vm_stat)"
eq 'a vm_stat that printed nothing reads as every field unavailable' \
  'pagesize=-1 compressor=-1 swapouts=-1 free=-1' "$(printf '' | rg_vm_stat)"
# vm_stat prints TWO compressor lines. "occupied by" is the physical pages the
# compressor consumes — a real share of RAM. "stored in" is the larger logical
# count of uncompressed pages it holds. Reading the second as the first
# overstates pressure by the compression ratio, which is roughly double.
TWOLINES='Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages occupied by compressor:               524288.
Pages stored in compressor:                1200000.'
contains 'the physical compressor line is the one that is read' \
  'compressor=524288' "$(printf '%s\n' "$TWOLINES" | rg_vm_stat)"
lacks 'and the larger logical one is not' \
  'compressor=1200000' "$(printf '%s\n' "$TWOLINES" | rg_vm_stat)"
# Values carry a trailing period. Read as a number rather than digits, awk
# would still give 524288 here — but a label whose value Apple ever pads or
# suffixes differently would not, so the digits are extracted explicitly.
eq 'the trailing period vm_stat puts on every value is not part of it' \
  'pagesize=4096 compressor=777 swapouts=88 free=-1' \
  "$(printf 'Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages occupied by compressor:  777.\nSwapouts:  88.\n' | rg_vm_stat)"

# ── sysctl integers ──────────────────────────────────────────────────────────
eq 'a sysctl that printed one integer is read'        4 "$(printf '4\n' | rg_sysctl_int)"
eq 'a sysctl that errored is unavailable, not zero'  -1 "$(printf 'sysctl: unknown oid\n' | rg_sysctl_int)"
eq 'a sysctl a non-root user could not read is too'  -1 "$(printf '' | rg_sysctl_int)"
eq 'and a negative reading is not trusted'           -1 "$(printf -- '-3\n' | rg_sysctl_int)"

summary pressure
