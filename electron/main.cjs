const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut, shell, powerMonitor, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const zlib = require('zlib');
const http = require('http');
const os = require('os');
const sharp = require('sharp');
const { TaskRuntime, originalRequest, isFalseSuccess } = require('./task-runtime.cjs');
const { SpeedLayer, runSeededDemoFastPath } = require('./speed-layer.cjs');
const { buildWorkflowManual, buildWorkflowRetirement, buildReplayPlan, nextWindowMode } = require('./workflow-utils.cjs');

const isDev = !app.isPackaged;
let win;
let dragSession;
let resizeSession;
let heightResizeSession;
let isExpanded = false;
let lastLensFrame;
let lensRefreshing = false;
let lensTimer;
let executionBounds;
let activeExecution;
let executionPeeked = false;
let nativeGlass;
let focusResumeSeconds = 15;
let memoryServer;
let nativeChatbarHeight = 56;
let eventRecorder;
let activeEventTrace = [];
let eventRecordingError = null;
let eventRecorderPoller;
let eventRecorderFile;
let eventEnrichmentBusy = false;
const managedApps = new Set();
const collapsedSize = { width: 590, height: 108 };
const minimizedSize = { width: 108, height: 108 };
const executionPillSize = { width: 240, height: 56 };
const expandedSize = { width: 660, height: 560 };
let collapsedHeight = collapsedSize.height;
let windowMode = 'chatbar';
const dataDir = path.join(app.getPath('userData'), 'workflow-memory');
const stateFile = path.join(dataDir, 'state.json');
const memoryFile = path.join(dataDir, 'MEMORY.md');
const memoryGuideFile = path.join(dataDir, 'MEMORY_GUIDE.md');
const usersFile = path.join(dataDir, 'users.md');
const employeeFile = path.join(dataDir, 'employee.md');
const dashboardFile = path.join(dataDir, 'memory-dashboard.html');
const transcriptFile = path.join(dataDir, 'transcript.jsonl');
const conversationArchiveDir = path.join(dataDir, 'conversation-archive');
const shotsDir = path.join(dataDir, 'screenshots');
const runtimeLogFile = path.join(dataDir, 'runtime.log');
const taskRuntime = new TaskRuntime(path.join(dataDir, 'task-runtime.json'));
const speedLayer = new SpeedLayer(dataDir, runtimeLog);

function gymstantCliPath() {
  if (process.env.GYMSTANT_CLI) return process.env.GYMSTANT_CLI;
  return process.platform === 'win32' ? 'hermes' : '/Users/stewartos/.local/bin/gymstant';
}

function gymstantWorkdir() {
  if (process.env.GYMSTANT_WORKDIR) return process.env.GYMSTANT_WORKDIR;
  return isDev ? path.resolve(__dirname, '..') : dataDir;
}

function hermesHomeDir() {
  if (process.env.HERMES_HOME) return process.env.HERMES_HOME;
  return path.join(os.homedir(), '.hermes');
}
// The macOS `gymstant` CLI wrapper always runs `hermes -p gymstant`, isolating this
// app to the "gymstant" profile. Windows has no wrapper/-p flag and targets the
// user's default (root) Hermes profile — see gymstantCliPath().
function hermesProfileDir() {
  if (process.env.GYMSTANT_HERMES_PROFILE_DIR) return process.env.GYMSTANT_HERMES_PROFILE_DIR;
  const home = hermesHomeDir();
  return process.platform === 'darwin' ? path.join(home, 'profiles', 'gymstant') : home;
}
function hermesEnv() {
  if (process.platform === 'win32') {
    const userHome = os.homedir();
    const extraPaths = [
      path.join(userHome, 'AppData', 'Local', 'Programs', 'Hermes'),
      path.join(userHome, 'AppData', 'Local', 'Programs', 'Hermes', 'bin'),
      path.join(userHome, 'go', 'bin'),
      'C:\\Program Files\\Hermes\\bin'
    ];
    return { ...process.env, PATH: `${extraPaths.join(';')};${process.env.PATH || ''}` };
  }
  return { ...process.env, PATH: `/Users/stewartos/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH || ''}` };
}

