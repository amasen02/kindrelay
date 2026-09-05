# KindRelay

KindRelay is a local-first browser workspace for a volunteer handover. It keeps source notes and tasks in this browser's IndexedDB, creates deterministic draft suggestions, and requires a human review before an approved-item export.

This is original work for the DEV Weekend Generosity context. It draws problem context from NCVO's *Ending volunteering well* guidance, without claiming endorsement, demand validation, or efficacy. Contest submission and human final review remain pending; deployment status must be verified from the live artifact.

## Demo release and recovery

The GitHub Pages release workflow is manual (`workflow_dispatch`) so a reviewed branch or tag must be selected before deployment. To recover a prior release, manually rerun the workflow for a reviewed tag pointing to the prior commit (or a reviewed branch); this repository does not claim that deleting a deployment recovers local browser data. Keep private work in a locally hosted trusted copy and maintain your own backups.

## Requirements and commands

Node 24 is supported.

```sh
npm ci
npx playwright install chromium
npm run dev
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run preview -- --host 127.0.0.1
```

`npm run test:e2e` builds the app and runs Playwright against the strict local preview server. The Chromium browser download is a one-time Playwright setup prerequisite.

## Demo

Create a workspace, add a source, and use only these case-sensitive line prefixes after leading whitespace:

```text
ACTION: Return the shared laptop.
TODO: Confirm the pantry inventory.
- [ ] Arrange a key return.
```

The remainder of a nonempty matching line becomes both a draft title and its exact citation quote. Ordinary prose is ignored; KindRelay does not infer owners, dates, completion, or actions. Edit and review each task. Only approved, selected tasks can be exported in JSON or escaped Markdown. Imported packets always create a new local workspace and reset imported tasks to drafts.

## Privacy and limitations

Browser storage is local but **not encrypted**. Backups are the user's responsibility and can contain notes, drafts, rejected tasks, and history. Inspect every field before approval, export, backup, or restore; the app cannot guarantee pasted notes do not contain secrets.

The public project-site demo is intended for synthetic or sample notes only. GitHub Pages project sites share the `amasen02.github.io` origin, and IndexedDB is scoped to that origin rather than isolated by project path. Use a locally hosted trusted copy for sensitive work; it remains unencrypted. KindRelay adds no analytics.

Approved shares contain cited excerpts and provenance hashes, not complete uncited notes. Hashes detect accidental corruption but do not establish authenticity. Private backup v1 cannot preserve an earlier, separately stored imported-provenance chain. This is not a PWA and makes no offline-cache claim. It has no accounts, cloud sync, publishing, external services, or automatic messaging.

## AI disclosure

See [AI_DISCLOSURE.md](AI_DISCLOSURE.md). The product itself does not use an LLM: suggestion extraction is deterministic and inspectable.

## License

MIT; see [LICENSE](LICENSE).
