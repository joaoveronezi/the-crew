// Local issue tracker: the project's issues live in one of three plain-file formats (references/issues.md).
//   issues.json    an array (or { "issues": [...] }) of { id, title, status, ... }
//   issues/        one markdown file per issue, with front matter (id, title, status, priority, depends_on)
//   issues.md      one markdown file, one "## <id>: <title>" section per issue with a "Status:" line
// The crew only ever changes an issue's status and appends a log line; everything else stays as the user wrote it.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export const STATUSES = ['open', 'in_progress', 'done'];
const SYNONYMS = { todo: 'open', new: 'open', backlog: 'open', doing: 'in_progress', 'in progress': 'in_progress', wip: 'in_progress', closed: 'done', resolved: 'done', complete: 'done', completed: 'done' };
export const normalizeStatus = (s) => {
  const v = String(s ?? 'open').trim().toLowerCase();
  return STATUSES.includes(v) ? v : SYNONYMS[v] ?? v;
};
const today = () => new Date().toISOString().slice(0, 10);

export function issueSource(root, file) {
  const path = join(root, file);
  if (file.endsWith('.json')) return { kind: 'json', path };
  if (file.endsWith('.md')) return { kind: 'md', path };
  return { kind: 'dir', path };
}

// ---- issues.json --------------------------------------------------------------------------------------------------

export function parseJsonIssues(text) {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : data.issues;
  if (!Array.isArray(list)) throw new Error('issues.json must be an array or { "issues": [...] }');
  return list.map((i) => ({ ...i, id: String(i.id), status: normalizeStatus(i.status) }));
}
export function updateJsonIssues(text, id, { status, note }) {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : data.issues;
  const issue = list.find((i) => String(i.id) === String(id));
  if (!issue) throw new Error(`issue ${id} not found in issues.json`);
  if (status) issue.status = status;
  if (note) (issue.log ??= []).push(`${today()}: ${note}`);
  return JSON.stringify(data, null, 2) + '\n';
}

// ---- issues/ (front matter) ---------------------------------------------------------------------------------------

