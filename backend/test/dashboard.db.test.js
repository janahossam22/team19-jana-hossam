// Dashboard endpoint tests against a real database (issue #36). Owner: Jana Hossam.
// Runs only when DATABASE_URL is set (backend/.env, DEV branch).
// Cleans up: deletes the plan and template it creates and deactivates its users.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');


try {
  process.loadEnvFile(`${__dirname}/../.env`);
} catch {
  // no .env file
}
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256-signing';
}
// The daily job needs a CRON_SECRET of at least 32 characters (it refuses otherwise).
if (!process.env.CRON_SECRET || process.env.CRON_SECRET.length < 32) {
  process.env.CRON_SECRET = 'test-cron-secret-that-is-long-enough-1234567890';
}
const CRON = process.env.CRON_SECRET;

const SKIP = process.env.DATABASE_URL && process.env.DASHBOARD_DATABASE_URL
  ? false
  : 'database URLs not set; database tests skipped';

const request = require('supertest');

let app;
let pool;
let signToken;
const run = crypto.randomBytes(4).toString('hex');   // makes test emails unique
const tokens = {};
const userIds = {};
const userEmails = [];
const created = { templateId: null, planId: null };
const alert = { templateId: null, planId: null, lateTaskId: null, soonTaskId: null, doneTaskId: null, inactiveId: null };
const as = (role) => ({ Authorization: `Bearer ${tokens[role]}` });
const summary = (role) => request(app).get('/api/dashboard/summary').set(as(role));

before(async () => {
  if (SKIP) return;
  app = require('../src/app');
  pool = require('../src/db/pool');
  ({ signToken } = require('../src/lib/tokens'));
  for (const role of ['Admin', 'Staff', 'Customer']) {
    const email = `test-dash-${role.toLowerCase()}-${run}@example.test`;
    const { rows } = await pool.db().query(
      `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, 'not-a-real-hash', $3) RETURNING id`,
      [`Test ${role}`, email, role]
    );
    userEmails.push(email);
    userIds[role] = rows[0].id;
    tokens[role] = signToken(rows[0].id);
  }
});

after(async () => {
  if (SKIP) return;
  if (created.planId) await pool.db().query('DELETE FROM onboarding_plans WHERE id = $1', [created.planId]);
  if (created.templateId) await pool.db().query('DELETE FROM templates WHERE id = $1', [created.templateId]);
  if (alert.planId) await pool.db().query('DELETE FROM onboarding_plans WHERE id = $1', [alert.planId]);
  if (alert.templateId) await pool.db().query('DELETE FROM templates WHERE id = $1', [alert.templateId]);
  await pool.db().query('UPDATE users SET active = false WHERE email = ANY($1)', [userEmails]);
  await pool.db().end();
});

test('summary: not logged in -> 401, Customer -> 403', { skip: SKIP }, async () => {
  assert.strictEqual((await request(app).get('/api/dashboard/summary')).status, 401);
  assert.strictEqual((await summary('Customer')).status, 403);
});

test('summary: Admin and Staff -> 200 with the right shape', { skip: SKIP }, async () => {
  for (const role of ['Admin', 'Staff']) {
    const res = await summary(role);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(Object.keys(res.body.plans).sort(), ['active', 'cancelled', 'completed']);
    assert.deepStrictEqual(Object.keys(res.body.tasks).sort(), ['done', 'inProgress', 'notStarted']);
    assert.strictEqual(typeof res.body.overdueTasks, 'number');
  }
});

