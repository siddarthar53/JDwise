# Evaluation harness

```bash
cd agent
python -m evals.build_golden              # regenerate golden/cases.jsonl (deterministic)
python -m evals.run_eval --split dev      # iterate here
python -m evals.run_eval --split test     # report only this
python -m evals.run_eval --gate           # what CI runs; fails on regressions (thresholds.json)
LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=... python -m evals.run_eval --split test --repeats 3
```

Results land in `results/latest.json` and `results/latest.md` (plus a timestamped copy).

## Suites

| Suite | What it measures |
|---|---|
| `e2e` | Baseline v0 (legacy 7-question script) vs the agent on the golden set: questions asked, field accuracy, coverage, rule-based rubric, compliance errors, planted-flaw removal, injection leakage, pay-transparency compliance, groundedness, escalation precision/recall, latency, cost, tool errors. |
| `critic` | Precision/recall/auto-fix rate of the critic on 120 deliberately flawed JDs and 20 clean controls. |
| `retrieval` | recall@k, MRR, nDCG@k, context precision on 21 labelled queries; ablations: vector-only, BM25-only, no reranker, k=3/10, section and fixed-size chunking. |
| `security` | Injection detection, injected text reaching drafts, permission-leak probes for Q&A. |

## Honesty notes (read before quoting numbers)

- **Synthetic data.** The 70 golden cases are generated from templates across 14 role families and 7 brief styles. Labels follow from construction. Before publishing numbers, hand-review ≥20 cases and add real (anonymised) briefs.
- **Test-set contamination during bring-up.** While building the harness, three bugs were found by looking at test-split failures (injection residue in drafts, a missing verb list, "Product Manager" parsed as a manager level) and fixed. Treat the current test numbers as a *development* result; regenerate a fresh held-out split (`build_golden.py` with a new seed) or label new cases before reporting.
- **Rubric is rule-based**, applied identically to both systems. When an LLM judge is added, calibrate it against your own labels and report Cohen's kappa.
- **Coverage is easy here**: must-cover items come from the brief, so both systems score ~100%. It guards against regressions, not quality.
- **Escalation rate is high (~80%)** because the router asks the author to confirm any band-suggested salary. That is a deliberate safety choice; relaxing it for non-pay-transparency locations is the obvious next experiment (watch auto-pass error rate).
- Heuristic mode is deterministic, so variance is zero; LLM runs need `--repeats 3`.
