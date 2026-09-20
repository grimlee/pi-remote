# Contributing to Pi Remote

Thanks for trying Pi Remote.

The project is still young, so **bug reports, UX feedback, testing, documentation fixes, and small focused pull requests are all useful**. You do not need to be a Swift expert to contribute.

## Before opening an issue

Please include enough context to reproduce the behavior:

- Host OS and architecture.
- Pi Agent version.
- iOS version.
- Whether you are using Quick Connect (Tailcat) or the public Relay/Cloudflare path.
- What you expected.
- What happened instead.
- The smallest reproducible sequence you can find.

For UI issues, a screenshot or short screen recording is often more useful than a long description.

For transport/reconnect issues, the Host launcher writes diagnostics under:

~~~text
.runtime/
~~~

Do **not** post raw logs before checking them for sensitive local information.

## Please do not share

Never include these in a public issue or discussion:

- pairing QR payloads;
- Tailcat addresses or private keys;
- private session JSONL files;
- provider/API credentials;
- browser cookies;
- SSH keys;
- MCP credentials;
- private filesystem contents.

## Pull requests

Focused changes are easier to review than broad rewrites.

For Host/Relay work, please run:

~~~bash
npm --prefix host test
npm --prefix relay test
npm --prefix host run typecheck
npm --prefix relay run typecheck
~~~

For PiRemoteCore:

~~~bash
cd ios/PiRemoteCore
swift test
~~~

The repository GitHub Actions workflow performs the full iOS build and packages the unsigned sideload IPA.

## Product direction

Pi Remote is a general-purpose remote workspace for Pi Agent, not a terminal-first coding client.

Changes should generally preserve these principles:

- Pi and tools execute on the Host.
- The phone stays session/conversation oriented.
- Network details stay out of the normal UX.
- Host/Pi state remains authoritative.
- Security and device identity are independent from the chosen transport underlay.
- UI simplicity is preferred over exposing implementation details.

If an idea changes one of those assumptions, opening an issue/discussion before a large implementation is usually best.