test('summary: counts include a newly added plan with 3 tasks', { skip: SKIP }, async () => {
 // a template, a plan and 3 tasks: 1 Done, 1 overdue (Not Started, due 2 days ago), 1 In Progress
  const tpl = await pool.db().query(
    `INSERT INTO templates (title, created_by) VALUES ($1, $2) RETURNING id`,
    [`Dashboard test ${run}`, userIds.Admin]
  );
  created.templateId = tpl.rows[0].id;
  const plan = await pool.db().query(
    `INSERT INTO onboarding_plans (template_id, template_version, customer_id, title, start_date, created_by)
     VALUES ($1, 1, $2, $3, CURRENT_DATE - 10, $4) RETURNING id`,
    [created.templateId, userIds.Customer, `Dashboard plan ${run}`, userIds.Admin]
  );
  created.planId = plan.rows[0].id;
  await pool.db().query(
    `INSERT INTO tasks (plan_id, title, position, visibility, actor, due_date, status, completed_at) VALUES
       ($1, 'Done task',        1, 'customer', 'staff', CURRENT_DATE - 5, 'Done',        now()),
       ($1, 'Overdue task',     2, 'customer', 'staff', CURRENT_DATE - 2, 'Not Started', NULL),
       ($1, 'In progress task', 3, 'internal', 'staff', CURRENT_DATE + 5, 'In Progress', NULL)`,
    [created.planId]
  );

  // Other test files add and delete plans at the same time, so exact totals can change.
  // Our own plan is still there, so each count must be AT LEAST 1. The exact numbers
  // for one plan are checked in 'plans: shows the progress of the test plan correctly'.
  const after = (await summary('Admin')).body;
  assert.ok(after.plans.active >= 1);
  assert.ok(after.tasks.done >= 1);
  assert.ok(after.tasks.notStarted >= 1);
  assert.ok(after.tasks.inProgress >= 1);
  assert.ok(after.overdueTasks >= 1);
  for (const n of [...Object.values(after.plans), ...Object.values(after.tasks), after.overdueTasks]) {
    assert.ok(Number.isInteger(n) && n >= 0, 'every count is a whole number, never negative');
  }
});

test('summary: no emails in the response', { skip: SKIP }, async () => {
  const res = await summary('Admin');
  assert.ok(!JSON.stringify(res.body).includes('@'));
});

const plansList = (role, query = '') => request(app).get(`/api/dashboard/plans${query}`).set(as(role));

test('plans: not logged in -> 401, Customer -> 403', { skip: SKIP }, async () => {
  assert.strictEqual((await request(app).get('/api/dashboard/plans')).status, 401);
  assert.strictEqual((await plansList('Customer')).status, 403);
});

test('plans: shows the progress of the test plan correctly', { skip: SKIP }, async () => {
  // the plan with 3 tasks was created in the summary test above
  const res = await plansList('Staff', '?status=Active&limit=100');
  assert.strictEqual(res.status, 200);
  const mine = res.body.plans.find((p) => p.id === created.planId);
  assert.ok(mine, 'test plan should be in the list');
  assert.strictEqual(mine.customerName, 'Test Customer');
  assert.strictEqual(mine.totalTasks, 3);
  assert.strictEqual(mine.doneTasks, 1);
  assert.strictEqual(mine.overdueTasks, 1);
  assert.strictEqual(mine.progress, 33);
});

test('plans: bad URL options -> 400', { skip: SKIP }, async () => {
  for (const query of ['?status=Pending', '?limit=0', '?limit=101', '?page=0', '?page=abc', '?page=1.5']) {
    const res = await plansList('Admin', query);
    assert.strictEqual(res.status, 400, `expected 400 for ${query}`);
  }
});

test('plans: paging works and no emails are returned', { skip: SKIP }, async () => {
  const res = await plansList('Admin', '?page=1&limit=1');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.page, 1);
  assert.strictEqual(res.body.limit, 1);
  assert.ok(res.body.plans.length <= 1);
  assert.ok(!JSON.stringify(res.body).includes('@'));
});

const auditList = (role, query = '') => request(app).get(`/api/audit${query}`).set(as(role));

test('audit: not logged in -> 401, Staff and Customer -> 403', { skip: SKIP }, async () => {
  assert.strictEqual((await request(app).get('/api/audit')).status, 401);
  assert.strictEqual((await auditList('Staff')).status, 403);
  assert.strictEqual((await auditList('Customer')).status, 403);
});

