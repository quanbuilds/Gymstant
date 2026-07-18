function normalizeWatchCommand(text) {
  return /^\/?watch this\s*[.!]?$/i.test(String(text || '').trim());
}

function nextWindowMode({ width, height, collapsedHeight = 108 }) {
  if (width <= 168 && height <= collapsedHeight + 8) return 'minimized';
  if (height <= collapsedHeight + 8) return 'chatbar';
  return 'expanded';
}

function buildWorkflowManual(workflow) {
  const privacy = workflow.privacy === 'pixelated' ? 'pixelated screenshots only' : 'local screenshots';
  const rows = [
    `# ${workflow.title || 'Untitled workflow'}`,
    '',
    '## Purpose',
    `- Application: ${workflow.app || 'Observed application'}`,
    `- Trigger: ${workflow.trigger || 'Observed demonstration'}`,
    `- Privacy: ${privacy}`,
    `- Human confirmation required: ${workflow.finalAction || 'Confirm consequential final actions before completing them.'}`,
    '',
    '## Observed steps'
  ];
  for (const [index, step] of (workflow.steps || []).entries()) {
    rows.push(`${index + 1}. ${step.label || `Observed action ${index + 1}`}`);
    rows.push(`   - Note: ${step.note || 'Describe what is being checked or changed at this step.'}`);
    rows.push(`   - Evidence: ${step.path || 'Written observation only'}`);
  }
  rows.push('', '## Automation boundary', 'Gymstant may reproduce these preparation steps after review. It must stop for the confirmation above and preserve the privacy setting.');
  const events = Array.isArray(workflow.events) ? workflow.events : [];
  if (events.length) {
    const clicks = events.filter(event => event.type === 'mouse.click').length;
    const keys = events.filter(event => event.type === 'key.press').length;
    const windows = events.filter(event => event.type === 'window.activate').length;
    rows.push('', '## Deterministic event trace', `- Version: ${workflow.eventTraceVersion || 1}`, `- Events: ${events.length} (${clicks} clicks, ${keys} key presses, ${windows} window transitions)`, '- Text policy: key codes and modifiers retained; typed text omitted and must be re-entered or mapped to an approved field during review.');
  } else if (workflow.eventRecordingError) {
    rows.push('', '## Deterministic event trace', `- Unavailable: ${workflow.eventRecordingError}`);
  }
  rows.push('', '## Replay plan');
  for (const step of buildReplayPlan(workflow)) rows.push(`- ${step.id}: ${step.action} | target: ${step.target} | reason: ${step.reason} | verify: ${step.verify} | risk: ${step.risk}`);
  if (workflow.recording) {
    rows.push('', '## Video evidence', `- Recording: ${workflow.recording.name || 'local video'}`, `- Extraction: ${workflow.recording.extractionStatus || 'review required'}`, `- Privacy: ${workflow.recording.privacy || 'review required'}`);
    for (const step of workflow.videoSteps || []) rows.push(`- ${step.label}: ${step.note}`);
  }
  return rows.join('\n');
}

function buildReplayPlan(workflow) {
  return (workflow?.steps || []).map((step, index) => {
    const text = `${step.label || ''} ${step.note || ''}`;
    const action = step.actionType || (/\b(type|enter|write|draft|prepare|message)\b/i.test(text) ? 'input' : /\b(click|select|open|choose|navigate)\b/i.test(text) ? 'navigate' : 'inspect');
    const risk = /\b(send|submit|delete|remove|pay|purchase|publish|finalize|sign)\b/i.test(text) ? 'consequential-stop' : 'preparation';
    return {
      id:`step-${index + 1}`,
      action,
      target:step.target || step.label || `Observed action ${index + 1}`,
      reason:step.reason || step.note || 'Confirm the visible state before continuing.',
      verify:step.verification || 'Visually verify the expected state before advancing.',
      risk
    };
  });
}

function buildWorkflowRetirement(workflow) {
  return [
    '## Workflow retirement',
    `- Retired workflow: ${workflow.title || 'Untitled workflow'}`,
    `- ID: ${workflow.id || 'unknown'}`,
    `- Retired: ${new Date().toISOString()}`,
    '- This workflow was removed by an operator and must not be used for future automation.',
    ''
  ].join('\n');
}

module.exports = { buildWorkflowManual, buildWorkflowRetirement, buildReplayPlan, nextWindowMode, normalizeWatchCommand };
