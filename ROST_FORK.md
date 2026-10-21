# Rost Managed Rakazo

This private application fork is based on upstream Rakazo revision
`6191ad23ac2760687bb74ba23da9af9b276fc20e`. Upstream source attribution, Apache-2.0
licensing and third-party notices are retained. OpenBot-derived components retain their
separate notice in `apps/web/src/pages/OPENBOT_LICENSE.txt`.

## Included

- Codex CLI runtime integration, managed model/effort selection and scoped usage.
- Private team workspaces, account administration, approved bot workflows and
  leadership transfer without private-history transfer.
- Durable questions, in-chat reports, charts and office-file delivery surfaces.
- Protected native sessions, completion receipts and developer-only workbench.
- Token-free Rost job completion watches and per-turn token counters.

The matching solver images, installer handling and protected gateway deployment
are maintained separately in the Rost deployment tooling. This repository is
the application source, not an installer containing a solver license or client
workspace. Use matching reviewed Rost deployment templates and image digests;
the upstream Compose defaults alone do not activate the managed runtime.

## Secrets And Data

Configure credentials only in the operator's private environment or secret
mounts, outside Git. Never commit API keys, auth/session files, commercial solver
licenses, SSH keys, customer workbooks, solve results or deployment evidence.
Keep public open-source `LICENSE` and attribution notices; those are not solver
activation files. `.env.example` and explicitly synthetic test credentials are
documentation/fixtures only, not usable deployment credentials.

Do not bake credentials or a machine-bound solver license into an image. Supply
an authorized license at runtime and verify it on the destination machine. Keep
provider keys behind the protected gateway; users and bot workspaces must not
receive the operator's provider keys. Missing capability never permits silent
provider/solver fallback or policy changes.

## Verification

Use the pinned Node/pnpm versions from `package.json`, then generate the database
client before type checking and testing. Tests are offline unless a separately
reviewed command explicitly opts into an external service. Database smoke tests
require an explicitly disposable, migrated database; never point them at a
production database. Do not run the desktop Electron E2E suite on a maintainer's
desktop as routine verification.

For completion monitoring, use `schedule_create` with `rostJobOut` set to the
exact workspace-relative existing job directory and a repeating timer. Worker
polls do not create agent turns. One completion/failure/required-attention wake
retains the reviewed validation/export handoff. A watch cannot authorize new
compute, change policy or publish an unvalidated workbook.

The first repository import has local regression, type-check, image-build and
isolated-database evidence. It is not a full release certification. Repository
Actions are initially disabled so inherited upstream publishing, deployment and
scheduled workflows cannot execute automatically. Review and configure CI before
enabling Actions; disabled CI is not a passing CI result.

The repository starts with a clean, reviewed source snapshot. Historical Git
objects, local build caches and private deployment history are not imported.

Before each push, run a redacted local Gitleaks scan of the working tree and new
commits, and inspect the staged paths. The scanner configuration exempts only
exact, documented synthetic fixture strings, not whole files or directories.