function eventRecorderPath() {
  const candidates = [
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'electron', 'native', 'workflow-event-recorder'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'electron', 'native', 'Gymstant Event Recorder.app', 'Contents', 'MacOS', 'workflow-event-recorder'),
    path.join(__dirname, 'native', 'workflow-event-recorder'),
    path.join(__dirname, 'native', 'Gymstant Event Recorder.app', 'Contents', 'MacOS', 'workflow-event-recorder')
  ];
  return candidates.find(candidate => candidate && !candidate.includes(`${path.sep}app.asar${path.sep}`) && fs.existsSync(candidate)) || null;
}
function eventRecorderAppPath() {
  const candidates = [
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'electron', 'native', 'Gymstant Event Recorder.app'),
    path.join(__dirname, 'native', 'Gymstant Event Recorder.app')
  ];
  return candidates.find(candidate => candidate && fs.existsSync(path.join(candidate, 'Contents', 'MacOS', 'workflow-event-recorder'))) || null;
}
function killEventRecorderProcesses() {
  const appBundle = eventRecorderAppPath();
  const binary = eventRecorderPath();
  const target = appBundle ? path.join(appBundle, 'Contents', 'MacOS', 'workflow-event-recorder') : binary;
  if (target) { try { spawn('/usr/bin/pkill', ['-f', target], { stdio:'ignore' }); } catch {} }
  if (eventRecorder && !eventRecorder.killed) { try { eventRecorder.kill('SIGTERM'); } catch {} }
  eventRecorder = null;
}
async function enrichEventTarget(event) {
  if (!event || event.type !== 'mouse.click' || event.elementTitle || event.elementDescription || event.elementHelp || event.visibleTarget) return event;
  if (!Number.isFinite(Number(event.x)) || !Number.isFinite(Number(event.y))) return event;
  if (eventEnrichmentBusy) return event;
  eventEnrichmentBusy = true;
  try {
    const point = { x:Number(event.x), y:Number(event.y) };
    const display = screen.getDisplayMatching(point);
    const sources = await desktopCapturer.getSources({ types:['screen'], thumbnailSize:display.size });
    const source = sources.find(item => item.display_id === String(display.id)) || sources[0];
    if (!source || source.thumbnail.isEmpty()) return event;
    const png = source.thumbnail.toPNG();
    const imageSize = source.thumbnail.getSize();
    const scaleX = imageSize.width / Math.max(1, display.size.width);
    const scaleY = imageSize.height / Math.max(1, display.size.height);
    const clickX = (point.x - display.bounds.x) * scaleX;
    const clickY = (point.y - display.bounds.y) * scaleY;
    const binary = process.platform === 'darwin' && fs.existsSync('/opt/homebrew/bin/tesseract') ? '/opt/homebrew/bin/tesseract' : null;
    if (!binary) return event;
    const words = await new Promise(resolve => {
      const child = spawn(binary, ['stdin','stdout','-l','eng','--psm','11','tsv'], { stdio:['pipe','pipe','ignore'] });
      let stdout = '', timer;
      const finish = value => { if (timer) clearTimeout(timer); resolve(value); };
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.on('error', () => finish([]));
      child.on('close', () => {
        const rows = [];
        for (const row of stdout.split(/\r?\n/).slice(1)) {
          const c = row.split('\t'); if (c.length < 12 || c[0] !== '5') continue;
          const [left, top, width, height, confidence] = [6,7,8,9,10].map(i => Number(c[i]));
          const text = c.slice(11).join('\t').trim();
          if (!text || confidence < 25 || ![left,top,width,height].every(Number.isFinite)) continue;
          rows.push({ text, left, top, right:left + width, bottom:top + height, cx:left + width / 2, cy:top + height / 2 });
        }
        finish(rows);
      });
      timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} finish([]); }, 2500);
      child.stdin.end(png);
    });
    const nearby = words.filter(word => Math.hypot(word.cx - clickX, word.cy - clickY) < 260 * Math.max(scaleX, scaleY));
    nearby.sort((a,b) => Math.hypot(a.cx-clickX,a.cy-clickY) - Math.hypot(b.cx-clickX,b.cy-clickY));
    const candidate = nearby[0];
    if (!candidate) return event;
    const sensitive = /@|\b\d{3}[-. )]\d{3}[-. ]\d{4}\b|\b(?:email address|mobile number|phone number)\b/i;
    const label = candidate.text.replace(/[^\w &'’/-]/g, '').trim();
    if (!label || sensitive.test(label)) return event;
    return { ...event, visibleTarget:label, visibleTargetSource:'local-ocr', visibleTargetConfidence:'screen-near-click' };
  } finally { eventEnrichmentBusy = false; }
}
async function syncEventRecorderFile() {
  if (!eventRecorderFile || !fs.existsSync(eventRecorderFile)) return;
  const events = fs.readFileSync(eventRecorderFile, 'utf8').split(/\r?\n/).filter(Boolean).flatMap(line => { try { const event = JSON.parse(line); return event?.type ? [event] : []; } catch { return []; } });
  const current = dedupeEventTrace(events);
  const enriched = [];
  for (const event of current) {
    const key = [event.type,event.at,event.x,event.y].join('|');
    const known = activeEventTrace.find(item => [item.type,item.at,item.x,item.y].join('|') === key);
    if (known?.visibleTarget || event.type !== 'mouse.click') enriched.push(known || event);
    else enriched.push(await enrichEventTarget(event));
  }
  activeEventTrace = enriched;
}
function dedupeEventTrace(events = []) {
  const seen = new Set();
  return events.filter(event => {
    const key = [event.type, event.at, event.x, event.y, event.keyCode, event.app, event.windowTitle].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
async function startWorkflowEventRecording() {
  await stopWorkflowEventRecording();
  activeEventTrace = [];
  eventRecordingError = null;
  if (process.platform !== 'darwin') return { ok: false, reason: 'Deterministic event recording is currently macOS-only.' };
  const appBundle = eventRecorderAppPath();
  const binary = eventRecorderPath();
  if (!binary) return { ok: false, reason: 'The macOS event recorder is not installed.' };
  try {
    eventRecorderFile = path.join(os.tmpdir(), `gymstant-events-${process.pid}.jsonl`);
    try { fs.unlinkSync(eventRecorderFile); } catch {}
    // Execute the recorder directly: LaunchServices exits immediately after
    // handing off an LSUIElement app and makes the tap lifecycle unreliable.
    // The nested executable is stably signed with the recorder bundle's
    // development identity; the JSONL file remains the single event source.
    eventRecorder = spawn(binary, ['--record-file', eventRecorderFile], { stdio: ['ignore', 'ignore', 'pipe'] });
    // When --record-file is active, the file poller is the single source of
    // truth. Reading stdout as well duplicates every event and can cause
    // replay to run the same click sequence twice.
    eventRecorder.stderr.on('data', chunk => { eventRecordingError = String(chunk).trim(); });
    eventRecorder.on('error', error => { eventRecordingError = error.message; runtimeLog('workflow.events.error', { error: error.message }); eventRecorder = null; });
    eventRecorder.on('close', (code, signal) => { runtimeLog('workflow.events.close', { code, signal, error: eventRecordingError || undefined }); });
    eventRecorder.on('close', code => { if (code && !eventRecordingError) eventRecordingError = `Event recorder exited with code ${code}`; eventRecorder = null; });
    if (appBundle) eventRecorderPoller = setInterval(syncEventRecorderFile, 120);
    await new Promise(resolve => setTimeout(resolve, 220));
    if (eventRecordingError) return { ok: false, reason: eventRecordingError };
    runtimeLog('workflow.events.start', { binary });
    return { ok: true, eventTraceVersion: 1, textPolicy: 'omitted' };
  } catch (error) { eventRecordingError = error.message; return { ok: false, reason: error.message }; }
}
async function stopWorkflowEventRecording() {
  if (eventRecorderPoller) { clearInterval(eventRecorderPoller); eventRecorderPoller = null; }
  // Kill first. OCR enrichment can take a couple seconds and must never leave
  // the native recorder alive while the user is trying to pause/restart.
  killEventRecorderProcesses();
  await syncEventRecorderFile();
  const trace = activeEventTrace.slice();
  runtimeLog('workflow.events.stop', { events: trace.length, error: eventRecordingError || undefined });
  try { if (eventRecorderFile) fs.unlinkSync(eventRecorderFile); } catch {}
  eventRecorderFile = null;
  return { events: trace, error: eventRecordingError };
}
function replayWorkflowEvents(events, options = {}) {
  return new Promise((resolve, reject) => {
    const binary = eventRecorderPath();
    if (!binary) return reject(new Error('The macOS event recorder is not installed.'));
    const child = spawn(binary, ['--replay'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve({ ok:true, events:events.length, output:stdout }) : reject(new Error(stderr.trim() || `Replay exited with code ${code}`)));
    child.stdin.end(events.map(event => JSON.stringify(event)).join('\n'));
    setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, options.timeout || 120000);
  });
}
// Lightweight sibling to runProcessGroup for short, non-cancelable, non-focus-aware
// CLI calls (settings reads/writes). Deliberately does not touch activeExecution —
// that singleton drives Cancel/focus-pause for real computer-use tasks, and a
// concurrent settings call would clobber and then null it out mid-task.
function runQuickProcess(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }, options.timeout || 20000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(Object.assign(new Error(stderr.trim() || `exit ${code}`), { code, stderr }));
      resolve({ stdout, stderr });
    });
  });
}
function readHermesModelConfig() {
  const configPath = path.join(hermesProfileDir(), 'config.yaml');
  if (!fs.existsSync(configPath)) return null;
  const lines = fs.readFileSync(configPath, 'utf8').split('\n');
  const start = lines.findIndex(line => /^model:\s*$/.test(line));
  if (start === -1) return null;
  const model = {};
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (!/^\s/.test(line)) break; // dedented back to top level -> block ended
    const match = line.match(/^\s+([A-Za-z_]+):\s*(.*)$/);
    if (match) model[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return Object.keys(model).length ? model : null;
}
function readHermesModelCatalog() {
  const dir = hermesProfileDir();
  if (!fs.existsSync(dir)) return { available: false, models: [], reason: 'no-profile' };
  const cachePath = path.join(dir, 'cache', 'openrouter_model_metadata.json');
  if (!fs.existsSync(cachePath)) return { available: false, models: [], reason: 'not-cached' };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch { return { available: false, models: [], reason: 'unreadable' }; }
  const byName = new Map();
  for (const [id, meta] of Object.entries(raw || {})) {
    if (!meta || !meta.name) continue;
    const existing = byName.get(meta.name);
    const isCanonical = id.includes('/');
    if (!existing || (isCanonical && !existing.id.includes('/'))) byName.set(meta.name, { id, name: meta.name, contextLength: meta.context_length || null });
  }
  return { available: true, models: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}
function parseHermesToolsList(raw) {
  const clean = String(raw || '').replace(/\[[0-9;]*m/g, '');
  const tools = [];
  for (const line of clean.split('\n')) {
    const match = line.match(/^\s*(✓|✗)\s+(enabled|disabled)\s+(\S+)\s+(.+)$/);
    if (match) tools.push({ name: match[3], label: match[4].trim(), enabled: match[2] === 'enabled' });
  }
  return tools;
}

function runtimeLog(event, data = {}) { ensureData(); fs.appendFileSync(runtimeLogFile, `${new Date().toISOString()} ${event} ${JSON.stringify(data)}\n`); }
function sendActivity(text, tone = 'active') { if (win && !win.isDestroyed()) win.webContents.send('execution:activity', { text, tone, at: Date.now() }); }
function frontmostApp(callback) {
  if (process.platform !== 'darwin') return callback('');
  const child = spawn('/usr/bin/osascript', ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let name = '';
  child.stdout.on('data', chunk => { name += chunk; });
  child.on('close', () => callback(name.trim()));
}
function activateApp(name) {
  if (!name || process.platform !== 'darwin') return;
  spawn('/usr/bin/osascript', ['-e', `tell application "${name.replace(/["\\]/g, '')}" to activate`], { detached: true, stdio: 'ignore' }).unref();
}
function startFocusMonitor(execution) {
  if (process.platform !== 'darwin' || !managedApps.size) return;
  execution.focusStartedAt = Date.now();
  execution.focusTimer = setInterval(() => {
    if (execution.cancelled || activeExecution !== execution) return;
    frontmostApp(name => {
      if (activeExecution !== execution || !name) return;
      const allowed = name === 'Gymstant' || name === 'CuaDriver' || [...managedApps].some(appName => name.includes(appName.replace('Google ', '')));
      if (!allowed && !execution.paused && Date.now() - execution.focusStartedAt > 3500) {
        execution.paused = true;
        execution.interruptedBy = name;
        try { process.kill(-execution.child.pid, 'SIGSTOP'); } catch {}
        sendActivity(`Paused while you use ${name}.`, 'paused');
        runtimeLog('execution.focus-paused', { app: name });
      } else if (execution.paused) {
        const idleFor = powerMonitor.getSystemIdleTime();
        if (allowed || idleFor >= focusResumeSeconds) {
          if (!allowed) activateApp([...managedApps][0]);
          try { process.kill(-execution.child.pid, 'SIGCONT'); } catch {}
          execution.paused = false;
          sendActivity(allowed ? 'Your work is out of the way. Resuming…' : 'The computer is free again. Resuming…');
          if (win && !win.isDestroyed()) win.webContents.send('execution:focus-resumed', { seconds: focusResumeSeconds, returnedNaturally: allowed });
          runtimeLog('execution.focus-resumed', { app: name, idle_seconds: idleFor });
        }
      }
    });
  }, 1000);
}
function stopFocusMonitor(execution) { if (execution?.focusTimer) clearInterval(execution.focusTimer); }
function nativeGlassPath() {
  if (process.platform !== 'darwin') return null;
  return isDev
    ? path.join(__dirname, 'native/GymstantGlassHost')
    : path.join(process.resourcesPath, 'app.asar.unpacked/electron/native/GymstantGlassHost');
}
function sensitiveScannerPath() {
  return isDev
    ? path.join(__dirname, 'native/scan-sensitive-ui.applescript')
    : path.join(process.resourcesPath, 'app.asar.unpacked/electron/native/scan-sensitive-ui.applescript');
}
function mergeRedactionRegions(regions, width, height) {
  const clamped = regions.map(region => ({
    left: Math.max(0, Math.min(width - 1, Math.round(region.left))),
    top: Math.max(0, Math.min(height - 1, Math.round(region.top))),
    width: Math.max(1, Math.min(width - Math.max(0, Math.round(region.left)), Math.round(region.width))),
    height: Math.max(1, Math.min(height - Math.max(0, Math.round(region.top)), Math.round(region.height)))
  })).filter(region => region.width > 3 && region.height > 3);
  const merged = [];
  for (const region of clamped) {
    const overlap = merged.find(item => !(region.left > item.left + item.width + 8 || region.left + region.width + 8 < item.left || region.top > item.top + item.height + 8 || region.top + region.height + 8 < item.top));
    if (!overlap) merged.push({ ...region });
    else {
      const right = Math.max(overlap.left + overlap.width, region.left + region.width);
      const bottom = Math.max(overlap.top + overlap.height, region.top + region.height);
      overlap.left = Math.min(overlap.left, region.left);
      overlap.top = Math.min(overlap.top, region.top);
      overlap.width = right - overlap.left;
      overlap.height = bottom - overlap.top;
    }
  }
  return merged.slice(0, 80);
}
function scanSensitiveRegions(display) {
  return new Promise(resolve => {
    if (process.platform !== 'darwin') return resolve({ ok:false, reason:'Sensitive-region scanning is not available on this platform.' });
    const file = sensitiveScannerPath();
    if (!fs.existsSync(file)) return resolve({ ok:false, reason:'Sensitive-region scanner is missing.' });
    const child = spawn('/usr/bin/osascript', [file], { stdio:['ignore','pipe','pipe'] });
    let stdout = '', stderr = '', settled = false, timer;
    const finish = result => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve(result); };
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => finish({ ok:false, reason:error.message }));
    child.on('close', code => {
      if (code !== 0) return finish({ ok:false, reason:stderr.trim() || `Scanner exited with ${code}.` });
      const sensitive = /(email|e-mail|phone|mobile|address|guardian|parent|birth|dob|medical|allerg|payment|balance|autopay|(?:first|middle|last|full)\s+name|student\s*(?:name|id)|family\s*(?:name|id)|emergency|waiver|contact|account\s*(?:id|number)|@|\b\d{3}[-. )]\d{3}[-. ]\d{4}\b)/i;
      const entryRole = /(AXTextField|AXTextArea|AXSecureTextField|text field|text area)/i;
      const ignored = /(address and search bar|ask google|search field|filter|find)/i;
      const regions = [];
      for (const line of stdout.split(/\r?\n/)) {
        const parts = line.split('|'); if (parts.length < 5) continue;
        const [x,y,w,h] = parts.slice(0,4).map(Number); const text = parts.slice(4).join('|');
        if (![x,y,w,h].every(Number.isFinite) || ignored.test(text)) continue;
        const isEntry = entryRole.test(text);
        const isSensitive = sensitive.test(text);
        if (!isEntry && !isSensitive) continue;
        const padding = 10;
        const labelExpansion = isSensitive && !isEntry ? Math.max(w + 300, 380) : w + padding * 2;
        regions.push({ left:x - display.bounds.x - padding, top:y - display.bounds.y - padding, width:labelExpansion, height:h + padding * 2 });
      }
      finish({ ok:true, regions:mergeRedactionRegions(regions, display.size.width, display.size.height) });
    });
    timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} finish({ ok:false, reason:'Sensitive-region scan timed out.' }); }, 3500);
  });
}
async function scanSensitiveImage(png, width, height) {
  const ocrScale = 2;
  const ocrPng = await sharp(png).resize({ width:width * ocrScale }).grayscale().normalize().sharpen().png().toBuffer();
  return new Promise(resolve => {
    const binary = process.platform === 'darwin' && fs.existsSync('/opt/homebrew/bin/tesseract') ? '/opt/homebrew/bin/tesseract' : null;
    if (!binary) return resolve({ ok:false, reason:'Local OCR is unavailable.' });
    const child = spawn(binary, ['stdin','stdout','-l','eng','--psm','11','tsv'], { stdio:['pipe','pipe','pipe'] });
    let stdout = '', stderr = '', settled = false, timer;
    const finish = result => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve(result); };
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => finish({ ok:false, reason:error.message }));
    child.on('close', code => {
      if (code !== 0) return finish({ ok:false, reason:stderr.trim() || `OCR exited with ${code}.` });
      const lines = new Map();
      for (const row of stdout.split(/\r?\n/).slice(1)) {
        const columns = row.split('\t'); if (columns.length < 12 || columns[0] !== '5') continue;
        const [left,top,wordWidth,wordHeight] = columns.slice(6,10).map(value => Number(value) / ocrScale);
        const text = columns.slice(11).join('\t').trim(); if (!text || ![left,top,wordWidth,wordHeight].every(Number.isFinite)) continue;
        const key = `${columns[2]}:${columns[3]}:${columns[4]}`;
        const line = lines.get(key) || { words:[], left, top, right:left + wordWidth, bottom:top + wordHeight };
        line.words.push(text); line.left = Math.min(line.left,left); line.top = Math.min(line.top,top); line.right = Math.max(line.right,left + wordWidth); line.bottom = Math.max(line.bottom,top + wordHeight); lines.set(key,line);
      }
      const sensitive = /(email|e-mail|phone|mobile|address|guardian|parent|birth|dob|medical|allerg|payment|balance|autopay|(?:first|middle|last|full)\s+name|student\s*(?:name|id)|family\s*(?:name|id)|emergency|waiver|contact|account\s*(?:id|number)|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b\d{3}[-. )]\d{3}[-. ]\d{4}\b|\b(?:EDU|STU|ACC|FAM)-[A-Z0-9-]{4,}\b|\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b)/i;
      const commonHeading = /^(student details|education|course|academic year|program|notification|menu|home|enabled|save|cancel)$/i;
      const properName = /\b[A-Z][a-z]{2,}\s+[A-Z][a-z]{2,}\b/;
      const regions = [];
      for (const line of lines.values()) {
        const text = line.words.join(' ');
        const matched = sensitive.test(text) || (properName.test(text) && !commonHeading.test(text.trim()));
        if (!matched) continue;
        const labelLike = /(email|phone|mobile|address|guardian|parent|birth|medical|payment|balance|(?:first|middle|last|full)\s+name|student|family|emergency|waiver|contact|account)/i.test(text);
        regions.push({ left:line.left - 12, top:line.top - 10, width:labelLike ? Math.max(line.right - line.left + 360, 440) : line.right - line.left + 24, height:Math.max(line.bottom - line.top + 20, labelLike ? 86 : 26) });
      }
      finish({ ok:true, regions:mergeRedactionRegions(regions, width, height) });
    });
    child.stdin.end(ocrPng);
    timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} finish({ ok:false, reason:'Local OCR timed out.' }); }, 8000);
  });
}
async function blurSensitiveRegions(png, regions) {
  if (!regions.length) return png;
  const composites = [];
  for (const region of regions) {
    const input = await sharp(png).extract(region).blur(22).png().toBuffer();
    composites.push({ input, left:region.left, top:region.top });
  }
  return sharp(png).composite(composites).png().toBuffer();
}
function runBinaryBuffer(file, args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio:['ignore','pipe','pipe'] });
    const chunks = []; let stderr = '';
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} reject(new Error(`${path.basename(file)} timed out`)); }, timeout);
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim() || `${path.basename(file)} exited with ${code}`));
      resolve(Buffer.concat(chunks));
    });
  });
}
async function analyzeRecordingFile(file) {
  if (!file || !fs.existsSync(file)) throw new Error('The selected recording is no longer available.');
  const ffprobe = process.platform === 'win32' ? 'ffprobe' : '/opt/homebrew/bin/ffprobe';
  const ffmpeg = process.platform === 'win32' ? 'ffmpeg' : '/opt/homebrew/bin/ffmpeg';
  if (!fs.existsSync(ffprobe) && process.platform !== 'win32') throw new Error('FFprobe is unavailable; the recording was not imported.');
  if (!fs.existsSync(ffmpeg) && process.platform !== 'win32') throw new Error('FFmpeg is unavailable; the recording was not imported.');
  const metadata = JSON.parse((await runBinaryBuffer(ffprobe, ['-v','error','-show_entries','format=duration:stream=width,height','-of','json',file])).toString('utf8'));
  const duration = Math.max(0, Number(metadata.format?.duration || 0));
  const stream = (metadata.streams || []).find(item => item.width && item.height) || {};
  const frameCount = Math.min(12, Math.max(3, Math.ceil(duration / 6) || 3));
  const recordingDir = path.join(dataDir, 'recordings', `${Date.now()}-${path.basename(file).replace(/[^a-z0-9]+/gi,'-').toLowerCase()}`);
  fs.mkdirSync(recordingDir, { recursive:true });
  const frames = [];
  for (let index = 0; index < frameCount; index++) {
    const timestamp = duration ? Math.min(duration - 0.05, (duration * index) / Math.max(1, frameCount - 1)) : 0;
    const raw = await runBinaryBuffer(ffmpeg, ['-hide_banner','-loglevel','error','-ss',String(Math.max(0,timestamp)),'-i',file,'-frames:v','1','-f','image2pipe','-vcodec','png','pipe:1'], 30000);
    if (!raw.length) continue;
    const image = sharp(raw); const imageMeta = await image.metadata();
    const width = imageMeta.width || Number(stream.width) || 1; const height = imageMeta.height || Number(stream.height) || 1;
    const scan = await scanSensitiveImage(raw, width, height);
    if (!scan.ok) throw new Error(`Privacy scan failed at ${Math.round(timestamp)}s: ${scan.reason}`);
    const output = await blurSensitiveRegions(raw, scan.regions || []);
    const framePath = path.join(recordingDir, `frame-${String(index + 1).padStart(2,'0')}.png`);
    fs.writeFileSync(framePath, output);
    frames.push({ index:index + 1, at:timestamp, path:framePath, url:pathToFileURL(framePath).href, redactions:(scan.regions || []).length, privacy:'redacted' });
  }
  let previewUrl = null;
  if (frames.length) {
    const previewPath = path.join(recordingDir, 'redacted-preview.mp4');
    try {
      await runBinaryBuffer(ffmpeg, ['-y','-hide_banner','-loglevel','error','-framerate',String(frames.length / Math.max(duration, 1)),'-i',path.join(recordingDir,'frame-%02d.png'),'-c:v','libx264','-pix_fmt','yuv420p',previewPath], 60000);
      if (fs.existsSync(previewPath)) previewUrl = pathToFileURL(previewPath).href;
    } catch (error) { runtimeLog('recording.preview-failed', { message:error.message }); }
  }
  return {
    name:path.basename(file), url:pathToFileURL(file).href, sourceUrl:pathToFileURL(file).href, previewUrl, privacy:'redacted', reviewRequired:true,
    extractionStatus:'draft-review-required', duration, width:Number(stream.width) || null, height:Number(stream.height) || null,
    frames,
    extractedSteps:frames.map((frame, index) => ({
      label:`Review recorded screen state ${index + 1}`,
      note:`Video frame at ${Math.round(frame.at)}s. Confirm the action and reason manually before approval.`,
      source:'video', at:frame.at, evidenceUrl:frame.url, privacy:'redacted', redactions:frame.redactions
    }))
  };
}
function startNativeGlass() {
  // The native host is optional. It previously survived renderer restarts and
  // could leave a stale gray window above the interactive Electron surface.
  // Keep the recordable Electron UI as the reliable default; developers can
  // explicitly opt back into the experimental host when working on it.
  if (process.env.GYMSTANT_NATIVE_GLASS !== '1' || nativeGlass) return;
  const file = nativeGlassPath();
  if (!file || !fs.existsSync(file)) return;
  nativeGlass = spawn(file, [], { stdio: ['pipe', 'ignore', 'ignore'] });
  nativeGlass.on('error', error => runtimeLog('glass.native-failed', { message: error.message }));
  nativeGlass.on('close', () => { nativeGlass = null; });
  setTimeout(syncNativeGlass, 120);
}
function syncNativeGlass() {
  if (!nativeGlass?.stdin?.writable || !win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const payload = { ...bounds, screenTop: display.bounds.y, screenHeight: display.bounds.height, expanded: isExpanded || executionPeeked, compact: bounds.width < 250, chatbarHeight: nativeChatbarHeight };
  try { nativeGlass.stdin.write(`${JSON.stringify(payload)}\n`); } catch {}
}
function stopNativeGlass() { try { nativeGlass?.stdin?.end(); } catch {} nativeGlass = null; }
function runProcessGroup(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const execution = { child, reject, cancelled: false, paused: false };
    activeExecution = execution;
    if (options.focusAware) startFocusMonitor(execution);
    let stdout = '', stderr = '', timedOut = false;
    let lastProgressAt = Date.now();
    child.stdout.on('data', chunk => { stdout += chunk; lastProgressAt = Date.now(); sendActivity('Receiving Gymstant’s update…'); }); child.stderr.on('data', chunk => { stderr += chunk; lastProgressAt = Date.now(); });
    let activeMs = 0, lastTickAt = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      if (!execution.paused) activeMs += now - lastTickAt;
      lastTickAt = now;
      if (activeMs > (options.timeout || 180000)) { timedOut = true; clearInterval(timer); try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
    }, 500);
    const progressTimer = options.progressTimeout ? setInterval(() => {
      if (execution.paused) lastProgressAt = Date.now();
      else if (Date.now() - lastProgressAt > options.progressTimeout) { timedOut = true; try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
    }, 1000) : null;
    child.on('error', error => { clearInterval(timer); if (progressTimer) clearInterval(progressTimer); stopFocusMonitor(execution); if (activeExecution?.child === child) activeExecution = null; reject(error); });
    child.on('close', code => { clearInterval(timer); if (progressTimer) clearInterval(progressTimer); stopFocusMonitor(execution); const cancelled = activeExecution?.child === child && activeExecution.cancelled; if (activeExecution?.child === child) activeExecution = null; if (cancelled) return reject(Object.assign(new Error('cancelled'), { code: 'ECANCELED', killed: true })); if (timedOut) return reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT', killed: true })); if (code !== 0) return reject(Object.assign(new Error('failed'), { code, stderr })); resolve({ stdout, stderr }); });
  });
}
function cleanupGymstantMcp() {
  if (process.platform !== 'darwin') return;
  const cleaner = spawn('/usr/bin/pkill', ['-f', '/Users/stewartos/.local/bin/cua-driver mcp'], { detached: true, stdio: 'ignore' });
  cleaner.unref();
}
function cancelActiveExecution() {
  if (!activeExecution?.child) return false;
  const pid = activeExecution.child.pid;
  activeExecution.cancelled = true;
  if (activeExecution.paused) { try { process.kill(-pid, 'SIGCONT'); } catch {} }
  try { process.kill(-pid, 'SIGTERM'); } catch {}
  cleanupGymstantMcp();
  setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch {} }, 900);
  runtimeLog('execution.cancelled', { pid });
  return true;
}
function gridRects(count, bounds) {
  if (count <= 0) return [];
  if (count === 1) return [{ ...bounds }];
  if (count === 2) {
    const left = Math.floor(bounds.width / 2);
    return [
      { x: bounds.x, y: bounds.y, width: left, height: bounds.height },
      { x: bounds.x + left, y: bounds.y, width: bounds.width - left, height: bounds.height }
    ];
  }
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  const cellWidth = Math.floor(bounds.width / columns);
  const cellHeight = Math.floor(bounds.height / rows);
  return Array.from({ length: count }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return {
      x: bounds.x + column * cellWidth,
      y: bounds.y + row * cellHeight,
      width: column === columns - 1 ? bounds.width - column * cellWidth : cellWidth,
      height: row === rows - 1 ? bounds.height - row * cellHeight : cellHeight
    };
  });
}
function setMacWindowBounds(target, rect) {
  const appName = String(target.app || '').replace(/["\\]/g, '');
  const index = Math.max(1, Number(target.index) || 1);
  const script = `tell application "System Events"\nif exists process "${appName}" then\ntell process "${appName}"\nif (count of windows) >= ${index} then\nset position of window ${index} to {${rect.x}, ${rect.y}}\nset size of window ${index} to {${rect.width}, ${rect.height}}\nend if\nend tell\nend if\nend tell`;
  spawn('/usr/bin/osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref();
}
function listMacManagedWindows(apps, callback) {
  const names = JSON.stringify(apps);
  const script = `const se=Application('System Events'); const names=${names}; const out=[]; names.forEach(name=>{ const process=se.processes.byName(name); if (!process.exists()) return; const count=process.windows.length; for (let index=1; index<=count; index++) out.push({app:name,index}); }); JSON.stringify(out);`;
  const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.on('close', () => {
    try { callback(JSON.parse(output.trim() || '[]')); }
    catch { callback([]); }
  });
}
function preferredGymstantSide() {
  try {
    const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
    return state.settings?.workspaceSide === 'left' ? 'left' : 'right';
  } catch { return 'right'; }
}
function arrangeWorkspace(reservedForGymstant = 0) {
  if (!managedApps.size) return;
  const bounds = screen.getPrimaryDisplay().workArea;
  const apps = [...managedApps];
  const showGymstant = executionPeeked || Number(reservedForGymstant) > 180;
  if (process.platform !== 'darwin') return;
  listMacManagedWindows(apps, workWindows => {
    if (!workWindows.length) return;
    const gymstantSide = preferredGymstantSide();
    let workRects;
    let gymstantRect = null;
    if (!showGymstant) {
      // One work window fills the display, two split left/right, and three or
      // more use the smallest balanced grid that contains them.
      workRects = gridRects(workWindows.length, bounds);
    } else if (workWindows.length === 1) {
      const gymWidth = Math.max(420, Math.floor(bounds.width / 3));
      const workWidth = bounds.width - gymWidth;
      if (gymstantSide === 'left') {
        gymstantRect = { x: bounds.x, y: bounds.y, width: gymWidth, height: bounds.height };
        workRects = [{ x: bounds.x + gymWidth, y: bounds.y, width: workWidth, height: bounds.height }];
      } else {
        workRects = [{ x: bounds.x, y: bounds.y, width: workWidth, height: bounds.height }];
        gymstantRect = { x: bounds.x + workWidth, y: bounds.y, width: gymWidth, height: bounds.height };
      }
    } else if (workWindows.length === 2) {
      const halfWidth = Math.floor(bounds.width / 2);
      const halfHeight = Math.floor(bounds.height / 2);
      if (gymstantSide === 'left') {
        workRects = [
          { x: bounds.x + halfWidth, y: bounds.y, width: bounds.width - halfWidth, height: bounds.height },
          { x: bounds.x, y: bounds.y, width: halfWidth, height: halfHeight }
        ];
        gymstantRect = { x: bounds.x, y: bounds.y + halfHeight, width: halfWidth, height: bounds.height - halfHeight };
      } else {
        workRects = [
          { x: bounds.x, y: bounds.y, width: halfWidth, height: bounds.height },
          { x: bounds.x + halfWidth, y: bounds.y, width: bounds.width - halfWidth, height: halfHeight }
        ];
        gymstantRect = { x: bounds.x + halfWidth, y: bounds.y + halfHeight, width: bounds.width - halfWidth, height: bounds.height - halfHeight };
      }
    } else {
      const cells = gridRects(workWindows.length + 1, bounds);
      workRects = cells.slice(0, workWindows.length);
      gymstantRect = cells[workWindows.length];
    }
    workWindows.forEach((target, index) => setMacWindowBounds(target, workRects[index]));
    if (gymstantRect && win && !win.isDestroyed()) {
      windowMode = 'expanded'; isExpanded = true;
      win.setBounds(gymstantRect, true);
      win.webContents.send('window:mode', 'chatbar');
    }
    runtimeLog('workspace.arranged', { apps, workWindows: workWindows.length, showGymstant, gymstantSide, bounds, gymstantRect });
  });
}
function deterministicAction(text) {
  const multiAppWorkflow = /\b(class software|frappe|education|roster|attendance|guardian|student|makeup class|class capacity)\b/i.test(text) || (/\b(?:and|then|after)\b/i.test(text) && text.length > 140);
  const gmail = /\b(gmail|email)\b/i.test(text) && /\b(open|write|draft|introduction|introductory)\b/i.test(text);
  const numbers = /\bnumbers\b/i.test(text) && /\b(open|launch|start)\b/i.test(text);
  if (numbers) {
    managedApps.add('Numbers');
    const child = process.platform === 'darwin' ? spawn('/usr/bin/open', ['-a', 'Numbers'], { detached: true, stdio: 'ignore' }) : null;
    child?.unref();
    setTimeout(arrangeWorkspace, 1200);
    return { text: 'Opened Numbers.', model: 'Gymstant deterministic fast path' };
  }
  if (!gmail || multiAppWorkflow) return null;
  const subject = 'Introduction to Gymstant';
  const body = `Hi,\n\nI’m Gymstant, a privacy-first digital coworker built to help gymnastics gyms work more efficiently with the software they already use. I learn each gym’s approved workflows, assist with repetitive administrative work, and keep consequential final actions under human confirmation until they are verified.\n\nBest,\nGymstant`;
  const url = `https://mail.google.com/mail/?view=cm&fs=1&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const child = process.platform === 'darwin' ? spawn('/usr/bin/open', ['-a', 'Google Chrome', url], { detached: true, stdio: 'ignore' }) : spawn('cmd', ['/c', 'start', '', 'chrome', url], { detached: true, stdio: 'ignore', windowsHide: true });
  managedApps.add('Google Chrome');
  child.unref();
  setTimeout(arrangeWorkspace, 1400);
  return { text: 'Opened Chrome to a new Gmail draft and filled the subject and introduction body. The recipient is blank and the message was not sent.', model: 'Gymstant deterministic fast path' };
}

function ensureData() {
  fs.mkdirSync(shotsDir, { recursive: true });
  fs.mkdirSync(conversationArchiveDir, { recursive: true });
  if (!fs.existsSync(memoryFile)) fs.writeFileSync(memoryFile, '# Gymstant Workflow Memory\n\nAppend-only evidence of workflows taught, reviewed, monitored, and completed.\n');
  if (!fs.existsSync(memoryGuideFile)) fs.writeFileSync(memoryGuideFile, '# Understanding Gymstant’s Memory\n\nThis folder is Gymstant’s local memory. It stays on this computer unless you intentionally connect another service.\n\n## What Gymstant remembers\n\n- **Workflows:** Tasks staff demonstrated, their steps, review status, and supporting screenshots.\n- **Conversations:** Current and archived discussions with Gymstant.\n- **People:** `users.md` describes the staff members Gymstant works with.\n- **Employee role:** `employee.md` explains Gymstant’s responsibilities and boundaries.\n- **Evidence:** `screenshots/` contains visual evidence captured while learning workflows.\n- **Technical history:** `runtime.log` and JSON files help diagnose what happened.\n\nUse the Memory dashboard to browse or edit the human-readable information. Consequential workflow changes should still be reviewed before automation.\n');
  if (!fs.existsSync(usersFile)) fs.writeFileSync(usersFile, '# Human Staff Members\n\nUse this file to describe the people who work with Gymstant. Avoid passwords, payment details, medical information, or other secrets.\n\n## Staff member template\n\n- **Name:**\n- **Role:**\n- **Preferred name:**\n- **Responsibilities:**\n- **Software used:**\n- **Approval authority:**\n- **Communication preferences:**\n- **Notes that help Gymstant collaborate:**\n');
  if (!fs.existsSync(employeeFile)) fs.writeFileSync(employeeFile, '# Gymstant as an Employee\n\nGymstant is a privacy-first digital coworker initially built for gyms. It learns the approved processes staff perform in existing class-management, communication, calendar, and office software.\n\n## Responsibilities\n\n- Observe and document demonstrated workflows.\n- Prepare repetitive administrative work accurately.\n- Maintain clear Review and Monitor queues.\n- Ask before remembering or scheduling reusable work.\n- Pause when a human needs the computer.\n- Explain problems in plain language and offer to repair them.\n\n## Boundaries\n\nGymstant must stop before sending, submitting, deleting, publishing, moving money, exposing sensitive information, or completing other consequential final actions until that workflow has been explicitly approved and verified.\n');
  const sourceDashboard = path.join(__dirname, '../memory-dashboard.html');
  if (fs.existsSync(sourceDashboard)) fs.copyFileSync(sourceDashboard, dashboardFile);
}

function memoryData() {
  ensureData();
  const read = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const conversations = [];
  if (fs.existsSync(transcriptFile)) conversations.push({ id: 'current', title: 'Current conversation', messages: parseTranscript(read(transcriptFile)) });
  for (const file of fs.readdirSync(conversationArchiveDir).filter(name => name.endsWith('.jsonl.gz')).sort().reverse()) {
    try { const messages = parseTranscript(zlib.gunzipSync(fs.readFileSync(path.join(conversationArchiveDir, file))).toString('utf8')); conversations.push({ id: file, title: messages.find(m => m.role === 'user')?.content?.slice(0, 60) || file, messages }); } catch {}
  }
  let state = {}; try { state = fs.existsSync(stateFile) ? JSON.parse(read(stateFile)) : {}; } catch {}
  return {
    markdown: { 'MEMORY.md': read(memoryFile), 'MEMORY_GUIDE.md': read(memoryGuideFile), 'users.md': read(usersFile), 'employee.md': read(employeeFile) },
    workflows: state.workflows || [], conversations,
    screenshots: fs.readdirSync(shotsDir).filter(name => name.endsWith('.png')).sort().reverse(),
    logs: read(runtimeLogFile).split('\n').slice(-250).join('\n')
  };
}
function startMemoryServer() {
  if (memoryServer) return Promise.resolve(memoryServer.address().port);
  return new Promise(resolve => {
    memoryServer = http.createServer((req, res) => {
      const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(value)); };
      if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(dashboardFile)); }
      if (req.method === 'GET' && req.url === '/api/data') return json(200, memoryData());
      if (req.method !== 'POST' || req.url !== '/api/save') return json(404, { error: 'Not found' });
      let body = ''; req.on('data', chunk => { if (body.length < 2_000_000) body += chunk; }); req.on('end', () => {
        try {
          const payload = JSON.parse(body); const data = memoryData();
          if (payload.kind === 'markdown' && Object.hasOwn(data.markdown, payload.id)) fs.writeFileSync(path.join(dataDir, path.basename(payload.id)), String(payload.content));
          else if (payload.kind === 'workflows') { const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {}; state.workflows = JSON.parse(payload.content); fs.writeFileSync(stateFile, JSON.stringify(state, null, 2)); }
          else if (payload.kind === 'conversation') { const messages = JSON.parse(payload.content); const raw = messages.map(item => JSON.stringify(item)).join('\n') + '\n'; if (payload.id === 'current') fs.writeFileSync(transcriptFile, raw); else { const safe = path.basename(payload.id); if (!safe.endsWith('.jsonl.gz')) throw new Error('Invalid archive'); fs.writeFileSync(path.join(conversationArchiveDir, safe), zlib.gzipSync(raw, { level: 9 })); } }
          else throw new Error('That item is read-only.');
          runtimeLog('memory.edited', { kind: payload.kind, id: payload.id }); json(200, { ok: true });
        } catch (error) { json(400, { error: error.message }); }
      });
    });
    memoryServer.listen(0, '127.0.0.1', () => resolve(memoryServer.address().port));
  });
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    width: collapsedSize.width, height: collapsedSize.height, x: Math.round(area.x + (area.width - collapsedSize.width) / 2), y: area.y + area.height - 150,
    frame: false, transparent: true, alwaysOnTop: true, resizable: false, movable: true, skipTaskbar: true,
    hasShadow: false, backgroundColor: '#00000000', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true }
  });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (process.platform === 'win32' && typeof win.setBackgroundMaterial === 'function') win.setBackgroundMaterial('acrylic');
  // Gymstant must remain visible in the operator's screen recordings.
  win.setContentProtection(false);
  win.loadURL(isDev ? 'http://127.0.0.1:5173' : `file://${path.join(__dirname, '../web-dist/index.html')}`);
  win.on('moved', () => { sendPlacement(); syncNativeGlass(); });
  win.on('move', () => { sendPlacement(); syncNativeGlass(); });
  win.on('resize', syncNativeGlass);
  win.webContents.on('did-finish-load', () => { sendPlacement(); startNativeGlass(); });
}

function currentPlacement() {
  if (!win) return { vertical: 'up', horizontal: 'center' };
  const bounds = win.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  return {
    vertical: centerY > area.y + area.height / 2 ? 'up' : 'down',
    horizontal: centerX < area.x + area.width * .34 ? 'left' : centerX > area.x + area.width * .66 ? 'right' : 'center'
  };
}
function sendPlacement() { if (win && !win.isDestroyed()) win.webContents.send('window:placement', currentPlacement()); }

async function refreshLens() {
  if (!win || win.isDestroyed() || lensRefreshing) return lastLensFrame || null;
  lensRefreshing = true;
  const bounds = win.getBounds();
  const display = screen.getDisplayMatching(bounds);
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: display.size });
    const source = sources.find(item => item.display_id === String(display.id)) || sources[0];
    if (!source || source.thumbnail.isEmpty()) return lastLensFrame || null;
    const frame = { dataUrl: source.thumbnail.toDataURL(), width: display.size.width, height: display.size.height, x: bounds.x - display.bounds.x, y: bounds.y - display.bounds.y };
    lastLensFrame = frame;
    win.webContents.send('lens:frame', frame);
    return frame;
  } finally { lensRefreshing = false; }
}
function sendLensPosition() {
  if (!lastLensFrame || !win) return;
  const bounds = win.getBounds();
  const display = screen.getDisplayMatching(bounds);
  lastLensFrame = { ...lastLensFrame, x: bounds.x - display.bounds.x, y: bounds.y - display.bounds.y };
  win.webContents.send('lens:frame', lastLensFrame);
}
// Avoid recursively capturing this recordable overlay (and burning a CPU core).
function startLensTimer() {}
function stopLensTimer() { if (lensTimer) { clearInterval(lensTimer); lensTimer = null; } }

