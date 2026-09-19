# the disprove gate

Multi-model code review produces a lot of findings, and a large share of them are not real
defects. This gate scores each finding and drops the ones that are confidently false
positives, so a human reads fewer of them.

```
bun run findings:gen        # regenerate the corpus (deterministic, seeded)
bun run findings:eval       # score it, sweep for a threshold
bun run findings:sabotage   # prove the measurement can fail
```

## The pattern: a battery, not one question

The first version of this eval asked a single `noul` that listed five disqualifiers at
once. It scored **-0.120 separation** — the wrong direction, 50.0% balanced accuracy, pure
chance. Real defects scored *higher* on "is this a false positive" than actual false
positives did, because the model was reading how mechanism-dense the text sounded rather
than evaluating a five-way disjunction.

Replacing it with **seven narrow questions aggregated by `maxGate`** moved it to +0.251 and
100% on the same corpus. Each question is framed so the bad case is TRUE, which is what
makes taking the max meaningful: one confident disqualifier is enough.

That is the whole lesson. A calibrated yes/no head answers one question well and a compound
question badly, and the failure is silent — you get a confident number pointing the wrong
way rather than an error.

## Results, and the gap between them

| | synthetic corpus | real findings |
|---|---|---|
| n | 200 | 130 |
| Balanced accuracy | 100.0% | **74.9%** |
| Mean score, real defects | 0.680 | 0.605 |
| Mean score, false positives | 0.931 | 0.759 |
| Separation | 0.251–0.255 | 0.153 |
| Zero-false-drop threshold | 0.82–0.83 | 0.89 |
| False positives dropped at that threshold | **100%** | **20%** |

The synthetic column is given as a range because two independent runs produced
0.251/0.82 and 0.255/0.83. Accuracy was 100.0% both times; the cut point is a
plateau, not a value, and a threshold quoted to two decimals from one run is
false precision.

**The synthetic number is not the real number, and the difference is the point of this
table.** The corpus in this repo was written from the same taxonomy as the battery
questions, so the eval is close to teaching to the test: it shows the battery detects the
false-positive families *as described in the generator*. On real findings it detects far
fewer of them, because real false positives do not arrive pre-sorted into named families.

The real column comes from a private measurement we cannot publish: 130 findings drawn from
production code review, each labelled by two independent judges from different vendors who
agreed. The findings themselves are not ours to share; only the aggregate is, so you cannot
reproduce this column — treat it as a reported result, not a verified one.

**One known bias, stated because it cuts against us.** 180 findings were sampled and only
130 got labels: 30 where the judges disagreed and 20 where one judge did not return a
parseable verdict. That exclusion is *not* random. On the excluded rows the first judge
called 80% of them real defects, against 32% on the included rows. Consensus filtering
therefore stripped out disproportionately many likely-real findings, which means the 2:1
false-positive ratio in this sample understates how often findings are real, and the gate's
measured accuracy is flattered by an easier set. We did check one plausible mechanism and
cleared it: the excluded findings are not systematically longer (442 vs 511 chars), so the
judge's token ceiling was not quietly dropping the hard ones.

**If you take one number from this page, take the 52.5% loss rate, not either accuracy figure.**

## Is it worth shipping? Read this before the table above

The two errors are not symmetric: a wrongly-kept finding costs a reviewer a minute, while a
wrongly-dropped one is never looked at again. So the tempting threshold is the highest cut
at which no real defect was lost.

**That threshold does not survive a holdout, and the first version of this page said it
did.** Fitting the cut on the labelled rows and then reporting zero losses *on those same
rows* measures nothing. Refitting on half the data and testing on the other half, 200 times:

| | |
|---|---|
| Mean fitted threshold | 0.85 |
| Splits that lost at least one real defect | **52.5%** (105/200) |
| Mean real defects lost per split | 0.89 |
| Mean false positives caught | 35.0% |

So the honest statement is not "drops 20% of false positives at no risk". It is: **a
threshold fitted on ~40 labelled real defects loses a real defect about half the time on
data it has not seen.** The in-sample zero was an artifact of selection.

That is a materially different product. Used as an auto-drop it will lose defects. What it
can still do safely is *rank*: score every finding, show a human the low-scoring ones first,
and drop nothing automatically. Ranking has no silent-loss failure mode, and the separation
measured above (0.153 on real findings) is real even though the cut point is not stable.

If you do want an auto-drop, fit the threshold on far more than 40 labelled defects, re-fit
on your own data, and measure the loss rate on a holdout rather than on the fitting set.

## Measure your own

Both thresholds here were measured on their own corpus. They do not transfer — not from the
synthetic corpus to real findings, as the table shows, and not from our findings to yours.
Run `eval.ts` against your own labelled sample before trusting any cut point.