test('audit: Admin sees the denied Staff attempt, newest first', { skip: SKIP }, async () => {
  // the Staff 403 above was written to the audit log as access_denied
  const res = await auditList('Admin', '?action=access_denied&result=denied&limit=100');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.entries.every((e) => e.action === 'access_denied' && e.result === 'denied'));
  assert.ok(res.body.entries.some((e) => e.actorId === userIds.Staff), 'Staff attempt should be logged');
  const times = res.body.entries.map((e) => new Date(e.createdAt).getTime());
  assert.deepStrictEqual(times, [...times].sort((a, b) => b - a));
});

test('audit: bad URL options -> 400', { skip: SKIP }, async () => {
  for (const query of ['?action=DROP TABLE', '?result=maybe', '?from=banana', '?to=yesterday', '?limit=500']) {
    const res = await auditList('Admin', query);
    assert.strictEqual(res.status, 400, `expected 400 for ${query}`);
  }
});

test('audit: no emails in the response', { skip: SKIP }, async () => {
  const res = await auditList('Admin', '?limit=100');
  assert.strictEqual(res.status, 200);
  assert.ok(!JSON.stringify(res.body).includes('@'));
});

// ---- Week 3: overdue, at-risk and inactive-owner queries (#38) ----------------

// Creates the test data once: a deactivated Staff user and one Active plan with 3 tasks:
//   late  = Not Started, due 3 days ago, owned by the deactivated user  -> overdue + inactive owner
//   soon  = Not Started, due tomorrow, owned by the active Staff user   -> due soon (at risk)
//   done  = Done, due 5 days ago                                        -> not overdue
async function makeAlertData() {
  if (alert.planId) return;
  const email = `test-dash-inactive-${run}@example.test`;
  const u = await pool.db().query(
    `INSERT INTO users (name, email, password_hash, role, active)
     VALUES ($1, $2, 'not-a-real-hash', 'Staff', false) RETURNING id`,
    [`Test Inactive Staff ${run}`, email]
  );
  userEmails.push(email);
  alert.inactiveId = u.rows[0].id;

  const tpl = await pool.db().query(
    `INSERT INTO templates (title, created_by) VALUES ($1, $2) RETURNING id`,
    [`Alert test ${run}`, userIds.Admin]
  );
  alert.templateId = tpl.rows[0].id;
  const plan = await pool.db().query(
    `INSERT INTO onboarding_plans (template_id, template_version, customer_id, title, start_date, created_by)
     VALUES ($1, 1, $2, $3, CURRENT_DATE - 10, $4) RETURNING id`,
    [alert.templateId, userIds.Customer, `Alert plan ${run}`, userIds.Admin]
  );
  alert.planId = plan.rows[0].id;
  const t = await pool.db().query(
    `INSERT INTO tasks (plan_id, title, position, visibility, actor, assignee_id, due_date, status, completed_at) VALUES
       ($1, 'Late task', 1, 'customer', 'staff', $2, CURRENT_DATE - 3, 'Not Started', NULL),
       ($1, 'Soon task', 2, 'customer', 'staff', $3, CURRENT_DATE + 1, 'Not Started', NULL),
       ($1, 'Done task', 3, 'customer', 'staff', $3, CURRENT_DATE - 5, 'Done',        now())
     RETURNING id`,
    [alert.planId, alert.inactiveId, userIds.Staff]
  );
  [alert.lateTaskId, alert.soonTaskId, alert.doneTaskId] = t.rows.map((r) => r.id);
}

const NEW_ROUTES = ['/api/dashboard/overdue', '/api/dashboard/at-risk', '/api/dashboard/inactive-owners'];
const get = (role, path) => request(app).get(path).set(as(role));

test('alerts: not logged in -> 401, Customer -> 403 on all three', { skip: SKIP }, async () => {
  for (const path of NEW_ROUTES) {
    assert.strictEqual((await request(app).get(path)).status, 401, path);
    assert.strictEqual((await get('Customer', path)).status, 403, path);
  }
});

