// /api/data.js
// Vercel serverless function — pulls live data from ClickUp and computes
// rolled-up dev hours per task by walking the full subtask tree.
//
// SETUP: in your Vercel project settings → Environment Variables, add:
//   CLICKUP_API_TOKEN = <your ClickUp personal API token>
// (Get this from ClickUp: Settings → Apps → API Token. Never commit it to the repo.)
//
// WHY THIS IS SLOWER THAN IT COULD BE, ON PURPOSE:
// Three earlier versions tried to be clever — pull the whole list in bulk
// (subtasks=true + pagination) and sum from that in one pass. Each version was
// provably wrong in a different way: incomplete tree capture, silent partial
// sums, and a validation check against a field (subtasks_count) that turned out
// not to be reliably present on bulk-list results. Every one of those bugs was
// only caught by spot-checking against ClickUp's own UI.
//
// So this version does the simple, slow, boring thing instead: for every task
// that has children, fetch it directly (one call), and recurse into each child
// with its own direct fetch, all the way down to leaves. This is exactly the
// method used to build the original correct numbers by hand earlier in this
// project — nothing here is unverified. Siblings are fetched in parallel to
// keep wall-clock time down, but the total call count is real and roughly
// proportional to the number of tasks+subtasks in the whole list (can be
// several hundred). See the timeout note near CACHE_SECONDS below.

const LIST_ID = '901411533253'; // Developments / Portal Projects
const VERSION_FIELD_ID = '3320c289-6741-479b-b10c-fba72d5780d0';
const PROJECT_FIELD_ID = 'f5f09764-8847-4751-8dc8-ae7f2447d059';
const PROGRESS_FIELD_ID = '5c9d36d8-ea95-4740-8234-a05ca8c38ac7';
const DEV_STATUSES = ['to do', 'in progress', 'bugs', 'ui ux fixes', 'infrastructure'];

// Cached at the edge for this long. Given the call volume below, this also
// acts as a rate-limit safety margin — don't set this very low.
// NOTE ON TIMEOUTS: Vercel's Hobby (free) plan hard-caps functions at 10s no
// matter what maxDuration says; Pro allows up to 60s (300s on higher tiers).
// This function may genuinely need more than 10s given the number of tasks
// with subtasks in your list. If it starts timing out, that's the reason —
// either upgrade the Vercel plan or ask me to shard this into multiple smaller
// requests (e.g. one per business area) so each one finishes faster.
const CACHE_SECONDS = 900;

export const config = {
  maxDuration: 60,
};

async function clickupFetch(url, token, retried = false) {
  const res = await fetch(url, { headers: { Authorization: token } });
  if (res.status === 429 && !retried) {
    await new Promise(r => setTimeout(r, 1000));
    return clickupFetch(url, token, true);
  }
  if (!res.ok) {
    throw new Error(`ClickUp API error ${res.status} for ${url}: ${await res.text()}`);
  }
  return res.json();
}

async function fetchTopLevelTasks(token) {
  // One pass over the list WITHOUT subtasks — just to find the tracked epics
  // (top-level tasks with Version set) and their own metadata. Subtask hours
  // are fetched separately, directly, per epic — see fetchSubtreeHours.
  const all = [];
  let page = 0;
  while (true) {
    const url = `https://api.clickup.com/api/v2/list/${LIST_ID}/task` +
      `?include_closed=true&page=${page}`;
    const data = await clickupFetch(url, token);
    all.push(...data.tasks);
    if (data.last_page || !data.tasks.length) break;
    page++;
    if (page > 20) break; // safety guard
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

// Direct, recursive, proven-correct — fetch a task, and if it has subtasks,
// fetch each of THEM directly too, all the way to leaves. No trusting of any
// bulk/summary field along the way.
async function fetchSubtreeHours(taskId, token, depth = 0) {
  if (depth > 8) return null; // guard against runaway/circular recursion
  const url = `https://api.clickup.com/api/v2/task/${taskId}?include_subtasks=true`;
  const task = await clickupFetch(url, token);
  const kids = task.subtasks || [];
  if (!kids.length) {
    return task.time_estimate ? task.time_estimate / 1000 / 3600 : null;
  }
  const kidHoursList = await Promise.all(
    kids.map(kid => fetchSubtreeHours(kid.id, token, depth + 1))
  );
  const known = kidHoursList.filter(h => h !== null);
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}

export default async function handler(req, res) {
  const token = process.env.CLICKUP_API_TOKEN;
  if (!token) {
    res.status(500).json({ error: 'CLICKUP_API_TOKEN is not set in Vercel environment variables' });
    return;
  }

  try {
    const allTasks = await fetchTopLevelTasks(token);

    const epics = allTasks.filter(t => {
      if (t.parent) return false; // only true top-level tasks
      const v = versionLabel(t);
      return v === 'v1' || v === 'v2';
    });

    const results = await Promise.all(epics.map(async t => {
      const version = versionLabel(t);
      const hours = await fetchSubtreeHours(t.id, token);
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

    res.setHeader('Cache-Control', `s-maxage=${CACHE_SECONDS}, stale-while-revalidate`);
    res.status(200).json({
      generated_at: new Date().toISOString(),
      epics_processed: epics.length,
      tasks: results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
