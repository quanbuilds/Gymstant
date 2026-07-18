const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWorkflowManual, buildWorkflowRetirement, buildReplayPlan, normalizeWatchCommand, nextWindowMode } = require('../electron/workflow-utils.cjs');
const { deriveSteps } = require('../electron/task-runtime.cjs');

test('recognizes the watch-this command without treating ordinary messages as commands', () => {
  assert.equal(normalizeWatchCommand('watch this'), true);
  assert.equal(normalizeWatchCommand('/watch this'), true);
  assert.equal(normalizeWatchCommand('  Watch this  '), true);
  assert.equal(normalizeWatchCommand('watch this later'), false);
});

test('creates a privacy-forward reusable workflow manual with each observed note', () => {
  const manual = buildWorkflowManual({
    id: 'wf-1',
    title: 'Close daily attendance',
    app: 'Class software',
    trigger: 'At the end of the class day',
    finalAction: 'A manager confirms Save',
    privacy: 'pixelated',
    steps: [
      { label: 'Open the attendance screen', note: 'Navigate from the class dashboard.', path: '/safe/shot-1.png' },
      { label: 'Review missing check-ins', note: 'Compare the roster before changing anything.', path: '/safe/shot-2.png' }
    ]
  });
  assert.match(manual, /Privacy: pixelated screenshots only/);
  assert.match(manual, /1\. Open the attendance screen/);
  assert.match(manual, /Note: Navigate from the class dashboard\./);
  assert.match(manual, /Human confirmation required: A manager confirms Save/);
});

test('allows both resize handles to reach collapsed and square minimized modes', () => {
  assert.equal(nextWindowMode({ width: 500, height: 108, collapsedHeight: 108 }), 'chatbar');
  assert.equal(nextWindowMode({ width: 148, height: 108, collapsedHeight: 108 }), 'minimized');
  assert.equal(nextWindowMode({ width: 660, height: 260, collapsedHeight: 108 }), 'expanded');
});

test('records an auditable retirement note when an incorrect workflow is removed', () => {
  const note = buildWorkflowRetirement({ title: 'Old parent follow-up', id: 'wf-old' });
  assert.match(note, /Retired workflow: Old parent follow-up/);
  assert.match(note, /ID: wf-old/);
  assert.match(note, /must not be used for future automation/i);
});

test('turns observed notes into a structured replay plan with safety boundaries', () => {
  const plan = buildReplayPlan({ steps: [
    { label: 'Open the roster', note: 'Navigate to the Tuesday class.' },
    { label: 'Prepare the message', note: 'Do not send until a person confirms.' }
  ] });
  assert.equal(plan[0].action, 'navigate');
  assert.equal(plan[1].action, 'input');
  assert.equal(plan[1].risk, 'consequential-stop');
  assert.match(buildWorkflowManual({ steps: [{ label:'Open roster', note:'Check the class.' }] }), /## Replay plan/);
});

test('preserves a deterministic event trace without exposing typed text', () => {
  const manual = buildWorkflowManual({ title:'Roster review', events:[
    { type:'mouse.click' }, { type:'key.press', textRedacted:true }, { type:'window.activate' }
  ], eventTraceVersion:1, steps:[] });
  assert.match(manual, /Deterministic event trace/);
  assert.match(manual, /3 \(1 clicks, 1 key presses, 1 window transitions\)/);
  assert.match(manual, /typed text omitted/i);
});

test('keeps navigation smoke tests out of the class-verification route', () => {
  const steps = deriveSteps('Open Safari and navigate to education.localhost:8000. Stop when the Education page is visibly loaded; do not click anything else.');
  assert.equal(steps.length, 1);
  assert.match(steps[0].label, /desktop work/i);
});
