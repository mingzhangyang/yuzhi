# Architecture v2 Completion Record

**Status:** Completed  
**Completed:** 2026-10-04  
**Operating state after completion:** Maintenance / evolution

## Completion statement

Architecture v2 is complete. Phase 0–5 and implementation Batch A–D have been delivered and accepted. This record closes the architecture-adjustment plan as a finite body of work.

The completed plan remains a historical design baseline and a source of long-lived invariants. It is **not** an evergreen backlog. Future structural work must start a new RFC or architecture plan rather than adding Phase 6, Batch E, or similar continuation labels to this plan.

## Final acceptance evidence

| Evidence | Final result |
|---|---|
| Final acceptance PR | [PR #10 — docs: complete Batch D final architecture audit](https://github.com/mingzhangyang/yuzhi/pull/10) |
| PR #10 merge commit | `73c7b7d31882429cfdbb083f189eb442d460f799` |
| Accepted PR head | `6386d612574370498687c944ce6f389090d41ba7` |
| Main CI | CI #55 — success |
| Real-browser lifecycle validation | Browser lifecycle smoke #23 — success |
| Unresolved inline review threads at final acceptance | 0 |
| Final Copilot review | Approval recommended; documentation matched the tested architecture and current-head CI/browser checks passed |

The ordinary CI result is tied to the accepted head. Browser evidence follows the executable trigger-surface contract in `.github/workflows/browser-lifecycle.yml`; later changes that hit that surface require fresh browser validation.

## Scope completed

- **Phase 0 — Migration foundation:** version separation, migration pipeline, compatibility fixtures, failure-safe upgrade behavior.
- **Phase 1 — Operation facts:** operation facts and globally ordered fact sequencing.
- **Phase 2 — Derived-state removal:** settlement consequences derived from facts/read models rather than duplicated writable state.
- **Phase 3 — Atomic batch:** transactional user actions, rollback, flush-generation semantics, replacement barriers and queue invariants.
- **Phase 4 — Single-writer tabs and lifecycle:** Web Locks ownership, reader/writer handoff, AppSession orchestration, versionchange handling and real Chrome BFCache/multi-tab validation.
- **Phase 5 — Structural cleanup:** legacy business collections retired from the current model, action implementations split by domain, composition-only public action barrel and architecture boundary tests.
- **Batch A–D:** lifecycle consolidation, browser acceptance, domain action extraction and final cross-check.

## Long-lived architecture invariants

The completion of the plan does not retire its constraints. The project continues to preserve these rules:

1. **A fact is stored once.** Derived state is recomputed instead of maintained as a second writable truth.
2. **A user action is atomic.** It either commits completely or fails completely.
3. **Old data has an explicit upgrade path.** Compatibility semantics are not removed merely because a name looks legacy.
4. **Write authority has one source.** The coordinator owns writer authority; a session becomes writable only after the required durable refresh/recovery boundary.
5. **Stale asynchronous work cannot revive old authority.** Revision/generation boundaries invalidate results produced under obsolete ownership or lifecycle state.
6. **The public action barrel is composition-only.** Domain modules do not depend back on the public barrel.
7. **Platform lifecycle behavior is validated in a real browser.** Unit tests do not substitute for the required browser boundary checks.

Detailed rationale, implementation history and validation rules remain in [`架构调整方案.md`](架构调整方案.md).

## Repository marker

The canonical Git marker for this milestone is:

```text
architecture-v2-complete
```

It must point to the `master` commit that contains this completion record. That tag defines the exact repository state at which Architecture v2 was formally closed.

## What happens next

The project is now in **maintenance / evolution mode**:

- normal product work proceeds against the completed architecture;
- maintenance fixes preserve the invariants above;
- a materially new architecture direction starts a new RFC / architecture plan;
- this completed plan is referenced as a baseline instead of being reopened or extended.
