const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWorkflowManual, buildWorkflowRetirement, normalizeWatchCommand, nextWindowMode } = require('../electron/workflow-utils.cjs');

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