app.whenReady().then(() => {
  ensureData(); killEventRecorderProcesses(); createWindow();
  globalShortcut.register('CommandOrControl+Shift+G', () => win?.webContents.send('capture:shortcut'));
  globalShortcut.register('CommandOrControl+Shift+W', () => win?.webContents.send('workflow:shortcut-toggle'));
});
app.on('will-quit', () => { globalShortcut.unregisterAll(); if (lensTimer) clearInterval(lensTimer); stopNativeGlass(); killEventRecorderProcesses(); });
app.on('window-all-closed', () => app.quit());

ipcMain.on('window:resize', (_, expanded) => {
  isExpanded = expanded;
  const old = win.getBounds();
  const area = screen.getDisplayMatching(old).workArea;
  const placement = currentPlacement();
  windowMode = expanded ? 'expanded' : 'chatbar';
  const next = { width: windowMode === 'minimized' ? minimizedSize.width : old.width, height: expanded ? Math.min(900, area.height - 20) : collapsedHeight };
  const anchorX = placement.horizontal === 'left' ? old.x : placement.horizontal === 'right' ? old.x + old.width : old.x + old.width / 2;
  const anchorY = placement.vertical === 'up' ? old.y + old.height : old.y;
  let x = placement.horizontal === 'left' ? anchorX : placement.horizontal === 'right' ? anchorX - next.width : anchorX - next.width / 2;
  let y = placement.vertical === 'up' ? anchorY - next.height : anchorY;
  x = Math.max(area.x, Math.min(x, area.x + area.width - next.width));
  y = Math.max(area.y, Math.min(y, area.y + area.height - next.height));
  win.setBounds({ x: Math.round(x), y: Math.round(y), ...next }, true);
  setTimeout(sendPlacement, 40);
  setTimeout(refreshLens, 90);
});
ipcMain.on('window:drag-start', (_, point) => {
  dragSession = { point, bounds: win.getBounds() };
});
ipcMain.on('window:drag-move', (_, point) => {
  if (!dragSession) return;
  const display = screen.getDisplayNearestPoint({ x: point.x, y: point.y });
  const area = display.workArea;
  const x = Math.max(area.x, Math.min(dragSession.bounds.x + point.x - dragSession.point.x, area.x + area.width - dragSession.bounds.width));
  const y = Math.max(area.y, Math.min(dragSession.bounds.y + point.y - dragSession.point.y, area.y + area.height - dragSession.bounds.height));
  win.setPosition(Math.round(x), Math.round(y));
  sendLensPosition();
});
ipcMain.on('window:drag-end', () => { dragSession = null; sendPlacement(); refreshLens(); });
ipcMain.on('window:resize-start', (_, payload) => { resizeSession = { edge: payload.edge, point: payload.point, bounds: win.getBounds() }; });
ipcMain.on('window:resize-move', (_, point) => {
  if (!resizeSession) return;
  const { edge, bounds, point: start } = resizeSession;
  const area = screen.getDisplayMatching(bounds).workArea;
  const minWidth = minimizedSize.width;
  let width = edge === 'right' ? bounds.width + point.x - start.x : bounds.width - (point.x - start.x);
  width = Math.max(minWidth, Math.min(width, area.width));
  let x = edge === 'left' ? bounds.x + bounds.width - width : bounds.x;
  x = Math.max(area.x, Math.min(x, area.x + area.width - width));
  const mode = nextWindowMode({ width, height: bounds.height, collapsedHeight });
  if (mode === 'minimized') {
    width = minimizedSize.width;
    x = edge === 'left' ? bounds.x + bounds.width - width : bounds.x;
    windowMode = 'minimized';
  } else if (windowMode === 'minimized') windowMode = 'chatbar';
  win.setBounds({ x: Math.round(x), y: bounds.y, width: Math.round(width), height: bounds.height });
  win.webContents.send('window:mode', windowMode);
  sendLensPosition();
});
ipcMain.on('window:resize-end', () => { resizeSession = null; refreshLens(); });
ipcMain.on('window:height-resize-start', (_, point) => { heightResizeSession = { point, bounds: win.getBounds() }; });
ipcMain.on('window:height-resize-move', (_, point) => {
  if (!heightResizeSession) return;
  const { bounds, point: start } = heightResizeSession;
  const area = screen.getDisplayMatching(bounds).workArea;
  const bottom = bounds.y + bounds.height;
  const height = Math.max(collapsedSize.height, Math.min(bounds.height - (point.y - start.y), area.height));
  const y = Math.max(area.y, bottom - height);
  const nextHeight = Math.round(bottom - y);
  windowMode = nextWindowMode({ width: bounds.width, height: nextHeight, collapsedHeight });
  if (windowMode === 'chatbar') isExpanded = false;
  win.setBounds({ x: bounds.x, y: Math.round(y), width: bounds.width, height: nextHeight });
  win.webContents.send('window:mode', windowMode);
  sendLensPosition();
});
ipcMain.on('window:height-resize-end', () => { heightResizeSession = null; refreshLens(); });
ipcMain.handle('window:restore-chatbar', () => {
  if (!win) return false;
  const bounds = win.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  const width = collapsedSize.width;
  const height = collapsedHeight;
  const x = Math.max(area.x, Math.min(bounds.x + Math.round((bounds.width - width) / 2), area.x + area.width - width));
  const y = Math.max(area.y, Math.min(bounds.y + bounds.height - height, area.y + area.height - height));
  windowMode = 'chatbar'; isExpanded = false;
  win.setBounds({ x, y, width, height }, true);
  win.webContents.send('window:mode', 'chatbar');
  syncNativeGlass();
  return true;
});
ipcMain.on('window:content-height', (_, requested) => {
  if (!win || executionBounds) return;
  const bounds = win.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  const height = Math.max(108, Math.min(Number(requested) || 108, area.height));
  // Content changes (such as removing a workflow) must not collapse an
  // already-expanded panel. Explicit height-resize events use a separate
  // handler and remain allowed to reduce the window.
  if (isExpanded && windowMode === 'expanded' && height < bounds.height) return;
  if (!isExpanded) collapsedHeight = height;
  const placement = currentPlacement();
  let y = placement.vertical === 'up' ? bounds.y + bounds.height - height : bounds.y;
  y = Math.max(area.y, Math.min(y, area.y + area.height - height));
  win.setBounds({ x: bounds.x, y: Math.round(y), width: bounds.width, height: Math.round(height) });
  sendLensPosition();
});
ipcMain.on('glass:chatbar-height', (_, height) => { nativeChatbarHeight = Math.max(56, Math.min(300, Number(height) || 56)); syncNativeGlass(); });
ipcMain.handle('lens:refresh', refreshLens);
ipcMain.handle('execution:begin', () => {
  if (!win || executionBounds) return true;
  executionBounds = win.getBounds();
  executionPeeked = false;
  stopLensTimer();
  const area = screen.getDisplayMatching(executionBounds).workArea;
  windowMode = 'minimized'; isExpanded = false;
  win.setBounds({ x: area.x + area.width - executionPillSize.width - 10, y: area.y + 10, ...executionPillSize }, true);
  win.webContents.send('window:mode', 'minimized');
  arrangeWorkspace(0);
  return true;
});
ipcMain.handle('execution:peek', () => {
  if (!win || !executionBounds) return false;
  executionPeeked = true;
  const area = screen.getDisplayMatching(executionBounds).workArea;
  const height = Math.min(Math.max(360, executionBounds.height), Math.floor(area.height * .42));
  const width = Math.min(Math.max(660, executionBounds.width), area.width - 24);
  const bounds = { x: Math.round(area.x + (area.width - width) / 2), y: area.y + area.height - height - 8, width, height };
  windowMode = 'expanded'; isExpanded = true;
  win.webContents.send('window:mode', 'chatbar');
  win.setBounds(bounds, true);
  arrangeWorkspace(height + 18);
  return true;
});
ipcMain.handle('execution:hide', () => {
  if (!win || !executionBounds) return false;
  executionPeeked = false;
  const area = screen.getDisplayMatching(executionBounds).workArea;
  windowMode = 'minimized'; isExpanded = false;
  win.setBounds({ x: area.x + area.width - executionPillSize.width - 10, y: area.y + 10, ...executionPillSize }, true);
  win.webContents.send('window:mode', 'minimized');
  arrangeWorkspace(0);
  return true;
});
ipcMain.handle('execution:end', () => {
  if (!win || !executionBounds) return true;
  const restore = executionBounds;
  executionBounds = null;
  executionPeeked = false;
  windowMode = 'chatbar';
  win.webContents.send('window:mode', 'chatbar');
  if (!managedApps.size) win.setBounds(restore, true);
  else setTimeout(() => arrangeWorkspace(470), 260);
  startLensTimer();
  return true;
});
ipcMain.handle('execution:cancel', () => cancelActiveExecution());
ipcMain.handle('settings:focus-resume', (_, seconds) => {
  focusResumeSeconds = Math.max(5, Math.min(300, Number(seconds) || 15));
  runtimeLog('settings.focus-resume', { seconds: focusResumeSeconds });
  return focusResumeSeconds;
});
ipcMain.handle('app:restart', () => { app.relaunch(); app.exit(0); return true; });
ipcMain.handle('app:quit', () => { app.quit(); return true; });
ipcMain.handle('workflow:approve-learned', (_, actionId) => speedLayer.approve('missed-class-makeup', String(actionId || '')));
ipcMain.handle('monitor:execute', async (_, actionId) => {
  if (actionId === 'demo-makeup-roster') {
    const stdout = await runProcessGroup('/opt/homebrew/bin/docker', ['exec', 'education-frappe-1', 'bash', '-lc', `cd /home/frappe/frappe-bench && bench --site education.localhost execute 'frappe.get_attr("education.demo_seed.approve_makeup")()'`], { timeout: 30000 });
    spawn('/usr/bin/open', ['-a', 'Google Chrome', 'http://education.localhost:8000/app/student-group/Beginner%20Tumbling%20-%20Tuesday%205%3A00%20PM'], { detached:true, stdio:'ignore' }).unref();
    runtimeLog('monitor.completed', { action: actionId });
    return { ok:true, text:'Ava Bennett was added to Beginner Tumbling - Tuesday 5:00 PM as a makeup, and the saved roster was reopened for verification.' };
  }
  if (actionId === 'demo-makeup-email' && process.platform === 'darwin') {
    const js = `(()=>{const b=[...document.querySelectorAll('[role="button"],button')].find(x=>/^Send(?:\\s|$)/i.test((x.getAttribute('aria-label')||x.textContent||'').trim()));if(!b)return 'missing';b.click();return 'clicked';})()`;
    const safe = js.replace(/["\\]/g, value => `\\${value}`);
    const script = `tell application "Google Chrome"\nrepeat with w in windows\nrepeat with t in tabs of w\nif URL of t contains "mail.google.com" then\nset index of w to 1\nset active tab index of w to (index of t)\nset resultText to execute t javascript "${safe}"\nreturn resultText\nend if\nend repeat\nend repeat\nreturn "missing"\nend tell`;
    const { stdout } = await runProcessGroup('/usr/bin/osascript', ['-e', script], { timeout:15000 });
    if (!String(stdout).includes('clicked')) throw new Error('The prepared Gmail Send button was not visible.');
    runtimeLog('monitor.completed', { action: actionId });
    return { ok:true, text:'The approved makeup confirmation email was sent from the prepared Gmail draft.' };
  }
  throw new Error('That Monitor action is not executable yet.');
});
ipcMain.handle('calendar:options', () => {
  const exists = name => process.platform === 'darwin' && fs.existsSync(`/Applications/${name}.app`);
  const options = [];
  if (process.platform === 'darwin') options.push({ id: 'apple', label: 'Apple Calendar', detail: 'Installed on this Mac' });
  if (process.platform === 'win32' || fs.existsSync('/Applications/Google Chrome.app')) options.push({ id: 'google', label: 'Google Calendar', detail: 'Available through Chrome' });
  if (exists('Microsoft Outlook')) options.push({ id: 'outlook', label: 'Outlook', detail: 'Installed on this Mac' });
  if (exists('Fantastical')) options.push({ id: 'fantastical', label: 'Fantastical', detail: 'Installed on this Mac' });
  return options;
});
ipcMain.handle('calendar:schedule', async (_, payload) => {
  if (process.platform !== 'darwin' || payload?.calendar !== 'apple') return { delegated: true };
  const hourRaw = Math.max(0, Math.min(23, Number(payload.hour) || 14));
  const minute = Math.max(0, Math.min(59, Number(payload.minute) || 0));
  const title = String(payload.title || 'Gymstant workflow').replace(/["\\]/g, '');
  const detail = String(payload.detail || 'Automated by Gymstant').replace(/["\\]/g, '');
  const recurrence = payload.cadence === 'weekly' ? 'FREQ=WEEKLY' : payload.cadence === 'weekdays' ? 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' : 'FREQ=DAILY';
  const script = `tell application "Calendar"\nactivate\nif not (exists calendar "Gymstant") then\nset gymCalendar to make new calendar with properties {name:"Gymstant"}\nset color of gymCalendar to {30000, 23000, 65535}\nelse\nset gymCalendar to calendar "Gymstant"\nend if\nset startDate to current date\nset hours of startDate to ${hourRaw}\nset minutes of startDate to ${minute}\nset seconds of startDate to 0\nif startDate < (current date) then set startDate to startDate + (1 * days)\nset endDate to startDate + (30 * minutes)\nset createdEvent to make new event at end of events of gymCalendar with properties {summary:"${title}", description:"${detail}", start date:startDate, end date:endDate, recurrence:"${recurrence}"}\nreload calendars\nreturn uid of createdEvent\nend tell`;
  return await new Promise(resolve => {
    const child = spawn('/usr/bin/osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => {
      if (code === 0) { runtimeLog('calendar.scheduled', { calendar: 'apple', title, recurrence }); resolve({ ok: true, id: stdout.trim(), calendar: 'Apple Calendar', title }); }
      else { runtimeLog('calendar.failed', { calendar: 'apple', detail: stderr.slice(-300) }); resolve({ ok: false, message: 'Calendar would not accept the new event.' }); }
    });
  });
});
ipcMain.handle('assignment:ack', async (_, text) => {
  const prompt = `You are Gymstant, a concise desktop coworker. Acknowledge this assignment naturally in one short sentence and say what you will do. Do not claim it is complete and do not use tools. Assignment: ${String(text).slice(0, 1200)}`;
  try {
    const { stdout } = await runProcessGroup(gymstantCliPath(), ['-z', prompt, '-t', ''], {
      cwd: gymstantWorkdir(), timeout: 30000,
      env: hermesEnv()
    });
    return { text: stdout.replace(/\u001b\[[0-9;]*m/g, '').trim(), model: 'Hermes · task handoff' };
  } catch {
    return { text: 'I understand the assignment. I’ll move aside while I work and stop before any consequential final action.', model: 'Gymstant fallback' };
  }
});
ipcMain.handle('hermes:get-model', () => ({ model: readHermesModelConfig() }));
ipcMain.handle('hermes:list-models', () => readHermesModelCatalog());
ipcMain.handle('hermes:set-model', async (_, id) => {
  const modelId = String(id || '').trim();
  if (!modelId) return { ok: false, message: 'No model id provided.' };
  try {
    await runQuickProcess(gymstantCliPath(), ['config', 'set', 'model.provider', 'openrouter'], { cwd: gymstantWorkdir(), timeout: 20000, env: hermesEnv() });
    await runQuickProcess(gymstantCliPath(), ['config', 'set', 'model.default', modelId], { cwd: gymstantWorkdir(), timeout: 20000, env: hermesEnv() });
    runtimeLog('hermes.model-set', { model: modelId });
    return { ok: true, model: readHermesModelConfig() };
  } catch (error) {
    runtimeLog('hermes.model-set-failed', { model: modelId, message: String(error.message || error).slice(0, 200) });
    return { ok: false, message: String(error.message || error).slice(0, 200) };
  }
});
ipcMain.handle('hermes:list-tools', async () => {
  try {
    const { stdout } = await runQuickProcess(gymstantCliPath(), ['tools', 'list'], { cwd: gymstantWorkdir(), timeout: 20000, env: hermesEnv() });
    return { tools: parseHermesToolsList(stdout) };
  } catch (error) {
    return { tools: [], error: String(error.message || error).slice(0, 200) };
  }
});
ipcMain.handle('hermes:set-tool', async (_, name, enabled) => {
  const toolName = String(name || '').trim();
  if (!toolName) return { ok: false, message: 'No tool name provided.' };
  try {
    await runQuickProcess(gymstantCliPath(), ['tools', enabled ? 'enable' : 'disable', toolName], { cwd: gymstantWorkdir(), timeout: 20000, env: hermesEnv() });
    const { stdout } = await runQuickProcess(gymstantCliPath(), ['tools', 'list'], { cwd: gymstantWorkdir(), timeout: 20000, env: hermesEnv() });
    runtimeLog('hermes.tool-set', { tool: toolName, enabled: Boolean(enabled) });
    return { ok: true, tools: parseHermesToolsList(stdout) };
  } catch (error) {
    const raw = String(error.message || error);
    const message = raw.includes('interactive terminal') ? "Toggling tools isn't supported without an interactive terminal in this Hermes version." : raw.slice(0, 200);
    runtimeLog('hermes.tool-set-failed', { tool: toolName, message });
    return { ok: false, message };
  }
});
ipcMain.handle('chat:load', () => {
  if (!fs.existsSync(transcriptFile)) return [];
  return fs.readFileSync(transcriptFile, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).slice(-30);
});
function parseTranscript(raw) { return raw.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); }
ipcMain.handle('chat:history', () => {
  ensureData();
  const items = [];
  if (fs.existsSync(transcriptFile)) {
    const messages = parseTranscript(fs.readFileSync(transcriptFile, 'utf8'));
    if (messages.length) items.push({ id: 'current', title: messages.find(m => m.role === 'user')?.content?.slice(0, 54) || 'Current conversation', count: messages.length, archived: false });
  }
  for (const file of fs.readdirSync(conversationArchiveDir).filter(name => name.endsWith('.jsonl.gz')).sort().reverse()) {
    try { const messages = parseTranscript(zlib.gunzipSync(fs.readFileSync(path.join(conversationArchiveDir, file))).toString('utf8')); items.push({ id: file, title: messages.find(m => m.role === 'user')?.content?.slice(0, 54) || 'Archived conversation', count: messages.length, archived: true }); } catch {}
  }
  return items;
});
ipcMain.handle('chat:archive', () => {
  ensureData();
  if (!fs.existsSync(transcriptFile)) return false;
  const raw = fs.readFileSync(transcriptFile);
  if (!raw.length) { fs.unlinkSync(transcriptFile); return false; }
  const file = `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl.gz`;
  fs.writeFileSync(path.join(conversationArchiveDir, file), zlib.gzipSync(raw, { level: 9 }));
  fs.unlinkSync(transcriptFile);
  return true;
});
ipcMain.handle('chat:open', (_, id) => {
  if (id === 'current') return fs.existsSync(transcriptFile) ? parseTranscript(fs.readFileSync(transcriptFile, 'utf8')) : [];
  const safe = path.basename(String(id));
  const file = path.join(conversationArchiveDir, safe);
  return fs.existsSync(file) ? parseTranscript(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')) : [];
});
ipcMain.handle('state:load', () => fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null);
ipcMain.handle('state:save', (_, state) => { ensureData(); fs.writeFileSync(stateFile, JSON.stringify(state, null, 2)); return true; });
ipcMain.handle('data:open', async () => { const port = await startMemoryServer(); await shell.openExternal(`http://127.0.0.1:${port}`); return true; });
ipcMain.handle('capture:screen', async (_, label = 'step', privacy = 'redacted') => {
  ensureData();
  const display = screen.getPrimaryDisplay();
  const shouldRestore = Boolean(win && !win.isDestroyed() && win.isVisible());
  // A capture must document the operator's workspace, never Gymstant itself.
  // The native glass companion is stopped too, so it cannot leave a ghost box.
  if (shouldRestore) { stopNativeGlass(); win.hide(); await new Promise(resolve => setTimeout(resolve, 180)); }
  try {
    // Scan the exposed page before capturing. The scanner reads only local macOS
    // accessibility metadata and returns screen rectangles; it never receives
    // or writes the screenshot pixels.
    const scan = privacy === 'redacted' ? await scanSensitiveRegions(display) : { ok:true, regions:[] };
    if (!scan.ok) return { error:`Privacy pre-scan failed, so no screenshot was saved: ${scan.reason}` };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: display.size });
    const source = sources.find(item => item.display_id === String(display.id)) || sources[0];
    if (!source || source.thumbnail.isEmpty()) return { error: 'Screen Recording permission is required.' };
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(shotsDir, `${stamp}-${String(label).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`);
    let output = source.thumbnail.toPNG();
    let savedPrivacy = privacy;
    let redactionRegions = scan.regions || [];
    if (privacy === 'redacted') {
      const ocr = await scanSensitiveImage(output, display.size.width, display.size.height);
      if (!ocr.ok && !redactionRegions.length) return { error:`Privacy scan could not verify this frame, so no screenshot was saved: ${ocr.reason}` };
      redactionRegions = mergeRedactionRegions([...redactionRegions, ...(ocr.regions || [])], display.size.width, display.size.height);
      output = await blurSensitiveRegions(output, redactionRegions);
    }
    else if (privacy === 'pixelated') {
      const image = source.thumbnail.resize({ width:96, height:Math.max(54, Math.round(display.size.height / display.size.width * 96)) }).resize({ width:display.size.width, height:display.size.height, kernel:'nearest' });
      output = image.toPNG();
      savedPrivacy = 'pixelated';
    }
    // Only the processed buffer is persisted. The original frame existed in
    // memory for this operation and is never written in redacted/pixelated mode.
    fs.writeFileSync(file, output);
    const thumbnail = await sharp(output).resize({ width:420, withoutEnlargement:true }).png().toBuffer();
    runtimeLog('capture.saved', { privacy:savedPrivacy, redactions:redactionRegions.length, scanner:privacy==='redacted'?'local-accessibility+ocr':'none', file:path.basename(file) });
    return { path:file, fullUrl:pathToFileURL(file).href, dataUrl:`data:image/png;base64,${thumbnail.toString('base64')}`, privacy:savedPrivacy, redactions:redactionRegions.length, scanStatus:'completed', capturedAt:new Date().toISOString() };
  } finally {
    if (shouldRestore && win && !win.isDestroyed()) { win.showInactive(); startNativeGlass(); syncNativeGlass(); }
  }
});
ipcMain.handle('workflow:choose-recording', async () => {
  const result = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Video recording', extensions: ['mov', 'mp4', 'm4v', 'webm'] }] });
  if (result.canceled || !result.filePaths[0]) return null;
  return analyzeRecordingFile(result.filePaths[0]);
});
ipcMain.handle('workflow:analyze-recording', async (_, file) => analyzeRecordingFile(file));
ipcMain.handle('workflow:events-start', () => startWorkflowEventRecording());
ipcMain.handle('workflow:events-stop', async () => stopWorkflowEventRecording());
ipcMain.handle('workflow:events-snapshot', () => ({ count: activeEventTrace.length, lastAt: activeEventTrace.at(-1)?.at || null, events: activeEventTrace.slice() }));
ipcMain.handle('workflow:events-replay', (_, payload = {}) => {
  const trace = Array.isArray(payload.events) ? payload.events : [];
  const events = trace.filter(event => ['mouse.click', 'key.press'].includes(event?.type));
  if (!events.length) {
    const transitions = trace.filter(event => event?.type === 'window.activate');
    // A window-only trace is still useful locally: bring each recorded app to
    // the foreground in order instead of sending it to a model or declaring it
    // unavailable. Click/key replay remains reported as zero honestly.
    for (const event of transitions) {
      const app = String(event.app || '').trim();
      if (!app || app === 'Gymstant') continue;
      try { spawn('/usr/bin/open', ['-a', app], { detached: true, stdio: 'ignore' }).unref(); } catch {}
    }
    return { ok:true, events:0, windowTransitions:transitions.length, output:'window transitions replayed locally; no native click/key events were captured' };
  }
  return replayWorkflowEvents(events, payload.options || {});
});
ipcMain.handle('workflow:complete', (_, workflow) => {
  ensureData();
  const manual = buildWorkflowManual(workflow);
  fs.appendFileSync(memoryFile, `\n${manual}\n`);
  runtimeLog('workflow.manual-saved', { id: workflow.id, steps: workflow.steps?.length || 0, privacy: workflow.privacy || 'local' });
  return { memoryFile, manual };
});
ipcMain.handle('workflow:retire', (_, workflow) => {
  ensureData();
  const retirement = buildWorkflowRetirement(workflow || {});
  fs.appendFileSync(memoryFile, `\n${retirement}\n`);
  runtimeLog('workflow.retired', { id: workflow?.id || 'unknown', title: workflow?.title || 'Untitled workflow' });
  return { memoryFile, retirement };
});
ipcMain.handle('local:chat', async (_, payload) => {
  ensureData();
  const startedAt = Date.now();
  const messages = Array.isArray(payload) ? payload : payload.messages;
  const actionable = Array.isArray(payload) ? true : Boolean(payload.options?.actionable);
  const latest = messages[messages.length - 1];
  const normalizedLatest = actionable ? originalRequest(latest?.content || '') : String(latest?.content || '');
  const priorTranscript = fs.existsSync(transcriptFile) ? parseTranscript(fs.readFileSync(transcriptFile, 'utf8')) : [];
  const duplicateRetry = actionable && priorTranscript.some(item => item.role === 'user' && originalRequest(item.content) === normalizedLatest);
  if (!duplicateRetry) fs.appendFileSync(transcriptFile, `${JSON.stringify({ ...latest, content: normalizedLatest, at: new Date().toISOString() })}\n`);
  const deterministic = deterministicAction(latest?.content || '');
  if (deterministic) {
    runtimeLog('route.complete', { route: 'deterministic-gmail', duration_ms: Date.now() - startedAt });
    fs.appendFileSync(transcriptFile, `${JSON.stringify({ role: 'assistant', content: deterministic.text, model: deterministic.model, at: new Date().toISOString() })}\n`);
    return deterministic;
  }
  const preparationOnly = /\b(?:do not|don't|never)\b[^.]{0,180}\b(?:send|submit|finalize|change)\b/i.test(latest?.content || '') || /\bwithout (?:me|my|human)\b/i.test(latest?.content || '');
  const highRisk = !payload?.options?.approved && !payload?.options?.preview && !preparationOnly && /\b(send|submit|publish|post|delete|remove|pay|purchase|buy|transfer|trade|password|credential|social security|sign|book|cancel|finalize)\b/i.test(latest?.content || '');
  if (highRisk) {
    const result = { text: 'I can prepare and inspect this task, but Gymstant requires the Monitor lane and a human final confirmation before executing consequential actions.', model: 'Gymstant safety gate' };
    fs.appendFileSync(transcriptFile, `${JSON.stringify({ role: 'assistant', content: result.text, model: result.model, at: new Date().toISOString() })}\n`);
    return result;
  }
  if (payload?.options?.preview) {
    if (/\bchrome|class software|client software|education|frappe\b/i.test(latest?.content || '')) managedApps.add('Google Chrome');
    setTimeout(() => arrangeWorkspace(0), 80);
    runtimeLog('preview.start', { route:'hermes-preview', title:normalizedLatest.slice(0, 100) });
    const previewPrompt = `You are Gymstant's workflow preview operator. Execute only the preparation steps in the saved workflow below using computer_use. Open the target application if needed, visibly perform each step in order, and report what you actually verified. Do not save, send, submit, delete, publish, purchase, or complete any consequential action. If a step is ambiguous, stop and report the ambiguity instead of improvising.\n\nSAVED WORKFLOW PREVIEW:\n${latest?.content || normalizedLatest}`;
    try {
      // Preview owns the computer-use session. Do not pause it merely because
      // the orchestration shell/Terminal is the current foreground app; that
      // focus monitor was repeatedly interrupting otherwise valid replays.
      // Computer-use providers often buffer their stdout until the whole turn
      // is complete. A short "no output" watchdog therefore killed valid
      // visible runs even while Hermes was actively driving the screen. Use a
      // hard five-minute safety bound, but let the model/tool loop make
      // progress without requiring shell output between each action.
      runtimeLog('preview.timeout-config', { timeout_ms: 300000, progress_watchdog: false, model: readHermesModelConfig() });
      const { stdout } = await runProcessGroup(gymstantCliPath(), ['-z', previewPrompt, '-t', 'computer_use'], { cwd:gymstantWorkdir(), timeout:300000, progressTimeout:0, focusAware:false, maxBuffer:1024 * 1024, env:hermesEnv() });
      const clean = stdout.replace(/\u001b\[[0-9;]*m/g, '').trim();
      if (!clean || isFalseSuccess(clean)) throw new Error(clean || 'Preview returned no verified result.');
      runtimeLog('preview.complete', { route:'hermes-preview', result_chars:clean.length });
      return { text:clean, model:'Hermes · visible workflow preview' };
    } catch (error) {
      runtimeLog('preview.failed', { route:'hermes-preview', message:String(error.message || error).slice(0, 240) });
      throw error;
    }
  }
  const learnedRoute = actionable && speedLayer.match(normalizedLatest);
  if (learnedRoute === 'seeded-makeup-fastpath') {
    const fastStartedAt = Date.now();
    managedApps.add('Google Chrome');
    setTimeout(() => arrangeWorkspace(0), 80);
    runtimeLog('route.start', { route: learnedRoute });
    try {
      const deliberate = !speedLayer.isApproved('missed-class-makeup');
      runtimeLog('workflow.trust-mode', { task: 'missed-class-makeup', mode: deliberate ? 'first-run-proof' : 'approved-fast' });
      const fast = await runSeededDemoFastPath({ activity: sendActivity, arrange: () => arrangeWorkspace(isExpanded ? 416 : 118), deliberate });
      const result = { text: fast.text, model: 'Gymstant · learned fast path', monitorActions: [
        { id:'demo-makeup-roster', title:'Add Ava to Tuesday makeup roster', app:'Class software', status:'monitor', steps:1, confidence:100, detail:'Beginner Tumbling - Tuesday 5:00 PM · staged and unsaved' },
        { id:'demo-makeup-email', title:'Send Maya’s makeup confirmation', app:'Gmail', status:'monitor', steps:1, confidence:100, detail:'Draft prepared · unsent' }
      ] };
      const duration = Date.now() - fastStartedAt;
      speedLayer.recordSuccess(normalizedLatest, learnedRoute, duration, fast.steps);
      runtimeLog('route.complete', { route: learnedRoute, duration_ms: duration, steps: fast.steps.length });
      fs.appendFileSync(transcriptFile, `${JSON.stringify({ role: 'assistant', content: result.text, model: result.model, at: new Date().toISOString() })}\n`);
      setTimeout(() => arrangeWorkspace(470), 750);
      return result;
    } catch (error) {
      const duration = Date.now() - fastStartedAt;
      speedLayer.recordFailure(normalizedLatest, learnedRoute, duration, error);
      runtimeLog('route.failed', { route: learnedRoute, duration_ms: duration, code: error.code || 'unknown' });
      sendActivity('Step 4 needs attention. The completed checks are saved.', 'error');
      throw new Error(`I could not visibly stage the roster proposal: ${String(error.message || error).slice(0, 220)} Use Fix to retry this step; I did not switch to a slower agent or claim completion.`);
    }
  }
  if (!actionable) {
    runtimeLog('route.start', { route: 'hermes-gpt55-chat' });
    let clean = '';
    try {
      const conversation = messages.slice(-6).map(item => `${item.role === 'user' ? 'User' : 'Gymstant'}: ${item.content}`).join('\n');
      const prompt = `You are Gymstant, a concise privacy-first coworker for gyms. Answer the user's latest message in 60 words or fewer. Never claim you used tools or changed the computer.\n\n${conversation}`;
      const { stdout } = await runQuickProcess(gymstantCliPath(), ['-z', prompt], { cwd: gymstantWorkdir(), timeout: 60000, env: hermesEnv() });
      clean = stdout.replace(/\x1b\[[0-9;]*m/g, '').trim();
    } catch {
      clean = 'Gymstant could not reach GPT-5.5 just now. Workflow capture, Review, Monitor, memory, and privacy-protected screenshots remain available locally.';
    }
    if (/\b(?:I (?:have|'ve) (?:added|sent|saved|changed|updated|opened)|completed successfully|all updates are complete)\b/i.test(clean)) clean = 'I have not executed that action from ordinary conversation. Open Monitor and approve each visible final action so the approval is explicit and auditable.';
    const result = { text: clean || 'I could not form a response.', model: 'GPT-5.5 · Hermes' };
    runtimeLog('route.complete', { route: 'hermes-gpt55-chat', duration_ms: Date.now() - startedAt });
    fs.appendFileSync(transcriptFile, `${JSON.stringify({ role: 'assistant', content: result.text, model: result.model, at: new Date().toISOString() })}\n`);
    return result;
  }
  const identityPath = path.join(__dirname, '../IDENTITY.md');
  const identity = fs.existsSync(identityPath) ? fs.readFileSync(identityPath, 'utf8') : 'Gymstant is a privacy-first workflow coworker initially built for gyms.';
  const demoMemoryPath = path.join(__dirname, '../demo-training/MEMORY.md');
  const demoMemory = fs.existsSync(demoMemoryPath) ? fs.readFileSync(demoMemoryPath, 'utf8') : '';
  const task = taskRuntime.open(normalizedLatest);
  const learnedHint = speedLayer.learnedHint(normalizedLatest);
  if (/\bchrome|gmail\b/i.test(latest.content)) managedApps.add('Google Chrome');
  if (/\bclass software|frappe|education\b/i.test(latest.content)) managedApps.add('Google Chrome');
  if (/\bnumbers\b/i.test(latest.content)) managedApps.add('Numbers');
  setTimeout(() => arrangeWorkspace(0), 80);
  runtimeLog('route.start', { route: 'hermes-computer-use', task_id: task.id, remaining_steps: task.steps.filter(s => s.status !== 'complete').length });
  try {
    let step;
    while ((step = taskRuntime.pending(task))) {
      taskRuntime.begin(task, step);
      sendActivity(step.label);
      runtimeLog('task.step-start', { task_id: task.id, step: step.id, attempt: step.attempts });
      const prompt = `${identity}\n\n${demoMemory}\n\nYou are Gymstant's desktop operator. Execute ONLY the current stage below; never redo completed stages. Use computer_use, take the shortest reliable path, and visibly verify the result. Do not narrate routine clicks. Stop before send, submit, purchase, delete, publish, money movement, credentials, or any consequential final confirmation. A negative instruction like "do not send" means prepare the work and stop immediately before that action. Return a compact factual result under 180 words containing the exact facts the next stage needs. Never report success if the visible result is not verified. ${learnedHint}\n\nORIGINAL REQUEST: ${task.request}\n\nCOMPLETED STAGES:\n${taskRuntime.summary(task) || 'None'}\n\nCURRENT STAGE (${step.id}): ${step.label}`;
      const { stdout } = await runProcessGroup(gymstantCliPath(), ['-z', prompt, '-t', 'computer_use'], {
        cwd: gymstantWorkdir(), timeout: 120000, progressTimeout: 110000, focusAware: true, maxBuffer: 1024 * 1024,
        env: hermesEnv()
      });
      const stepResult = stdout.replace(/\u001b\[[0-9;]*m/g, '').trim();
      if (!stepResult || isFalseSuccess(stepResult)) throw Object.assign(new Error(stepResult || 'Hermes returned no verified result.'), { code: 'EFALSUCCESS' });
      taskRuntime.completeStep(task, step, stepResult);
      runtimeLog('task.step-complete', { task_id: task.id, step: step.id, result_chars: stepResult.length });
    }
    const clean = taskRuntime.summary(task);
    cleanupGymstantMcp();
    const result = { text: clean || 'The requested stages were completed and verified.', model: 'Hermes · checkpointed computer use' };
    speedLayer.recordSuccess(normalizedLatest, 'hermes-checkpointed', Date.now() - startedAt, task.steps.map(item => item.label));
    runtimeLog('route.complete', { route: 'hermes-computer-use', task_id: task.id, duration_ms: Date.now() - startedAt, steps: task.steps.length });
    setTimeout(arrangeWorkspace, 250);
    fs.appendFileSync(transcriptFile, `${JSON.stringify({ role: 'assistant', content: result.text, model: result.model, at: new Date().toISOString() })}\n`);
    return result;
  } catch (error) {
    cleanupGymstantMcp();
    const failedStep = task.steps.find(s => s.status === 'running') || taskRuntime.pending(task);
    if (failedStep) taskRuntime.failStep(task, failedStep, error);
    runtimeLog('route.failed', { route: 'hermes-computer-use', task_id: task.id, step: failedStep?.id, duration_ms: Date.now() - startedAt, code: error.code || 'unknown' });
    if (error.code === 'ECANCELED') throw new Error('Stopped by you before the task completed. Completed steps were saved, so Fix will resume from here.');
    if (error.killed || error.code === 'ETIMEDOUT') throw new Error(`That step took too long, so I stopped it safely. Completed work is saved; Fix will resume at “${failedStep?.label || 'the unfinished step'}.”`);
    if (error.code === 'EFALSUCCESS') throw new Error(`Hermes ran out of working context during “${failedStep?.label || 'the unfinished step'}.” Completed work is saved and Fix will retry only this step with a fresh context.`);
    const detail = String(error.stderr || '').replace(/\u001b\[[0-9;]*m/g, '').trim().split('\n').slice(-3).join(' ');
    throw new Error(detail ? `Hermes tool error: ${detail.slice(0, 260)}` : 'Hermes could not complete the desktop tool call.');
  }
});
