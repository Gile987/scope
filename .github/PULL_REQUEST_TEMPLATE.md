## Summary

<!-- What changed and why? Link the related issue, if any. -->

## Testing

<!-- List commands/manual checks and results, or explain why testing isn't applicable. -->

## Documentation and compatibility

<!-- Link updated docs, or explain why none are needed. Note breaking changes,
API/CLI compatibility impacts, and any upgrade steps; write "None" if not applicable. -->

## Checklist

<!-- Complete applicable items; mark others N/A. See CONTRIBUTING.md for guidance. -->

- [ ] If Portal features changed, keep CLI capabilities in sync.
- [ ] If Portal components changed, update their Storybook stories.
- [ ] If database changes require a migration, include `up()` / `down()` and keep it CosmosDB-compatible.
- [ ] If dependencies changed, update the lockfile and regenerate `NOTICE` / `NOTICE-REVIEW.txt` with `pnpm notice` as needed.
