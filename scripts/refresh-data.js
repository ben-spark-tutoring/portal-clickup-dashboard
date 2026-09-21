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
const MAX_CONCURRENT = 6; // gentle pacing — no reason to rush now

// --- tiny concurrency limiter, no dependencies ---
function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}
const limit = createLimiter(MAX_CONCURRENT);

async function clickupFetch(url, retried = false) {
  const res = await fetch(url, { headers: { Authorization: TOKEN } });
  if (res.status === 429 && !retried) {
    await new Promise(r => setTimeout(r, 3000));
    return clickupFetch(url, true);
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
    const data = await clickupFetch(url);
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
  if (!kids.length) {
    return task.time_estimate ? task.time_estimate / 1000 / 3600 : null;
  }
  const kidHoursList = await Promise.all(kids.map(kid => fetchSubtreeHours(kid.id, depth + 1)));
  const known = kidHoursList.filter(h => h !== null);
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
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

  const results = await Promise.all(epics.map(async t => {
    const version = versionLabel(t);
    const hours = await fetchSubtreeHours(t.id);
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
    };
  }));

  const output = {
    generated_at: new Date().toISOString(),
    tasks: results,
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Wrote ${results.length} tasks to ${OUTPUT_PATH}`);
}

main().catch(err => {
  console.error('Refresh failed:', err);
  process.exit(1);
});
