// Dashboard & Monitoring - Owner: Jana Hossam
// Endpoints for the dashboard, notifications, audit log and the daily job
// go here (proposal section 5.1).
//   GET /api/dashboard/summary   Admin, Staff   counts of plans, tasks and overdue tasks
//   GET /api/dashboard/plans     Admin, Staff   progress of each plan (?status=&page=&limit=)
//   GET /api/audit               Admin          security log (?action=&result=&from=&to=&page=&limit=)
//   GET /api/dashboard/overdue          Admin, Staff   late tasks in Active plans
//   GET /api/dashboard/at-risk          Admin, Staff   plans with overdue or due-soon tasks
//   GET /api/dashboard/inactive-owners  Admin, Staff   open tasks owned by deactivated users
//   GET   /api/jobs/notifications        Vercel Cron   daily overdue / at-risk notifications (CRON_SECRET)

const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const crypto = require('node:crypto');
const { recordAudit } = require('../lib/audit');
const { parseId } = require('../lib/templateRules');

const router = express.Router();

const PLAN_STATUSES = ['Active', 'Completed', 'Cancelled'];



// Reads page and limit from the URL. Returns { page, limit } or { error } for a 400.
function readPaging(query) {
  const page = query.page === undefined ? 1 : Number(query.page);
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  if (!Number.isInteger(page) || page < 1) return { error: 'page must be a whole number of 1 or more' };
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return { error: 'limit must be a whole number from 1 to 100' };
  return { page, limit };
}

const AUDIT_RESULTS = ['allowed', 'denied'];

// Reads a date from the URL. Returns { value } (null if not given) or { error }.
function readDate(raw, name) {
  if (raw === undefined) return { value: null };
  const date = new Date(raw);
  if (typeof raw !== 'string' || Number.isNaN(date.getTime())) {
    return { error: `${name} must be a date, for example 2026-11-01` };
  }
  return { value: date.toISOString() };
}

const AT_RISK_DAYS = 2;   // "due soon" = due within this many days


router.get('/dashboard/summary', requireAuth, requireRole('Admin', 'Staff'), async (req, res, next) => {
  try {
    const db = pool.dashboardDb();   // read-only role
    const plans = await db.query(
      `SELECT status, COUNT(*)::int AS count FROM onboarding_plans GROUP BY status`
    );
    const tasks = await db.query(
      `SELECT t.status, COUNT(*)::int AS count
         FROM tasks t JOIN onboarding_plans p ON p.id = t.plan_id
        WHERE p.status = 'Active'
        GROUP BY t.status`
    );

    const overdue = await db.query(
      `SELECT COUNT(*)::int AS count
         FROM tasks t JOIN onboarding_plans p ON p.id = t.plan_id
        WHERE p.status = 'Active' AND t.status <> 'Done' AND t.due_date < CURRENT_DATE`
    );

    const planCounts = { active: 0, completed: 0, cancelled: 0 };
    for (const row of plans.rows) {
      planCounts[row.status.toLowerCase()] = row.count;
    }

    const taskKeys = { 'Not Started': 'notStarted', 'In Progress': 'inProgress', Done: 'done' };
    const taskCounts = { notStarted: 0, inProgress: 0, done: 0 };
    for (const row of tasks.rows) {
      taskCounts[taskKeys[row.status]] = row.count;
    }
    return res.json({
      plans: planCounts,
      tasks: taskCounts,
      overdueTasks: overdue.rows[0].count,
    });

  } catch (err) {
    return next(err);
  }
});
router.get('/dashboard/plans', requireAuth, requireRole('Admin', 'Staff'), async (req, res, next) => {
  try {
    // 1. check the URL options
    const status = req.query.status;
    if (status !== undefined && !PLAN_STATUSES.includes(status)) {
      return res.status(400).json({ error: "status must be 'Active', 'Completed' or 'Cancelled'" });
    }
    const paging = readPaging(req.query);
    if (paging.error) return res.status(400).json({ error: paging.error });
    const offset = (paging.page - 1) * paging.limit;

    // 2. run the query (read-only role)
    const { rows } = await pool.dashboardDb().query(
      `SELECT p.id, p.title, p.status, to_char(p.start_date, 'YYYY-MM-DD') AS start_date, u.name AS customer_name,
              COUNT(t.id)::int                                            AS total_tasks,
              COUNT(t.id) FILTER (WHERE t.status = 'Done')::int           AS done_tasks,
              COUNT(t.id) FILTER (WHERE t.status <> 'Done'
                                    AND t.due_date < CURRENT_DATE)::int   AS overdue_tasks,
                     to_char(MIN(t.due_date) FILTER (WHERE t.status <> 'Done'), 'YYYY-MM-DD') AS next_due_date
         FROM onboarding_plans p
         JOIN users u      ON u.id = p.customer_id
         LEFT JOIN tasks t ON t.plan_id = p.id
        WHERE ($1::text IS NULL OR p.status = $1)
        GROUP BY p.id, u.name
        ORDER BY overdue_tasks DESC, p.id
        LIMIT $2 OFFSET $3`,
      [status ?? null, paging.limit, offset]
    );



    // 3. turn each row into camelCase JSON, and work out progress
    const plans = rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      startDate: r.start_date,
      customerName: r.customer_name,
      totalTasks: r.total_tasks,
      doneTasks: r.done_tasks,
      overdueTasks: r.overdue_tasks,
      progress: r.total_tasks ? Math.round((r.done_tasks / r.total_tasks) * 100) : 0,
      nextDueDate: r.next_due_date,
    }));



    return res.json({ page: paging.page, limit: paging.limit, plans });
  } catch (err) {
    return next(err);
  }
});


