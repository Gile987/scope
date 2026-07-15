# scope-doc

[![Built with Starlight](https://astro.badg.es/v2/built-with-starlight/tiny.svg)](https://starlight.astro.build)

End-user documentation site for **Scope**, built with
[Astro](https://astro.build) + [Starlight](https://starlight.astro.build)
and published to GitHub Pages.

The product itself lives in
[scope-core](https://github.com/growth-ecosystems/scope-core). This
repo contains only the documentation.

## Project structure

```
.
├── public/                          # static assets
├── src/
│   ├── assets/
│   ├── content/docs/                # all user-facing pages (.md / .mdx)
│   │   ├── introduction/
│   │   ├── getting-started/
│   │   ├── guides/
│   │   ├── reference/
│   │   └── resources/
│   ├── openapi/scope-openapi.json   # snapshot of the live OpenAPI spec
│   ├── plugins/
│   │   └── remark-http-snippets.mjs # turns ```http blocks into multi-language tabs
│   └── content.config.ts
├── astro.config.mjs                 # sidebar, plugins, starlight-openapi config
├── AGENTS.md                        # conventions & guardrails for contributors / AI agents
├── package.json
└── tsconfig.json
```

Sidebar order is defined in `astro.config.mjs`, not by directory order.

## Commands

| Command                | Action                                                     |
| :--------------------- | :--------------------------------------------------------- |
| `pnpm install`         | Install dependencies                                       |
| `pnpm dev`             | Start local dev server at `localhost:4321`                 |
| `pnpm build`           | Build the production site to `./dist/`                     |
| `pnpm preview`         | Preview the production build locally                       |
| `SCOPE_OPENAPI_URL=<url> pnpm refresh:openapi` | Re-snapshot the live OpenAPI spec |

## Authoring docs

- Use `.md` for plain Markdown, `.mdx` whenever the page contains JSX
  (e.g. Starlight `<Tabs>`).
- Write HTTP examples as a single fenced ` ```http ` block — the
  custom remark plugin in
  [src/plugins/remark-http-snippets.mjs](src/plugins/remark-http-snippets.mjs)
  expands it into synced curl / JS fetch / Python / Go / Java / C#
  tabs at build time. Files containing such blocks must be `.mdx`.
- Per-endpoint REST API reference pages under `/reference/api/...`
  are auto-generated from `src/openapi/scope-openapi.json` by
  [`starlight-openapi`](https://starlight-openapi.vercel.app/) — do
  not edit them by hand.

See [AGENTS.md](AGENTS.md) for conventions, the source-of-truth
policy (everything factual must be grounded in scope-core), and
where to look in scope-core for any given topic.

## Deployment

Pushed builds deploy to GitHub Pages via
[../.github/workflows/static.yml](../.github/workflows/static.yml).
The workflow builds from this `website/` directory (via a
`working-directory` default and `website/**` path filters). `site`
and `base` are driven by `actions/configure-pages` outputs with safe
localhost defaults.

## Learn more

- [Astro docs](https://docs.astro.build)
- [Starlight docs](https://starlight.astro.build/)
- [starlight-openapi](https://starlight-openapi.vercel.app/)
