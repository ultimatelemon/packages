# @ultimatelemon-eu/github-app

Act on GitHub as a GitHub App: short-lived installation tokens, narrowed to
the repositories and permissions one use needs (ADR-0019). Signs the App JWT,
finds the installation, and reuses a token until five minutes before it
expires. Node only, no dependencies.

```bash
npm install @ultimatelemon-eu/github-app
```

```ts
import { createGitHubApp } from '@ultimatelemon-eu/github-app';

const app = createGitHubApp({
  clientId: process.env.GITHUB_APP_CLIENT_ID!,
  privateKey: process.env.GITHUB_APP_PRIVATE_KEY!
});

const { token, expiresAt } = await app.installationToken({
  owner: 'ultimatelemon',
  repositories: ['nova', 'packages'],
  permissions: { contents: 'write', pull_requests: 'write' }
});
```

Use the token as `GH_TOKEN` for `gh`, or for git over HTTPS as user
`x-access-token`. It is valid for one hour.

## Narrowing

- `repositories`: names without the owner. Leave it out for every repository
  the installation covers. An empty list is refused, because GitHub reads it
  as "all".
- `permissions`: a subset of what the App was granted. Leave it out for all
  of them.

Tokens are cached per owner, repository set and permission set, in memory and
per `createGitHubApp` instance. A failed request is not cached.

## Configuration

| Option       | Default                  |                              |
| ------------ | ------------------------ | ---------------------------- |
| `clientId`   | required                 | the App's client ID (`Iv…`)  |
| `privateKey` | required                 | PEM, as GitHub generated it  |
| `apiUrl`     | `https://api.github.com` | for GitHub Enterprise Server |
| `fetch`      | global `fetch`           | for tests or a proxy         |

`app.jwt()` gives the App JWT itself (ten minutes) for the App's own
endpoints. Errors from GitHub throw `GitHubAppError` with the HTTP `status`
and GitHub's message.