// GET /api/audit   Admin only   security log, newest first (issue #37)
router.get('/audit', requireAuth, requireRole('Admin'), async (req, res, next) => {
  try {
    const { action, result } = req.query;
    if (action !== undefined && (typeof action !== 'string' || !/^[a-z_]{1,60}$/.test(action))) {
      return res.status(400).json({ error: 'action must be lowercase letters and _ only (max 60)' });
    }
    if (result !== undefined && !AUDIT_RESULTS.includes(result)) {
      return res.status(400).json({ error: "result must be 'allowed' or 'denied'" });
    }
    const from = readDate(req.query.from, 'from');
    if (from.error) return res.status(400).json({ error: from.error });
    const to = readDate(req.query.to, 'to');
    if (to.error) return res.status(400).json({ error: to.error });
    const paging = readPaging(req.query);
    if (paging.error) return res.status(400).json({ error: paging.error });

    const { rows } = await pool.dashboardDb().query(
      `SELECT a.id, a.action, a.entity, a.entity_id, a.result, a.ip_address,
              a.created_at, a.actor_id, u.name AS actor_name
         FROM audit_log a
         LEFT JOIN users u ON u.id = a.actor_id
        WHERE ($1::text        IS NULL OR a.action = $1)
          AND ($2::text        IS NULL OR a.result = $2)
          AND ($3::timestamptz IS NULL OR a.created_at >= $3)
          AND ($4::timestamptz IS NULL OR a.created_at <  $4)
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $5 OFFSET $6`,
      [action ?? null, result ?? null, from.value, to.value, paging.limit, (paging.page - 1) * paging.limit]
    );

    const entries = rows.map((r) => ({
      id: Number(r.id),
      action: r.action,
      entity: r.entity,
      // old Week 2 rows may hold an email here (threat model, known limit 6): never show it
      entityId: r.entity_id && r.entity_id.includes('@') ? null : r.entity_id,
      result: r.result,
      ipAddress: r.ip_address,
      actorId: r.actor_id,
      actorName: r.actor_name,
      createdAt: r.created_at,
    }));

    return res.json({ page: paging.page, limit: paging.limit, entries });
  } catch (err) {
    return next(err);
  }
});

// GET /api/dashboard/overdue   Admin, Staff   late tasks in Active plans (issue #38)
router.get('/dashboard/overdue', requireAuth, requireRole('Admin', 'Staff'), async (req, res, next) => {
  try {
    const paging = readPaging(req.query);
    if (paging.error) return res.status(400).json({ error: paging.error });

    const { rows } = await pool.dashboardDb().query(
      `SELECT t.id, t.title, t.status, to_char(t.due_date, 'YYYY-MM-DD') AS due_date,
              (CURRENT_DATE - t.due_date)::int AS days_overdue,
              p.id AS plan_id, p.title AS plan_title, u.name AS assignee_name
         FROM tasks t
         JOIN onboarding_plans p ON p.id = t.plan_id
         LEFT JOIN users u       ON u.id = t.assignee_id
        WHERE p.status = 'Active' AND t.status <> 'Done' AND t.due_date < CURRENT_DATE
        ORDER BY t.due_date, t.id
        LIMIT $1 OFFSET $2`,
      [paging.limit, (paging.page - 1) * paging.limit]
    );

    const tasks = rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      dueDate: r.due_date,
      daysOverdue: r.days_overdue,
      planId: r.plan_id,
      planTitle: r.plan_title,
      assigneeName: r.assignee_name,
    }));
    return res.json({ page: paging.page, limit: paging.limit, tasks });
  } catch (err) {
    return next(err);
  }
});

