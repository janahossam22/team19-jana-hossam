// Audit-log screen (issue #42). Owner: Jana Hossam.
// Admin only. Reads GET /api/audit (read-only role on the server).
// All text is added with textContent (through ui.el), never innerHTML.

(() => {
  const user = auth.requireLogin(['Admin']);
  if (!user) return;

  const { el, clear, showMessage, hideMessage } = ui;
  const $ = (id) => document.getElementById(id);
  const message = $('page-message');
  const PAGE_SIZE = 25;
  let page = 1;

  // A date from <input type="date"> ("2026-11-25") as the start of that day in local time.
  function startOfDay(value) {
    return new Date(`${value}T00:00`).toISOString();
  }
  // "To" is inclusive for the user, so ask the API for everything before the NEXT day.
  function startOfNextDay(value) {
    const d = new Date(`${value}T00:00`);
    d.setDate(d.getDate() + 1);
    return d.toISOString();
  }

  function formatTime(value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime())
      ? String(value)
      : d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  }

  function buildQuery() {
    const query = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    const action = $('action').value.trim();
    if (action) {
      // same rule as the API, so the user gets a clear message before any request
      if (!/^[a-z_]{1,60}$/.test(action)) {
        throw new Error('Action must be lowercase letters and _ only, for example login_failed.');
      }
      query.set('action', action);
    }
    if ($('result').value) query.set('result', $('result').value);
    if ($('from').value) query.set('from', startOfDay($('from').value));
    if ($('to').value) query.set('to', startOfNextDay($('to').value));
    if ($('from').value && $('to').value && $('from').value > $('to').value) {
      throw new Error('"From" must be on or before "To".');
    }
    return query;
  }

  async function load() {
    hideMessage(message);
    try {
      const data = await api.get(`/api/audit?${buildQuery()}`);
      const tbody = $('audit-rows');
      clear(tbody);
      for (const e of data.entries) {
        const record = e.entity ? `${e.entity}${e.entityId ? ` #${e.entityId}` : ''}` : '–';
        tbody.append(el('tr', {},
          el('td', {}, formatTime(e.createdAt)),
          el('td', {}, e.actorName || (e.actorId ? `user #${e.actorId}` : 'system / not logged in')),
          el('td', {}, el('code', {}, e.action)),
          el('td', {}, record),
          el('td', {}, el('span', { className: `badge ${e.result === 'denied' ? 'denied' : 'active'}` }, e.result)),
          el('td', {}, e.ipAddress || '–'),
        ));
      }
      $('audit-empty').hidden = data.entries.length > 0;
      $('page-label').textContent = `Page ${page}`;
      $('prev-page').disabled = page === 1;
      $('next-page').disabled = data.entries.length < PAGE_SIZE;
    } catch (err) {
      showMessage(message, err.message, 'error');
    }
  }

  $('filters').addEventListener('submit', (e) => { e.preventDefault(); page = 1; load(); });
  $('clear').addEventListener('click', () => { $('filters').reset(); page = 1; load(); });
  $('prev-page').addEventListener('click', () => { if (page > 1) { page -= 1; load(); } });
  $('next-page').addEventListener('click', () => { page += 1; load(); });

  load();
})();
