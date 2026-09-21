// /api/data.js
// Vercel serverless function — pulls live data from ClickUp, computes rolled-up
// dev hours per task (walking the full subtask tree), and returns it as JSON
// for the dashboard frontend to render.
//
// SETUP: in your Vercel project settings → Environment Variables, add:
//   CLICKUP_API_TOKEN = <your ClickUp personal API token>
// (Get this from ClickUp: Settings → Apps → API Token. Never commit it to the repo.)
//
// Freshness: responses are cached at the edge for CACHE_SECONDS. This is a
// deliberate choice, not a limitation glossed over: computing this from scratch
// requires paging through the whole list and rebuilding the subtask tree, and
// doing that on every single page view would risk hitting ClickUp's API rate
// limits under real traffic. 15 minutes is a reasonable freshness window for a
// weekly-report dashboard; lower CACHE_SECONDS if you want it fresher and are
// comfortable with the added API load.

const LIST_ID = '901411533253'; // Developments / Portal Projects
const VERSION_FIELD_ID = '3320c289-6741-479b-b10c-fba72d5780d0';
const PROJECT_FIELD_ID = 'f5f09764-8847-4751-8dc8-ae7f2447d059';
const PROGRESS_FIELD_ID = '5c9d36d8-ea95-4740-8234-a05ca8c38ac7';
const DEV_STATUSES = ['to do', 'in progress', 'bugs', 'ui ux fixes', 'infrastructure'];
const CACHE_SECONDS = 900; // 15 minutes

export const config = {
  maxDuration: 30, // fallback fetches are sequential; give them room (Hobby plan caps at 10s — see note below)
};

async function fetchAllTasks(token) {
  const all = [];
  let page = 0;
  while (true) {
    const url = `https://api.clickup.com/api/v2/list/${LIST_ID}/task` +
      `?subtasks=true&include_closed=true&page=${page}`;
    const res = await fetch(url, { headers: { Authorization: token } });
    if (!res.ok) {
      throw new Error(`ClickUp API error ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    all.push(...data.tasks);
    if (data.last_page || !data.tasks.length) break;
    page++;
    if (page > 20) break; // safety guard against runaway pagination
  }
  return all;
}

function getCustomFieldValue(task, fieldId) {
  const f = (task.custom_fields || []).find(cf => cf.id === fieldId);
  return f ? f.value : null;
}

// Fallback: ClickUp's bulk list endpoint (subtasks=true + pagination) does not
// reliably return every level of deeply nested subtasks in one pull — some
// families come through complete, others get cut off partway down the tree.
// When the bulk pull leaves a task with no computable hours despite having
// children, re-fetch that task's subtree directly via the single-task endpoint,
// which is slower but has proven reliable (it's how the original correct
// numbers were gathered). This only runs for the handful of tasks the bulk
// pull got wrong, not for all 76 epics, so it stays well within rate limits.
async function fetchSubtreeDirect(taskId, token, depth = 0) {
  if (depth > 6) return null; // guard against runaway/circular recursion
  const url = `https://api.clickup.com/api/v2/task/${taskId}?include_subtasks=true`;
  const res = await fetch(url, { headers: { Authorization: token } });
  if (!res.ok) return null; // don't let one bad fetch kill the whole response
  const task = await res.json();
  const kids = task.subtasks || [];
  if (!kids.length) {
    return task.time_estimate ? task.time_estimate / 1000 / 3600 : null;
  }
  let total = 0, any = false;
  for (const kid of kids) {
    const kidHours = (kid.subtasks && kid.subtasks.length)
      ? await fetchSubtreeDirect(kid.id, token, depth + 1)
      : (kid.time_estimate ? kid.time_estimate / 1000 / 3600 : null);
    if (kidHours !== null) { total += kidHours; any = true; }
  }
  return any ? total : null;
}

function versionLabel(task) {
  const v = getCustomFieldValue(task, VERSION_FIELD_ID);
  if (v === null || v === undefined) return null;
  // Dropdown fields return the option's orderindex; resolve it against the field's options.
  const f = (task.custom_fields || []).find(cf => cf.id === VERSION_FIELD_ID);
  const opt = f && f.type_config && f.type_config.options && f.type_config.options[v];
  return opt ? opt.name : null;
}

export default async function handler(req, res) {
  const token = process.env.CLICKUP_API_TOKEN;
  if (!token) {
    res.status(500).json({ error: 'CLICKUP_API_TOKEN is not set in Vercel environment variables' });
    return;
  }

  try {
    const tasks = await fetchAllTasks(token);

    // Build parent -> children map so we can walk each epic's full subtree.
    const byId = new Map(tasks.map(t => [t.id, t]));
    const childrenOf = new Map();
    for (const t of tasks) {
      if (t.parent) {
        if (!childrenOf.has(t.parent)) childrenOf.set(t.parent, []);
        childrenOf.get(t.parent).push(t.id);
      }
    }

    function sumSubtreeHours(taskId) {
      const kids = childrenOf.get(taskId) || [];
      if (!kids.length) {
        const t = byId.get(taskId);
        return t && t.time_estimate ? t.time_estimate / 1000 / 3600 : null; // ms -> hours
      }
      let total = 0;
      let anyFound = false;
      for (const kidId of kids) {
        const kidHours = sumSubtreeHours(kidId);
        if (kidHours !== null) { total += kidHours; anyFound = true; }
      }
      return anyFound ? total : null;
    }

    // Only top-level tasks (no parent) with Version set are the tracked "epics".
    const results = [];
    let fallbackCount = 0;
    for (const t of tasks) {
      if (t.parent) continue; // skip subtasks — they're rolled up into their epic
      const version = versionLabel(t);
      if (version !== 'v1' && version !== 'v2') continue; // untagged legacy backlog

      const hasSubtasks = (childrenOf.get(t.id) || []).length > 0;
      let hours = sumSubtreeHours(t.id);

      // Bulk pull came back empty for a task that has children — re-fetch directly.
      if (hours === null && hasSubtasks) {
        hours = await fetchSubtreeDirect(t.id, token);
        fallbackCount++;
      }

      const project = getCustomFieldValue(t, PROJECT_FIELD_ID) || 'Unassigned';
      const progressRaw = getCustomFieldValue(t, PROGRESS_FIELD_ID);
      const progress_pct = progressRaw && typeof progressRaw === 'object' && 'percent_complete' in progressRaw
        ? progressRaw.percent_complete
        : (typeof progressRaw === 'number' ? progressRaw : null);

      results.push({
        id: t.id,
        name: t.name,
        status: (t.status && t.status.status || '').toLowerCase(),
        version,
        project,
        time_estimate_hours: hours,
        has_subtasks: hasSubtasks,
        progress_pct,
      });
    }

    res.setHeader('Cache-Control', `s-maxage=${CACHE_SECONDS}, stale-while-revalidate`);
    res.status(200).json({
      generated_at: new Date().toISOString(),
      fallback_fetches_used: fallbackCount,
      tasks: results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
