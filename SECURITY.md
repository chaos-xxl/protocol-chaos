# Security

A Protocol Chaos repository holds what a person told their assistants about their life. Problems that could expose it, or let one writer change what another wrote, are treated as security problems.

## Reporting

Report privately through GitHub: on the [Security tab](https://github.com/chaos-xxl/protocol-chaos/security), choose **Report a vulnerability**. Do not open a public issue, and do not include real personal data; a reproduction with made-up Events is enough.

You will get an answer within seven days. Once a fix is ready, it is released and the report is published with credit to you, unless you prefer otherwise.

## Scope

- The specification: a rule that would make conforming servers expose data, or let a writer overwrite what another has committed.
- The reference server in [server/](server/README.md) and the `protocol-chaos` package on npm.
- The conformance tests in [conformance/](conformance/README.md).

Other implementations are maintained by their authors; report their problems to them.

## Supported versions

| | Supported |
|---|---|
| Draft 0.2 and `protocol-chaos` 0.2.x | Yes |
| Draft 0.1 and `protocol-chaos` 0.1.0-alpha versions | No |
