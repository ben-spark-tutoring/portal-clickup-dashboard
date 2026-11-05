// scripts/refresh-data.js
// Run by the GitHub Actions workflow on a schedule (see .github/workflows/refresh.yml).
// Pulls live data from ClickUp, computes rolled-up dev hours per task by walking
// the full subtask tree, and writes the result to public/data.json — which
// Vercel then serves as a plain static file. The dashboard page fetches that
// static file directly; it never talks to ClickUp itself.
//
// This uses the same direct-per-task-fetch method proven correct earlier in
// this project (see the comments in the git history of api/data.js for the
// three earlier approaches that were each wrong in different ways — bulk-pull
// summing is not reliable for this ClickUp workspace's task structure).
//
// A small concurrency limiter is used to avoid bursting past ClickUp's rate
// limit, since this script — unlike the old on-request version — now has the
// luxury of not being time-pressured by a serverless timeout, so there's no
// reason not to be gentle with the API.

const fs = require('fs');
const path = require('path');

const TOKEN = process.env.CLICKUP_API_TOKEN;
if (!TOKEN) {
  console.error('CLICKUP_API_TOKEN is not set (check your GitHub Actions secret).');
  process.exit(1);
}

const LIST_ID = '901411533253'; // Developments / Portal Projects
const VERSION_FIELD_ID = '3320c289-6741-479b-b10c-fba72d5780d0';
const PROJECT_FIELD_ID = 'f5f09764-8847-4751-8dc8-ae7f2447d059';
const PROGRESS_FIELD_ID = '5c9d36d8-ea95-4740-8234-a05ca8c38ac7';
const OUTPUT_PATH = path.join(__dirname, '..', 'data.json');
const HISTORY_PATH = path.join(__dirname, '..', 'history.json');
const HISTORY_MAX_ENTRIES = 4000; // safety net only; compactHistory() keeps the file far below this
const HISTORY_FULL_DETAIL_DAYS = 14; // keep every 15-minute point for this long, then one point per day

// Keeps full detail for the last two weeks and one point per day before that, so the trend can
// cover months instead of being cut off after ~42 days. The kept point for each old day is the
// median by V1 dev hours, so a one-cycle glitch can't be the one that survives.
function compactHistory(history, nowMs) {
  const cutoff = nowMs - HISTORY_FULL_DETAIL_DAYS * 86400000;
  const recent = [];
  const byDay = new Map();
  for (const h of history) {
    if (new Date(h.t).getTime() >= cutoff) { recent.push(h); continue; }
    const day = h.t.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(h);
  }
  const thinned = [];
  for (const day of [...byDay.keys()].sort()) {
    const list = byDay.get(day).sort((a, b) => (a.v1_dev_hours || 0) - (b.v1_dev_hours || 0));
    thinned.push(list[Math.floor(list.length / 2)]);
  }
  return [...thinned, ...recent];
}
// One-time repair of the 3-5 Nov readings. On 3 Nov five tasks moved from Pre Launch to Post
// Launch, and until Post Launch was excluded from dev hours those readings counted their hours as
// build work (V1 +61h, V2 +1,070h), which drew a false spike in the trend chart. Readings written
// by the current code carry post_launch_hours, so this only touches the old ones, it only fires if
// the Pre Launch drop matches those two figures exactly, and once repaired it never matches again.
const POST_LAUNCH_V1_HOURS = 61;
const POST_LAUNCH_V2_HOURS = 1070;
function repairPostLaunchReadings(history) {
  const total = POST_LAUNCH_V1_HOURS + POST_LAUNCH_V2_HOURS;
  const first = history.findIndex((h, k) => k > 0
    && h.post_launch_hours === undefined
    && history[k - 1].pre_launch_hours !== undefined && h.pre_launch_hours !== undefined
    && Math.abs((history[k - 1].pre_launch_hours - h.pre_launch_hours) - total) < 1);
  if (first < 0) return history;
  console.log(`Repairing history readings from ${history[first].t} onward (Post Launch hours were counted as dev hours).`);
  return history.map((h, k) => (k >= first && h.post_launch_hours === undefined)
    ? { ...h, v1_dev_hours: h.v1_dev_hours - POST_LAUNCH_V1_HOURS, v2_dev_hours: h.v2_dev_hours - POST_LAUNCH_V2_HOURS, post_launch_hours: total }
    : h);
}
const CHANGELOG_PATH = path.join(__dirname, '..', 'changelog.json');
const CHANGELOG_MAX_ENTRIES = 500; // individual change events, not runs — a busy day can use these up faster than history.json's entries
const MAX_CONCURRENT = 1; // fully sequential — no reason to risk concurrency now this runs unattended
const MIN_INTERVAL_MS = 1200; // ~50/min, a real safety margin under ClickUp's limit, not just barely under it

