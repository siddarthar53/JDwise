# Evaluation report — 2026-10-28T12:16:50

Provider: **heuristic** · split: **test** · prompt version v1.0 · repeats 1

## End-to-end: Baseline v0 vs agent (n=38 cases)

| Metric | Baseline v0 | Agent |
|---|---|---|
| schema_valid_pct | 100.0 | 100.0 |
| questions_per_jd | 7 | 1.421 |
| field_accuracy_pct | 58.3 | 98.7 |
| requirement_coverage_pct | 100.0 | 100.0 |
| rubric_avg_1to5 | 3.56 | 4.909 |
| compliance_errors_per_jd | 1.632 | 0 |
| warnings_per_jd | 0.158 | 0 |
| planted_flaws_remaining_pct | 100.0 | 0.0 |
| injection_leak_pct | 100.0 | 0.0 |
| pay_transparency_compliant_pct | 86.8 | 100.0 |
| groundedness_pct | None | 100.0 |
| invented_qualifications_per_jd | None | 0 |
| escalation_rate_pct | 0.0 | 81.6 |
| escalation_precision_pct | None | 100.0 |
| escalation_recall_pct | 0.0 | 96.9 |
| latency_ms_p50 | 0.0 | 50.7 |
| latency_ms_p95 | 0.0 | 73.9 |
| cost_usd_per_jd | 0.0 | 0.0 |
| tool_error_rate_pct | 0.0 | 0.0 |

### By brief style (agent)

| Style | n | questions | field acc % | coverage % | rubric |
|---|---|---|---|---|---|
| biased | 6 | 1.333 | 97.2 | 100.0 | 4.929 |
| complete | 7 | 0.143 | 97.6 | 100.0 | 4.906 |
| contradictory | 6 | 0.333 | 97.2 | 100.0 | 4.955 |
| injection | 3 | 1 | 100.0 | 100.0 | 4.915 |
| pasted | 5 | 1.4 | 100.0 | 100.0 | 4.85 |
| slack | 5 | 2.4 | 100.0 | 100.0 | 4.912 |
| terse | 6 | 3.5 | 100.0 | 100.0 | 4.892 |

## Critic defect detection

Overall precision 100.0%, recall 100.0%, false alarms on clean controls 0.0% (120 flawed / 20 clean JDs).

| Rule | Precision % | Recall % | Auto-fix % |
|---|---|---|---|
| R-INCLUSIVE | 100.0 | 100.0 | 100.0 |
| R-LEVEL-YEARS | 100.0 | 100.0 | 100.0 |
| R-PAY-MISSING | 100.0 | 100.0 | 0.0 |
| R-VAGUE | 100.0 | 100.0 | 100.0 |
| R-STACK-SKILLS | 100.0 | 100.0 | 100.0 |
| R-STACK-IMPOSSIBLE | 100.0 | 100.0 | 100.0 |

## Retrieval (21 labelled queries)

| Config | recall@k | MRR | nDCG@k | context precision | p95 ms |
|---|---|---|---|---|---|
| hybrid + reranker, k=5, bullet chunks (default) | 1.0 | 0.952 | 0.951 | 0.81 | 3.3 |
| vector_only | 1.0 | 0.952 | 0.955 | 0.829 | 1.9 |
| bm25_only | 0.976 | 0.952 | 0.942 | 0.81 | 1.8 |
| hybrid_no_reranker | 0.929 | 0.937 | 0.902 | 0.752 | 1.2 |
| k=3 | 0.976 | 0.952 | 0.936 | 0.921 | 2.3 |
| k=10 | 1.0 | 0.952 | 0.958 | 0.714 | 3.7 |
| chunking=section | 0.976 | 0.976 | 0.955 | 0.733 | 1.8 |
| chunking=fixed_60_words | 0.976 | 0.952 | 0.948 | 0.524 | 1.8 |

## Security

- Injection detection on the injection suite: 100.0%
- Injected text reaching the draft: 0 / 8 cases
- Permission leaks: 0 / 5 probes
- No agent tool can change approval state; that guarantee is structural (see app/tools.py), not measured here.

## How to read this

- Golden cases are synthetic (see `evals/build_golden.py`); labels follow from construction. Hand-review a subset before quoting numbers externally.
- The rubric is the deterministic rule-based rubric, applied identically to both systems — not an LLM judge.
- Baseline v0 is the legacy 7-question script answered truthfully by a simulated author; it has no retrieval, checks or salary lookup.
- In heuristic mode results are deterministic (zero run-to-run variance). With an LLM provider use `--repeats 3` and report the spread.
