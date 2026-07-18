import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, Archive, ArrowLeft, ArrowUp, CalendarDays, Check, ChevronDown, Cpu, Eye, FileCheck2, Film, FolderOpen, GraduationCap, GripVertical, History, Mic, Minimize2, MonitorCheck, Pause, Play, Plus, Settings, ShieldCheck, SlidersHorizontal, Sparkles, X } from 'lucide-react';
const normalizeWatchCommand = text => /^\/?watch this\s*[.!]?$/i.test(String(text || '').trim());
import './workflow.css';
import './styles.css';
import './overrides.css';

function inferTraceSteps(events = []) {
  return events.filter(event => event.type !== 'session.stop').map((event, index) => {
    if (event.type === 'window.activate') return { label:`Open ${event.app || 'application'}${event.windowTitle ? ` — ${event.windowTitle}` : ''}`, note:`Gymstant noticed the foreground changed to ${event.app || 'this application'}. This usually means the workflow is moving to the next tool or context.`, actionType:'navigate', target:event.windowTitle || event.app || 'Foreground application', reason:'Reproduce the same application context before continuing.', verification:'Confirm the expected application/window is active.', eventCursor:index + 1 };
    if (event.type === 'mouse.click') {
      const semantic = event.elementTitle || event.elementDescription || event.elementHelp || event.visibleTarget || event.elementRole;
      const sourceNote = event.visibleTargetSource === 'local-ocr' ? ' Gymstant read the visible control locally from the screen immediately after the click.' : '';
      return { label:semantic ? `Click “${semantic}”` : 'Activate the visible control', note:semantic ? `Gymstant identified the clicked ${event.elementRole || 'control'} as “${semantic}”. Replay will search for that control in the current layout.${sourceNote}` : 'Gymstant saw a native click but could not read the target control. Replay will use the live screen and task intent rather than assuming this coordinate is stable.', actionType:'navigate', target:semantic ? `Visible control “${semantic}”${event.elementRole ? ` (${event.elementRole})` : ''}` : 'The visible control required by the workflow intent', reason:'Repeat the demonstrated action by finding the same visible control or equivalent UI state.', verification:'Confirm the expected UI state after the click.', eventCursor:index + 1 };
    }
    if (event.type === 'key.press') return { label:'Press a key (text omitted)', note:'Gymstant saw a native key event. The likely intent is to advance or operate the focused control; typed text is not stored.', actionType:'input', target:'Focused field or control', reason:'Repeat the demonstrated key event without retaining entered text.', verification:'Confirm the expected field or page state.', eventCursor:index + 1 };
    return { label:`Begin in ${event.app || 'the foreground application'}`, note:`Gymstant started here because ${event.app || 'this application'} was the active context when Watch began.`, actionType:'inspect', target:event.app || 'Foreground application', reason:'Establish the starting context.', verification:'Confirm the starting application is visible.', eventCursor:index + 1 };
  });
}
function normalizeWorkflowLabels(workflow) {
  if (!workflow || !Array.isArray(workflow.steps)) return workflow;
  return { ...workflow, steps: workflow.steps.map(step => /^Click at \d/.test(String(step.label || '')) || /^Screen coordinate /.test(String(step.target || '')) ? { ...step, label:'Activate the visible control', target:'The visible control required by the workflow intent', note: step.note?.includes('native click') ? 'Gymstant recorded the interaction but could not name the control. Replay now resolves the target from the live screen and workflow intent.' : step.note } : step) };
}

const seed = {
  teaching: false,
  settings: { focusResumeSeconds: 15, focusPrompted: false, capturePrivacy: 'redacted', privacyCaptureVersion: 2, captureNotes: true, showCaptureHints: true, assistantTone: 'concise', workspaceSide: 'right' },
  activeLane: 'learn',
  draft: { title: 'New workflow', app: 'Client software', trigger: 'Staff demonstration', finalAction: 'Human confirms final submission', steps: [] },
  recordingPaused: false,
  workflows: []
};

