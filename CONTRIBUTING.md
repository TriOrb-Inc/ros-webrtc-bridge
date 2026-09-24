# Contributing

This file defines the shared rules for human and agent contributors. Follow them when changing code or documentation, adding dependencies, and validating changes. It also defines design principles specific to the ROS 2 / WebRTC DataChannel Bridge.

## Base Standard

- This `CONTRIBUTING.md` is the canonical source of shared rules.
- `AGENTS.md` provides additional guidance for agents.
- Keep rules specific to a package or directory in a nearby `AGENTS.md` or `README`.
- When rules conflict, prefer the more specific rules in the target directory over this general document.

## Development Workflow

1. Identify affected packages, configuration, documentation, interfaces, and operating procedures before making changes.
2. For nontrivial changes, define work boundaries, dependencies, primary risks, and required validation before implementation.
3. When possible, prepare a failing reproduction test or a way to check expected behavior before fixing a bug or adding a feature.
4. Update related `README` files and `docs/` in the same change when behavior, configuration, APIs, UI, or other external interfaces change.
5. Clearly distinguish the current state from goals in specifications and proposals.
6. Record rationale, constraints, and caveats needed by users and developers in public documentation or code comments, not only in PR comments. Store migration history, investigation logs, and working notes in `.runtime/`.
7. Make exploration, evaluation, and tuning parameters (thresholds, weights, limits, guard conditions, and similar values) overridable at runtime through configuration files or environment variables by default. Do not edit source constants for each experiment. If defaults remain in source, document overrides and their precedence.

## Project-Specific Principles

This open-source project bridges ROS 2 Topic Pub/Sub and WebRTC DataChannels through configuration. It is currently a proof of concept connecting real ROS and browsers. Read the [design document](docs/design.md) and distinguish implemented and validated behavior from missing features and hardware or performance checks that have not been performed.

- Consider whether declarative configuration can support a feature before adding Topic-specific implementations. `bridge.yaml` is the configuration source of truth; its schema must agree with the public catalog.
- Separate ROS adapters, type schemas/codecs, sessions/authorization/queues, WebRTC transport, and signaling.
- Keep the system testable with a mock adapter, and keep the mock and rclnodejs adapters' public interfaces consistent.
- Validate ROS QoS and DataChannel delivery settings independently. Reliable DataChannels alone do not recover losses on the ROS side.
- Deny Topic, type, and direction permissions by default. Do not expose unconfigured Topics or arbitrary client-specified ROS types.
- Validate and convert both directions according to ROS type schemas. Do not infer numbers from ordinary strings or introduce mapping DSLs that permit arbitrary code execution.
- Bound per-peer queues, payloads, send buffers, and rates. Do not block ROS callbacks while waiting for WebRTC sends.
- Create a new session/epoch on reconnect and never replay old commands. Revalidate command leases, sequences, ownership, and types immediately before ROS publication.
- Bridge command validation and controller watchdog/deadline checks are separate responsibilities. A publish acknowledgment does not mean controller completion or guarantee exactly-once delivery.
- The initial scope is Topic Pub/Sub. Update the design and scope before adding Services, Actions, Parameters, MediaTracks, or similar features.
- When changing configuration, DataChannel protocols, public schemas, or SDK contracts, update the corresponding design, existing schemas, configuration examples, and SDK documentation in the same change. Create missing artifacts when implementing the feature.
- Prefer evaluating the permissively licensed `werift` for WebRTC transport. Do not adopt `node-datachannel` / `libdatachannel`, which use MPL-2.0, under the no-copyleft policy below. Check selected versions and transitive dependencies.

## Local Checks

Use Node.js 22 (22.12 or later; validated with 22.22.2). Dependencies are pinned by the lockfile.

```bash
npm ci --ignore-scripts
npm run prepare:transport
npm run build
npm run typecheck
npm run test:packaging:contract
npm run test:transport:media
npm run test:performance
```

The build removes the previous `.runtime/build/` and regenerates TypeScript output and source maps. `node_modules/` stays at the repository root for standard npm resolution and is excluded from Git. Linting is not yet configured. [CI](.github/workflows/ci.yml) runs when PRs are opened or reopened and when commits are pushed to PR branches. See [TESTS.md](TESTS.md) for test commands and their guarantees.

Deployments that configure `video_tracks` additionally need GStreamer and the elements their selected encoder backend uses, installed on the host. Nothing from GStreamer is bundled or linked; a missing element fails startup with an actionable message. Runtime dependencies are `yaml 2.9.0` (ISC), `rclnodejs 2.2.0` (Apache-2.0), `swagger-ui-dist 5.32.15` (Apache-2.0) for HTTP documentation, and the [local Werift core package](vendor/werift-datachannel/README.md) (MIT). Swagger UI's transitive dependency `@scarf/scarf 1.4.0` is also Apache-2.0. The standard `npm ci --ignore-scripts` does not execute its installation telemetry. Swagger UI loads only the distributed CSS/JavaScript assets and does not import this helper at runtime. Run rclnodejs installation and type generation explicitly in a ROS environment; ROS-independent unit tests do not load native bindings. Preserve the [additional ref-napi notices](vendor/rclnodejs-notices/README.md) in distributions.