const FRONT = /^---\n([\s\S]*?)\n---\n?/;
export function parseFrontMatter(text, fallbackId) {
  const m = text.match(FRONT);
  const fields = {};
  for (const line of (m?.[1] ?? '').split('\n')) {
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim().replace(/^["']|["']$/g, '');
    if (/^\[.*\]$/.test(value)) value = value.slice(1, -1).split(',').map((v) => v.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    fields[kv[1]] = value;
  }
  const body = m ? text.slice(m[0].length) : text;
  const title = fields.title ?? body.match(/^#\s+(.+)$/m)?.[1] ?? fallbackId;
  return { ...fields, id: String(fields.id ?? fallbackId), title, status: normalizeStatus(fields.status), depends_on: fields.depends_on ?? [], body };
}
export function updateFrontMatterIssue(text, { status, note }) {
  let out = text;
  if (status) {
    const m = out.match(FRONT);
    if (!m) out = `---\nstatus: ${status}\n---\n${out}`;
    else if (/^status:.*$/m.test(m[1])) out = out.replace(FRONT, (block) => block.replace(/^status:.*$/m, `status: ${status}`));
    else out = out.replace(FRONT, (block) => block.replace(/\n---\n?$/, `\nstatus: ${status}\n---\n`));
  }
  if (note) {
    if (!/^## Log$/m.test(out)) out = out.replace(/\n*$/, '\n\n## Log\n');
    out = out.replace(/\n*$/, '\n') + `- ${today()}: ${note}\n`;
  }
  return out;
}
function dirFiles(dir) {
  return readdirSync(dir).filter((f) => f.endsWith('.md') && !/^readme\.md$/i.test(f) && statSync(join(dir, f)).isFile()).sort();
}

// ---- issues.md (sections) -----------------------------------------------------------------------------------------

// "## 12: Title", "## [AUTH-1] Title", "## #12 Title" or "## 12 — Title".
const HEADING = /^##\s+(?:\[([^\]]+)\]|#?([A-Za-z0-9._-]+)(?::|\s+[—–-])?)\s+(.*)$/;
// "Status: open", "**Status:** open" or "**Status: open**" (the colon is required, so prose about status isn't matched).
const STATUS_LINE = /^(\**\s*status\s*\**\s*:\s*\**\s*)(.+)$/i;
function sections(text) {
  const lines = text.split('\n');
  const found = [];
  lines.forEach((line, i) => {
    const m = line.match(HEADING);
    if (m) found.push({ id: m[1] ?? m[2], title: m[3].trim(), start: i });
  });
  found.forEach((s, k) => { s.end = k + 1 < found.length ? found[k + 1].start : lines.length; });
  return { lines, found };
}
export function parseMdIssues(text) {
  const { lines, found } = sections(text);
  return found.map(({ id, title, start, end }) => {
    const body = lines.slice(start + 1, end);
    const statusLine = body.find((l) => STATUS_LINE.test(l));
    const status = statusLine ? statusLine.match(STATUS_LINE)[2].replace(/\*+/g, '').trim() : 'open';
    return { id: String(id), title, status: normalizeStatus(status), body: body.join('\n').trim() };
  });
}
export function updateMdIssue(text, id, { status, note }) {
  const { lines, found } = sections(text);
  const s = found.find((x) => String(x.id) === String(id));
  if (!s) throw new Error(`issue ${id} not found in issues.md`);
  const body = lines.slice(s.start + 1, s.end);
  if (status) {
    const i = body.findIndex((l) => STATUS_LINE.test(l));
    if (i >= 0) body[i] = body[i].replace(STATUS_LINE, (_, prefix, value) => prefix + status + (value.trim().endsWith('**') ? '**' : ''));
    else body.unshift(`Status: ${status}`);
  }
  if (note) {
    let last = body.length;
    while (last > 0 && body[last - 1].trim() === '') last--;
    body.splice(last, 0, `- Log ${today()}: ${note}`);
  }
  return [...lines.slice(0, s.start + 1), ...body, ...lines.slice(s.end)].join('\n');
}

// ---- file access --------------------------------------------------------------------------------------------------

export function listIssues(source) {
  if (!existsSync(source.path)) throw new Error(`issue file ${source.path} does not exist`);
  if (source.kind === 'json') return parseJsonIssues(readFileSync(source.path, 'utf8'));
  if (source.kind === 'md') return parseMdIssues(readFileSync(source.path, 'utf8'));
  return dirFiles(source.path).map((f) => ({ ...parseFrontMatter(readFileSync(join(source.path, f), 'utf8'), basename(f, '.md')), file: f }));
}

// Changes one issue's status and/or appends a log note. Returns the file it changed (relative to the source path's
// parent) so the caller can stage it with the merge.
export function updateIssue(source, id, change) {
  if (source.kind === 'json') { writeFileSync(source.path, updateJsonIssues(readFileSync(source.path, 'utf8'), id, change)); return source.path; }
  if (source.kind === 'md') { writeFileSync(source.path, updateMdIssue(readFileSync(source.path, 'utf8'), id, change)); return source.path; }
  const issue = listIssues(source).find((i) => i.id === String(id));
  if (!issue) throw new Error(`issue ${id} not found in ${source.path}`);
  const file = join(source.path, issue.file);
  writeFileSync(file, updateFrontMatterIssue(readFileSync(file, 'utf8'), change));
  return file;
}

// ---- the tracker the crew uses -----------------------------------------------------------------------------------

// A project whose issues live anywhere else (a TODO list, a CSV, a backlog doc, a tracker export) gets a small
// adapter script written by `/crew adapt` (see templates/issues-adapter.mjs). It exports
//   listIssues(root)                 → [{ id, title, status, priority?, depends_on?, body? }]
//   updateIssue(root, id, change)    → path of the file it changed, or null when the source is read-only
// and the crew calls nothing else. Built-in formats need no adapter.
export async function issueTracker(root, issues) {
  if (issues.adapter) {
    const { pathToFileURL } = await import('node:url');
    const mod = await import(pathToFileURL(join(root, issues.adapter)).href);
    return {
      kind: `adapter ${issues.adapter}`,
      list: async () => (await mod.listIssues(root)).map(normalizeIssue),
      update: async (id, change) => (issues.writeBack === false ? null : mod.updateIssue(root, id, change)),
    };
  }
  const source = issueSource(root, issues.file);
  return {
    kind: `${source.kind} ${issues.file}`,
    list: async () => listIssues(source).map(normalizeIssue),
    update: async (id, change) => (issues.writeBack === false ? null : updateIssue(source, id, change)),
  };
}

export function normalizeIssue(i) {
  const deps = i.depends_on ?? i.dependsOn ?? [];
  return { ...i, id: String(i.id), title: String(i.title ?? '').trim(), status: normalizeStatus(i.status), depends_on: (Array.isArray(deps) ? deps : String(deps).split(',')).map((d) => String(d).trim()).filter(Boolean) };
}

// What `crew issues --check` and `crew validate` require of any tracker's output.
export function issueErrors(list) {
  const errors = [];
  const ids = new Set();
  for (const i of list) {
    if (!/^[A-Za-z0-9._#-]+$/.test(i.id)) errors.push(`issue id "${i.id}" must be letters, digits, dot, dash, underscore or #`);
    if (ids.has(i.id)) errors.push(`duplicate issue id ${i.id}`);
    ids.add(i.id);
    if (!i.title) errors.push(`issue ${i.id} has no title`);
    if (!STATUSES.includes(i.status)) errors.push(`issue ${i.id} has unknown status "${i.status}" (use ${STATUSES.join(', ')} or a synonym)`);
  }
  for (const i of list) for (const d of i.depends_on) if (!ids.has(d)) errors.push(`issue ${i.id} depends on unknown issue ${d}`);
  return errors;
}