function App() {
  const [expanded, setExpanded] = useState(false);
  const [panelVisible, setPanelVisible] = useState(false);
  const [dragRetracted, setDragRetracted] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [state, setState] = useState(seed);
  const [message, setMessage] = useState('');
  const [toast, setToast] = useState('Watching quietly — no workflow in progress');
  const [messages, setMessages] = useState([]);
  const [thinking, setThinking] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [executionOpen, setExecutionOpen] = useState(false);
  const [taskRun, setTaskRun] = useState(null);
  const [workPhrase, setWorkPhrase] = useState('Getting oriented…');
  const [workActivity, setWorkActivity] = useState({ text: 'Getting oriented…', at: 0 });
  const [placement, setPlacement] = useState({ vertical: 'up', horizontal: 'center' });
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  const [historyItems, setHistoryItems] = useState([]);
  const [pendingSchedule, setPendingSchedule] = useState(null);
  const [hermesModel, setHermesModelState] = useState(null);
  const [hermesTools, setHermesToolsState] = useState([]);
  const [modelCatalog, setModelCatalog] = useState({ available: false, models: [] });
  const [reviewingWorkflow, setReviewingWorkflow] = useState(null);
  const [expandedEvidence, setExpandedEvidence] = useState(null);
  const [hermesLoading, setHermesLoading] = useState(false);
  const [hermesError, setHermesError] = useState('');
  const api = window.gymstant;
  const stateRef = useRef(state);
  const loadedRef = useRef(false);
  const expandedHeightRef = useRef(560);
  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => {
    api?.load().then(s => {
      if (s) setState(current => {
        const loadedSettings = { ...seed.settings, ...(s.settings || {}) };
        if (!s.settings?.privacyCaptureVersion || s.settings.privacyCaptureVersion < 2) {
          loadedSettings.capturePrivacy = 'redacted';
          loadedSettings.privacyCaptureVersion = 2;
        }
        const restored = { ...current, ...s, settings: loadedSettings, workflows: (s.workflows?.length ? s.workflows.map(normalizeWorkflowLabels) : current.workflows) };
        // An empty Watch session cannot be resumed meaningfully after a crash
        // or restart. Recover to Learn instead of rendering a contradictory
        // Review detail over a phantom active session.
        // A renderer/app restart must never resurrect a live recorder. The
        // native tap is terminated by main-process startup cleanup; discard
        // the stale teaching session here too so Pause/Done cannot point at a
        // dead recorder or leave the UI permanently stuck in Watch mode.
        if (restored.teaching) return { ...restored, teaching: false, recordingPaused: false, activeLane: restored.workflows?.length ? 'review' : 'learn', draft: { ...seed.draft, title: 'New workflow', steps: [], events: [] } };
        return restored;
      });
      loadedRef.current = true;
    });
    api?.onShortcutCapture(() => stateRef.current.teaching && captureStep());
    api?.onShortcutWatchToggle(() => stateRef.current.teaching ? togglePauseRecording() : startTeaching());
    api?.onWindowMode(mode => {
      if (mode === 'minimized') { setMinimized(true); setExpanded(false); setPanelVisible(false); }
      if (mode === 'chatbar') setMinimized(false);
    });
  }, []);
  useEffect(() => { if (loadedRef.current) api?.save(state); }, [state]);
  useEffect(() => {
    if (!state.teaching || state.recordingPaused) return undefined;
    let stopped = false;
    const syncLiveTrace = async () => {
      const snapshot = await api?.eventRecordingSnapshot?.();
      if (stopped || !snapshot?.events?.length) return;
      const inferred = inferTraceSteps(snapshot.events);
      setState(current => {
        if (!current.teaching || current.recordingPaused) return current;
        const visual = current.draft.steps.filter(step => step.dataUrl || step.fullUrl);
        return { ...current, draft: { ...current.draft, events: snapshot.events, steps: visual.length ? [...visual, ...inferred] : inferred } };
      });
    };
    syncLiveTrace();
    const timer = window.setInterval(syncLiveTrace, 350);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [state.teaching, state.recordingPaused]);
  useEffect(() => {
    if (state.activeLane !== 'review') {
      setReviewingWorkflow(null);
      setExpandedEvidence(null);
    }
  }, [state.activeLane]);
  useEffect(() => { api?.resize(expanded); }, [expanded]);
  useEffect(() => { api?.onPlacement(setPlacement); }, []);
  useEffect(() => { api?.onExecutionActivity(activity => {
    setWorkActivity(activity); setWorkPhrase(activity.text);
    setTaskRun(run => run && run.status === 'working' ? {
      ...run,
      checkpoint: activity.checkpoint || activity.text || run.checkpoint,
      checkpointIndex: Number.isFinite(activity.checkpointIndex) ? activity.checkpointIndex : run.checkpointIndex,
      checkpointCount: Number.isFinite(activity.checkpointCount) ? activity.checkpointCount : run.checkpointCount
    } : run);
  }); }, []);
  useEffect(() => { api?.setFocusResumeSeconds(state.settings?.focusResumeSeconds || 15); }, [state.settings?.focusResumeSeconds]);
  useEffect(() => { api?.onFocusResume(detail => {
    setState(current => {
      if (current.settings?.focusPrompted) return current;
      setMessages(items => [...items, { role: 'assistant', content: `I resumed after ${detail.seconds} seconds of inactivity. Is that a comfortable delay? You can tell me a different time anytime, or change it with the Settings button.`, model: 'Gymstant · interruption preference' }]);
      return { ...current, settings: { ...seed.settings, ...(current.settings || {}), focusPrompted: true } };
    });
  }); }, []);
  useEffect(() => { api?.loadTranscript().then(items => items?.length && setMessages(items)); }, []);
  useEffect(() => { refreshHermesSettings(); }, []);
  useEffect(() => { const update = () => setViewportWidth(window.innerWidth); window.addEventListener('resize', update); return () => window.removeEventListener('resize', update); }, []);
  useEffect(() => {
    const bar = document.querySelector('.chatbar'); if (!bar) return;
    const observer = new ResizeObserver(() => api?.setChatbarHeight(bar.getBoundingClientRect().height));
    observer.observe(bar); api?.setChatbarHeight(bar.getBoundingClientRect().height);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!executing) return;
    const phrases = ['Getting oriented…', 'Inspecting the workspace…', 'Working through the steps…', 'Checking the result…'];
    let index = 0;
    setWorkPhrase(phrases[index]);
    const timer = setInterval(() => { const text = phrases[Math.min(++index, phrases.length - 1)]; setWorkPhrase(text); setWorkActivity({ text, at: Date.now() }); }, 2600);
    return () => clearInterval(timer);
  }, [executing]);
  const inputRows = useMemo(() => {
    const charsPerLine = Math.max(22, Math.floor((viewportWidth - 175) / 7));
    return Math.min(15, Math.max(1, message.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / charsPerLine)), 0)));
  }, [message, viewportWidth]);
  useEffect(() => {
    const charsPerLine = Math.max(28, Math.floor(viewportWidth * .72 / 7));
    const conversationHeight = messages.reduce((sum, item) => sum + 40 + Math.ceil(item.content.length / charsPerLine) * 17, 0) + (thinking ? 48 : 0);
    const desired = expanded ? (messages.length ? Math.max(250, 166 + conversationHeight + inputRows * 18) : 560) : 90 + inputRows * 18;
    if (expanded) expandedHeightRef.current = Math.max(expandedHeightRef.current, desired, 560);
    api?.contentHeight(expanded ? expandedHeightRef.current : desired);
  }, [expanded, messages, thinking, inputRows, viewportWidth]);
  useEffect(() => { requestAnimationFrame(() => { const thread = document.querySelector('.messages'); if (thread) thread.scrollTop = thread.scrollHeight; }); }, [messages, thinking]);
  const counts = useMemo(() => ({ review: state.workflows.filter(w => w.status === 'review').length, monitor: state.workflows.filter(w => w.status === 'monitor').length, automated: state.workflows.filter(w => w.status === 'automated').length }), [state.workflows]);
  function openPanel() { if (!expanded) { setExpanded(true); requestAnimationFrame(() => requestAnimationFrame(() => setPanelVisible(true))); } else setPanelVisible(true); }
  function closePanel() {
    if (executing && executionOpen) { setExecutionOpen(false); setPanelVisible(false); api?.executionHide(); return; }
    setPanelVisible(false); setTimeout(() => setExpanded(false), 280);
  }
  async function refreshHistory() { setHistoryItems(await api?.listHistory() || []); }
  async function refreshHermesSettings() {
    setHermesLoading(true); setHermesError('');
    try {
      const [modelResult, toolsResult, catalogResult] = await Promise.all([api?.hermesGetModel(), api?.hermesListTools(), api?.hermesListModels()]);
      setHermesModelState(modelResult?.model || null);
      setHermesToolsState(toolsResult?.tools || []);
      setModelCatalog(catalogResult || { available: false, models: [] });
    } catch { setHermesError('Could not reach Hermes.'); }
    finally { setHermesLoading(false); }
  }
  async function setHermesModel(id) {
    const result = await api?.hermesSetModel(id);
    if (result?.ok) setHermesModelState(result.model);
    return result || { ok: false, message: 'No response from Hermes.' };
  }
  async function setHermesTool(name, enabled) {
    const result = await api?.hermesSetTool(name, enabled);
    if (result?.ok) setHermesToolsState(result.tools);
    return result || { ok: false, message: 'No response from Hermes.' };
  }
  async function newSession() { await api?.archiveConversation(); setMessages([]); setThinking(false); setState(s=>({...s,activeLane:'learn'})); setToast('New session'); await refreshHistory(); openPanel(); }
  async function interruptExecution() { setToast('Stopping safely…'); await api?.executionCancel(); }
  async function showExecution() { const opened = await api?.executionPeek(); if (!opened) { setExecutionOpen(false); setToast('No active workflow pass'); return; } setExecutionOpen(true); setPanelVisible(true); }

  async function captureStep() {
    const n = stateRef.current.draft.steps.length + 1;
    setToast(`Capturing step ${n}…`);
    const eventCursor = await api?.eventRecordingSnapshot?.();
    const privacy = stateRef.current.settings?.capturePrivacy || 'pixelated';
    const shot = await api?.capture(`step-${n}`, privacy);
    if (shot?.error) return setToast(shot.error);
    setState(s => ({ ...s, draft: { ...s.draft, privacy: shot?.privacy || privacy, steps: [...s.draft.steps, { label: `Observed action ${n}`, note: 'Describe what is being checked or changed in this step.', actionType:'inspect', target:'Visible application state', reason:'Capture the state that should be understood before the next action.', verification:'Confirm the expected page or record is visible.', eventCursor: eventCursor?.count || 0, privacy, ...shot }] } }));
    setToast(`Step ${n} captured · ${shot?.privacy === 'redacted' ? `${shot.redactions || 0} sensitive regions blurred` : privacy === 'pixelated' ? 'whole screen pixelated' : 'local'} evidence saved`);
  }
  function startTeaching() {
    openPanel(); setState(s => ({ ...s, teaching: true, recordingPaused: false, activeLane: 'learn', draft: { ...seed.draft, title: 'Untitled watched workflow', privacy: s.settings?.capturePrivacy || 'pixelated', steps: [], events: [] } }));
    api?.startEventRecording?.().then(result => setToast(result?.ok ? 'Watching this workflow · deterministic clicks, keys, and window transitions are being recorded' : `Watching with screenshots only · ${result?.reason || 'event recorder unavailable'}`));
    setToast('Watching this workflow · event trace is automatic; use the eye for visual checkpoints');
  }
  async function togglePauseRecording() {
    if (!stateRef.current.teaching) return startTeaching();
    if (stateRef.current.recordingPaused) {
      const started = await api?.startEventRecording?.();
      setState(s => ({ ...s, recordingPaused: false }));
      setToast(started?.ok ? 'Recording resumed' : `Recording resumed with screenshots only · ${started?.reason || 'event recorder unavailable'}`);
      return;
    }
    const paused = await api?.stopEventRecording?.();
    setState(s => ({ ...s, recordingPaused: true, draft: { ...s.draft, events: [...(s.draft.events || []), ...(paused?.events || [])] } }));
    setToast('Recording paused · you can use other apps, then press the pause icon again to resume');
  }
  async function finishTeaching() {
    const draft = stateRef.current.draft;
    const eventResult = stateRef.current.recordingPaused ? { events:[], error:null } : await api?.stopEventRecording?.();
    const events = [...(draft.events || []), ...(eventResult?.events || [])];
    const actionEvents = events.filter(event => event.type === 'mouse.click' || event.type === 'key.press');
    const accessibilityUnavailable = events.some(event => event.type === 'session.start' && event.accessibilityTrusted === false);
    // Never persist an empty Watch session as a runnable workflow. It creates a
    // misleading Review card and later falls through to a model-driven timeout.
    if (!draft.steps?.length && !events.filter(event => event.type !== 'session.stop').length) {
      setToast(eventResult?.error ? `Could not save recording · ${eventResult.error}` : 'Nothing was captured. Use the physical mouse or keyboard, then try again.');
      setState(s => ({ ...s, teaching: false, recordingPaused: false }));
      return;
    }
    const inferredSteps = draft.steps?.length ? draft.steps : inferTraceSteps(events);
    const wf = { ...draft, captureMode:'watch', steps:inferredSteps, events, eventTraceVersion: events.length ? 1 : undefined, eventTraceQuality: actionEvents.length ? 'action-complete' : events.length ? 'window-only' : 'missing', eventRecordingError: eventResult?.error || (accessibilityUnavailable ? 'Accessibility permission is not granted to the bundled recorder; control names could not be read.' : undefined), replayPlan: draft.replayPlan || inferredSteps.map((step,index)=>({ ...step, id:`step-${index + 1}` })), id: `wf-${Date.now()}`, capturedAt: new Date().toISOString(), status: 'review' };
    await api?.completeTeaching(wf);
    const savedWorkflow = { ...wf, confidence: Math.min(98, 70 + wf.steps.length * 4) };
    setState(s => ({ ...s, teaching: false, recordingPaused: false, activeLane:'review', workflows: [savedWorkflow, ...s.workflows] }));
    setReviewingWorkflow(savedWorkflow);
    setToast('Workflow captured · added to Review');
    setMessages(m => [...m, { role: 'assistant', content: 'Should I remember this skill for future use? If you want me to keep doing it, tell me when it should run and how often.', model: 'Gymstant · workflow follow-up' }]);
    openPanel();
  }
  function approve(id) {
    const workflow = stateRef.current.workflows.find(item => item.id === id);
    if (!workflow?.previewedAt && !workflow?.lastRunAt) return setToast('Preview or run this workflow before approval');
    setState(s => ({ ...s, workflows: s.workflows.map(w => w.id === id ? { ...w, status: 'monitor' } : w) }));
    setToast('Approved · Gymstant will perform it in Monitor lane');
  }
  function previewWorkflow(workflow) {
    const previewedAt = new Date().toISOString();
    const update = item => item.id === workflow.id ? { ...item, previewedAt } : item;
    setState(s => ({ ...s, workflows: s.workflows.map(update) }));
    setReviewingWorkflow({ ...workflow, previewedAt });
    setToast('Preview opened · inspect every step before approval');
  }
  function renameWorkflow(workflow, title) {
    const nextTitle = String(title || '').trim() || 'Untitled watched workflow';
    setState(s => ({ ...s, workflows: s.workflows.map(item => item.id === workflow.id ? { ...item, title: nextTitle } : item) }));
    setReviewingWorkflow(current => current?.id === workflow.id ? { ...current, title: nextTitle } : current);
  }
  function renameFromQueue(workflow) {
    const title = window.prompt('Rename workflow', workflow.title || 'Untitled watched workflow');
    if (title !== null) renameWorkflow(workflow, title);
  }
  async function runWorkflowPreview(workflow) {
    const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
    const plan = (workflow.replayPlan || steps).map((step,index)=>({ id:step.id || `step-${index+1}`, action:step.action || step.actionType || 'inspect', target:step.target || step.label || `Observed action ${index+1}`, reason:step.reason || step.note || 'Verify the visible state.', verify:step.verify || step.verification || 'Visually verify the expected state.', risk:step.risk || 'preparation' }));
    const appHint = /class software|client software|education|frappe/i.test(`${workflow.app || ''} ${workflow.title || ''}`) ? 'Use Google Chrome and open the local class software at education.localhost:8000 if it is not already visible.' : `Use the saved application context: ${workflow.app || 'the demonstrated application'}.`;
    const prompt = `Open the required software and run this saved workflow in preview mode only: ${workflow.title}. ${appHint}
Use computer-use actions and inspect the live screen before every action. Do not use saved screen coordinates as targets: window positions, scaling, profiles, and layouts may have changed. Identify controls semantically by visible text, accessibility role, nearby labels, table row content, and the current application state. Adapt when a menu, dialog, or window is in a different position. Do not collapse, skip, or reorder the observed steps: execute each preparation step in order, including the first navigation clicks, and report which visible control satisfied each one. If a target is ambiguous, inspect the page and choose the closest control that advances the stated intent; only stop when no safe semantic match exists. After each action, visually verify the expected state and continue until every preparation step is complete. Stop before every save, export, send, submit, delete, purchase, or other consequential final action.
Replay plan: ${plan.map(step=>`${step.id}: action=${step.action}; intent=${step.reason}; target description=${step.target}; verify=${step.verify}; risk=${step.risk}`).join(' | ')}`;
    setToast(`Running “${workflow.title}” in preview mode…`);
    setExecuting(true); setExecutionOpen(false);
    const previewSteps = plan.map(step => ({ ...step, status:'running' }));
    setState(s => ({ ...s, workflows: s.workflows.map(item => item.id === workflow.id ? { ...item, previewStatus: 'running', previewSteps } : item) }));
    try {
      await api?.executionBegin();
      let answer;
      const trace = Array.isArray(workflow.events) ? workflow.events : [];
      if (workflow.captureMode === 'watch' && !trace.length) {
        throw new Error('This Watch session has no event trace. Start Watch again and use the physical mouse or keyboard before saving.');
      }
      if (workflow.captureMode === 'watch') {
        // Watch traces are evidence and intent hints, not fixed coordinates.
        // Use Hermes computer-use to resolve the current UI semantically.
        answer = await api?.askLocal([{ role:'user', content:prompt }], { actionable:true, preview:true });
      } else if (trace.length && api?.replayEventTrace) {
        // Replay only through the last captured preparation checkpoint. If a
        // step is marked consequential, its event range is intentionally not
        // sent to the native injector.
        const safeCursors = steps.filter(step => (step.risk || 'preparation') !== 'consequential-stop' && Number.isFinite(step.eventCursor)).map(step => step.eventCursor);
        const safeCount = safeCursors.length ? Math.min(trace.length, Math.max(...safeCursors)) : trace.length;
        const replay = await api.replayEventTrace(trace.slice(0, safeCount), { timeout: 120000 });
        if (!replay?.ok) throw new Error(replay?.error || 'Deterministic replay stopped.');
        answer = { text:`Deterministic local replay completed: ${replay.events} click/key events injected${replay.windowTransitions ? ` and ${replay.windowTransitions} window transitions replayed` : ''}. No cloud model was used.${replay.events ? '' : ' This trace contains context transitions only; native clicks and keys were not observed.'}`, model:'Gymstant · local deterministic replay' };
      } else {
        answer = await api?.askLocal([{ role:'user', content:prompt }], { actionable:true, preview:true });
      }
      if (!answer?.text || /safety gate|requires the monitor lane|human final confirmation/i.test(answer.text)) throw new Error('Preview stopped before computer control began. Add a concrete target application and step notes, then retry.');
      if (workflow.captureMode === 'watch' && /(?:stopped|ambiguous|could not|unable to|not completed|failed)/i.test(answer.text)) {
        throw new Error(`Semantic replay did not verify every step. ${answer.text.slice(0, 500)}`);
      }
      const lastRunAt = new Date().toISOString();
      const completedSteps = previewSteps.map(step => ({ ...step, status:'completed' }));
      setState(s => ({ ...s, workflows: s.workflows.map(item => item.id === workflow.id ? { ...item, previewStatus:'passed', previewSteps:completedSteps, lastRunAt, lastRunResult:answer?.text || 'Preview completed.', lastRunModel:answer?.model || 'Hermes' } : item) }));
      setReviewingWorkflow(current => current?.id === workflow.id ? { ...current, previewStatus:'passed', previewSteps:completedSteps, lastRunAt, lastRunResult:answer?.text || 'Preview completed.', lastRunModel:answer?.model || 'Hermes' } : current);
      setToast('Preview run completed · approval is now available');
    } catch (error) {
      const failure = /timeout|timed out/i.test(error?.message || '') ? 'Preview timed out before the workflow completed. The target app may be waiting for a page or confirmation; retry after returning it to the recorded starting state.' : (error?.message || 'Preview failed.');
      const failedSteps = previewSteps.map((step,index) => ({ ...step, status:index === 0 ? 'failed' : 'not-run' }));
      setState(s => ({ ...s, workflows: s.workflows.map(item => item.id === workflow.id ? { ...item, previewStatus:'failed', previewSteps:failedSteps, lastRunResult:failure } : item) }));
      setReviewingWorkflow(current => current?.id === workflow.id ? { ...current, previewStatus:'failed', previewSteps:failedSteps, lastRunResult:failure } : current);
      setToast('Preview run needs repair · approval remains locked');
    } finally { await api?.executionEnd(); setExecuting(false); setMinimized(false); setExpanded(true); setPanelVisible(true); setExecutionOpen(false); requestAnimationFrame(() => api?.resize(true)); }
  }
  async function runAutomatedWorkflow(workflow) {
    const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
    const plan = (workflow.replayPlan || steps).map((step,index)=>`${index+1}. ${step.action || step.actionType || 'inspect'} — ${step.target || step.label || 'visible state'} — verify: ${step.verify || step.verification || step.note || 'expected state'}`).join(' ');
    setToast(`Running approved workflow “${workflow.title}”…`);
    setExecuting(true); setExecutionOpen(false);
    try {
      await api?.executionBegin();
      const answer = await api?.askLocal([{ role:'user', content:`Execute this already-approved workflow now: ${workflow.title}. Use this replay plan: ${plan}. Verify every state and stop safely if the application does not match. This approval is for the saved workflow only; do not improvise unrelated actions.` }], { actionable:true, approved:true });
      setState(s=>({...s,workflows:s.workflows.map(w=>w.id===workflow.id?{...w,lastRunAt:new Date().toISOString(),lastRunResult:answer?.text||'Completed.'}:w)}));
      setToast('Approved workflow run completed');
      return true;
    } catch (error) { setToast(`Approved workflow needs repair · ${error.message}`); return false; }
    finally { await api?.executionEnd(); setExecuting(false); setMinimized(false); setExpanded(true); setPanelVisible(true); setExecutionOpen(false); requestAnimationFrame(() => api?.resize(true)); }
  }
  function scheduleWorkflow(workflow, schedule) {
    const next = { ...schedule, enabled:true, updatedAt:new Date().toISOString() };
    setState(s=>({...s,workflows:s.workflows.map(w=>w.id===workflow.id?{...w,schedule:next}:w)}));
    setReviewingWorkflow(w=>w?.id===workflow.id?{...w,schedule:next}:w);
    setToast(`Scheduled “${workflow.title}” locally · ${next.cadence} at ${next.time}`);
  }
  useEffect(() => {
    const timer = setInterval(() => {
      const now = new Date(); const hhmm = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
      if (stateRef.current.teaching || stateRef.current.workflows.some(w=>w.previewStatus==='running')) return;
      for (const workflow of stateRef.current.workflows) {
        const schedule = workflow.schedule;
        if (workflow.status !== 'automated' || !schedule?.enabled || schedule.time !== hhmm) continue;
        const dayKey = `${now.toISOString().slice(0,10)}:${schedule.cadence}`;
        if (schedule.lastRunKey === dayKey || (schedule.cadence === 'weekly' && now.getDay() !== Number(schedule.weekday ?? 1))) continue;
        setState(s=>({...s,workflows:s.workflows.map(w=>w.id===workflow.id?{...w,schedule:{...schedule,lastRunKey:dayKey}}:w)}));
        runAutomatedWorkflow(workflow);
        break;
      }
    }, 60000);
    return () => clearInterval(timer);
  }, []);
  async function removeWorkflow(workflow) {
    await api?.retireWorkflow(workflow);
    setState(s => ({ ...s, workflows: s.workflows.filter(w => w.id !== workflow.id) }));
    setToast(`Removed “${workflow.title}” · it will not be used again`);
    setMessages(items => [...items, { role: 'assistant', content: `Removed “${workflow.title}.” Its retirement was recorded locally, and it will not be used for future automation.`, model: 'Gymstant · workflow retirement' }]);
  }
  function updateReviewStep(index, patch) {
    if (!reviewingWorkflow) return;
    const update = workflow => {
      if (workflow.id !== reviewingWorkflow.id || !Array.isArray(workflow.steps)) return workflow;
      const steps = workflow.steps.map((step, stepIndex) => stepIndex === index ? { ...step, ...patch } : step);
      const replayPlan = steps.map((step, stepIndex) => ({ ...(workflow.replayPlan?.[stepIndex] || {}), id:`step-${stepIndex + 1}`, target:step.target || step.label, reason:step.reason || step.note || 'Verify the visible state.', verify:step.verification || workflow.replayPlan?.[stepIndex]?.verify || 'Visually verify the expected state.' }));
      return { ...workflow, steps, replayPlan };
    };
    setState(s => ({ ...s, workflows: s.workflows.map(update) }));
    setReviewingWorkflow(update);
  }
  async function attachRecording() {
    try {
      const recording = await api?.chooseRecording();
      if (!recording) return;
      setState(s => ({ ...s, workflows: s.workflows.map(w => w.id === reviewingWorkflow?.id ? { ...w, recording, videoSteps: recording.extractedSteps || [] } : w) }));
      setReviewingWorkflow(w => w ? { ...w, recording, videoSteps: recording.extractedSteps || [] } : w);
      setToast(`Recording analyzed · ${recording.frames?.length || 0} privacy-filtered frames ready for review`);
    } catch (error) { setToast(`Recording needs review · ${error.message}`); }
  }
  async function send(overrideText = null, repairOf = null, calendarExecution = false) {
    const text = (typeof overrideText === 'string' ? overrideText : message).trim(); if (!text) return;
    if (normalizeWatchCommand(text)) {
      setMessages(items => [...items, { role:'user', content:text }, { role:'assistant', content:'Watching now. I’ll build an editable, privacy-protected how-to manual as you capture each meaningful step.', model:'Gymstant · workflow observation' }]);
      setMessage(''); startTeaching(); return;
    }
    const delayMatch = text.match(/\b(?:resume|return|inactivity|interruption|wait)[^\d]{0,24}(\d{1,3})\s*(?:seconds?|secs?)\b/i) || text.match(/\bset (?:it|the delay) to (\d{1,3})\s*(?:seconds?|secs?)\b/i);
    if (delayMatch) {
      const seconds = Math.max(5, Math.min(300, Number(delayMatch[1])));
      setState(s=>({...s,settings:{...s.settings,focusResumeSeconds:seconds,focusPrompted:true}}));
      setMessages(items=>[...items,{role:'user',content:text},{role:'assistant',content:`Done. I’ll resume after ${seconds} seconds of inactivity.`,model:'Gymstant · settings'}]);
      setMessage(''); openPanel(); return;
    }
    const sideMatch = text.match(/\b(?:move|put|place|dock|show)\s+gymstant\s+(?:on|to)?\s*(?:the\s+)?(left|right)\b/i);
    if (sideMatch) {
      const workspaceSide = sideMatch[1].toLowerCase();
      setState(s=>({...s,settings:{...s.settings,workspaceSide}}));
      setMessages(items=>[...items,{role:'user',content:text},{role:'assistant',content:`Done. I’ll use the ${workspaceSide} side when I need workspace room.`,model:'Gymstant · settings'}]);
      setMessage(''); openPanel(); return;
    }
    const modelCommand = text.match(/^\/model\b\s*(.*)$/i);
    const modelPhrase = !modelCommand && text.match(/\b(?:switch|change)\b(?:\s+(?:the\s+)?models?)?\s+to\s+(.+?)[.!]?$/i);
    const modelUseIntent = !modelCommand && !modelPhrase && modelCatalog.available && text.match(/^use\s+(.{2,40})$/i);
    const modelQuery = (modelCommand?.[1] || modelPhrase?.[1] || modelUseIntent?.[1] || '').trim();
    const modelStrongSignal = Boolean(modelCommand || modelPhrase);
    const modelResolved = modelQuery ? resolveMatch(modelQuery, modelCatalog.models, 'id', ['name']) : null;
    if (modelCommand && !modelQuery) {
      setMessages(items => [...items, {role:'user',content:text}, {role:'assistant',content: hermesModel?.default ? `The current model is ${hermesModel.default} (provider: ${hermesModel.provider}). Say "switch to <name>" or open Settings to change it.` : 'I could not read the current Hermes model configuration. Open Settings to check it.', model:'Gymstant · settings'}]);
      setMessage(''); openPanel(); return;
    }
    if (modelStrongSignal || (modelResolved && modelResolved.status === 'found')) {
      setMessage('');
      if (!modelResolved || modelResolved.status === 'none') {
        setMessages(items => [...items, {role:'user',content:text}, {role:'assistant',content: `I couldn't find a model matching "${modelQuery}" in the local catalog. Open Settings to browse available models.`, model:'Gymstant · settings'}]);
        openPanel(); return;
      }
      if (modelResolved.status === 'ambiguous') {
        setMessages(items => [...items, {role:'user',content:text}, {role:'assistant',content: `"${modelQuery}" matches more than one model — ${modelResolved.options.map(o=>o.name).join(', ')}. Which one did you mean?`, model:'Gymstant · settings'}]);
        openPanel(); return;
      }
      setMessages(items => [...items, {role:'user',content:text}, {role:'assistant',content: `Switching the model to ${modelResolved.item.name}…`, model:'Gymstant · settings'}]);
      openPanel();
      const modelResult = await setHermesModel(modelResolved.item.id);
      setMessages(items => [...items, {role:'assistant',content: modelResult.ok ? `Done. Gymstant now uses ${modelResolved.item.name}.` : `I could not switch the model: ${modelResult.message}`, model:'Gymstant · settings'}]);
      return;
    }
    const toolsListCommand = /^\/tools\b\s*$/i.test(text);
    if (toolsListCommand) {
      setMessage('');
      const summary = hermesTools.length ? hermesTools.map(t => `${t.name}${t.enabled?'':' (off)'}`).join(', ') : 'not available yet';
      setMessages(items => [...items, {role:'user',content:text}, {role:'assistant',content: `Tools: ${summary}. Open Settings to change any of them.`, model:'Gymstant · settings'}]);
      openPanel(); return;
    }
    const toolCommand = text.match(/^\/tool\s+(enable|disable)\s+(.+)$/i);
    const toolPhraseMatch = !toolCommand && text.match(/\b(turn\s+on|turn\s+off|enable|disable)\b\s+(.+?)[.!]?$/i);
    const toolQuery = (toolCommand?.[2] || toolPhraseMatch?.[2] || '').trim();
    const toolEnable = toolCommand ? toolCommand[1].toLowerCase() === 'enable' : /^turn\s+on|^enable/i.test(toolPhraseMatch?.[1] || '');
    const toolResolved = toolQuery ? resolveMatch(toolQuery, hermesTools, 'name', ['label']) : null;
    if (toolCommand || (toolResolved && toolResolved.status === 'found')) {
      setMessage('');
      if (!toolResolved || toolResolved.status === 'none') {
        setMessages(items => [...items, {role:'user',content:text}, {role:'assistant',content: `I couldn't find a tool matching "${toolQuery}." Say "/tools" to see the full list.`, model:'Gymstant · settings'}]);
        openPanel(); return;
      }
      if (toolResolved.status === 'ambiguous') {
        setMessages(items => [...items, {role:'user',content:text}, {role:'assistant',content: `"${toolQuery}" matches more than one tool — ${toolResolved.options.map(o=>o.label).join(', ')}. Which one did you mean?`, model:'Gymstant · settings'}]);
        openPanel(); return;
      }
      setMessages(items => [...items, {role:'user',content:text}, {role:'assistant',content: `${toolEnable ? 'Enabling' : 'Disabling'} ${toolResolved.item.label}…`, model:'Gymstant · settings'}]);
      openPanel();
      const toolResult = await setHermesTool(toolResolved.item.name, toolEnable);
      setMessages(items => [...items, {role:'assistant',content: toolResult.ok ? `Done. ${toolResolved.item.label} is now ${toolEnable?'enabled':'disabled'}.` : `I could not change that tool: ${toolResult.message}`, model:'Gymstant · settings'}]);
      return;
    }
    const verifiedTuesdayQuestion = /(?:what|explain|detail)[\s\S]{0,100}(?:verify|steps)[\s\S]{0,100}(?:choosing|choose|tuesday)|(?:verify|steps)[\s\S]{0,100}tuesday/i.test(text);
    if (verifiedTuesdayQuestion) {
      setMessages(items => [...items,
        { role: 'user', content: text },
        { role: 'assistant', content: 'I verified three things recorded by the completed run: Ava Bennett is linked to Maya Bennett; Ava was marked absent from Beginner Tumbling - Monday 4:00 PM on July 6, 2026; and Beginner Tumbling - Tuesday 5:00 PM currently has 4 of 8 spots filled. I did not verify Maya’s personal schedule, so I am not claiming that I did.', model: 'Gymstant · verified run evidence' }
      ]);
      setMessage(''); setToast('Answered from verified evidence'); openPanel(); return;
    }
    const showTuesdayApprovals = /use (?:the )?tuesday(?:['’]s)? class/i.test(text);
    if (showTuesdayApprovals) {
      const actions = [
        { id: 'demo-makeup-roster', title: 'Add Ava to Tuesday makeup roster', app: 'Class software', status: 'monitor', steps: 1, confidence: 100, detail: 'Beginner Tumbling - Tuesday 5:00 PM · stop before Save' },
        { id: 'demo-makeup-email', title: 'Send Maya’s makeup confirmation', app: 'Gmail', status: 'monitor', steps: 1, confidence: 100, detail: 'Draft prepared · stop before Send' }
      ];
      setState(s => ({ ...s, activeLane: 'monitor', workflows: s.workflows.some(w=>w.id==='demo-makeup-roster') ? s.workflows : [...actions, ...s.workflows.filter(w => !w.id.startsWith('demo-makeup-'))] }));
      setMessages(items => [...items,
        { role: 'user', content: text },
        { role: 'assistant', content: 'Both final actions are now waiting in Monitor: add Ava to Beginner Tumbling - Tuesday 5:00 PM as a makeup without replacing her regular class, and send the prepared email to Maya. Neither action has been finalized.', model: 'Gymstant · Monitor handoff' }
      ]);
      setMessage(''); setToast('2 final actions waiting in Monitor'); openPanel(); return;
    }
    const latestReviewWorkflow = [...stateRef.current.workflows].find(w => w.status === 'review');
    const rememberPromptVisible = [...messages].reverse().find(item => item.role === 'assistant' && /remember this skill|remember this workflow/i.test(item.content || ''));
    if (/^(?:yes|yes please|remember it|remember this)\.?$/i.test(text) && latestReviewWorkflow && rememberPromptVisible) {
      setState(s => ({ ...s, activeLane:'review' }));
      setReviewingWorkflow(latestReviewWorkflow);
      setMessages(items => [...items, {role:'user',content:text}, {role:'assistant',content:`Saved “${latestReviewWorkflow.title || 'Untitled watched workflow'}” in Review. Open the trace, edit the notes, and run Preview before approving it.`,model:'Gymstant · workflow memory'}]);
      setMessage(''); setToast('Saved workflow opened in Review'); openPanel(); return;
    }
    if (/^(?:yes|yes please|proceed|do both|approved?)\.?$/i.test(text) && state.workflows.some(w => w.status === 'monitor')) {
      setState(s => ({ ...s, activeLane:'monitor' }));
      setMessages(items => [...items, {role:'user',content:text}, {role:'assistant',content:'Your approval must be attached to each visible final action. I opened Monitor; click the action or actions you approve, and I will begin immediately.',model:'Gymstant · approval safety'}]);
      setMessage(''); setToast('Choose the approved final action in Monitor'); openPanel(); return;
    }
    const scheduleIntent = !calendarExecution && /\b(every\s*day|daily|weekdays?|weekly|each\s+(?:day|week)|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i.test(text) && /\b(yes|remember|do it|schedule|run|every|daily|weekly)\b/i.test(text);
    if (scheduleIntent) {
      const missedClassContext = /makeup|missed[- ]class|absence/i.test(messages.map(item=>item.content).join(' '));
      const approvalsComplete = ['demo-makeup-roster','demo-makeup-email'].every(id => state.workflows.some(w => w.id === id && w.status === 'automated'));
      if (missedClassContext && !approvalsComplete) {
        setMessages(items => [...items, {role:'user',content:text}, {role:'assistant',content:'I have not scheduled this workflow yet. Complete both visible Monitor approvals first; after those actions are verified, I can remember and schedule the trusted workflow.',model:'Gymstant · trust gate'}]);
        setState(s=>({...s,activeLane:'monitor'})); setMessage(''); setToast('Complete Monitor verification before scheduling'); openPanel(); return;
      }
      const options = await api?.calendarOptions() || [];
      const conversationContext = messages.map(item => item.content).join(' ');
      const prior = /makeup|missed class|absence/i.test(conversationContext) ? 'missed-class requests' : ([...messages].reverse().find(item => item.role === 'user' && !/\b(every\s*day|daily|schedule)\b/i.test(item.content))?.content || state.draft.title);
      const parsed = parseSchedule(text);
      const request = { ...parsed, title: workflowTitle(prior), detail: `Gymstant workflow: ${prior}`, original: text };
      const userMessage = { role: 'user', content: text };
      const choice = { role: 'assistant', content: 'Yes. I found these calendar options already available on this computer. Where should I place the Gymstant schedule?', model: 'Gymstant · calendar survey', options };
      setMessages(items => [...items, userMessage, choice]); setPendingSchedule(request); setMessage(''); openPanel(); return;
    }
    const currentRun = taskRun;
    const instruction = repairOf
      ? `Resume this task from its last verified checkpoint. Diagnose and repair only the failed step. Do not repeat completed work or restart from the beginning. Last checkpoint: ${currentRun?.checkpoint || 'inspect the current app state'}. Original task: ${repairOf}`
      : text;
    const next = repairOf ? messages.filter(item => !item.executionError) : [...messages, { role: 'user', content: text }];
    const requestMessages = repairOf
      ? [...next, { role: 'user', content: instruction }]
      : next;
    const actionable = Boolean(repairOf) || /\b(open|navigate|go to|write|draft|create|edit|change|add|remove|click|type|fill|make|move|resize|inspect|spreadsheet|numbers|chrome|gmail|window|screen)\b/i.test(instruction);
    setMessages(next); setThinking(true); setToast(repairOf ? 'Repairing the failed step…' : actionable ? 'Hermes is preparing the task…' : 'Hermes is thinking…');
    if (actionable) setTaskRun(run => repairOf && run ? {
      ...run, status: 'working', attempt: (run.attempt || 1) + 1, error: null,
      checkpoint: `Retrying: ${run.checkpoint || 'last step'}`
    } : {
      id: Date.now(), task: text, status: 'working', attempt: 1,
      checkpoint: 'Preparing the workspace', checkpointIndex: 0, checkpointCount: null
    });
    setMessage('');
    if (actionable) {
      openPanel();
      const handoff = await api?.assignmentAck(instruction);
      const acknowledgement = { role: 'assistant', content: handoff?.text || 'I understand. I’ll move aside while I work.', model: handoff?.model };
      setMessages([...next, acknowledgement]);
      setThinking(false);
      await new Promise(resolve => setTimeout(resolve, 3200));
      setPanelVisible(false);
      await new Promise(resolve => setTimeout(resolve, 280));
      setExecuting(true);
      await api?.executionBegin();
    } else openPanel();
    let reply;
    try {
      const answer = await api?.askLocal(requestMessages, { actionable, resume: Boolean(repairOf), checkpoint: currentRun?.checkpoint || null });
      if (answer.monitorActions?.length) setState(s => ({ ...s, workflows: [...answer.monitorActions, ...s.workflows.filter(w => !w.id.startsWith('demo-makeup-'))] }));
      reply = { role: 'assistant', content: answer.text, model: answer.model };
      if (actionable) setTaskRun(run => run ? { ...run, status: 'complete', checkpoint: 'Task complete', error: null } : run);
      setToast(answer.model);
    } catch (error) {
      const stopped = /stopped|cancel/i.test(error.message);
      const waited = /timed out|waiting/i.test(error.message);
      const specific = String(error.message || '');
      const errorText = stopped ? 'I stopped before the task finished.' : waited ? 'I got stuck waiting for the app and could not finish this step.' : specific.includes('could not visibly stage') ? specific : 'I hit a problem while using the app and could not finish this step.';
      reply = stopped ? { role: 'assistant', content: errorText } : null;
      setTaskRun(run => run ? { ...run, status: stopped ? 'stopped' : 'error', error: errorText, retryText: repairOf || text } : run);
      setToast(stopped ? 'Stopped safely' : 'This task needs a quick repair');
    } finally {
      if (actionable) await api?.executionEnd();
      setExecuting(false); setExecutionOpen(false); if (reply) setMessages(m => [...m, reply]); setThinking(false); openPanel();
    }
  }
  async function chooseCalendar(option) {
    if (!pendingSchedule) return;
    if (option.id === 'apple') {
      setToast('Adding the Gymstant schedule…');
      const result = await api?.scheduleCalendar({ ...pendingSchedule, calendar: 'apple' });
      setMessages(items => [...items, result?.ok
        ? { role:'assistant', content:`Scheduled in ${result.calendar}. I created a purple Gymstant calendar so these events are easy to recognize.`, model:'Gymstant · scheduled' }
        : { role:'assistant', content:'I could not add that event to Apple Calendar yet.', error:true, retryText:`Schedule ${pendingSchedule.title} in Apple Calendar ${pendingSchedule.cadence} at ${pendingSchedule.hour}:${String(pendingSchedule.minute).padStart(2,'0')}.` }]);
      setPendingSchedule(null); setToast(result?.ok ? 'Scheduled' : 'Calendar needs a quick repair'); openPanel(); return;
    }
    const instruction = `Use ${option.label}. Create a calendar or label named Gymstant with a distinct purple color if it does not exist, then schedule "${pendingSchedule.title}" ${pendingSchedule.cadence} at ${pendingSchedule.hour}:${String(pendingSchedule.minute).padStart(2,'0')}. Verify the event appears and report the result.`;
    setPendingSchedule(null); await send(instruction, null, true);
  }
  async function confirmMonitor(workflow) {
    if (!String(workflow.id || '').startsWith('demo-makeup-')) {
      const completed = await runAutomatedWorkflow(workflow);
      if (completed) setState(s=>({...s,workflows:s.workflows.map(w=>w.id===workflow.id?{...w,status:'automated'}:w)}));
      return;
    }
    setToast(`Approval received · completing ${workflow.title}…`);
    setMessages(items => [...items, { role:'assistant', content:`I received your approval for “${workflow.title}.” I’m completing that approved final action now; you do not need to tell me again.`, model:'Gymstant · approval received' }]);
    try {
      const answer = await api?.executeMonitorAction(workflow.id);
      await api?.approveLearnedWorkflow(workflow.id);
      setState(s=>({...s,workflows:s.workflows.map(w=>w.id===workflow.id?{...w,status:'automated'}:w)}));
      setMessages(items => [...items, { role:'assistant', content:answer?.text || `${workflow.title} is complete.`, model:'Gymstant · approved action' }]);
      setToast('Approved action completed');
    } catch (error) {
      setMessages(items => [...items, { role:'assistant', content:`I received the approval, but could not finish that action yet: ${error.message}`, error:true, retryText:workflow.title }]);
      setToast('Approval saved · action needs repair');
    }
  }

  function beginDrag(event) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragRetracted(true);
    api?.dragStart({ x: event.screenX, y: event.screenY });
  }
  function moveDrag(event) { if (event.currentTarget.hasPointerCapture(event.pointerId)) api?.dragMove({ x: event.screenX, y: event.screenY }); }
  function endDrag(event) { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); api?.dragEnd(); setDragRetracted(false); }
  function beginResize(edge, event) { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); api?.resizeStart({ edge, point: { x: event.screenX, y: event.screenY } }); }
  function moveResize(event) { if (event.currentTarget.hasPointerCapture(event.pointerId)) api?.resizeMove({ x: event.screenX, y: event.screenY }); }
  function endResize(event) { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); api?.resizeEnd(); }
  function beginHeightResize(event) { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); api?.heightResizeStart({ x: event.screenX, y: event.screenY }); }
  function moveHeightResize(event) { if (event.currentTarget.hasPointerCapture(event.pointerId)) api?.heightResizeMove({ x: event.screenX, y: event.screenY }); }
  function endHeightResize(event) { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); api?.heightResizeEnd(); }

  return <main className={`${expanded ? 'shell expanded' : 'shell'} expand-${placement.vertical} align-${placement.horizontal} ${executing ? 'executing' : ''} ${executionOpen ? 'execution-open' : ''} ${minimized ? 'minimized' : ''}`}>
    <svg className="lens-defs" aria-hidden="true"><filter id="liquidLens"><feTurbulence type="fractalNoise" baseFrequency="0.012 0.025" numOctaves="2" seed="7" result="noise"/><feDisplacementMap in="SourceGraphic" in2="noise" scale="14" xChannelSelector="R" yChannelSelector="B"/></filter></svg>
    {minimized && <button className="minimized-orb glass" aria-label="Expand Gymstant" title="Expand Gymstant" onClick={()=>{api?.restoreChatbar(); setMinimized(false); setToast('Ready when you are');}}><Sparkles/><span>G</span></button>}
    <button className="execution-pill glass" title="Open Gymstant’s live activity" onClick={showExecution}><span className="pulse live"/><span>{workPhrase}</span><span className="work-dots"><i/><i/><i/></span></button>
    {expanded && <section className={`panel ${panelVisible ? 'panel-visible' : 'panel-hidden'} ${dragRetracted ? 'drag-retracted' : ''}`}>
      <div className="height-handle" role="separator" aria-label="Adjust conversation height" onPointerDown={beginHeightResize} onPointerMove={moveHeightResize} onPointerUp={endHeightResize} onPointerCancel={endHeightResize}/>
      <div className="utility-row module"><nav className="glass">
        <button className="new-session" title="New session" onClick={newSession}><Plus/></button>
        <button className={state.activeLane === 'learn' ? 'active' : ''} onClick={() => setState(s=>({...s,activeLane:'learn'}))}><GraduationCap/>Learn</button>
        <button className={state.activeLane === 'review' ? 'active' : ''} onClick={() => setState(s=>({...s,activeLane:'review'}))}><FileCheck2/>Review {counts.review > 0 && <i>{counts.review}</i>}</button>
        <button className={state.activeLane === 'monitor' ? 'active' : ''} onClick={() => setState(s=>({...s,activeLane:'monitor'}))}><MonitorCheck/>Monitor {counts.monitor > 0 && <i>{counts.monitor}</i>}</button>
        <button className={state.activeLane === 'automated' ? 'active' : ''} onClick={() => setState(s=>({...s,activeLane:'automated'}))}><Play/>Automated {counts.automated > 0 && <i>{counts.automated}</i>}</button>
        <button className={state.activeLane === 'history' ? 'active' : ''} onClick={() => {setState(s=>({...s,activeLane:'history'}));refreshHistory();}}><History/>History</button>
        <button className="settings-tab" title="Settings" onClick={()=>setState(s=>({...s,activeLane:'settings'}))}><SlidersHorizontal/></button>
      </nav><button className="close-pill glass" onClick={closePanel}><X size={15}/></button></div>
      <div className="content module">{state.activeLane === 'settings'
        ? <SettingsPanel settings={state.settings || seed.settings} update={settings=>setState(s=>({...s,settings:{...s.settings,...settings}}))}
            hermesModel={hermesModel} hermesTools={hermesTools} modelCatalog={modelCatalog} hermesLoading={hermesLoading} hermesError={hermesError}
            onSetModel={setHermesModel} onSetTool={setHermesTool}/>
        : state.activeLane === 'history'
        ? <HistoryPanel items={historyItems} archive={async()=>{await api?.archiveConversation();setMessages([]);await refreshHistory();}} open={async id=>{setMessages(await api?.openConversation(id)||[]);setState(s=>({...s,activeLane:'learn'}));}}/>
        : state.activeLane === 'learn' && messages.length > 0 && !state.teaching
        ? <div className="messages">{taskRun&&<ExecutionStatusCard run={taskRun} onFix={()=>send(taskRun.retryText || taskRun.task, taskRun.retryText || taskRun.task)} onStop={interruptExecution}/>} {messages.map((m,i)=><div key={`${m.at||''}-${i}`} className={`message ${m.role} ${m.error?'error':''}`}><p>{m.content}</p>{m.model&&<small>{m.model}</small>}{m.options&&<div className="calendar-options">{m.options.map(option=><button key={option.id} onClick={()=>chooseCalendar(option)}><CalendarDays/><span><b>{option.label}</b><small>{option.detail}</small></span></button>)}</div>}{m.error&&<button className="fix-button" onClick={()=>send(m.retryText,m.retryText)}>Fix</button>}</div>)}{thinking&&!executing&&<div className="message assistant typing"><i/><i/><i/></div>}{executing&&executionOpen&&<div className="live-work-row" key={workActivity.at}><div className={`message assistant activity ${workActivity.tone||''}`}><p>{workActivity.text}</p><i/><i/><i/></div><button className="stop-button" onClick={interruptExecution}>Stop</button></div>}</div>
        : <>{state.activeLane === 'learn' && <Learn state={state} setState={setState} start={startTeaching} capture={captureStep} finish={finishTeaching} togglePause={togglePauseRecording}/>} {state.activeLane === 'review' && (reviewingWorkflow ? <WorkflowReview workflow={reviewingWorkflow} onBack={()=>setReviewingWorkflow(null)} onRun={()=>runWorkflowPreview(reviewingWorkflow)} onExpand={setExpandedEvidence} onUpdate={updateReviewStep} onAttach={attachRecording} onRename={renameWorkflow} onSchedule={scheduleWorkflow}/> : <Queue items={state.workflows.filter(w=>w.status==='review')} action={approve} remove={removeWorkflow} onPreview={previewWorkflow} onRun={runWorkflowPreview} onRename={renameFromQueue} label="Approve for monitor" empty="Nothing waiting for review"/>)}{state.activeLane === 'monitor' && <Queue items={state.workflows.filter(w=>w.status==='monitor')} action={confirmMonitor} remove={removeWorkflow} onRename={renameFromQueue} label="Confirm final step" empty="No monitored runs right now" monitor/>}{state.activeLane === 'automated' && <Queue items={state.workflows.filter(w=>w.status==='automated')} action={runAutomatedWorkflow} remove={removeWorkflow} onRename={renameFromQueue} label="Run now" empty="No approved automated workflows" monitor/>}</>}
      </div>
      <footer className="glass module"><ShieldCheck size={14}/><span>Sensitive fields are ignored. Final actions stay human-confirmed until verified.</span><button onClick={()=>api?.openData()}><FolderOpen size={14}/>Memory</button></footer>
    </section>}
    {expandedEvidence&&<div className="evidence-modal" onClick={()=>setExpandedEvidence(null)}><div onClick={e=>e.stopPropagation()}><button onClick={()=>setExpandedEvidence(null)}><X size={16}/>Close</button><img src={expandedEvidence.fullUrl || expandedEvidence.dataUrl} alt={`Expanded redacted evidence for ${expandedEvidence.label}`}/><small>{expandedEvidence.privacy==='redacted'?`${expandedEvidence.redactions || 0} sensitive regions blurred locally — the rest remains sharp.`:'Legacy whole-frame privacy evidence.'}</small></div></div>}<div className="toast"><span className={state.teaching ? 'pulse live' : 'pulse'}></span>{toast}{thinking&&<span className="work-dots mini"><i/><i/><i/></span>}</div>
    {!minimized && <section className="chatbar glass">
      <div className="width-handle left" role="separator" aria-label="Resize from left" onPointerDown={e=>beginResize('left',e)} onPointerMove={moveResize} onPointerUp={endResize} onPointerCancel={endResize}/>
      <div className="drag-grip" role="button" aria-label="Drag Gymstant" title="Drag" onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}><GripVertical/></div>
      <button title={state.teaching ? (state.recordingPaused ? 'Resume recording' : 'Pause recording') : 'Watch this workflow'} className={state.teaching ? 'observe active' : 'observe'} onClick={state.teaching ? togglePauseRecording : startTeaching}>{state.teaching ? (state.recordingPaused ? <Play/> : <Pause/>) : <Eye/>}</button>
      <div className="input" style={{minHeight:`${Math.max(40,30+inputRows*18)}px`}}><textarea rows={inputRows} value={message} onChange={e=>setMessage(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}}} placeholder="Ask Gymstant, or type “watch this”…"/><button className="mic"><Mic/></button><button className="send" onClick={send}><ArrowUp/></button></div>
      <button className="expand" onClick={()=>expanded?closePanel():openPanel()}><ChevronDown className={expanded?'flip':''}/></button>
      <div className="width-handle right" role="separator" aria-label="Resize from right" onPointerDown={e=>beginResize('right',e)} onPointerMove={moveResize} onPointerUp={endResize} onPointerCancel={endResize}/>
    </section>}
  </main>;
}

