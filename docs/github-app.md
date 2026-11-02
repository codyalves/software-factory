# The factory's GitHub App

The factory acts on GitHub as its own GitHub App, not as you. Its comments and
pull requests show the app's name, its permissions are limited to what is
granted below, and its tokens expire after an hour.

Without the app configured, the factory still runs; outbox messages (issue
comments) wait in the database until it is.

## Create it (about five minutes)

1. GitHub → your avatar → **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. **GitHub App name:** something unique, e.g. `codyalves-software-factory`.
   **Homepage URL:** the repository URL.
3. **Webhook:** uncheck **Active**. The factory receives events through the
   repository webhook for now.
4. **Repository permissions:**

   | Permission | Access | Used for |
   | --- | --- | --- |
   | Issues | Read and write | Comments on issues |
   | Pull requests | Read and write | Opening and merging pull requests (M1) |
   | Contents | Read and write | Pushing branches with implemented changes (M1) |
   | Metadata | Read-only | Required by GitHub |

   Leave everything else at **No access**.
5. **Where can this GitHub App be installed?** Only on this account.
6. **Create GitHub App**. Note the **App ID** at the top of the page.
7. **Private keys → Generate a private key.** A `.pem` file downloads. Keep it
   outside the repository; it is the app's password.
8. **Install App** (left menu) → your account → **Only select repositories** →
   pick the repositories the factory should work on.

## Check it

```bash
GITHUB_APP_ID=123456 GITHUB_APP_PRIVATE_KEY_FILE=~/keys/factory.pem \
  node apps/orchestrator/src/check-github-app.ts codyalves/<repo>
```

It changes nothing on GitHub; it only proves the app can get a token for the repository.

## Configure the factory

In `.env` (never committed):

```bash
GITHUB_APP_ID=123456
# The PEM on one line with \n escapes:
#   awk 'NF {sub(/\r/, ""); printf "%s\\n", $0}' ~/keys/factory.pem
GITHUB_APP_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n
```

Outside Docker, `GITHUB_APP_PRIVATE_KEY_FILE=/path/to/key.pem` works too.

If the key ever leaks: the app's settings page → **Private keys** → delete it
and generate a new one.
