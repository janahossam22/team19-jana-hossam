# The API in the AWS version (Floci) – Jana Hossam, issue #43

Runs our Express API in a container on Floci (the AWS emulator), the way it
would run on AWS: as an IAM role, with its secrets in Secrets Manager and
IAM login to RDS. Builds on Hana Fady's RDS + IAM setup (`../setup.sh`) and
IAM database login in `backend/src/db/pool.js` (#64).

## How it works

| Part | How |
|---|---|
| Who the API is | IAM role `team19-api`, with temporary keys (1 hour) from `sts assume-role` |
| `JWT_SECRET`, `CRON_SECRET` | Secret `team19/app` in Secrets Manager, random values made by `start-app.sh`. `start-api.js` reads them when the container starts, keeps them only in memory, and refuses to start if one is missing or shorter than 32 characters |
| Database | IAM tokens (`DB_IAM_AUTH=true`): the three URLs have no password; each pool logs in as its own least-privilege user (`app_rw`, `dashboard_ro`, `notifier`) |
| Secret access | `api-secret-policy.json`: `team19-api` may read `team19/app` only, not the RDS master password; the other roles can't read it |
| Container | non-root `node` user, read-only files, no Linux capabilities, `no-new-privileges`; the image has only `src/` and production packages (no tests, no `.env`) |

## Files

| File | What it does |
|---|---|
| `docker-compose.yml` | `floci` (the emulator) and `api` (our API, sharing Floci's network) |
| `Dockerfile`, `Dockerfile.dockerignore` | The API image |
| `start-api.js` | Reads the secrets from Secrets Manager, then starts the API |
| `api-secret-policy.json` | Lets `team19-api` read `team19/app` only |
| `start-app.sh` | Creates the secret, adds the policy, starts the API as `team19-api` |
| `smoke.sh` | 15 checks against the running API and Floci |

## Run it

On GitHub: **Actions → Floci – API in the AWS version → Run workflow**
(it also runs on every push that changes `backend/` or `infra/floci/`).
Results are on the run's **Summary** page and in the `floci-app-results` artifact.

On Linux / WSL (needs Docker, the AWS CLI, `psql`, `jq`), from the repo root:

```bash
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1
docker compose -f infra/floci/app/docker-compose.yml up -d floci
bash infra/floci/setup.sh
bash infra/floci/app/start-app.sh
bash infra/floci/app/smoke.sh
docker compose -f infra/floci/app/docker-compose.yml --profile app down   # when finished
```

## Notes and limits

- The keys `test` are Floci's bootstrap administrator, used only to build
  things and to read `CRON_SECRET` for one check. On AWS this would be the
  deployer's own identity.
- In Floci the role's temporary keys are given to the container as settings
  and expire after 1 hour (restart with `start-app.sh`). On AWS (ECS) the
  task role gives the container keys that renew by themselves, and none
  are passed in.
- Secrets are read once at start; after changing `team19/app`, restart the API.