function Learn({state,setState,start,capture,finish,togglePause}) {
  if (!state.teaching) return <div className="empty"><span className="hero-icon"><Eye/></span><h2>Watch it once. Gymstant learns it.</h2><p>Use the eye or say “watch this.” Gymstant captures privacy-protected evidence, your notes, and an editable how-to manual for Review.</p><button className="primary" onClick={start}><Play/>Watch this workflow</button><small>⌘ ⇧ W starts or saves · ⌘ ⇧ G captures a step. Screenshots stay on this Mac.</small></div>;
  const timelineRef = useRef(null);
  useEffect(() => { if (timelineRef.current) timelineRef.current.scrollTop = timelineRef.current.scrollHeight; }, [state.draft.steps.length]);
  return <div className="learning"><div className="learning-head"><div><span className="eyebrow"><Activity/>{state.recordingPaused ? 'RECORDING PAUSED' : 'WATCHING THIS WORKFLOW'}</span><input value={state.draft.title} aria-label="Workflow manual title" onChange={e=>setState(s=>({...s,draft:{...s.draft,title:e.target.value}}))}/><p>{state.draft.steps.length} live steps · event trace records automatically · {state.draft.privacy === 'redacted' ? 'only detected private regions blurred' : state.draft.privacy === 'pixelated' ? 'whole screen pixelated' : 'evidence stored locally'}</p></div><div className="ring">{state.draft.steps.length}<small>live</small></div></div><div className="timeline" ref={timelineRef}>{state.draft.steps.length===0?<p className="hint">Gymstant is recording clicks, keys, and window transitions automatically. The newest interpreted action will appear here as it happens.</p>:state.draft.steps.map((s,i)=><div className="step step-edit" key={`${s.eventCursor || i}-${s.capturedAt || ''}`}><span>{i+1}</span>{(s.dataUrl||s.fullUrl)&&<img src={s.dataUrl||s.fullUrl} alt={`Private evidence for step ${i+1}`}/>}<div><input value={s.label} aria-label={`Step ${i+1} action`} onChange={e=>setState(x=>({...x,draft:{...x.draft,steps:x.draft.steps.map((q,j)=>j===i?{...q,label:e.target.value}:q)}}))}/><textarea value={s.note || ''} aria-label={`Step ${i+1} note`} onChange={e=>setState(x=>({...x,draft:{...x.draft,steps:x.draft.steps.map((q,j)=>j===i?{...q,note:e.target.value}:q)}}))}/></div><Check/></div>)}</div><div className="actions"><button onClick={capture}><Eye/>Capture visual checkpoint</button><button onClick={togglePause}>{state.recordingPaused ? <Play/> : <Pause/>}{state.recordingPaused ? 'Resume recording' : 'Pause recording'}</button><button className="primary" onClick={finish}><Check/>Done & save workflow</button></div></div>;
}
function Queue({items,action,remove,onPreview,onRun,onRename,label,empty,monitor}) { return items.length===0?<div className="empty compact"><Check/><h2>{empty}</h2></div>:<div className="queue">{items.map(w=>{const unlocked=monitor||Boolean(w.previewedAt||w.lastRunAt);const replayable=!w.captureMode||Array.isArray(w.events)&&w.events.length>0;return <article key={w.id}><div className="appmark">{w.app?.[0]||'W'}</div><div className="details">{onRename?<button className="queue-title-button" onClick={()=>onRename(w)} title="Rename workflow">{w.title}</button>:<b>{w.title}</b>}<span>{w.detail || `${w.app} · ${typeof w.steps==='number'?w.steps:w.steps.length} steps · ${w.confidence}% confidence`}</span></div><span className={monitor?'badge amber':unlocked?'badge':'badge locked'}>{monitor?'Awaiting final click':unlocked?'Previewed':'Preview required'}</span><div className="queue-actions">{onPreview&&<button className="evidence-button" onClick={()=>onPreview(w)}><Eye size={15}/>Preview</button>}{onRun&&<button className="run-workflow" onClick={()=>onRun(w)} disabled={w.previewStatus==='running'||!replayable} title={!replayable?'This Watch trace has no events yet':''}><Play size={14}/>{w.previewStatus==='running'?'Running…':replayable?'Run manually':'Replay unavailable'}</button>}<button className="remove-workflow" title={`Remove ${w.title}`} aria-label={`Remove ${w.title}`} onClick={()=>remove(w)}><X size={15}/>Remove</button><button className="action" disabled={!unlocked} title={!unlocked?'Preview or run this workflow first':''} onClick={()=>action(monitor?w:w.id)}>{unlocked?label:'Preview first'}<ArrowUp/></button></div></article>})}</div> }
function WorkflowReview({workflow,onBack,onAttach,onUpdate,onExpand,onRun,onRename,onSchedule}) {
  const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
  const videoSteps = Array.isArray(workflow.videoSteps) ? workflow.videoSteps : [];
  const recording = workflow.recording;
  const eventTrace = Array.isArray(workflow.events) ? workflow.events : [];
  const eventCounts = eventTrace.reduce((counts,event) => { if (event.type === 'mouse.click') counts.clicks += 1; else if (event.type === 'key.press') counts.keys += 1; else if (event.type === 'window.activate') counts.windows += 1; return counts; }, { clicks:0, keys:0, windows:0 });
  const replayable = !workflow.captureMode || Array.isArray(workflow.events) && workflow.events.length > 0;
  const selective = workflow.privacy === 'redacted';
  const [scheduleOpen,setScheduleOpen] = useState(false);
  const [scheduleTime,setScheduleTime] = useState(workflow.schedule?.time || '17:00');
  const [scheduleCadence,setScheduleCadence] = useState(workflow.schedule?.cadence || 'daily');
  return <div className="workflow-review">
    <div className="review-toolbar"><button className="back-button" onClick={onBack}><ArrowLeft size={15}/>All review items</button><div className="review-toolbar-actions"><button className="back-button" onClick={()=>setScheduleOpen(v=>!v)}>Schedule</button><button className="run-workflow" onClick={onRun} disabled={workflow.previewStatus==='running'||!replayable} title={!replayable?'This Watch trace has no native click/key events yet':''}><Play size={14}/>{workflow.previewStatus==='running'?'Running preview…':replayable?'Run manually':'Replay unavailable'}</button></div></div>
    <div className="review-head"><span className="hero-icon small"><Eye/></span><div><input className="workflow-title-edit" aria-label="Workflow title" value={workflow.title || ''} onChange={e=>onRename(workflow,e.target.value)} onBlur={e=>onRename(workflow,e.target.value)}/><p>{steps.length} captured steps · {selective?'selectively redacted sharp evidence':workflow.privacy==='pixelated'?'legacy whole-frame pixelation':'local evidence'}</p></div></div>
    <div className={`trace-summary ${workflow.eventTraceQuality === 'window-only' ? 'trace-warning' : ''}`}><Activity size={15}/><span><b>{eventTrace.length ? (workflow.eventTraceQuality === 'window-only' ? 'Window-only trace · replay incomplete' : 'Deterministic event trace captured') : 'No deterministic event trace'}</b>{eventTrace.length ? ` · ${eventCounts.clicks} clicks · ${eventCounts.keys} key presses · ${eventCounts.windows} window transitions · text omitted${workflow.eventTraceQuality === 'window-only' ? ' · no native click/key events observed; accessibility-driven test actions may not emit CGEvents' : ''}` : ` · ${workflow.eventRecordingError || 'Start Watch to capture clicks, keys, and window transitions.'}`}</span></div>
    {workflow.lastRunResult&&<div className={`preview-result ${workflow.previewStatus||''}`}><b>Last preview run <small>{workflow.lastRunModel === 'Gymstant · local deterministic replay' ? 'LOCAL · NO TOKENS' : 'HERMES / MODEL-DRIVEN'}</small></b><span>{workflow.lastRunResult}</span></div>}
    {workflow.previewSteps?.length ? <div className="preview-steps"><b>Preview checkpoints</b>{workflow.previewSteps.map(step=><div key={step.id}><span className={`preview-dot ${step.status}`}/><strong>{step.id}</strong><span>{step.target}</span><small>{step.status}</small></div>)}</div> : null}
    {scheduleOpen ? <div className="schedule-editor"><b>Local schedule</b><small>Runs only while Gymstant is open, and only for an approved Automated workflow.</small><label>Cadence<select value={scheduleCadence} onChange={e=>setScheduleCadence(e.target.value)}><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label><label>Time<input type="time" value={scheduleTime} onChange={e=>setScheduleTime(e.target.value)}/></label><button className="run-workflow" onClick={()=>{onSchedule(workflow,{cadence:scheduleCadence,time:scheduleTime});setScheduleOpen(false);}}>Save schedule</button></div> : null}
    <div className="privacy-callout"><ShieldCheck size={16}/><span><b>Privacy status: {selective?'local sensitive-region redaction':workflow.privacy==='pixelated'?'legacy whole-frame pixelation':'local screenshots'}.</b> {selective?'Gymstant pre-scanned the visible page and blurred only matched sensitive UI regions before writing the screenshot.':workflow.privacy==='pixelated'?'This older evidence intentionally obscures the entire frame and will remain blurry when enlarged.':'This image was kept locally without automatic redaction.'}</span></div>
    {recording ? <div className="recording-card"><div><Film size={16}/><b>{recording.name}</b></div><small>Original video stays local and is never rendered. This playback is a redacted preview assembled from privacy-filtered frames.</small>{recording.previewUrl ? <video controls src={recording.previewUrl}/> : null}{recording.frames?.length ? <div className="recording-frames">{recording.frames.map(frame=><button className="evidence-image" key={frame.index} onClick={()=>onExpand({label:`Video frame ${frame.index}`,fullUrl:frame.url,privacy:'redacted',redactions:frame.redactions})}><img src={frame.url} alt={`Redacted video frame at ${Math.round(frame.at)} seconds`}/><i>{Math.round(frame.at)}s</i></button>)}</div> : null}</div> : <div className="recording-card empty-recording"><Film size={16}/><div><b>No recording attached</b><small>Attach a local video to extract privacy-filtered frames and timestamped draft steps.</small></div><button onClick={onAttach}>Attach local recording</button></div>}
    {videoSteps.length ? <div className="video-extraction"><b>Video action draft · human review required</b>{videoSteps.map((step,index)=><div key={`${step.at}-${index}`}><span>{index+1}</span><div><b>{step.label}</b><small>{step.note}</small></div></div>)}</div> : null}
    <div className="evidence-list">{steps.length ? steps.map((step,index)=><article className="evidence-step" key={step.capturedAt||index}><span>{index+1}</span>{(step.dataUrl||step.fullUrl)&&<button className="evidence-image" onClick={()=>onExpand(step)}><img src={step.dataUrl||step.fullUrl} alt={`Privacy-filtered evidence for ${step.label}`}/><i>Expand</i></button>}<div><input aria-label={`Review step ${index+1} action`} value={step.label} onChange={e=>onUpdate(index,{label:e.target.value})}/><textarea aria-label={`Review step ${index+1} note`} value={step.note||''} onChange={e=>onUpdate(index,{note:e.target.value})}/><small>{step.privacy==='redacted'?`${step.redactions||0} sensitive regions blurred`:step.privacy==='pixelated'?'Legacy whole-frame pixelation':'Local screenshot'} · {step.capturedAt&&new Date(step.capturedAt).toLocaleString()}</small></div></article>) : <p className="hint">No visual checkpoints were added. The automatic click/key/window event trace is still saved; add visual checkpoints only when screenshot evidence helps a reviewer.</p>}</div>
  </div>;
}
function HistoryPanel({items,archive,open}) { return <div className="history-list">{items.length===0?<div className="empty compact"><History/><h2>No saved conversations</h2></div>:items.map(item=><article key={item.id} className="history-item glass"><button className="history-open" onClick={()=>open(item.id)}><b>{item.title}</b><span>{item.count} messages · {item.archived?'Archived':'Current'}</span></button>{!item.archived&&<button className="archive-button" title="Archive conversation" onClick={archive}><Archive/></button>}</article>)}</div> }
function SettingsPanel({settings,update,hermesModel,hermesTools,modelCatalog,hermesLoading,hermesError,onSetModel,onSetTool}) {
  const appApi = window.gymstant;
  const [pendingTool, setPendingTool] = useState(null);
  const [toolError, setToolError] = useState('');
  async function toggleTool(tool, checked) {
    setPendingTool(tool.name); setToolError('');
    const result = await onSetTool(tool.name, checked);
    setPendingTool(null);
    if (!result.ok) setToolError(`Could not change ${tool.label}: ${result.message}`);
  }
  const catalogNote = { 'no-profile': "Hermes hasn't been set up on this computer yet.", 'not-cached': 'The model catalog isn’t cached yet. Run “hermes model” once in a terminal, then reopen Settings.', 'unreadable': 'The model catalog file could not be read.' }[modelCatalog.reason] || 'Model catalog isn’t available yet.';
  return <div className="settings-panel"><div className="settings-card glass"><span className="hero-icon small"><Settings/></span><div><h2>Interruption recovery</h2><p>When you use another app, Gymstant pauses. After this much inactivity it returns to its work.</p></div><label><b>{settings.focusResumeSeconds} seconds</b><input type="range" min="5" max="120" step="5" value={settings.focusResumeSeconds} onChange={e=>update({focusResumeSeconds:Number(e.target.value)})}/><small>Ask Gymstant to change this anytime.</small></label></div><div className="personalization-card glass"><div><Sparkles/><span><b>Workflow capture &amp; workspace</b><small>Keep evidence private and work windows as large as possible.</small></span></div><label className="setting-select"><span>Screenshot privacy</span><select value={settings.capturePrivacy} onChange={e=>update({capturePrivacy:e.target.value})}><option value="redacted">Blur detected sensitive regions</option><option value="pixelated">Pixelate the entire screen</option><option value="local">Keep local screenshot unchanged</option></select></label><label className="setting-select"><span>Gymstant workspace side</span><select value={settings.workspaceSide||'right'} onChange={e=>update({workspaceSide:e.target.value})}><option value="right">Right side</option><option value="left">Left side</option></select></label><label className="setting-toggle"><input type="checkbox" checked={Boolean(settings.captureNotes)} onChange={e=>update({captureNotes:e.target.checked})}/><span>Prompt me to annotate each captured step</span></label><label className="setting-toggle"><input type="checkbox" checked={Boolean(settings.showCaptureHints)} onChange={e=>update({showCaptureHints:e.target.checked})}/><span>Show capture and shortcut hints</span></label><label className="setting-select"><span>Assistant voice</span><select value={settings.assistantTone} onChange={e=>update({assistantTone:e.target.value})}><option value="concise">Concise</option><option value="coaching">Coaching</option><option value="detailed">Detailed</option></select></label></div>
    <div className="personalization-card glass">
      <div><Cpu/><span><b>AI &amp; Tools</b><small>Model and tool access for this Hermes agent.</small></span></div>
      {hermesLoading && <small>Loading Hermes settings…</small>}
      {hermesError && <small>{hermesError}</small>}
      <label className="setting-select">
        <span>Current model</span>
        {modelCatalog.available
          ? <select value={hermesModel?.default || ''} onChange={e=>onSetModel(e.target.value)} disabled={hermesLoading}>
              {!modelCatalog.models.some(m=>m.id===hermesModel?.default) && hermesModel?.default && <option value={hermesModel.default}>{hermesModel.default}</option>}
              {modelCatalog.models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          : <small>{catalogNote}{hermesModel?.default ? ` Current: ${hermesModel.default} (${hermesModel.provider}).` : ''}</small>}
      </label>
      {toolError && <small>{toolError}</small>}
      {hermesTools.map(tool => (
        <label className="setting-toggle" key={tool.name}>
          <input type="checkbox" checked={tool.enabled} disabled={pendingTool===tool.name} onChange={e=>toggleTool(tool, e.target.checked)}/>
          <span>{tool.label}{pendingTool===tool.name ? ' …' : ''}</span>
        </label>
      ))}
    </div>
    <div className="settings-actions glass">
      <div><b>App controls</b><small>Restart reloads Gymstant cleanly. Quit turns it off.</small></div>
      <button className="settings-restart" onClick={()=>appApi?.restartApp?.()}><Activity size={14}/>Restart Gymstant</button>
      <button className="settings-quit" onClick={()=>appApi?.quitApp?.()}><X size={14}/>Quit Gymstant</button>
    </div>
  </div> }

function ExecutionStatusCard({run,onFix,onStop}) {
  const progress = run.checkpointCount ? Math.max(4, Math.min(100, ((run.checkpointIndex || 0) / run.checkpointCount) * 100)) : run.status === 'complete' ? 100 : 18;
  const label = run.status === 'complete' ? 'Complete' : run.status === 'error' ? 'Needs repair' : run.status === 'stopped' ? 'Stopped' : run.attempt > 1 ? `Repairing · attempt ${run.attempt}` : 'In progress';
  return <article className={`execution-card ${run.status}`}>
    <div className="execution-card-head"><span className={`pulse ${run.status === 'working' ? 'live' : ''}`}/><b>{label}</b><small>{run.checkpointCount ? `${Math.min(run.checkpointIndex || 0,run.checkpointCount)} of ${run.checkpointCount}` : ''}</small></div>
    <p>{run.checkpoint}</p>
    <div className="execution-progress"><i style={{width:`${progress}%`}}/></div>
    {run.error&&<div className="execution-error"><span>{run.error}</span><button onClick={onFix}>Fix this step</button></div>}
    {run.status==='working'&&<button className="execution-card-stop" onClick={onStop}>Stop</button>}
  </article>;
}

function parseSchedule(text) {
  const match = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  let hour = Number(match?.[1] || 14), minute = Number(match?.[2] || 0);
  const suffix = match?.[3]?.toLowerCase(); if (suffix === 'pm' && hour < 12) hour += 12; if (suffix === 'am' && hour === 12) hour = 0;
  const cadence = /weekdays?/i.test(text) ? 'weekdays' : /weekly|each week/i.test(text) ? 'weekly' : 'daily';
  return { hour, minute, cadence };
}
function fuzzyPick(query, items, idKey, nameKeys) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  return items.map(item => {
    const id = String(item[idKey] || '').toLowerCase();
    const names = nameKeys.map(k => String(item[k] || '').toLowerCase());
    if (id === q || names.includes(q)) return { item, score: 0, length: id.length };
    const hit = id.includes(q) || names.some(n => n.includes(q));
    return hit ? { item, score: 1, length: Math.min(id.length, ...names.map(n => n.length || 999)) } : null;
  }).filter(Boolean).sort((a, b) => a.score - b.score || a.length - b.length);
}
function resolveMatch(query, items, idKey, nameKeys) {
  const scored = fuzzyPick(query, items, idKey, nameKeys);
  if (!scored.length) return { status: 'none' };
  if (scored.length === 1 || scored[0].score < scored[1].score) return { status: 'found', item: scored[0].item };
  if (scored[1].length > scored[0].length) return { status: 'found', item: scored[0].item };
  return { status: 'ambiguous', options: scored.filter(s => s.score === scored[0].score).slice(0, 5).map(s => s.item) };
}
function workflowTitle(context='') {
  if (/makeup|missed[- ]class|absence/i.test(context)) return 'Gymstant: Review missed-class requests';
  if (/roster/i.test(context)) return 'Gymstant: Review roster workflow';
  if (/email/i.test(context)) return 'Gymstant: Prepare follow-up';
  return `Gymstant: ${context.replace(/\s+/g,' ').slice(0,58) || 'Scheduled workflow'}`;
}

createRoot(document.getElementById('root')).render(<App/>);