test('overdue: shows the late task with days overdue, not the done or future ones', { skip: SKIP }, async () => {
  await makeAlertData();
  const res = await get('Staff', '/api/dashboard/overdue?limit=100');
  assert.strictEqual(res.status, 200);
  const late = res.body.tasks.find((t) => t.id === alert.lateTaskId);
  assert.ok(late, 'late task should be listed');
  assert.strictEqual(late.daysOverdue, 3);
  assert.match(late.dueDate, /^\d{4}-\d{2}-\d{2}$/);   // plain date, no time zone
  assert.strictEqual(late.planId, alert.planId);
  const ids = res.body.tasks.map((t) => t.id);
  assert.ok(!ids.includes(alert.soonTaskId), 'a task due tomorrow is not overdue');
  assert.ok(!ids.includes(alert.doneTaskId), 'a Done task is never overdue');
});

test('at-risk: the plan is listed with both reasons', { skip: SKIP }, async () => {
  await makeAlertData();
  const res = await get('Admin', '/api/dashboard/at-risk?limit=100');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.atRiskDays, 2);
  const mine = res.body.plans.find((p) => p.id === alert.planId);
  assert.ok(mine, 'alert plan should be at risk');
  assert.strictEqual(mine.overdueTasks, 1);
  assert.strictEqual(mine.dueSoonTasks, 1);
  assert.deepStrictEqual(mine.reasons, ['overdue_tasks', 'due_soon_not_started']);
});

test('inactive-owners: only the task owned by the deactivated user', { skip: SKIP }, async () => {
  await makeAlertData();
  const res = await get('Admin', '/api/dashboard/inactive-owners?limit=100');
  assert.strictEqual(res.status, 200);
  const late = res.body.tasks.find((t) => t.id === alert.lateTaskId);
  assert.ok(late, 'task of the deactivated user should be listed');
  assert.strictEqual(late.assigneeId, alert.inactiveId);
  assert.strictEqual(late.title, 'Late task');
  assert.ok(!res.body.tasks.some((t) => t.id === alert.soonTaskId), 'active owner -> not listed');
});

test('alerts: bad paging -> 400 and no emails in any response', { skip: SKIP }, async () => {
  for (const path of NEW_ROUTES) {
    assert.strictEqual((await get('Admin', `${path}?limit=0`)).status, 400, path);
    assert.strictEqual((await get('Admin', `${path}?page=abc`)).status, 400, path);
    const ok = await get('Admin', `${path}?limit=100`);
    assert.strictEqual(ok.status, 200, path);
    assert.ok(!JSON.stringify(ok.body).includes('@'), path);
  }
});

// ---- In-app notifications (#39) -----------------------------------------------

// Test data, made once (on the alert plan from the tests above):
//   Staff:    2 notifications, one already read and one unread
//   Customer: 1 unread notification about an INTERNAL task (title must stay hidden)
const notes = { staffRead: null, staffUnread: null, customerInternal: null };

async function makeNotifications() {
  if (notes.staffUnread) return;
  await makeAlertData();
  const internal = await pool.db().query(
    `INSERT INTO tasks (plan_id, title, position, visibility, actor, due_date)
     VALUES ($1, 'Secret internal task', 4, 'internal', 'staff', CURRENT_DATE + 10) RETURNING id`,
    [alert.planId]
  );
  const { rows } = await pool.db().query(
    `INSERT INTO notifications (user_id, plan_id, task_id, type, channel, read_at, created_at) VALUES
       ($1, $3, $4, 'assigned', 'in_app', now(), now() - interval '2 hours'),
       ($1, $3, $5, 'overdue',  'in_app', NULL,  now() - interval '1 hour'),
       ($2, $3, $6, 'assigned', 'in_app', NULL,  now())
     RETURNING id`,
    [userIds.Staff, userIds.Customer, alert.planId, alert.soonTaskId, alert.lateTaskId, internal.rows[0].id]
  );
  [notes.staffRead, notes.staffUnread, notes.customerInternal] = rows.map((r) => r.id);
}

