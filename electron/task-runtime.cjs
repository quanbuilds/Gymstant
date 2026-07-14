const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function cleanText(value, limit = 6000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function originalRequest(value) {
  const text = cleanText(value);
  const marker = text.match(/Original task:\s*([\s\S]+)$/i);
  return cleanText(marker ? marker[1] : text);
}

function taskId(request) {
  return crypto.createHash('sha256').update(request.toLowerCase()).digest('hex').slice(0, 16);
}

function deriveSteps(request) {
  const steps = [];
  const classWork = /class software|frappe|education|roster|attendance|guardian|student|makeup class|class capacity/i.test(request);
  const email = /gmail|e-?mail|draft/i.test(request);
  if (classWork) {
    steps.push({ id: 'class-verify', label: 'Verify the family, attendance, class options, and capacity in the class software.' });
    if (/prepare|change|roster|makeup/i.test(request)) steps.push({ id: 'class-prepare', label: 'Prepare the requested class or roster change, then stop before its final confirmation.' });
  }
  if (email) steps.push({ id: 'email-draft', label: 'Create the requested email draft using the verified details, then stop before Send.' });
  if (!steps.length) steps.push({ id: 'desktop-task', label: 'Complete and visibly verify the requested desktop work.' });
  return steps;
}

class TaskRuntime {
  constructor(file) { this.file = file; }
  readAll() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return { tasks: {} }; } }
  writeAll(data) { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(data, null, 2)); }
  open(rawRequest) {
    const request = originalRequest(rawRequest);
    const id = taskId(request);
    const data = this.readAll();
    let task = data.tasks[id];
    if (!task || task.status === 'complete') {
      task = { id, request, status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), steps: deriveSteps(request).map(step => ({ ...step, status: 'pending', attempts: 0 })) };
      data.tasks[id] = task;
    } else {
      task.status = 'running';
      task.updatedAt = new Date().toISOString();
    }
    this.writeAll(data);
    return task;
  }
  update(task) { const data = this.readAll(); task.updatedAt = new Date().toISOString(); data.tasks[task.id] = task; this.writeAll(data); return task; }
  pending(task) { return task.steps.find(step => step.status !== 'complete'); }
  begin(task, step) { step.status = 'running'; step.attempts += 1; step.lastStartedAt = new Date().toISOString(); delete step.error; return this.update(task); }
  completeStep(task, step, result) { step.status = 'complete'; step.result = cleanText(result, 1600); step.completedAt = new Date().toISOString(); if (!this.pending(task)) { task.status = 'complete'; task.completedAt = new Date().toISOString(); } return this.update(task); }
  failStep(task, step, error) { step.status = 'pending'; step.error = cleanText(error?.message || error, 500); task.status = 'failed'; task.lastError = step.error; return this.update(task); }
  summary(task) { return task.steps.filter(s => s.status === 'complete').map(s => `${s.label} Result: ${s.result}`).join('\n').slice(-3200); }
}

function isFalseSuccess(text) {
  return /context length exceeded|cannot compress further|maximum context|tool loop.*exceeded|API call failed|HTTP (?:4\d\d|5\d\d)|usage limit|rate limit|quota exceeded|unauthorized|invalid api key/i.test(String(text || ''));
}

module.exports = { TaskRuntime, originalRequest, deriveSteps, isFalseSuccess };
