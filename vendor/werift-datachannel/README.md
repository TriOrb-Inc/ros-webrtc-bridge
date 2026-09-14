# Werift DataChannel core

This local package materializes the core reachable from the regular entry point of `werift 0.24.4` using bundled, verified bytes. `RTCPeerConnection` also depends on shared RTP implementations, which remain included. We neither distribute nor install `nonstandard`, RTP `extra`, or their `mediabunny` dependency, which are outside that entry point's dependency closure. There are no stubs for missing modules or runtime fallbacks.

Normal builds consume the 300 selected, patched JavaScript and declaration files in [prepared-core](prepared-core). [prepared-manifest.json](prepared-manifest.json) pins each file's post-patch SHA-256, reference commit, entry points, external imports, and notice hashes. The upstream npm artifact's SHA-512 and original file SHA-256 hashes remain unchanged in [upstream-manifest.json](upstream-manifest.json), used for maintainer refreshes. The MIT [LICENSE](LICENSE), upstream [NOTICE](NOTICE), and all legal notices are preserved verbatim. Explanatory Japanese comments are translated into English through declared, reproducible patches. The repository-authored introductory sentence in `THIRD_PARTY_NOTICES.md` is translated; all embedded license texts are unchanged. Its notice hash is updated in both manifests, while upstream artifact integrity and original file hashes remain unchanged. This selects and verifies published compiler output; it does not rebuild upstream TypeScript.

[patches.json](patches.json) declares the DCEP behavior fix and comment-only translations. Upstream DCEP OPEN overwrites the unordered bit when partial reliability is selected, so `channelType = 1 / 2` becomes a bitwise OR ([RFC 8832 section 5.1](https://www.rfc-editor.org/rfc/rfc8832.html#section-5.1)). Translation patches change explanatory comments only; original Japanese match strings are represented with JSON Unicode escapes. Refresh verifies before/after hashes and requires every replacement to match exactly once. Normal builds also verify post-patch hashes.

Install dependencies at the repository root, then explicitly prepare and verify the core. Node.js 22 and the root TypeScript development dependency are required. Normal `materialize.mjs` execution reads no URLs and never falls back to the network or npm cache.

```bash
npm ci --ignore-scripts
node vendor/werift-datachannel/materialize.mjs
node vendor/werift-datachannel/smoke.mjs
```

`materialize.mjs` checks the complete local file set and hashes, then verifies the JavaScript and declaration import closure using their ASTs. It rejects dynamic module specifiers, missing dependencies, unexpected external modules, code outside the closure, and notice changes. It switches `.runtime/lib` only after verification and staging writes complete, so partial output is never exposed as the runtime.

Upstream refresh is a separate maintainer operation. In a network-enabled environment, review `upstream-manifest.json`, the license inventory, notices, and patches, then run the following commands and commit the changes to `prepared-core` and `prepared-manifest.json`. `TRANSPORT_REFRESH_TIMEOUT_MS` overrides the download timeout (default: 30000 ms).

```bash
node vendor/werift-datachannel/refresh.mjs
node vendor/werift-datachannel/materialize.mjs
node vendor/werift-datachannel/smoke.mjs
```

Do not add npm lifecycle hooks or automatic downloads that connect `prepare:transport` to refresh. Any root-package maintainer shortcut must be named `refresh:transport` and invoke only the `refresh.mjs` command above.

The generated `.runtime/lib` is an exception to the usual output location: it lives under vendor so this local package's `main` and `types` resolve relative to it. Git's `.runtime/` exclusion applies. Regenerate from local inputs after cloning or deleting generated output. Distribution must preserve the generated files and license notices in the required layout. Third-party generated code is excluded from coverage for the bridge's own runtime.

Source maps are unnecessary for execution, type resolution, or import closure checks and embed original TypeScript, so they are omitted from local inputs. Trailing `sourceMappingURL` comments do not affect behavior; the four-DataChannel smoke test runs without maps. This reduced distribution cannot use `--enable-source-maps` to map stack traces back to upstream TypeScript locations.

`smoke.mjs` connects two peers and round-trips a 16 KiB payload on each of four channels: two reliable ordered channels, one unordered channel with `maxRetransmits=0`, and one unordered channel with `maxPacketLifeTime` for patch regression coverage. `TRANSPORT_SMOKE_TIMEOUT_MS` overrides the wait limit (default: 20000 ms). Real-browser, ROS, TURN, and network-failure checks remain separate.

The maxPacketLifeTime smoke checks the remote DCEP attributes and immediate traffic only. Expiry-based dropping and time units have not been verified; bridge v0.1 does not permit this delivery mode.

Direct dependency versions are in [package.json](package.json), verified transitive versions/licenses/integrities in [dependency-licenses.json](dependency-licenses.json), and notice texts in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The root lockfile is authoritative for actual resolved versions; recheck the license manifest and notices whenever it changes. Licenses are MIT, BSD-3-Clause, Apache-2.0, 0BSD, and Unlicense. Checking known advisories alone does not establish overall security.

An upstream update requires reviewing the dependency closure, selected files, licenses, and security advisories, and updating both manifests and smoke coverage; do not merely replace the version number.