test('notifications: not logged in -> 401 on all four', { skip: SKIP }, async () => {
  assert.strictEqual((await request(app).get('/api/notifications')).status, 401);
  assert.strictEqual((await request(app).get('/api/notifications/unread-count')).status, 401);
  assert.strictEqual((await request(app).patch('/api/notifications/1/read')).status, 401);
  assert.strictEqual((await request(app).patch('/api/notifications/read-all')).status, 401);
});

test('notifications: each user sees only their own, newest first', { skip: SKIP }, async () => {
  await makeNotifications();
  const staff = await get('Staff', '/api/notifications?limit=100');
  assert.strictEqual(staff.status, 200);
  const ids = staff.body.notifications.map((n) => n.id);
  assert.ok(ids.includes(notes.staffRead) && ids.includes(notes.staffUnread));
  assert.ok(!ids.includes(notes.customerInternal), "Staff must not see the Customer's notification");
  assert.ok(ids.indexOf(notes.staffUnread) < ids.indexOf(notes.staffRead), 'newest first');

  const unread = await get('Staff', '/api/notifications?unread=true&limit=100');
  assert.ok(unread.body.notifications.every((n) => n.read === false));
  assert.ok(unread.body.notifications.some((n) => n.id === notes.staffUnread));

  assert.strictEqual((await get('Staff', '/api/notifications?unread=maybe')).status, 400);
});

test('notifications: a Customer never sees the title of an internal task', { skip: SKIP }, async () => {
  await makeNotifications();
  const res = await get('Customer', '/api/notifications?limit=100');
  assert.strictEqual(res.status, 200);
  const mine = res.body.notifications.find((n) => n.id === notes.customerInternal);
  assert.ok(mine, 'Customer should see their own notification');
  assert.strictEqual(mine.taskTitle, null);
  assert.strictEqual(mine.planTitle, `Alert plan ${run}`);
  assert.ok(!JSON.stringify(res.body).includes('Secret internal task'));
});

test('notifications: mark as read works only on your own (others -> 404)', { skip: SKIP }, async () => {
  await makeNotifications();
  const before = (await get('Staff', '/api/notifications/unread-count')).body.unread;

  // someone else's notification, a bad id and an unknown id -> 404, nothing changes
  assert.strictEqual((await request(app).patch(`/api/notifications/${notes.staffUnread}/read`).set(as('Customer'))).status, 404);
  assert.strictEqual((await request(app).patch('/api/notifications/abc/read').set(as('Staff'))).status, 404);
  assert.strictEqual((await request(app).patch('/api/notifications/999999999/read').set(as('Staff'))).status, 404);
  assert.strictEqual((await get('Staff', '/api/notifications/unread-count')).body.unread, before);

  // the owner marks it read; doing it again keeps the first read time
  const first = await request(app).patch(`/api/notifications/${notes.staffUnread}/read`).set(as('Staff'));
  assert.strictEqual(first.status, 200);
  assert.strictEqual(first.body.read, true);
  const again = await request(app).patch(`/api/notifications/${notes.staffUnread}/read`).set(as('Staff'));
  assert.strictEqual(again.body.readAt, first.body.readAt);
  assert.strictEqual((await get('Staff', '/api/notifications/unread-count')).body.unread, before - 1);
});

test('notifications: read-all marks only my own', { skip: SKIP }, async () => {
  await makeNotifications();
  const res = await request(app).patch('/api/notifications/read-all').set(as('Customer'));
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.updated >= 1);
  assert.strictEqual((await get('Customer', '/api/notifications/unread-count')).body.unread, 0);

  // the Staff user's notifications were not touched by the Customer's read-all
  const staff = await get('Staff', '/api/notifications?limit=100');
  const read = staff.body.notifications.find((n) => n.id === notes.staffRead);
  assert.ok(read.read);
});

// ---- Daily notification job (#41) ----------------------------------------------

