# Final deployment check and evidence (issue #44)

Owner: Jana Hossam (lead for deployment and logging) · Checked on: 25 November 2026

This page records the final check of the live system, the limits of the free plans it runs on, and where the evidence for the whole project is kept. Screenshots are in `docs/evidence/`. No passwords, tokens, connection strings or personal IP addresses appear in this page or in the screenshots.

## 1. What runs where

| Part | Live (Neon + Vercel) | AWS version (Floci, in GitHub Actions) |
|---|---|---|
| Website | Vercel project `team19-web`: https://team19-web.vercel.app | – |
| API | Vercel project `team19-api`: https://team19-api.vercel.app | API container running as the IAM role `team19-api` (PR #66) |
| Database | Neon PostgreSQL, branch `main` (production) and `dev` (tests) | RDS PostgreSQL with IAM-only login (PRs #55, #64) |
| App secrets | Vercel environment variables, GitHub Actions secrets | Secrets Manager `team19/app` (PR #66); RDS master password managed by RDS |
| Daily job | Vercel Cron, `0 5 * * *` (PR #49) | – |
| Plan events | Direct in-app notification | SQS queue + worker (PR #58) |
| Deployment | GitHub Actions `deploy.yml` on every push to `main` (PR #33) | Workflows `floci-rds-iam.yml`, `floci-sqs.yml`, `floci-app.yml` on every PR |

## 2. Live site check

Each row was checked by hand on the live site on 25 November 2026. Screenshots are in `docs/evidence/live/`.

| # | Check | How | Expected | Result | Evidence |
|---|---|---|---|---|---|
| L1 | API is up | Open https://team19-api.vercel.app/api/health | `{"status":"ok"}` | ✅ | `l1-health.jpg` |
| L2 | Website reaches the API | Open https://team19-web.vercel.app | "API status: connected" | ✅ | `l2-website.jpg` |
| L3 | Security headers on the API | Browser DevTools → Network → `/api/health` → Response headers | `Content-Security-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Strict-Transport-Security`, no `X-Powered-By` | ✅ all present, plus `Referrer-Policy: no-referrer` and `Cache-Control: no-store` | `l3-headers.jpg` |
| L4 | Protected routes refuse anonymous calls | Open https://team19-api.vercel.app/api/dashboard/summary without logging in | `401` | ✅ | `l4-401.jpg` |
| L5 | Login works on the live site | Log in with my own live account | Home page with my name and role | ✅ "Jana Hossam (Admin)" | `l5-login.jpg` |
| L6 | Dashboard screen | Open the Dashboard | Summary tiles, plan list, overdue / at-risk / inactive-owner lists load without errors | ✅ | `l6-dashboard.jpg` |
| L7 | Audit-log screen (Admin) | Open Audit log, filter `action = login` | Recent logins listed; no email addresses shown | ✅ (IP column left out of the screenshot) | `l7-audit.jpg` |
| L8 | Daily job runs every day | Audit log, filter `action = job_notifications` | One `allowed` row per day around 05:00–06:00 UTC | ✅ scheduled run on 25 Nov at 05:55 UTC (07:55 Cairo time). The three runs on 24 Nov in the evening were manual runs after the deployment, to check the job on production | `l8-job-runs.jpg` |
| L9 | Both Vercel projects deployed from the latest `main` | Vercel → `team19-api` and `team19-web` → Deployments | Latest production deployment "Ready", same commit as `main` | ✅ | `l9-vercel-api.jpg`, `l9-vercel-web.jpg` |
| L10 | Secrets set, none in the repository | Vercel → Settings → Environment Variables (names only, values hidden); GitHub → Settings → Secrets (names only) | `DATABASE_URL`, `DASHBOARD_DATABASE_URL`, `NOTIFIER_DATABASE_URL`, `JWT_SECRET`, `CRON_SECRET`, `CORS_ORIGINS` on the API; 4 Vercel secrets in GitHub | ✅ | `l10-env-names.jpg`, `l10-gh-secrets.jpeg` |
| L11 | Database usage within the free plan | Neon → Project → Usage | Compute and storage well under the limits in section 3 | ✅ about 1% of compute, 3% of storage | `l11-neon-usage.jpg` |

Why L8 uses the audit log and not the Vercel logs: on the Hobby plan Vercel keeps runtime logs for only one hour, so a run at 05:00 UTC is gone from the logs later that morning. Every run of the job writes a `job_notifications` row to the audit log (and every refused call a `job_denied` row), which is a lasting record.

## 3. Free-plan limits

Checked on the providers' own pages on 25 November 2026. Limits change; the source of each is listed at the end.

| Service | Free limit (most relevant) | Our use | If we go over | Risk for us |
|---|---|---|---|---|
| **Vercel Hobby** (API and website) | 1,000,000 function invocations, 4 CPU-hours active CPU, 360 GB-hours memory, 100 GB fast data transfer per month; function max 300 s; 100 deployments per day; runtime logs kept 1 hour; non-commercial use only | A few hundred API calls a day; every push to `main` makes 2 deployments | Usage-limited features pause until 30 days have passed | Low for a course project. A real business would need Pro (commercial use, longer logs) |
| **Vercel Cron** (Hobby) | Once per day at most; runs anywhere within the scheduled hour (`0 5 * * *` → 05:00–05:59 UTC) | 1 job, once a day | A more frequent schedule fails at deployment | None today. Overdue notices can't be more often than daily, and arrive up to an hour late |
| **Neon Free** (database) | Per project: 100 CU-hours of compute per month, 1 GB storage, 10 branches, 5 GB public network transfer; compute scales to zero after 5 minutes idle (can't be turned off) | 2 branches (`main`, `dev`). Since 1 Nov 2026 (checked 25 Nov): 1.3 CU-hours of 100 (about 1%), 33 MB storage of 1 GB (about 3%), 1.35 MB network transfer of 5 GB. Tests and Postman run on `dev`, sharing the project's compute hours | Compute is suspended until the next month: the live site stops answering database calls | **Highest of all.** `main` and `dev` share the 100 CU-hours, so heavy test runs on `dev` could stop the live site. The first request after 5 idle minutes is slower (cold start) |
| **GitHub Actions** | Standard GitHub-hosted runners are free for public repositories | Deploy, Floci (RDS/IAM, SQS, app) and the deployed regression run on every push / PR / daily | – (free while the repository is public) | If the repository were made private, the Floci runs (several minutes each) would use the free monthly allowance quickly |
| **Brevo Free** (email) | 300 emails per day; up to 100,000 contacts | Not used by the app yet (in-app notifications only); sender verified, domain not authenticated | Emails above 300 wait for the next day | If email is added: test emails may land in spam until the domain is authenticated |

What would break first if use grew: the **Neon compute hours**, because the live database and the test branch draw from the same allowance and the live site has no fallback when compute is suspended. The fixes are to watch Neon's usage page, keep tests on short runs, or move to Neon's pay-per-use plan.

## 4. Automated evidence (GitHub Actions)

| Workflow | What it proves | Latest result | Evidence |
|---|---|---|---|
| Deploy (`deploy.yml`) | API and website deployed from `main` | ✅ run #25 (merge of #67), both jobs green | `docs/evidence/jana-hossam/actions-deploy.jpg` |
| Deployed security regression | CORS, 401 on every protected route, forged/expired tokens refused, no error details on the live API | ✅ 93/93 checks (39 requests) | `docs/evidence/jana-hossam/actions-regression.jpg` |
| Floci – RDS and IAM security tests | RDS settings, IAM-only database login, least privilege, `check.sql` on RDS | ✅ 53/53 | `docs/evidence/hana-fady/floci-rds-iam-53.jpg` |
| Floci – plan events on SQS | Queue permissions per role, end to end API → SQS → worker → RDS | ✅ 28/28 | `docs/evidence/hana-anwar/floci-sqs-1.png` (to `-3.png`) |
| Floci – API in the AWS version | Secrets Manager, IAM token login from the app, least privilege for the secret, hardened container | ✅ 15/15 | `docs/evidence/jana-hossam/floci-app-15.jpg` |

## 5. Evidence from all members

Collected in `docs/evidence/`, one folder per member. Screenshots only: no passwords, tokens or connection strings.

| Member | Evidence | Where |
|---|---|---|
| Hana Fady | `npm run postman` (login, users, templates): 54 requests, 103 assertions, 0 failed, temporary Admin deactivated afterwards; `check.sql` 26/26 on dev, main and RDS; Floci RDS/IAM 53/53; threat model and security review | `docs/evidence/hana-fady/` |
| Hana Anwar | Postman plans, tasks and notes: 75 requests, 100 assertions, 0 failed (test data cleaned up afterwards); live end-to-end test: 30 requests, 44 of 44 checks (`npm run e2e:live`, PR #63, `docs/testing/e2e-live-results.md`); Floci SQS 28/28 | `docs/evidence/hana-anwar/`, `docs/testing/e2e-live-results.md` |
| Jana Hossam | Postman dashboard collection 13/13; live check (section 2); Floci app 15/15; deployment and regression runs | `docs/evidence/jana-hossam/`, `docs/evidence/live/` |
| Everyone | `npm test` on Neon `dev`: 200 tests, 200 pass, 0 fail, 0 skipped | `docs/evidence/npm-test.png` |

Merged pull requests with a teammate's review are the main record of who did what: see the repository's closed pull requests.

## 6. Result

✅ All live checks pass · ✅ All workflows green · ✅ Evidence collected from all three members

Open points (found during this check, not urgent):
1. **Node.js version.** The AWS SDK warns that versions published after the first week of January 2027 will need Node.js 22 or newer. The Floci API image (`node:20`) and `backend/package.json` (`"node": ">=20"`) should move to Node 22 before then.
2. **Database TLS setting.** The `pg` library warns that `sslmode=require` is treated today as `verify-full` (certificate checked), but in its next major version it will follow standard PostgreSQL meaning, which does not check the certificate. To keep today's protection, the Neon connection strings (Vercel settings, `backend/.env`, `.env.example`) should say `sslmode=verify-full`.

## Sources for section 3
- Vercel Hobby plan: https://vercel.com/docs/plans/hobby
- Vercel Cron Jobs usage and pricing: https://vercel.com/docs/schedules/cron-jobs/usage-and-pricing
- Neon Free plan limits: https://neon.com/faqs/free-plan-limits-and-quotas
- GitHub Actions billing: https://docs.github.com/en/billing/concepts/product-billing/github-actions
- Brevo Free plan: https://help.brevo.com/hc/en-us/articles/208580669
