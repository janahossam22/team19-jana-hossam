# Team 19 – Jana Hossam: individual proof of work

**Course:** Cloud Computing and Cloud Security · **Project:** Customer Onboarding Checklist Portal (Team 19)
**Team repository (all members, full history and reviews):** https://github.com/hanaelmasryy/Onboarding-portal-team19
**Live site:** https://team19-web.vercel.app · **API:** https://team19-api.vercel.app

My role in the team: **Dashboard & Monitoring** service, and lead for **deployment and logging** (Neon, Vercel, GitHub Actions, the daily notification job).

This repository contains only the files I wrote. Every part below links to the pull request in the team repository where it was reviewed by a teammate and merged, so the full history, discussions and reviews can be checked there.

## What I built

| Week | Work | Team-repo pull request | Files here |
|---|---|---|---|
| 1 | Cloud setup: Neon project with `dev` and `main` branches; two Vercel projects (API and website) with production environment variables; Brevo account with a verified sender; my GitHub issues (#34–#44) | setup in the Neon / Vercel / Brevo consoles | – |
| 1 | Deployment: GitHub Actions workflow that deploys the API and the website to Vercel on every push to `main` (Vercel can't import a repo the deployer doesn't own on the free plan); API address in the website config | [#33](https://github.com/hanaelmasryy/Onboarding-portal-team19/pull/33) | `.github/workflows/deploy.yml` |
| 2 | Dashboard summary, plan progress and the Admin audit-log API, all on the read-only `dashboard_ro` database role; 12 database tests | [#45](https://github.com/hanaelmasryy/Onboarding-portal-team19/pull/45) | `backend/src/routes/dashboard.js`, `backend/test/dashboard.db.test.js` |
| 3 | Overdue, at-risk and inactive-owner queries (open tasks owned by deactivated users); 5 database tests | [#47](https://github.com/hanaelmasryy/Onboarding-portal-team19/pull/47) | `backend/src/routes/dashboard.js`, `backend/test/dashboard.db.test.js` |
| 3 | In-app notifications API: each user sees and marks only their own (someone else's gives 404), Customers never see internal task titles; 5 database tests | [#48](https://github.com/hanaelmasryy/Onboarding-portal-team19/pull/48) | `backend/src/routes/dashboard.js`, `backend/test/dashboard.db.test.js` |
| 4 | Daily notification job run by Vercel Cron, protected by `CRON_SECRET` (constant-time compare, fails closed), runs as the `notifier` role, no duplicates per day; 4 database tests | [#49](https://github.com/hanaelmasryy/Onboarding-portal-team19/pull/49) | `backend/src/routes/dashboard.js`, `backend/vercel.json`, `backend/test/dashboard.db.test.js` |
| 4 | Postman collection for the dashboard, audit-log and notifications API: 13 requests with tests (200 / 400 / 404 / 401), 13/13 passed | [#50](https://github.com/hanaelmasryy/Onboarding-portal-team19/pull/50) | `docs/postman/dashboard.postman_collection.json` |

I also reviewed my teammates' pull requests: Hana Fady's [#32](https://github.com/hanaelmasryy/Onboarding-portal-team19/pull/32) (user accounts, threat model) and Hana Anwar's [#46](https://github.com/hanaelmasryy/Onboarding-portal-team19/pull/46) (task status rules, reassignment, internal notes).

## API endpoints I built

| Endpoint | Who | Database role |
|---|---|---|
| `GET /api/dashboard/summary` | Admin, Staff | `dashboard_ro` (read-only) |
| `GET /api/dashboard/plans?status=&page=&limit=` | Admin, Staff | `dashboard_ro` |
| `GET /api/dashboard/overdue` | Admin, Staff | `dashboard_ro` |
| `GET /api/dashboard/at-risk` | Admin, Staff | `dashboard_ro` |
| `GET /api/dashboard/inactive-owners` | Admin, Staff | `dashboard_ro` |
| `GET /api/audit?action=&result=&from=&to=&page=&limit=` | Admin | `dashboard_ro` |
| `GET /api/notifications`, `GET /api/notifications/unread-count`, `PATCH /api/notifications/:id/read`, `PATCH /api/notifications/read-all` | any logged-in user, own rows only | `app_rw` |
| `GET /api/jobs/notifications` | Vercel Cron only (`CRON_SECRET`) | `notifier` (read + insert only) |

## Security highlights
- **Least privilege:** dashboard and audit queries run as `dashboard_ro`, which can't see emails, password hashes or internal notes and can't change anything; the daily job runs as `notifier`, which can only read plans and tasks and add notifications.
- **Access control on every route:** `requireAuth` + `requireRole`; a Customer gets 403 on the dashboard; the audit log is Admin-only.
- **No IDOR on notifications:** every query is limited to the logged-in user's id from the token; someone else's notification returns 404, not 403.
- **Input validation:** status, page, limit, dates and audit filters are checked before any SQL; bad values get 400. All SQL is parameterised.
- **Privacy:** responses never contain emails (tested); the audit API hides old rows that stored an email; Customers never get internal task titles.
- **Daily job:** only Vercel can run it (secret compared in constant time, refused if missing or shorter than 32 characters); every run and every refused attempt is written to the audit log.
- **Deployment:** secrets live only in Vercel environment variables and GitHub Actions secrets, never in the repository.

## About this repository
- It shows my files only, so it doesn't run on its own: `backend/src/app.js`, the login middleware, the database pool and the schema belong to my teammates and are in the team repository. All my database tests run there with `cd backend && npm test`.
- `.github/workflows/deploy.yml` is a copy for reference; it only works in the team repository, where the Vercel secrets are set.
- No secrets are stored here: `.env` files are ignored, and the Postman collection reads the login details from a local Postman environment.