// Extra late tasks on the alert plan, made once:
//   staffLate    = staff task, due 4 days ago, owner = active Staff  -> Staff gets "overdue"
//   customerLate = customer task, due 2 days ago                     -> the plan's Customer gets "overdue"
// (the existing "Late task" belongs to the deactivated user          -> nobody gets "overdue" for it)
const job = { staffLate: null, customerLate: null };

async function makeJobData() {
  if (job.staffLate) return;
  await makeAlertData();
  const { rows } = await pool.db().query(
    `INSERT INTO tasks (plan_id, title, position, visibility, actor, assignee_id, due_date) VALUES
       ($1, 'Staff late task',    5, 'customer', 'staff',    $2,   CURRENT_DATE - 4),
       ($1, 'Customer late task', 6, 'customer', 'customer', NULL, CURRENT_DATE - 2)
     RETURNING id`,
    [alert.planId, userIds.Staff]
  );
  [job.staffLate, job.customerLate] = rows.map((r) => r.id);
}

const runJob = (header) => {
  const req = request(app).get('/api/jobs/notifications');
  return header === undefined ? req : req.set('Authorization', header);
};

// notifications of one type for one user on the alert plan
async function jobNotes(userId, type) {
  const { rows } = await pool.db().query(
    `SELECT task_id FROM notifications WHERE user_id = $1 AND plan_id = $2 AND type = $3 AND channel = 'in_app'`,
    [userId, alert.planId, type]
  );
  return rows.map((r) => r.task_id);
}

test('job: no secret, a wrong secret or a nearly-right secret -> 401, and it is audited', { skip: SKIP }, async () => {
  assert.strictEqual((await runJob()).status, 401);
  assert.strictEqual((await runJob('Bearer wrong')).status, 401);
  assert.strictEqual((await runJob(`Bearer ${CRON.slice(0, -1)}`)).status, 401);
  assert.strictEqual((await runJob(CRON)).status, 401);   // missing "Bearer "
  // a logged-in Admin's token is not the cron secret either
  assert.strictEqual((await runJob(`Bearer ${tokens.Admin}`)).status, 401);

  const { rows } = await pool.db().query(
    `SELECT COUNT(*)::int AS n FROM audit_log
      WHERE action = 'job_denied' AND result = 'denied' AND created_at > now() - interval '5 minutes'`
  );
  assert.ok(rows[0].n >= 5);
});

test('job: creates overdue notices for the owners and at-risk notices for Admins', { skip: SKIP }, async () => {
  await makeJobData();
  const res = await runJob(`Bearer ${CRON}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(typeof res.body.overdue, 'number');
  assert.strictEqual(typeof res.body.atRisk, 'number');

  assert.ok((await jobNotes(userIds.Staff, 'overdue')).includes(job.staffLate), 'Staff owner notified');
  assert.ok((await jobNotes(userIds.Customer, 'overdue')).includes(job.customerLate), 'Customer notified for a customer task');
  assert.deepStrictEqual(await jobNotes(alert.inactiveId, 'overdue'), [], 'deactivated user gets nothing');
  assert.ok((await jobNotes(userIds.Admin, 'at_risk')).length === 1, 'Admin gets one at-risk notice for the plan');
});

test('job: a second run on the same day adds nothing new', { skip: SKIP }, async () => {
  await makeJobData();
  await runJob(`Bearer ${CRON}`);
  const count = async () => (await pool.db().query(
    `SELECT COUNT(*)::int AS n FROM notifications WHERE plan_id = $1 AND type IN ('overdue', 'at_risk')`,
    [alert.planId]
  )).rows[0].n;
  const before = await count();
  const res = await runJob(`Bearer ${CRON}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(await count(), before);
});

test('job: every run is written to the audit log', { skip: SKIP }, async () => {
  const { rows } = await pool.db().query(
    `SELECT entity_id FROM audit_log
      WHERE action = 'job_notifications' AND result = 'allowed' AND created_at > now() - interval '5 minutes'`
  );
  assert.ok(rows.length >= 1);
  assert.match(rows[0].entity_id, /^overdue=\d+,at_risk=\d+$/);
});
