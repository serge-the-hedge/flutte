# Blabla

Blabla is Brickit's localization workspace. Developers sync committed Flutter
ARB catalogs from Git, translators edit and review values in the web app, and a
local CLI delivers reviewed output on a branch with matching generated Dart.
Agents propose candidates; a human or an explicitly authorized independent
Reviewer Agent decides what becomes current. Blabla never
pushes to Git or opens a pull request on the developer's behalf.

## Start here

- [Catalog message lifecycle](docs/catalog-message-lifecycle.md): the implemented
  path from Git import through review to delivery.
- [Product specification](docs/spec/localization-control-plane.md): accepted
  product rules, with an implementation-status table separating shipped and
  planned work.
- [Agent review policy](docs/agent-review.md): human enablement and independent
  reviewer credentials.
- [Agent skills](agent-kit/README.md): portable workflows and a bounded HTTP helper for coding agents.
- [Agent API](docs/agent-api.md): endpoint reference and compatible documentation links.
- [CLI](cli/README.md): installation, sync, delivery, and real-Flutter checks.
- [Hosted setup](docs/hosted-auth-setup.md): Vercel, Convex, and account email.
- [Domain glossary](CONTEXT.md): shared product vocabulary.

## Local development

Use Bun **1.3.13** (the version pinned in `package.json` and CI). The CLI also
needs Dart; see its [toolchain requirements](cli/README.md). Agent-kit checks
require Node.js **22+**.

```sh
bun install --frozen-lockfile
bun run dev:setup
```

Configure the chosen Convex development deployment's runtime authentication
variables before starting the app:

```sh
cd packages/backend
bunx convex env set SITE_URL http://localhost:3001
bunx convex env set TRUSTED_ORIGINS http://localhost:3001
# Enter a strong secret at the prompt; keep it stable for this deployment.
bunx convex env set BETTER_AUTH_SECRET
```

Better Auth uses the deployment's automatic `CONVEX_SITE_URL` unless an explicit
`BETTER_AUTH_URL` is configured. Set `apps/web/.env` to the matching deployment:

```dotenv
VITE_CONVEX_URL=https://<deployment>.convex.cloud
VITE_SITE_URL=http://localhost:3001
```

The web app derives the corresponding `.convex.site` URL. For a custom backend
hostname, also set `VITE_CONVEX_SITE_URL`. Backend `.env.local` files configure
the CLI; Convex functions read runtime variables from the selected deployment.

From the repository root:

```sh
bun run dev
```

Open [localhost:3001](http://localhost:3001) and create an email/password account.
Personal project creation and sign-in work without email delivery. Joining a
project by email invitation requires verification: use the account banner to
send a link, then open it. Existing unverified accounts use the same flow.
Configure Resend and `AUTH_EMAIL_FROM` using the hosted setup guide to exercise
verification or password recovery; development test mode only sends to Resend
test recipients.

## Working on translations

1. Add the source and target catalog bindings on the project's **Sync** page.
2. Create a workspace connection under **Settings → API tokens** and run its
   one-time login command.
3. Update the Brickit integration branch (`develop`) with a fast-forward pull,
   then run `blabla sync` from that checkout.
4. Edit values in **Strings**, or prepare candidates in **Translation tasks**.
   Review agent candidates before delivery.
5. Prepare and build a Ready **Release Record**. Run the displayed `blabla
   deliver` command from the integration checkout; include `--locale-proposal`
   when combining a ready new-Locale task with existing-Locale work.
6. Inspect the local review branch, then run the printed push/PR commands yourself.

For an unpublished CLI, run repository-local commands from this repository root:

```sh
bun run blabla -- login --server https://<deployment>.convex.site --token ...
bun run blabla -- sync --checkout /path/to/brickit-flutter
bun run blabla -- deliver --release <record-id> --checkout /path/to/brickit-flutter
```

Legacy catalog writes and exports are retired. Historic Change Sets and job
records remain evidence; their values do not update the current Workspace.
See the API guide's migration instructions for unfinished legacy proposals.

## Checks

```sh
bun run check       # lint, type checks, tests, production build
bun run check:fix   # apply Biome formatting and safe fixes
```

Lint warnings fail the check. TypeScript and web/backend tests run through
Turborepo. CI also checks the separate Dart CLI on macOS and Linux; run its
format, analysis, test, and compile commands from the CLI README when changing it.
Real-Flutter acceptance requires a supplied Brickit checkout and is separate
from the default fixture-based suite.

## Repository layout

- `apps/web`: React, TanStack Router, and the translator UI.
- `packages/backend/convex`: snapshot, catalog, review, release, and auth modules.
- `packages/ui`: shared shadcn primitives and design tokens.
- `packages/env`, `packages/config`: environment validation and TypeScript config.
- `cli`: Dart repository adapter, tests, and installer.
- `docs`: maintained contracts and operating instructions.
- `reports`: dated research and historical verification, not current product rules.

Change shared design tokens in `packages/ui/src/styles/globals.css`. Add shared
components with `bunx --bun shadcn@latest add <component> -c packages/ui`.

For new languages, follow [Adding a language](docs/adding-languages.md).
