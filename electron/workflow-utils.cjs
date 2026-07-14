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
  return rows.join('\n');
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

module.exports = { buildWorkflowManual, buildWorkflowRetirement, nextWindowMode, normalizeWatchCommand };
