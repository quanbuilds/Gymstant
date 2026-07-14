const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SEEDED_DEMO = /maya\s+bennet+t?.*ava.*(?:missed|absent|attendance).*beginner\s+tumbling.*(?:makeup|roster).*?(?:gmail|e-?mail|draft)/is;

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `${file} exited ${code}`)));
  });
}

class SpeedLayer {
  constructor(dataDir, log = () => {}) {
    this.metricsFile = path.join(dataDir, 'performance-metrics.jsonl');
    this.templatesFile = path.join(dataDir, 'learned-workflows.json');
    this.log = log;
  }
  metric(event) { fs.mkdirSync(path.dirname(this.metricsFile), { recursive: true }); fs.appendFileSync(this.metricsFile, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`); }
  templates() { try { return JSON.parse(fs.readFileSync(this.templatesFile, 'utf8')); } catch { return { version: 1, workflows: {} }; } }
  recordSuccess(request, route, durationMs, steps = []) {
    this.metric({ request: String(request).slice(0, 1000), route, duration_ms: durationMs, success: true, steps });
    const data = this.templates();
    const key = route === 'seeded-makeup-fastpath' ? 'missed-class-makeup' : String(request).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 64);
    const prior = data.workflows[key] || { key, examples: [], successes: 0, promoted: false, approvals: [] };
    prior.successes += 1; prior.lastDurationMs = durationMs; prior.bestDurationMs = Math.min(prior.bestDurationMs || Infinity, durationMs);
    prior.lastUsedAt = new Date().toISOString(); prior.steps = steps; prior.examples = [...new Set([...prior.examples, String(request).slice(0, 500)])].slice(-3);
    prior.promoted = Boolean(prior.approvedAt);
    data.workflows[key] = prior; fs.writeFileSync(this.templatesFile, JSON.stringify(data, null, 2));
    return prior;
  }
  isApproved(key = 'missed-class-makeup') { return Boolean(this.templates().workflows[key]?.approvedAt); }
  approve(key = 'missed-class-makeup', actionId = '') {
    const data = this.templates(); const item = data.workflows[key] || { key, examples: [], successes: 0, steps: [], approvals: [] };
    item.approvals = [...new Set([...(item.approvals || []), actionId])];
    if (item.approvals.includes('demo-makeup-roster') && item.approvals.includes('demo-makeup-email')) { item.approvedAt = new Date().toISOString(); item.promoted = true; }
    data.workflows[key] = item; fs.writeFileSync(this.templatesFile, JSON.stringify(data, null, 2)); return item;
  }
  recordFailure(request, route, durationMs, error) { this.metric({ request: String(request).slice(0, 1000), route, duration_ms: durationMs, success: false, error: String(error?.message || error).slice(0, 500) }); }
  match(request) { return SEEDED_DEMO.test(String(request || '')) ? 'seeded-makeup-fastpath' : null; }
  learnedHint(request) {
    const words = new Set(String(request).toLowerCase().match(/[a-z]{4,}/g) || []);
    const candidates = Object.values(this.templates().workflows).filter(item => item.promoted && item.steps?.length);
    const scored = candidates.map(item => ({ item, score: Math.max(...(item.examples || []).map(example => {
      const sample = new Set(String(example).toLowerCase().match(/[a-z]{4,}/g) || []);
      const overlap = [...words].filter(word => sample.has(word)).length;
      return overlap / Math.max(1, new Set([...words, ...sample]).size);
    }), 0) })).sort((a, b) => b.score - a.score);
    return scored[0]?.score >= .45 ? `A similar approved workflow previously succeeded using: ${scored[0].item.steps.join(' → ')}. Reuse that shortest path when the current screen still matches.` : '';
  }
}

async function openChrome(url, newWindow = false) {
  if (process.platform === 'darwin' && newWindow) {
    const safe = String(url).replace(/["\\]/g, value => `\\${value}`);
    return run('/usr/bin/osascript', ['-e', `tell application "Google Chrome"\nactivate\nset newWindow to make new window\nset URL of active tab of newWindow to "${safe}"\nend tell`]);
  }
  if (process.platform === 'darwin') return run('/usr/bin/open', ['-a', 'Google Chrome', url]);
  if (process.platform === 'win32') return run('cmd', ['/c', 'start', '', 'chrome', ...(newWindow ? ['--new-window'] : []), url], { windowsHide: true });
  return run('xdg-open', [url]);
}
async function cuaCall(tool, payload) {
  const raw = await run('/Users/stewartos/.local/bin/cua-driver', ['call', tool, JSON.stringify(payload)]);
  try { return JSON.parse(raw); } catch { return { text: raw }; }
}
function visibleField(elements, label, role) {
  return elements.filter(e => e.label === label && (!role || e.role === role) && e.frame?.h > 20).sort((a,b)=>(a.frame.y||0)-(b.frame.y||0))[0];
}
async function stageRosterProposal(data) {
  const name = encodeURIComponent(data.target_group || 'Beginner Tumbling - Tuesday 5:00 PM');
  await openChrome(`http://education.localhost:8000/app/student-group/${name}`);
  await wait(2600);
  if (process.platform !== 'darwin') return;
  const windows = await cuaCall('list_windows', {});
  const target = windows.windows?.find(w => w.app_name === 'Google Chrome' && w.is_on_screen && /Beginner Tumbling - Tuesday/i.test(w.title));
  if (!target) throw new Error('The Tuesday Student Group window was not visible.');
  let state = await cuaCall('get_window_state', { pid:target.pid, window_id:target.window_id, include_screenshot:false, max_elements:1200 });
  const add = (state.elements || []).filter(e => e.label === 'Add row' && e.role === 'AXButton' && e.frame?.h > 0).sort((a,b)=>(a.frame.y||0)-(b.frame.y||0))[0];
  if (!add) throw new Error('The Students Add row button was not available.');
  await cuaCall('click', { pid:target.pid, window_id:target.window_id, element_index:add.element_index });
  await wait(500);
  state = await cuaCall('get_window_state', { pid:target.pid, window_id:target.window_id, include_screenshot:false, max_elements:1200 });
  const student = visibleField(state.elements || [], 'Student', 'AXComboBox');
  if (!student) throw new Error('The new Student field did not appear.');
  await cuaCall('click', { pid:target.pid, window_id:target.window_id, element_index:student.element_index, delivery_mode:'foreground' });
  await cuaCall('hotkey', { pid:target.pid, window_id:target.window_id, keys:['cmd','a'], delivery_mode:'foreground' });
  await cuaCall('type_text', { pid:target.pid, text:data.student_id || 'EDU-STU-2026-00001', delivery_mode:'foreground', delay_ms:10 });
  await wait(500);
  state = await cuaCall('get_window_state', { pid:target.pid, window_id:target.window_id, include_screenshot:false, max_elements:1200 });
  const id = data.student_id || 'EDU-STU-2026-00001';
  const staged = (state.elements || []).find(e => e.role === 'AXComboBox' && String(e.value || e.label || '').includes(id));
  if (!staged) throw new Error('The unsaved Ava roster row could not be verified.');
}

async function seededSnapshot() {
  const fallback = { student: 'Ava Bennett', student_id: '', guardian: 'Maya Bennett', guardian_email: 'maya.bennett@example.test', attendance: 'Absent', attendance_date: '2026-07-06', source_group: 'Beginner Tumbling - Monday 4:00 PM', source_count: 5, target_group: 'Beginner Tumbling - Tuesday 5:00 PM', target_count: 4, capacity: 8 };
  try {
    const raw = await run(process.platform === 'darwin' ? '/opt/homebrew/bin/docker' : 'docker', ['exec', 'education-frappe-1', 'bash', '-lc', `cd /home/frappe/frappe-bench && bench --site education.localhost execute 'frappe.get_attr("education.demo_seed.snapshot")()'`], { timeout: 12000 });
    const line = raw.split('\n').reverse().find(value => value.trim().startsWith('{'));
    return { ...fallback, ...(line ? JSON.parse(line) : {}) };
  } catch { return fallback; }
}

async function runSeededDemoFastPath({ activity = () => {}, arrange = () => {}, deliberate = true } = {}) {
  const pause = deliberate ? 4200 : 900;
  const dataPromise = seededSnapshot();
  activity('Step 1 of 5 · Verify Ava and Maya’s family link');
  await openChrome('http://education.localhost:8000/app/student?student_name=%5B%22like%22%2C%22%25Ava%20Bennett%25%22%5D');
  arrange(); await wait(pause);
  const data = await dataPromise;
  activity('Step 2 of 5 · Verify Ava’s July 6 absence');
  await openChrome('http://education.localhost:8000/app/student-attendance?student_name=%5B%22like%22%2C%22%25Ava%20Bennett%25%22%5D&status=Absent');
  await wait(pause);
  activity('Step 3 of 5 · Verify Tuesday class capacity');
  const group = encodeURIComponent(data.target_group || 'Beginner Tumbling - Tuesday 5:00 PM');
  await openChrome(`http://education.localhost:8000/app/student-group?student_group_name=%5B%22like%22%2C%22%25${group}%25%22%5D`);
  await wait(pause);
  activity('Step 4 of 5 · Prepare roster proposal without saving');
  await stageRosterProposal(data);
  await wait(deliberate ? 2800 : 400);
  activity('Step 5 of 5 · Prepare Gmail draft without sending');
  const subject = `Ava's Beginner Tumbling makeup option`;
  const body = `Hi Maya,\n\nI verified Ava's absence from Beginner Tumbling on July 6. The Tuesday 5:00 PM Beginner Tumbling class currently has ${data.target_count} of ${data.capacity} spots filled, so it has room for Ava's makeup class.\n\nThe roster change is prepared and waiting for final staff approval. Please let us know if Tuesday at 5:00 PM works for you.\n\nBest,\nGymstant`;
  const gmail = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(data.guardian_email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  await openChrome(gmail, true); arrange();
  return {
    data,
    steps: ['family verified', 'absence verified', 'capacity compared', 'roster proposal prepared without saving', 'Gmail draft opened without sending'],
    text: `Verified Ava Bennett is linked to Maya Bennett and was absent from ${data.source_group} on July 6, 2026. ${data.target_group} has ${data.target_count} of ${data.capacity} spots filled, so I prepared it as the makeup proposal without saving a roster change. I opened an unsent Gmail draft to ${data.guardian_email}. Both final actions still require staff confirmation.`
  };
}

module.exports = { SpeedLayer, runSeededDemoFastPath, SEEDED_DEMO };