// GET /api/dashboard/at-risk   Admin, Staff   Active plans that need attention (issue #38)
router.get('/dashboard/at-risk', requireAuth, requireRole('Admin', 'Staff'), async (req, res, next) => {
  try {
    const paging = readPaging(req.query);
    if (paging.error) return res.status(400).json({ error: paging.error });

    const { rows } = await pool.dashboardDb().query(
      `SELECT p.id, p.title, c.name AS customer_name,
              COUNT(t.id) FILTER (WHERE t.status <> 'Done' AND t.due_date < CURRENT_DATE)::int AS overdue_tasks,
              COUNT(t.id) FILTER (WHERE t.status = 'Not Started'
                                    AND t.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + $1::int)::int AS due_soon_tasks
         FROM onboarding_plans p
         JOIN users c ON c.id = p.customer_id
         JOIN tasks t ON t.plan_id = p.id
        WHERE p.status = 'Active'
        GROUP BY p.id, c.name
       HAVING COUNT(t.id) FILTER (WHERE t.status <> 'Done' AND t.due_date < CURRENT_DATE) > 0
           OR COUNT(t.id) FILTER (WHERE t.status = 'Not Started'
                                    AND t.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + $1::int) > 0
        ORDER BY overdue_tasks DESC, due_soon_tasks DESC, p.id
        LIMIT $2 OFFSET $3`,
      [AT_RISK_DAYS, paging.limit, (paging.page - 1) * paging.limit]
    );

    const plans = rows.map((r) => {
      const reasons = [];
      if (r.overdue_tasks > 0) reasons.push('overdue_tasks');
      if (r.due_soon_tasks > 0) reasons.push('due_soon_not_started');
      return {
        id: r.id,
        title: r.title,
        customerName: r.customer_name,
        overdueTasks: r.overdue_tasks,
        dueSoonTasks: r.due_soon_tasks,
        reasons,
      };
    });
    return res.json({ page: paging.page, limit: paging.limit, atRiskDays: AT_RISK_DAYS, plans });
  } catch (err) {
    return next(err);
  }
});

// GET /api/dashboard/inactive-owners   Admin, Staff   open tasks owned by deactivated users (issue #38)
router.get('/dashboard/inactive-owners', requireAuth, requireRole('Admin', 'Staff'), async (req, res, next) => {
  try {
    const paging = readPaging(req.query);
    if (paging.error) return res.status(400).json({ error: paging.error });

    const { rows } = await pool.dashboardDb().query(
      `SELECT t.id, t.title, t.status, to_char(t.due_date, 'YYYY-MM-DD') AS due_date,
              p.id AS plan_id, p.title AS plan_title,
              u.id AS assignee_id, u.name AS assignee_name
         FROM tasks t
         JOIN onboarding_plans p ON p.id = t.plan_id
         JOIN users u            ON u.id = t.assignee_id
        WHERE p.status = 'Active' AND t.status <> 'Done' AND u.active = false
        ORDER BY t.due_date, t.id
        LIMIT $1 OFFSET $2`,
      [paging.limit, (paging.page - 1) * paging.limit]
    );

    const tasks = rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      dueDate: r.due_date,
      planId: r.plan_id,
      planTitle: r.plan_title,
      assigneeId: r.assignee_id,
      assigneeName: r.assignee_name,
    }));
    return res.json({ page: paging.page, limit: paging.limit, tasks });
  } catch (err) {
    return next(err);
  }
});

// ---- In-app notifications (issue #39) -----------------------------------------
// Every logged-in user, for their OWN notifications only. Uses the app role,
// because dashboard_ro has no access to notifications and notifier can only add rows.

// GET /api/notifications?unread=true&page=&limit=   my notifications, newest first
router.get('/notifications', requireAuth, async (req, res, next) => {
  try {
    const { unread } = req.query;
    if (unread !== undefined && unread !== 'true' && unread !== 'false') {
      return res.status(400).json({ error: "unread must be 'true' or 'false'" });
    }
    const paging = readPaging(req.query);
    if (paging.error) return res.status(400).json({ error: paging.error });

    const { rows } = await pool.db().query(
      `SELECT n.id, n.type, n.plan_id, n.task_id, n.created_at, n.read_at,
              p.title AS plan_title,
              CASE WHEN t.visibility = 'internal' AND $3 = 'Customer' THEN NULL ELSE t.title END AS task_title
         FROM notifications n
         JOIN onboarding_plans p ON p.id = n.plan_id
         LEFT JOIN tasks t       ON t.id = n.task_id
        WHERE n.user_id = $1
          AND n.channel = 'in_app'
          AND ($2::boolean = false OR n.read_at IS NULL)
        ORDER BY n.created_at DESC, n.id DESC
        LIMIT $4 OFFSET $5`,
      [req.user.id, unread === 'true', req.user.role, paging.limit, (paging.page - 1) * paging.limit]
    );

    const notifications = rows.map((r) => ({
      id: r.id,
      type: r.type,
      planId: r.plan_id,
      planTitle: r.plan_title,
      taskId: r.task_id,
      taskTitle: r.task_title,
      read: r.read_at !== null,
      readAt: r.read_at,
      createdAt: r.created_at,
    }));
    return res.json({ page: paging.page, limit: paging.limit, notifications });
  } catch (err) {
    return next(err);
  }
});

