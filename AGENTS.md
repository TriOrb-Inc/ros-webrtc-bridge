# AGENTS Guide

This repository provides the following additional guidance for agents. Read [CONTRIBUTING.md](CONTRIBUTING.md) first; it is the canonical source of shared development rules.

## First Read Checklist

- Before starting work, read `CONTRIBUTING.md`, [README.md](README.md), and documentation relevant to the change.
- [docs/design.md](docs/design.md) is the design source of truth. Check section 14 for implemented and connection-tested scope; do not present proposed APIs or untested environments as supported.
- For test-related work, read [TESTS.md](TESTS.md) and decide the acceptance criteria and required test layers before implementation.
- Check whether an existing location can represent the content before adding top-level documents or directories.
- If a terminology glossary is added, use its preferred English terms.

## Sub-Agent Operating Model

Use planning, development, and QA teams by default. Do not add agents solely for small tasks that cannot proceed independently.

- **Team 1: Planning and coordination** — Start here for large, ambiguous, or cross-cutting tasks. Define scope, dependencies, file ownership, and completion criteria, and integrate deliverables. The parent agent may serve this role.
- **Team 2: Development** — Implement code and documentation within explicit ownership boundaries. Avoid concurrent edits to the same files; coordinate serial changes when needed.
- **Team 3: QA** — Independently review requirements, important behavior, edge cases, and regression risks. Validate after implementation and report unresolved risks, unverified areas, and user-facing impact.
- Keep handoffs bounded and specify the purpose, inputs, editable files, expected deliverables, and validation criteria.
- Surface blockers and limitations with their current impact and recommended next action.

Keep this section consistent with actual agent configuration when adding or changing it. Do not assume unavailable settings, roles, or concurrency limits.

## Working Principles

- Before nontrivial changes, identify purpose, dependencies, key risks, affected files, and validation methods.
- Independent investigation, generation, and validation may run in parallel. Assign ownership and serialize changes to the same file.
- Do not overwrite unexpected local changes or other contributors' work.
- Record rationale, assumptions, and constraints needed by users and developers in related public documentation or code comments. Keep migration history, investigation logs, and working notes in `.runtime/`.
- Make tunable rates, queue capacities, payload limits, timeouts, and leases configurable through files or environment variables; document defaults and overrides.
- Do not add fallbacks that hide symptoms. Prioritize root causes and shared rules. Record the purpose and removal criteria for temporary diagnostic workarounds.

## Project Boundaries

- Configure public Topics, ROS types, directions, QoS, and delivery modes declaratively; do not add individual handlers per Topic.
- Separate `RosAdapter`, schemas/codecs, sessions/authorization, WebRTC transport, and signaling. Keep mock and real ROS interfaces aligned.
- Do not conflate DDS QoS with DataChannel delivery characteristics or treat ROS publication success as controller completion.
- Update related schemas, SDKs, examples, and documentation together when changing protocols, conversions, authorization, queues, or reconnect contracts. Create missing artifacts during implementation.
- Never replay old commands after reconnect. Document the scope of deadline, epoch, and ownership validation and the controller's responsibilities.
- Base performance, browser compatibility, and ROS distribution support claims on actual validation results.

## Documentation And Tooling

- Distinguish the current state, goals, and open questions in specifications and proposals.
- Write maintained documentation, code comments, new PR bodies, and review replies in English unless explicitly instructed otherwise. Historical PR text and commit messages do not need translation.
- Do not interpolate multiline PR bodies or comments into shell arguments. Use structured tool arguments or a body file with `--body-file` to prevent accidental execution of backticks or `$()`.
- Render new or changed SVGs and check text overflow, overlap, and legibility of lines and text.
- For documentation work before implementation, verify links, example syntax, and consistency across designs. Do not report nonexistent build/test commands as executed.

## Security And Dependencies

- Never commit secrets, including dummy values, or include them in sub-agent prompts. Configuration examples should use environment variable names or explain how to reference values.
- Validate external inputs, network values, configuration, and environment variables at boundaries. Check types, directions, session ownership, and sizes.
- Follow the license policy in `CONTRIBUTING.md` for new dependencies. Check rationale, transitive dependencies, and distribution impact.
- See [SECURITY.md](SECURITY.md) for the security policy.

## Completion Checklist

- Follow shared rules and file ownership, and keep related documentation, examples, and specifications synchronized.
- Complete validation appropriate to the change and identify unperformed checks and their reasons.
- Follow `TESTS.md`; distinguish failures, skips, and unperformed required checks. Do not substitute coverage for real ROS or browser validation.
- Keep evidence and limitations needed for future decisions in the appropriate public specifications or private working notes.
- Do not include unnecessary temporary files or secrets in deliverables.

## Operational Know-How

- Store temporary investigation results and output in `.runtime/`, excluded from version control.
- Record reference repositories and commits in `.runtime/` when investigating them. Distinguish local checkouts from current remote contents.
- Record detours, recurring causes, and investigations in `.runtime/`. Move only information needed as public development guidance into related documentation.
- Do not link public documentation to individual `.runtime/` notes. A Git clone must contain everything needed to understand the specifications and rules.
