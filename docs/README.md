# CityShield docs

Everything that explains the project but is not code. Start with the root
[README](../README.md) for what CityShield is, and with the
[specification](specification.md) for how it behaves. The specification is the
reference: code comments cite it by section (`docs/specification.md §1.7`), so
keep its section numbers stable.

## Coming back to the project

Read these in order:

1. [timeline.md](timeline.md): what happened and when, on one page.
2. [glossary.md](glossary.md): the Bulgarian place words and the project's own
   terms (tick, burst, A1–A15, F1–F21).
3. [todo.md](todo.md): what is left before a Play Store release.
4. [open-questions.md](open-questions.md): what is undecided or unmeasured.

## Reference

| Document | Holds |
|---|---|
| [specification.md](specification.md) | The system as built, and why: data model, API, alert service, ingestion, polygons, GDPR, operations. Cited by section from the code |
| [design-decisions.md](design-decisions.md) | Each decision, why it was made, and what was rejected. Read before "simplifying" something |
| [findings.md](findings.md) | Facts measured about the outside world: OSM, Nominatim, the sources, the Cloudflare platform. Includes the dead ends not worth retrying |
| [incidents.md](incidents.md) | Every production incident: symptom, cause, fix, lesson |
| [troubleshooting.md](troubleshooting.md) | Symptom → cause → what to do. The first page to open when something looks wrong |
| [runbook.md](runbook.md) | Step-by-step procedures: deploy, reseed, check ingest health, run a review |
| [working-practices.md](working-practices.md) | How work is done here, and the mistakes behind each habit |
| [accuracy.md](accuracy.md) | The August 2026 notification-accuracy pass: diagnosis (Part I), fixes F1–F21 (Part II) |
| [compliance.md](compliance.md) | GDPR record: Play Data Safety answers, DPIA/DPO reasoning, breach runbook |
| [legal.md](legal.md) | Pre-release legal research: minors, liability, republishing the sources, Play policies, OSM, with the law quoted and the questions for a lawyer |
| [todo.md](todo.md) | Remaining work; §7 is the operator's account and credential checklist, §8 the legal gaps, §9 resilience |

## Docs that live next to their code

These stay where they are, because they describe one directory:

| Document | Holds |
|---|---|
| [AGENTS.md](../AGENTS.md) | The short brief for coding agents: layout, commands, rules that look like bugs |
| [frontend/SETUP.md](../frontend/SETUP.md) | Android toolchain, building the app, app-side troubleshooting |
| [backend/spikes/RESULTS.md](../backend/spikes/RESULTS.md) | Phase 0 spike results (July 2026): edge fetch, model choice, JSTS |
| [tools/osm-seed-builder/README.md](../tools/osm-seed-builder/README.md) | Building the regions/streets seed from OSM; the self-hosted Overpass |
| [tools/alert-review/README.md](../tools/alert-review/README.md) | Judging stored alerts; its `reports/` hold each review run |
| [tools/polygon-tester/README.md](../tools/polygon-tester/README.md) | Drawing every stage of the block-polygon builder |
| [tools/push-tester/README.md](../tools/push-tester/README.md) | End-to-end push delivery tests |

## Keeping these current

- A behaviour change updates **[specification.md](specification.md)** in the
  same commit. The other docs link to it rather than repeat it, so most changes
  touch nothing else here.
- A new incident gets an entry in [incidents.md](incidents.md) and, if it can
  recur, a row in [troubleshooting.md](troubleshooting.md).
- A decision that someone could plausibly undo by accident goes in
  [design-decisions.md](design-decisions.md), together with what it rules out.
- A retracted claim is removed from every doc that repeats it. See
  [working-practices.md](working-practices.md).
