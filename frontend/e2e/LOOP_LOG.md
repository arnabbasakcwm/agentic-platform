# New project composer: build → test → fix loop

One line per round: what failed, what changed.

- Round 1: A, B, C passed; D failed (the test's "Remove ZohoMcp" matched both the attachment chip and the Tools popover button); E failed (axe scrollable-region-focusable on the model list's scroll area, light and dark). Changed: scoped the test locator to the Tools dialog; made the model list's scroll area focusable.
- Round 2: all 20 composer checks passed; lint, unit tests (103) and build passed. 8 older e2e tests failed because they drove the removed trays and Name field. Changed: updated those tests (datasources-flow, mcp, model-tools, new-project-and-brief, new-project-model, project-names) to use the + menu, chips and popovers, keeping what each one checks; project-names now checks naming from the first line, as the Name field is gone.
- Round 3 (everything: lint, unit, build, token audit, full e2e): 126 passed, 3 failed — knowledge-workspace (light) once, not reproduced on re-run; phase-chrome (light, dark) measured the header mid-navigation (a hash goto keeps the document). Changed: phase-chrome now waits until the phase is current and layout has settled before measuring (6/6 on repeat). No app code changed.
- Round 4 (everything): lint, 103 unit tests, build, token audit 0, full e2e 129 passed. No changes.
- Round 5 (everything): same result, 129 e2e passed. Second clean round in a row — loop exits.

# Assistant composer (same loop)

- Round 1 (assistant-composer.spec.js): 9 of 16 failed. "Change request" also matched the Send button's name (test locator; now getByRole textbox); ticking a + checklist item only showed after the attach request returned, so the checkbox seemed not to change. Changed: attach/detach in the panel are optimistic (chip at once, lists reloaded from the server after).
- Round 2: 16/16 passed.
- Round 3 (everything: lint, 103 unit, build, token audit, full e2e): 145 passed. No changes.
- Round 4 (everything): same, 145 passed. Second clean round in a row — loop exits.
