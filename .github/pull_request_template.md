## What and why

<!-- What does this change, and what problem does it solve? Link the issue if there is one. -->

## How it was tested

<!-- e.g. "npm test", plus anything you checked by hand in the Extension Development Host. -->

## Checklist

- [ ] `npm run check` and `npm test` pass
- [ ] New behavior has tests (new providers, LLM clients and secret patterns are covered by the contract tests; see CONTRIBUTING.md)
- [ ] No new runtime dependencies
- [ ] Nothing written to disk or sent to an LLM bypasses `sanitize()`
- [ ] README / CHANGELOG updated if users will notice the change
