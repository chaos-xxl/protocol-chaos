# Contributing to Protocol Chaos

Thank you for helping. Protocol Chaos is a young protocol, and what it needs most is evidence from real use: cases where it fits, cases where it does not, and implementations that test whether the specification is enough on its own.

## Ways to contribute

| You have | Where it goes |
|---|---|
| A question, or an idea not yet worked out | [Discussions](https://github.com/chaos-xxl/protocol-chaos/discussions) |
| A case from real use the protocol handles badly | A [specification proposal](https://github.com/chaos-xxl/protocol-chaos/issues/new?template=spec_proposal.yml) |
| A bug in the reference server or the conformance tests | A [bug report](https://github.com/chaos-xxl/protocol-chaos/issues/new?template=bug_report.yml) |
| An implementation, in any language | Tell us in [Discussions](https://github.com/chaos-xxl/protocol-chaos/discussions), with its conformance results |
| A security problem | A private report, as [SECURITY.md](SECURITY.md) describes. Never a public issue. |

Never paste the contents of your own repository into an issue: it holds what you told your assistants. Reduce a problem to made-up Events first.

## What belongs in the specification

The specification holds only what two implementations must agree on to work with each other: the shape of Events and Entities, how words are kept, how writers change Events without overwriting one another, how a repository is moved. How a client finds the Events a conversation is about, how it ranks or presents them, and when it tidies up, are left to implementations, and so are storage, matching and models.

A change is judged by three questions:

1. **Interoperability.** Would two implementations fail to work together without it?
2. **Evidence.** Which real case shows it is needed? Fields and relations that no case uses are removed, not added (PROTOCOL.md, Appendix A).
3. **Simplicity.** Is it the smallest rule that solves the case, written so that a server can be tested against it?

## Proposing a change to the specification

1. Open a [specification proposal](https://github.com/chaos-xxl/protocol-chaos/issues/new?template=spec_proposal.yml) with the case: what the user said, what the assistants did, and where the protocol fell short.
2. Once the direction is agreed in the issue, open a pull request that changes [PROTOCOL.md](PROTOCOL.md) and, for every new or changed requirement on servers, adds or updates a test in [conformance/](conformance/README.md). A requirement without a test is not accepted.
3. Update the reference server so that it still passes every test, and add an entry to [CHANGELOG.md](CHANGELOG.md).

The specification is written in plain English. The words MUST, SHOULD and MAY are used in capitals only when they are normative (RFC 2119, RFC 8174). Each rule names its section, and each error names its code.

## How decisions are made

The specification is maintained by its author, [@chaos-xxl](https://github.com/chaos-xxl). Proposals are discussed in their issues and decided by the three questions above, and the decision and its reason are written in the issue before it is closed. Changes are released as new drafts; the [changelog](CHANGELOG.md) lists what each one changed.

## Working on the code

```sh
npm ci
npm test        # the reference server's storage tests, then every conformance test against it
```

- Node.js 20 or later. Plain JavaScript modules, no build step.
- No new dependencies without a discussion first. The reference server depends only on the MCP SDK.
- Messages returned by the server are written for agents: they say what was wrong and how to fix the call, and are never logged.
- Keep the reference server small. It exists to show that the specification is enough, and to check other implementations against; features that are not in the specification belong in other implementations.

## Pull requests

- One change per pull request, with a description of the case behind it.
- `npm test` passes; the continuous integration runs it on Node.js 20, 22 and 24.
- By contributing, you agree that your contribution is licensed under the [Apache License 2.0](LICENSE), as section 5 of the license describes.

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).
