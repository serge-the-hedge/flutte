# Hosted Deployment Setup

Production has one canonical browser origin:

```txt
https://blabla.seryozha.world
```

`flutte-web.vercel.app` and `flutte.seryozha.world` redirect there through
`vercel.json`. The Convex Better Auth cross-domain client stores its session per
browser origin, so independently serving the app on several aliases produces
several apparently unrelated login states.

## Vercel

Create the Vercel project from the repository root. Do not set `apps/web` as the
Root Directory: the build also needs `packages/backend`.

Use the root `vercel.json`:

- install: `bun install --frozen-lockfile`
- build: the `buildCommand` in `vercel.json`
- output: `apps/web/dist`

The build deploys Convex, injects its deployment-specific URL into Vite, and
then publishes the SPA. Configure:

```txt
Production: CONVEX_DEPLOY_KEY=<production deploy key>
Preview:    CONVEX_DEPLOY_KEY=<project preview deploy key>

Production: VITE_SITE_URL=https://blabla.seryozha.world
Preview:    omit VITE_SITE_URL so each preview uses its current origin
```

Do not set static `VITE_CONVEX_URL` or `VITE_CONVEX_SITE_URL` values in Vercel.
The build selects the matching production or branch-scoped preview deployment.

Add both custom domains. The second redirects to the first:

```txt
blabla.seryozha.world
flutte.seryozha.world
```

## Gandi DNS

Create this DNS record:

```txt
Type: CNAME
Name: blabla
Value: d84a471e3b5855b6.vercel-dns-017.com.
```

Wait until Vercel verifies the domain and provisions HTTPS.

## Convex Runtime Environment

Better Auth runs inside Convex, so its variables belong on Convex deployments,
not in Vercel. Production needs:

```bash
cd packages/backend
bunx convex env set --prod SITE_URL https://blabla.seryozha.world
bunx convex env set --prod BETTER_AUTH_URL https://polite-fish-670.convex.site
bunx convex env set --prod TRUSTED_ORIGINS \
  "https://blabla.seryozha.world"
bunx convex env set --prod BETTER_AUTH_SECRET
```

Use a strong environment-specific secret. When promoting an existing auth
database, retaining its secret avoids invalidating existing sessions.

New preview deployments inherit project defaults. Configure these once:

```bash
cd packages/backend
bunx convex env default set --type preview BETTER_AUTH_SECRET
bunx convex env default set --type preview RESEND_TEST_MODE true
```

Enable Vercel's system environment variables. During a Preview build,
`scripts/vercel-build.ts` binds the newly-created Convex deployment to that
exact `https://$VERCEL_URL`: it sets `SITE_URL`, `TRUSTED_ORIGINS`, and the
deployment-specific `BETTER_AUTH_URL` before building the frontend. This avoids
both unsafe `https://*.vercel.app` trust and sessions leaking conceptually
between the canonical app and a preview. Production is not mutated by this
script.

Every Convex preview is a fresh database. Sign up a disposable preview user, or
add a deliberate `--preview-run` seed later. Account-email delivery remains in
Resend test mode unless that preview also inherits a test API key and sender;
production email credentials must not be preview defaults.

Verify:

```bash
bunx convex env list --prod --names-only
curl -sS https://polite-fish-670.convex.site/api/auth/ok
curl -sS -D - \
  -H "Origin: https://blabla.seryozha.world" \
  https://polite-fish-670.convex.site/api/auth/get-session
```

The `get-session` response should include an `access-control-allow-origin`
header matching the request origin.

## Verification and Password Recovery Email

Email verification and password recovery are sent from Convex through the official
durable Resend component. Resend credentials belong to each Convex deployment, not Vercel.

1. In Resend, add `flutte-updates.seryozha.world` as a sending domain.
2. Add the exact SPF and DKIM records Resend displays to Gandi. Keep open and
   click tracking disabled for account mail. Add DMARC after SPF and
   DKIM verify.
3. Create a sending-only Resend API key and configure production Convex:

```bash
cd packages/backend
bunx convex env set --prod RESEND_API_KEY
bunx convex env set --prod AUTH_EMAIL_FROM \
  "Flutte <account@flutte-updates.seryozha.world>"
bunx convex env set --prod RESEND_TEST_MODE false
```

4. In Resend, create a webhook subscribed to all `email.*` events:

```txt
https://polite-fish-670.convex.site/resend-webhook
```

Copy its signing secret into production Convex:

```bash
bunx convex env set --prod RESEND_WEBHOOK_SECRET
```

For development, create a separate webhook pointing at
`https://pleasant-cow-99.convex.site/resend-webhook`, use a separate restricted
API key, and leave `RESEND_TEST_MODE=true`. The component then accepts only
Resend test recipients. No Resend key or webhook secret belongs in Vercel.

The account banner sends and resends verification links; invitations grant access
only after the account proves control of its email address. Sign-in and personal
project creation remain available without verification. The account UI also
supports requesting a one-hour reset link, choosing a new
password, and changing a known password. A successful reset revokes existing
sessions. Final delivery records are retained for one week; abandoned records
are retained for four weeks and cleaned automatically.

## Promote Dev Data to Production

Use one snapshot export and one atomic import. This retains document IDs and
references and avoids reading the catalog through application queries:

```bash
cd packages/backend
bunx convex export --include-file-storage --path /tmp/blabla-dev.zip
bunx convex export --prod --include-file-storage --path /tmp/blabla-prod-before.zip
bunx convex import --prod --replace-all --yes /tmp/blabla-dev.zip
```

Inspect production before `--replace-all` and retain the production export as a
rollback artifact. Convex environment variables and deployed functions are not
part of a snapshot and must be configured separately.

## Colleague Flow

1. Sign in as the owner.
2. Open a project.
3. Go to Settings -> Members.
4. Invite your colleague by email and choose a role.
5. Ask them to open `https://blabla.seryozha.world`.
6. They sign up with the same email.
7. They use the account banner to send a verification link and open it.
8. The app activates pending invitations after verification and the project
   appears in their Projects view. Already verified accounts can be added
   immediately by the owner.