// GET /api/notifications/unread-count   number for the badge
router.get('/notifications/unread-count', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.db().query(
      `SELECT COUNT(*)::int AS count FROM notifications
        WHERE user_id = $1 AND channel = 'in_app' AND read_at IS NULL`,
      [req.user.id]
    );
    return res.json({ unread: rows[0].count });
  } catch (err) {
    return next(err);
  }
});

// PATCH /api/notifications/read-all   mark all of mine as read
router.patch('/notifications/read-all', requireAuth, async (req, res, next) => {
  try {
    const { rowCount } = await pool.db().query(
      `UPDATE notifications SET read_at = now()
        WHERE user_id = $1 AND channel = 'in_app' AND read_at IS NULL`,
      [req.user.id]
    );
    return res.json({ updated: rowCount });
  } catch (err) {
    return next(err);
  }
});

// PATCH /api/notifications/:id/read   mark one of mine as read (someone else's -> 404)
router.patch('/notifications/:id/read', requireAuth, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Notification not found' });

    const { rows } = await pool.db().query(
      `UPDATE notifications SET read_at = COALESCE(read_at, now())
        WHERE id = $1 AND user_id = $2 AND channel = 'in_app'
        RETURNING id, read_at`,
      [id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Notification not found' });
    return res.json({ id: rows[0].id, read: true, readAt: rows[0].read_at });
  } catch (err) {
    return next(err);
  }
});

// ---- Daily notification job (issue #41) -----------------------------------------
// Called once a day by Vercel Cron with "Authorization: Bearer <CRON_SECRET>".
// Runs as the notifier role: it can read plans/tasks and only ADD notifications.
// The notifications_once_per_day index + ON CONFLICT DO NOTHING mean a second
// run on the same day adds nothing.

// Compares the header with the secret in constant time (no timing leaks).
// Fails closed: no secret configured, or a short one, means nobody gets in.
function cronSecretOk(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 32) return false;
  const given = Buffer.from(req.get('authorization') || '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

router.get('/jobs/notifications', async (req, res, next) => {
  try {
    if (!cronSecretOk(req)) {
      await recordAudit({ actorId: null, action: 'job_denied', entity: 'job', entityId: 'notifications', result: 'denied', ip: req.ip });
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const db = pool.notifierDb();

    // 1. overdue: the owner of each late task (staff task -> assignee, customer task -> the plan's customer)
    const overdue = await db.query(
      `INSERT INTO notifications (user_id, plan_id, task_id, type, channel)
       SELECT u.id, p.id, t.id, 'overdue', 'in_app'
         FROM tasks t
         JOIN onboarding_plans p ON p.id = t.plan_id
         JOIN users u ON u.id = CASE WHEN t.actor = 'customer' THEN p.customer_id ELSE t.assignee_id END
        WHERE p.status = 'Active' AND t.status <> 'Done' AND t.due_date < CURRENT_DATE AND u.active
       ON CONFLICT DO NOTHING`
    );

    // 2. at_risk: every active Admin, once per at-risk plan (same rule as /dashboard/at-risk)
    const atRisk = await db.query(
      `INSERT INTO notifications (user_id, plan_id, task_id, type, channel)
       SELECT a.id, p.id, NULL, 'at_risk', 'in_app'
         FROM onboarding_plans p
         JOIN users a ON a.role = 'Admin' AND a.active
        WHERE p.status = 'Active'
          AND EXISTS (
                SELECT 1 FROM tasks t
                 WHERE t.plan_id = p.id
                   AND (   (t.status <> 'Done' AND t.due_date < CURRENT_DATE)
                        OR (t.status = 'Not Started' AND t.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + $1::int)))
       ON CONFLICT DO NOTHING`,
      [AT_RISK_DAYS]
    );

    const result = { overdue: overdue.rowCount, atRisk: atRisk.rowCount };
    await recordAudit({ actorId: null, action: 'job_notifications', entity: 'job', entityId: `overdue=${result.overdue},at_risk=${result.atRisk}`, result: 'allowed', ip: req.ip });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});
module.exports = router;