When changing ROS packaging, source the target distribution and run `npm rebuild rclnodejs --foreground-scripts`, then validate `colcon build`, `colcon test`, and installed `ros2 run` / `ros2 launch` commands. See [ROS packaging](docs/ros-packaging.md) for prerequisites for isolated Humble/Jazzy validation with `npm run test:packaging`, CMake options, and dynamic ROS interface dependencies.

The normal `npm run prepare:transport` verifies only the bundled core and does not access the network. Only maintainers updating dependencies should explicitly run `npm run refresh:transport` to download upstream artifacts and update the prepared tree. Review licenses, notices, individual hashes, the dependency closure, and before/after patch hashes together. See the [performance harness](tests/performance/README.md) for performance and soak settings and overrides.

Development dependencies are `typescript 5.9.3` (Apache-2.0), `@types/node 22.20.2` (MIT), `c8 12.0.0` (ISC), and `playwright-core 1.63.0` (Apache-2.0). Transitive lockfile dependencies use permissive licenses such as MIT, ISC, BSD, Apache-2.0, 0BSD, Unlicense, and [BlueOak-1.0.0](https://blueoakcouncil.org/license/1.0.0). Include each dependency's license notices when distributing it.

CI uses the external Actions `actions/checkout` and `actions/setup-node`, pinned by version and commit SHA in workflows. Use versions whose MIT license and bundled permissive licenses have been checked, and recheck transitive dependencies and notices on updates.

For documentation changes, verify links, referenced files and commands, terminology, and consistency with the design. Also check the Git diff:

```bash
git diff --check
git diff --stat
```

Untracked new files do not appear in `git diff`, so check `git status --short` and their contents as well. Documentation-only changes do not require execution tests or code coverage measurement.

When adding implementation, document the applicable build/lint commands here and test commands and environment requirements in [TESTS.md](TESTS.md). Report completed and unperformed checks, including real ROS, browser, TURN, and communication-failure scenarios.

## Temporary Files

- Unless there is a reason otherwise, place temporary development, validation, and debugging files (experimental output, logs, build intermediates, scratch files, and validation artifacts) in `.runtime/` at the repository root.
- Exclude `.runtime/` from version control through `.gitignore`. Do not put artifacts that should be committed there.
- Keep private working notes, reference-repository investigations, source commits, and migration history in `.runtime/`. Do not mix working logs into READMEs or public specifications.
- Git does not distribute `.runtime/`. Create it with `mkdir -p .runtime` when needed in a new checkout. Public documentation must not depend on its contents.
- If a tool's fixed output path or another constraint requires temporary files elsewhere, record the reason in the PR or related documentation and update `.gitignore` as needed.

## File Size Limits

- **More than 1,000 lines**: splitting the file is recommended.
- **More than 2,000 lines**: splitting is strongly recommended.
- **More than 4,000 lines**: splitting is required unless there is an exceptional reason.
- Count effective lines, excluding comment-only and blank lines. Code lines with inline comments count as code.

## Directory Layout Limits

### Program file count per directory

Count program source files such as `.rs`, `.cpp`, `.hpp`, `.h`, `.cc`, `.cxx`, `.py`, `.ts`, and `.tsx`. Do not count documentation (`.md`), subdirectories, or configuration files such as `Cargo.toml`, `CMakeLists.txt`, and `package.json`.

- **7 or more files**: grouping related modules in a subdirectory named after the parent module is recommended.
- **13 or more files**: subdirectory organization is strongly recommended.
- **25 or more files**: subdirectory organization is required unless there is an exceptional reason.

### Using subdirectories

- When splitting a parent module, create a **subdirectory named after the parent** and place its submodules there.
  - Rust: split `foo.rs` into `foo/bar.rs` and `foo/baz.rs`, retaining the parent `.rs` file (Option A), or use `foo/mod.rs` (Option B).
  - C++: split `foo.cpp` into `foo/bar.cpp` and `foo/baz.cpp`.
- **Avoid flat layouts at a package's source root (`src/`).**
- Place sidecar `.md` files next to the corresponding source, including within subdirectories.

## Implementation Quality Rules

- Keep functions and files small enough for their responsibilities to remain clear; consider splitting them when they grow.
- Avoid excessive nesting. Prefer early returns and extracted helpers where they improve readability.
- Make failure handling explicit for external inputs and fallible operations. Do not silently swallow failures.
- Make assumptions, units, timing constraints, and ownership visible in code when users could otherwise misunderstand them.

## Standard Output Rules

- These rules apply to every program in the repository, including long-running processes, CLIs, utilities, tests, and evaluation or validation scripts.
- Apply these rules to existing programs/scripts when changing that file for a feature, bug fix, refactoring, added validation, or similar work. A repository-wide rewrite solely to enforce output rules is not required.
- After execution starts, write progress or status to standard output at least once every `5` seconds.
- If an operation inherently cannot produce output within `5` seconds, print a note immediately before it explaining the operation, why it may be silent, and its expected duration.
- Treat more than `10` seconds without output as abnormal unless preceded by that note. Where possible, programs should detect timeouts or stalls and fail themselves rather than relying only on monitoring wrappers.
- Divide external-command waits, service waits, polling, and long initialization into short, timed intervals and report their state.
- Do not wait indefinitely when work can be divided into intervals. Set timeouts and report a useful cause before exiting on timeout.

## Input Validation And Security Rules

- Validate file inputs, environment variables, network values, UI input, and values from external libraries at boundaries.
- Explicitly reject `nullptr`, out-of-range values, inconsistent enumerations, nonexistent paths, empty strings, excessive payloads, and similar invalid values where appropriate.
- Avoid disclosing excessive internal details in user-facing errors; retain enough context in developer logs to investigate failures.
- Never hard-code secrets such as API keys, tokens, passwords, or private keys. Use environment variables or another secure configuration mechanism.

## Comment Rules

- Write sufficient comments. Function documentation is required.
- Function documentation must include at least its purpose, arguments, return value, and expected input/output examples.
- Explain the purpose or intent of each processing block.
- Prioritize why the code is necessary, assumptions, failure handling, units, and ownership over restating what the code visibly does.
- Do not write five or more consecutive meaningful code lines without an explanatory comment.
- Write explanatory comments, documentation comments, docstrings, and JSDoc in English.
- Preserve official specification names, identifiers, protocol names, type names, API names, and SPDX identifiers. Keep license and copyright notices accurate. Multilingual test data may use explicit Unicode escapes to retain its original test meaning.

## Testing Rules

This section defines common quality standards. [TESTS.md](TESTS.md) defines test layers, acceptance criteria, measurement methods, and CI/release gates. Put feature specifications in [docs/design.md](docs/design.md); do not change specifications only through test documentation.

- Choose an automated test framework appropriate to the language and existing architecture.
- Where possible, cover normal behavior, failures, and boundary values at function level for new or changed implementations.
- Add a fixed reproduction test or validation procedure for bug fixes where possible.
- Prefer writing tests first when expected behavior can be specified in advance.
- Implementation requires **100% C0 and C1 coverage**. Documentation-only changes are excluded. Document measurement tools, scope, and exclusions; do not claim unmeasured coverage as achieved.
- Code that can only execute against host hardware - currently the GStreamer encoder backends - is
  outside the CI coverage gate, because a runner cannot exercise it. Such code must be isolated
  behind an injected interface so everything around it stays measurable, and it must be verified on
  real hardware with the evidence recorded. Do not measure coverage inside third-party runtimes such
  as GStreamer. An unexecuted hardware check is reported as `not run`, never as passing.
- MC/DC coverage is not required in this repository.

## License And Dependency Rules

- Do not introduce copyleft dependencies such as GPL, LGPL, AGPL, or MPL-2.0. Check direct and transitive dependencies and distributed artifacts.
- This rule governs what this project distributes. Host runtime dependencies that are neither bundled
  nor linked into a distributed artifact - the OS, ROS, and GStreamer - are outside it, exactly as ROS
  itself is. Never bundle or statically link them, and never make one a build-time requirement of the
  core package. A host that cannot provide a selected component is an error, not a reason to fall back.
- Even as a host dependency, do not make a GPL component part of a default, documented, or tested
  path. The H.264 encoder backends are selected explicitly for this reason: `openh264` is offered,
  `x264` is not. Upstream openh264 is BSD-2-Clause; its Debian packaging carries a small MPL-2.0
  component (`module/task_utils*`), which stays outside this rule while openh264 remains a host
  dependency this project neither bundles nor links.
- Prefer permissive licenses such as Apache-2.0, MIT, and BSD for new dependencies.
- Do not adopt dependencies with unknown licenses until their terms are verified.
- Explain the selection rationale, license, security implications, and distribution/operational impact of new dependencies in the PR or related documentation.

## Documentation

- Write maintained documentation, descriptions, new PR bodies, and review replies in English. If a glossary such as `docs/terminology.md` exists, use its preferred terms. Historical PR text and commit messages do not need to be rewritten.
- Require an adjacent sidecar `*.md` for Rust/TypeScript source files of at least 300 lines, and for C++ files when same-stem `cpp` / `hpp` / `h` / `cc` / `cxx` files in one directory total at least 300 lines.
- Sidecars must cover at least **Purpose**, **Scope**, **Current State**, **Implementation Decisions**, **Goals**, and **Related Resources**, explaining responsibilities and module boundaries that are hard to follow from source alone.
- Update existing sidecars in the same change as their corresponding source files.
- Diagrams in sidecars must be self-contained in one file using Mermaid, inline HTML SVG, or inline HTML base64.
- Distinguish the current state from goals in Markdown specifications and proposals.
- Update related READMEs when external interfaces or UI specifications change.
- Keep design assumptions, constraints, and operating guidance required to understand or maintain public specifications in existing `docs/` or related READMEs. Keep investigation history and working notes separate in `.runtime/`.
- Use English for new or updated GitHub PR descriptions unless explicitly instructed otherwise; do not rewrite historical PRs solely to translate them.
- Before adding top-level documents or directories, check whether an existing location can represent the content.