// --- rate-paced limiter: caps concurrency AND spaces out request starts ---
function createLimiter(maxConcurrent, minIntervalMs) {
  let active = 0;
  let lastStart = 0;
  const queue = [];
  const tryNext = () => {
    if (!queue.length || active >= maxConcurrent) return;
    const wait = Math.max(0, minIntervalMs - (Date.now() - lastStart));
    setTimeout(() => {
      if (active >= maxConcurrent || !queue.length) return;
      const { fn, resolve, reject } = queue.shift();
      active++;
      lastStart = Date.now();
      fn().then(resolve, reject).finally(() => { active--; tryNext(); });
      tryNext(); // let another slot start filling if concurrency allows
    }, wait);
  };
  return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); tryNext(); });
}
const limit = createLimiter(MAX_CONCURRENT, MIN_INTERVAL_MS);

async function clickupFetch(url, attempt = 0) {
  const res = await fetch(url, { headers: { Authorization: TOKEN } });
  const isRateLimit = res.status === 429;
  const isServerError = res.status >= 500 && res.status < 600;

  if ((isRateLimit || isServerError) && attempt < 6) {
    const backoff = Math.min(30000, 1000 * 2 ** attempt); // 1s, 2s, 4s, 8s, 16s, 30s
    const reason = isRateLimit ? 'Rate limited' : `ClickUp server error (${res.status})`;
    console.log(`${reason}, waiting ${backoff}ms before retry ${attempt + 1}/6…`);
    await new Promise(r => setTimeout(r, backoff));
    return clickupFetch(url, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`ClickUp API error ${res.status} for ${url}: ${await res.text()}`);
  }
  return res.json();
}

async function fetchTopLevelTasks() {
  const all = [];
  let page = 0;
  while (true) {
    const url = `https://api.clickup.com/api/v2/list/${LIST_ID}/task?include_closed=true&page=${page}`;
    const data = await limit(() => clickupFetch(url));
    all.push(...data.tasks);
    if (data.last_page || !data.tasks.length) break;
    page++;
    if (page > 20) break;
  }
  return all;
}

function getCustomFieldValue(task, fieldId) {
  const f = (task.custom_fields || []).find(cf => cf.id === fieldId);
  return f ? f.value : null;
}

function versionLabel(task) {
  const v = getCustomFieldValue(task, VERSION_FIELD_ID);
  if (v === null || v === undefined) return null;
  const f = (task.custom_fields || []).find(cf => cf.id === VERSION_FIELD_ID);
  const opt = f && f.type_config && f.type_config.options && f.type_config.options[v];
  return opt ? opt.name : null;
}

async function fetchSubtreeHours(taskId, depth = 0) {
  if (depth > 8) return null;
  const task = await limit(() =>
    clickupFetch(`https://api.clickup.com/api/v2/task/${taskId}?include_subtasks=true`)
  );
  const kids = task.subtasks || [];
  const ownHours = task.time_estimate ? task.time_estimate / 1000 / 3600 : null;

  if (!kids.length) {
    return ownHours;
  }

  // A parent can carry its own directly-set estimate IN ADDITION TO having
  // subtasks with their own estimates — ClickUp's rollup adds them together,
  // it doesn't treat "has children" as "ignore my own number." Sum both.
  const kidHoursList = await Promise.all(kids.map(kid => fetchSubtreeHours(kid.id, depth + 1)));
  const knownKidHours = kidHoursList.filter(h => h !== null);
  const childSum = knownKidHours.length ? knownKidHours.reduce((a, b) => a + b, 0) : null;

  if (ownHours === null && childSum === null) return null;
  return (ownHours || 0) + (childSum || 0);
}

