// Crew issue adapter: a template that `/crew adapt` copies to `.claude/crew/issues-adapter.mjs` and rewrites for this
// project when its issues live somewhere the built-in readers don't cover (issues.json, issues/, issues.md).
//
// Contract (keep it deterministic: plain parsing, no network, no model calls):
//   listIssues(root)              → [{ id, title, status, priority?, depends_on?, body? }]
//       id      stable and unique; letters, digits, . _ - #
//       status  open | in_progress | done (synonyms like todo/doing/closed are accepted)
//   updateIssue(root, id, change) → absolute path of the file it changed, or null if the source is read-only
//       change  { status?: 'open' | 'in_progress' | 'done', note?: string }
//       Change only that issue's status and add the note; leave everything else exactly as written.
//
// This example reads a checklist in TODO.md:
//   - [ ] #12 Add CSV export (depends: #9)
//   - [x] #9 Store exports in S3
// "[ ]" is open, "[~]" in progress, "[x]" done. Notes are appended as indented sub-bullets.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE = 'TODO.md';
const LINE = /^(\s*[-*]\s+\[)([ x~])(\]\s+#?([A-Za-z0-9._-]+)\s+)(.*)$/;
const STATUS = { ' ': 'open', '~': 'in_progress', x: 'done' };
const MARK = { open: ' ', in_progress: '~', done: 'x' };

export function listIssues(root) {
  return readFileSync(join(root, FILE), 'utf8').split('\n').flatMap((line) => {
    const m = line.match(LINE);
    if (!m) return [];
    const deps = m[5].match(/\(depends:\s*([^)]+)\)/)?.[1] ?? '';
    return [{
      id: m[4],
      title: m[5].replace(/\s*\(depends:[^)]*\)/, '').trim(),
      status: STATUS[m[2]],
      depends_on: deps.split(',').map((d) => d.trim().replace(/^#/, '')).filter(Boolean),
    }];
  });
}

export function updateIssue(root, id, { status, note }) {
  const path = join(root, FILE);
  const lines = readFileSync(path, 'utf8').split('\n');
  const i = lines.findIndex((l) => l.match(LINE)?.[4] === String(id));
  if (i < 0) throw new Error(`issue ${id} not found in ${FILE}`);
  if (status) lines[i] = lines[i].replace(LINE, (_, a, _mark, b, _id, rest) => `${a}${MARK[status]}${b}${rest}`);
  if (note) {
    // Append after this item's existing sub-bullets so notes read oldest first.
    const indent = lines[i].match(/^\s*/)[0];
    let end = i + 1;
    while (end < lines.length && lines[end].startsWith(`${indent}  `) && lines[end].trim()) end++;
    lines.splice(end, 0, `${indent}  - ${new Date().toISOString().slice(0, 10)}: ${note}`);
  }
  writeFileSync(path, lines.join('\n'));
  return path;
}
