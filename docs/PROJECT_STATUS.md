# Project 1 — PriorAuth Copilot

**Status: CLOSED · COMPLETE**  
**Closed:** July 9, 2026  
**Owner:** Abhi Sorari

---

## Definition of done — all criteria met

| Criterion | Status | Evidence |
|-----------|--------|----------|
| Live deployed demo | ✅ | [priorauth-copilot-swart.vercel.app](https://priorauth-copilot-swart.vercel.app/) |
| Honest preset replays (real citations, no fake traces) | ✅ | 5 scenarios keyless; `data/presetDemoResults.json` from verified Supabase runs |
| Golden eval suite | ✅ | 31 cases in `data/goldenCases.json` (26 clean + 3 messy-prose + 1 prefixed-code + 1 vial-units) |
| Post-optimization regression gate | ✅ | **100 / 0 / 100** — [`evals/results/2026-07-10T02-38-26-825Z.json`](../evals/results/2026-07-10T02-38-26-825Z.json) |
| CI eval gate green | ✅ | [workflow_dispatch run 29065131002](https://github.com/asorari09/priorauth-copilot/actions/runs/29065131002) |
| Measured cost reduction | ✅ | ~$0.041 → ~$0.003 approve / ~$0.006 deny (~90%); Langfuse trace `88046535-fa61-47e5-bdf3-5ecb9e9aa476` |
| Observability | ✅ | [Langfuse project](https://cloud.langfuse.com/project/cmrdrenon00chad0c3bi1gcoe) · [`langfuse-post-optimization.png`](langfuse-post-optimization.png) |
| Documentation | ✅ | [README](../README.md) · [Deep dive](PROJECT_DEEP_DIVE.md) · [Blueprint](blueprint.md) · [Migrations](MIGRATIONS.md) |
| Supabase schema | ✅ | `policy_chunks`, `cases`, `citation_cache` + `match_policy_chunks` RPC |
| GitHub mirror | ✅ | [asorari09/priorauth-copilot](https://github.com/asorari09/priorauth-copilot) — `main` synced |

---

## Resume bullet (verified, shippable)

> Cut per-case inference cost from **~$0.041** to **~$0.003** approve / **~$0.006** deny (**~92% / ~86%** reduction) at unchanged **26/26** eval accuracy via model routing, payload trimming, template reasoning, and inference caching.

---

## Deferred to future work (out of scope for Project 1)

- FHIR / CMS-0057-F structured intake
- PHI-compliant production infrastructure (BAAs, audit logging)
- OAuth / multi-tenancy replacing demo-key gate
- Sub-10s latency optimization for production triage

---

*Project 1 is closed. No further work required unless starting a new initiative on this codebase.*
