// Dashboard screen (issue #40). Owner: Jana Hossam.
// Admin and Staff only. Reads my read-only dashboard API:
//   GET /api/dashboard/summary, /plans, /overdue, /at-risk, /inactive-owners
// All text is added with textContent (through ui.el), never innerHTML.

(() => {
  const user = auth.requireLogin(['Admin', 'Staff']);
  if (!user) return;

  const { el, clear, showMessage, hideMessage } = ui;
  const $ = (id) => document.getElementById(id);
  const message = $('page-message');
  const PAGE_SIZE = 10;
    // "2026-12-01" -> "1 Dec 2026", read as a LOCAL date (no time-zone shift).
  function formatDay(value) {
    if (!value) return '–';
    const [y, m, d] = String(value).split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  let page = 1;

  // ---- summary tiles -----------------------------------------------------------
  function tile(label, value, warnWhenAboveZero = false) {
    const warn = warnWhenAboveZero && value > 0;
    return el('div', { className: warn ? 'stat warn' : 'stat' },
      el('span', { className: 'stat-value' }, String(value)),
      el('span', { className: 'stat-label' }, label));
  }

  async function loadSummary() {
    const s = await api.get('/api/dashboard/summary');
    const box = $('summary');
    clear(box);
    box.append(
      tile('Active plans', s.plans.active),
      tile('Completed plans', s.plans.completed),
      tile('Cancelled plans', s.plans.cancelled),
      tile('Tasks not started', s.tasks.notStarted),
      tile('Tasks in progress', s.tasks.inProgress),
      tile('Tasks done', s.tasks.done),
      tile('Overdue tasks', s.overdueTasks, true),
    );
  }

  // ---- shared table helper -----------------------------------------------------------
  // Fills a <tbody> with one <tr> per item; shows the "empty" text when there are none.
  function fillTable(tbodyId, emptyId, items, cellsFor) {
    const tbody = $(tbodyId);
    clear(tbody);
    for (const item of items) {
      tbody.append(el('tr', {}, ...cellsFor(item).map((cell) => el('td', {}, cell))));
    }
    $(emptyId).hidden = items.length > 0;
  }

  // ---- plan progress (with status filter and paging) ----------------------------------
  async function loadPlans() {
    const query = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    const status = $('status-filter').value;
    if (status) query.set('status', status);

    const data = await api.get(`/api/dashboard/plans?${query}`);
    fillTable('plan-rows', 'plans-empty', data.plans, (p) => [
      p.title,
      p.customerName,
      el('span', { className: `badge ${p.status === 'Active' ? 'active' : ''}` }, p.status),
      el('span', {},
        el('progress', { max: 100, value: p.progress, 'aria-label': `${p.progress}% done` }),
        ` ${p.progress}% (${p.doneTasks}/${p.totalTasks})`),
      p.overdueTasks > 0 ? el('span', { className: 'error' }, String(p.overdueTasks)) : '0',
      formatDay(p.nextDueDate)
    ]);

    $('page-label').textContent = `Page ${page}`;
    $('prev-page').disabled = page === 1;
    $('next-page').disabled = data.plans.length < PAGE_SIZE; // a short page is the last one
  }

  // ---- needs attention ------------------------------------------------------------------
  async function loadAttention() {
    const [overdue, risk, inactive] = await Promise.all([
      api.get('/api/dashboard/overdue?limit=20'),
      api.get('/api/dashboard/at-risk?limit=20'),
      api.get('/api/dashboard/inactive-owners?limit=20'),
    ]);

    fillTable('overdue-rows', 'overdue-empty', overdue.tasks, (t) => [
      t.title, t.planTitle, t.assigneeName || '(no owner)', formatDay(t.dueDate),
      el('span', { className: 'error' }, String(t.daysOverdue)),
    ]);

    $('risk-days').textContent = String(risk.atRiskDays);
    const reasonText = { overdue_tasks: 'overdue task', due_soon_not_started: 'due soon, not started' };
    fillTable('risk-rows', 'risk-empty', risk.plans, (p) => [
      p.title, p.customerName, String(p.overdueTasks), String(p.dueSoonTasks),
      p.reasons.map((r) => reasonText[r] || r).join(', '),
    ]);

    fillTable('inactive-rows', 'inactive-empty', inactive.tasks, (t) => [
      t.title, t.planTitle, t.assigneeName, t.status, formatDay(t.dueDate),
    ]);
  }

  // ---- load everything; one error message for the whole page ---------------------------
  async function run(task) {
    hideMessage(message);
    try {
      await task();
    } catch (err) {
      showMessage(message, err.message, 'error');
    }
  }

  const loadAll = () => run(() => Promise.all([loadSummary(), loadPlans(), loadAttention()]));

  $('status-filter').addEventListener('change', () => { page = 1; run(loadPlans); });
  $('plan-filters').addEventListener('submit', (e) => e.preventDefault());
  $('prev-page').addEventListener('click', () => { if (page > 1) { page -= 1; run(loadPlans); } });
  $('next-page').addEventListener('click', () => { page += 1; run(loadPlans); });
  $('refresh').addEventListener('click', (e) => ui.busy(e.currentTarget, loadAll));

  loadAll();
})();