async function main() {
  console.log('Fetching top-level tasks…');
  const allTasks = await fetchTopLevelTasks();

  const epics = allTasks.filter(t => {
    if (t.parent) return false;
    const v = versionLabel(t);
    return v === 'v1' || v === 'v2';
  });
  console.log(`Found ${epics.length} version-tagged epics. Walking subtask trees…`);

  // Last good values from the previous run. If ClickUp fails for one task after all retries, we
  // keep its last known hours instead of reporting "unknown" — otherwise a one-cycle glitch shows
  // up as a fake drop in the history chart and a pair of fake changes in the changelog.
  const lastKnownHours = new Map();
  try {
    if (fs.existsSync(OUTPUT_PATH)) {
      for (const pt of (JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8')).tasks || [])) {
        lastKnownHours.set(pt.id, pt.time_estimate_hours);
      }
    }
  } catch { /* no usable previous file, so nothing to carry forward */ }

  const results = await Promise.all(epics.map(async t => {
    const version = versionLabel(t);
    let hours;
    try {
      hours = await fetchSubtreeHours(t.id);
    } catch (err) {
      const carried = lastKnownHours.has(t.id) ? lastKnownHours.get(t.id) : null;
      console.warn(`Giving up on hours for "${t.name}" (${t.id}) after retries: ${err.message} — keeping last known value (${carried})`);
      hours = carried; // one bad task shouldn't take down the whole run, or fake a change
    }
    const project = getCustomFieldValue(t, PROJECT_FIELD_ID) || 'Unassigned';
    const progressRaw = getCustomFieldValue(t, PROGRESS_FIELD_ID);
    const progress_pct = progressRaw && typeof progressRaw === 'object' && 'percent_complete' in progressRaw
      ? progressRaw.percent_complete
      : (typeof progressRaw === 'number' ? progressRaw : null);

    return {
      id: t.id,
      name: t.name,
      status: (t.status && t.status.status || '').toLowerCase(),
      version,
      project,
      time_estimate_hours: hours,
      has_subtasks: hours !== null || (t.subtasks_count || 0) > 0,
      progress_pct,
      due_date: t.due_date ? Number(t.due_date) : null, // ms epoch, matches JS Date
      date_updated: t.date_updated ? Number(t.date_updated) : null,
      assignees: (t.assignees || []).map(a => a.username || a.email || `user_${a.id}`),
    };
  }));

  const generated_at = new Date().toISOString();

  // --- diff against the previous run BEFORE overwriting data.json, so we can
  // record what actually changed. Skipped entirely on the very first run
  // (no previous file = no real baseline, not "everything was just added").
  if (fs.existsSync(OUTPUT_PATH)) {
    try {
      const prevOutput = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
      const prevResults = prevOutput.tasks || [];
      const prevById = new Map(prevResults.map(t => [t.id, t]));
      const newById = new Map(results.map(t => [t.id, t]));
      const events = [];

      for (const t of results) {
        const prev = prevById.get(t.id);
        if (!prev) {
          events.push({ t: generated_at, type: 'added', task: t.name, version: t.version, project: t.project, hours: t.time_estimate_hours });
          continue;
        }
        const prevHours = prev.time_estimate_hours;
        const newHours = t.time_estimate_hours;
        const hoursDiffer = prevHours !== newHours && !(prevHours === null && newHours === null);
        if (hoursDiffer) {
          const delta = (newHours || 0) - (prevHours || 0);
          if (Math.abs(delta) > 0.05 || (prevHours === null) !== (newHours === null)) {
            events.push({ t: generated_at, type: 'hours_changed', task: t.name, version: t.version, project: t.project, from: prevHours, to: newHours, delta: Math.round(delta * 100) / 100 });
          }
        }
        if (prev.status !== t.status) {
          events.push({ t: generated_at, type: 'status_changed', task: t.name, version: t.version, project: t.project, from: prev.status, to: t.status });
        }
      }
      for (const p of prevResults) {
        if (!newById.has(p.id)) {
          events.push({ t: generated_at, type: 'removed', task: p.name, version: p.version, project: p.project });
        }
      }

      if (events.length) {
        let changelog = [];
        if (fs.existsSync(CHANGELOG_PATH)) {
          try {
            changelog = JSON.parse(fs.readFileSync(CHANGELOG_PATH, 'utf8'));
            if (!Array.isArray(changelog)) changelog = [];
          } catch {
            changelog = [];
          }
        }
        changelog.push(...events);
        if (changelog.length > CHANGELOG_MAX_ENTRIES) {
          changelog = changelog.slice(changelog.length - CHANGELOG_MAX_ENTRIES);
        }
        fs.writeFileSync(CHANGELOG_PATH, JSON.stringify(changelog));
        console.log(`Recorded ${events.length} change event(s) to ${CHANGELOG_PATH}`);
      } else {
        console.log('No changes detected since last run.');
      }
    } catch (err) {
      console.warn('Could not compute changelog diff (continuing anyway):', err.message);
    }
  } else {
    console.log('No previous data.json found — skipping changelog on this first run.');
  }
  if (!fs.existsSync(CHANGELOG_PATH)) {
    fs.writeFileSync(CHANGELOG_PATH, '[]'); // ensure it always exists so `git add` never fails on a missing file
  }

  const output = {
    generated_at,
    tasks: results,
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Wrote ${results.length} tasks to ${OUTPUT_PATH}`);

  // --- append a compact snapshot to history.json for the trend chart ---
  const DEV_STATUSES = ['to do', 'in progress', 'bugs', 'ui ux fixes', 'infrastructure'];
  const sum = (list) => list.reduce((a, b) => a + (b.time_estimate_hours || 0), 0);
  const snapshot = {
    t: output.generated_at,
    // Pre Launch and Post Launch are excluded from dev hours (matches the dashboard cards) and
    // tracked on their own lines. 'in review' (built, awaiting department review) is tracked
    // separately from testing, and like testing it is not counted as build work.
    v1_dev_hours: sum(results.filter(r => r.version === 'v1' && DEV_STATUSES.includes(r.status) && r.project !== 'Pre Launch' && r.project !== 'Post Launch')),
    v2_dev_hours: sum(results.filter(r => r.version === 'v2' && DEV_STATUSES.includes(r.status) && r.project !== 'Pre Launch' && r.project !== 'Post Launch')),
    pre_launch_hours: sum(results.filter(r => DEV_STATUSES.includes(r.status) && r.project === 'Pre Launch')),
    post_launch_hours: sum(results.filter(r => DEV_STATUSES.includes(r.status) && r.project === 'Post Launch')),
    v1_testing_hours: sum(results.filter(r => r.version === 'v1' && r.status === 'testing')),
    v2_testing_hours: sum(results.filter(r => r.version === 'v2' && r.status === 'testing')),
    v1_review_hours: sum(results.filter(r => r.version === 'v1' && r.status === 'in review')),
    v2_review_hours: sum(results.filter(r => r.version === 'v2' && r.status === 'in review')),
  };

  let history = [];
  if (fs.existsSync(HISTORY_PATH)) {
    try {
      history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
      if (!Array.isArray(history)) history = [];
      history = repairPostLaunchReadings(history);
    } catch {
      history = []; // corrupt/unreadable — start fresh rather than fail the whole run
    }
  }
  history.push(snapshot);
  history = compactHistory(history, Date.parse(output.generated_at));
  if (history.length > HISTORY_MAX_ENTRIES) {
    history = history.slice(history.length - HISTORY_MAX_ENTRIES);
  }
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history));
  console.log(`Appended snapshot to ${HISTORY_PATH} (${history.length} entries total)`);
}

main().catch(err => {
  console.error('Refresh failed:', err);
  process.exit(1);
});
