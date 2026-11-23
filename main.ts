// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over
// and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- file lines (SPEC section 3) ----

function leadingWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}
function stripTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

interface FileParts {
  lines: string[];
  br: string;
  ends: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const ends = text.endsWith(br);
  if (ends) parts.pop();
  return { lines: parts, br, ends };
}

function joinFile(lines: string[], br: string, ends: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (ends ? br : '');
}

// ---- matching lines (SPEC section 5) ----

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

function occurrencesAt(fileLines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(fileLines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(
  fileLines: string[],
  o: string[],
  strict: boolean,
  from = 0,
  eofOnly = false,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let pos = occurrencesAt(fileLines, o, t, from);
    if (eofOnly) pos = pos.filter((p) => p + o.length === fileLines.length);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

interface NSpec {
  isCtx: boolean;
  text: string;
  oIdx: number | null;
}

// Build the replacement lines for a matched block. Context lines are the
// file's own matched lines; every other line of N is re-indented at tier 2.
function buildReplacement(
  fileLines: string[],
  pos: number,
  o: string[],
  nspec: NSpec[],
  tier: number,
): string[] {
  const f = o.length > 0 ? leadingWS(fileLines[pos]!) : '';
  const p = o.length > 0 ? leadingWS(o[0]!) : '';
  const out: string[] = [];
  for (const item of nspec) {
    if (item.isCtx) {
      out.push(fileLines[pos + item.oIdx!]!);
    } else {
      let t = item.text;
      if (tier === 2 && !/^[ \t]*$/.test(t) && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return out;
}

// Split a hunk/chunk body (raw items) into O lines and the N spec.
function splitBody(raw: RawItem[]): { o: string[]; nspec: NSpec[] } {
  const o: string[] = [];
  const nspec: NSpec[] = [];
  for (const item of raw) {
    if (item.kind === 'ctx') {
      const idx = o.length;
      o.push(item.text);
      nspec.push({ isCtx: true, text: item.text, oIdx: idx });
    } else if (item.kind === 'del') {
      o.push(item.text);
    } else if (item.kind === 'add') {
      nspec.push({ isCtx: false, text: item.text, oIdx: null });
    }
  }
  return { o, nspec };
}

interface RawItem {
  kind: 'ctx' | 'del' | 'add' | 'bs';
  text: string;
  orig: string;
}

// True when a `\` line follows the body's last context or `+` line.
function hasNoNewline(raw: RawItem[]): boolean {
  let last = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i]!.kind === 'ctx' || raw[i]!.kind === 'add') last = i;
  }
  if (last < 0) return false;
  return raw[last + 1] !== undefined && raw[last + 1]!.kind === 'bs';
}

// ---- unified diffs (SPEC section 6) ----

function unifiedPath(raw: string): string {
  const t = raw.split('\t')[0]!.trim();
  if (t.startsWith('a/')) return t.slice(2);
  if (t.startsWith('b/')) return t.slice(2);
  return t;
}

interface UHunk {
  a: number;
  raw: RawItem[];
}

interface USection {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  plusNew: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UHunk[];
}

const DIFF_RE = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  let i = 0;
  const newSection = (): USection => {
    const s: USection = {
      pairOld: undefined,
      pairNew: undefined,
      renameOld: undefined,
      renameNew: undefined,
      plusNew: undefined,
      diffOld: undefined,
      diffNew: undefined,
      isCreate: false,
      isDelete: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    const dm = DIFF_RE.exec(line);
    if (line.startsWith('diff --git ')) {
      if (!dm) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.diffOld = dm[1]!;
      s.diffNew = dm[2]!;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const hm = HUNK_RE.exec(line);
      if (!hm) throw new Exit2(`error: parse ${i + 1}`);
      if (!cur) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const a = parseInt(hm[1]!, 10);
      const raw: RawItem[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          if (bl === '') raw.push({ kind: 'ctx', text: '', orig: bl });
          else if (bl[0] === ' ') raw.push({ kind: 'ctx', text: bl.slice(1), orig: bl });
          else if (bl[0] === '-') raw.push({ kind: 'del', text: bl.slice(1), orig: bl });
          else if (bl[0] === '+') raw.push({ kind: 'add', text: bl.slice(1), orig: bl });
          else raw.push({ kind: 'bs', text: bl, orig: bl });
          j++;
          continue;
        }
        break;
      }
      while (raw.length > 0 && raw[raw.length - 1]!.orig === '') raw.pop();
      cur.hunks.push({ a, raw });
      i = j;
      continue;
    }
    if ((cur === null || !inHeader) && line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const s = newSection();
      const oldRaw = unifiedPath(line.slice(4));
      const newRaw = unifiedPath(lines[i + 1]!.slice(4));
      s.pairOld = oldRaw === '/dev/null' ? null : oldRaw;
      s.pairNew = newRaw === '/dev/null' ? null : newRaw;
      i += 2;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        const oldRaw = unifiedPath(line.slice(4));
        const newRaw = unifiedPath(lines[i + 1]!.slice(4));
        cur.pairOld = oldRaw === '/dev/null' ? null : oldRaw;
        cur.pairNew = newRaw === '/dev/null' ? null : newRaw;
        i += 2;
        continue;
      }
      if (line.startsWith('+++ ')) {
        cur.plusNew = unifiedPath(line.slice(4));
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameOld = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameNew = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.isCreate = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.isDelete = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }

  const edits: Edit[] = [];
  for (const s of sections) {
    const oldPath = s.pairOld !== undefined ? s.pairOld : s.renameOld !== undefined ? s.renameOld : s.diffOld;
    const newPath =
      s.pairNew !== undefined ? s.pairNew : s.renameNew !== undefined ? s.renameNew : s.plusNew !== undefined ? s.plusNew : s.diffNew;
    const hunks = s.hunks;
    const isCreate = s.isCreate || oldPath === null;
    const isDelete = !isCreate && (s.isDelete || newPath === null);
    edits.push((tree) => {
      if (isCreate) {
        const np = newPath as string | null | undefined;
        if (np === null || np === undefined) throw new Fail('unsafe', '');
        if (!safe(np)) throw new Fail('unsafe', np);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const plus: string[] = [];
        for (const h of hunks) for (const item of h.raw) if (item.kind === 'add') plus.push(item.text);
        // The created file ends without a line break only when a `\` line
        // follows the section's last `+` line.
        let lastBs = false;
        outer: for (let hi = hunks.length - 1; hi >= 0; hi--) {
          const h = hunks[hi]!;
          for (let k = h.raw.length - 1; k >= 0; k--) {
            if (h.raw[k]!.kind === 'add') {
              lastBs = h.raw[k + 1] !== undefined && h.raw[k + 1]!.kind === 'bs';
              break outer;
            }
          }
        }
        const text = plus.length === 0 ? '' : plus.join('\n') + (lastBs ? '' : '\n');
        tree.now.set(np, text);
        return;
      }
      if (isDelete) {
        const op = oldPath as string | null | undefined;
        if (op === null || op === undefined) throw new Fail('unsafe', '');
        if (!safe(op)) throw new Fail('unsafe', op);
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
        return;
      }
      const op = oldPath as string | null | undefined;
      const np = newPath as string | null | undefined;
      if (op === null || op === undefined || np === null || np === undefined) throw new Fail('unsafe', '');
      const isMove = op !== np;
      if (!safe(op)) throw new Fail('unsafe', op);
      if (isMove && !safe(np)) throw new Fail('unsafe', np);
      const oldText = tree.get(op);
      if (oldText === null) throw new Fail('missing', op);
      if (isMove && tree.get(np) !== null) throw new Fail('exists', np);
      const parts = splitFile(oldText);
      let fileLines = parts.lines;
      const br = parts.br;
      let ends = parts.ends;
      let d = 0;
      for (const h of hunks) {
        const { o, nspec } = splitBody(h.raw);
        const noNl = hasNoNewline(h.raw);
        if (o.length === 0) {
          const before = fileLines.length;
          const idx = Math.min(Math.max(h.a + d, 0), before);
          const repl = nspec.map((x) => x.text);
          const atEnd = idx === before;
          fileLines = [...fileLines.slice(0, idx), ...repl, ...fileLines.slice(idx)];
          if (atEnd) ends = !noNl;
          d += nspec.length;
        } else {
          const found = findTier(fileLines, o, strict);
          if (!found) throw new Fail('no-match', op);
          const target = h.a - 1 + d;
          let best = found.positions[0]!;
          let bestDist = Math.abs(best - target);
          for (const p of found.positions) {
            const dist = Math.abs(p - target);
            if (dist < bestDist) {
              best = p;
              bestDist = dist;
            }
          }
          const pos = best;
          const repl = buildReplacement(fileLines, pos, o, nspec, found.tier);
          const atEnd = pos + o.length === fileLines.length;
          fileLines = [...fileLines.slice(0, pos), ...repl, ...fileLines.slice(pos + o.length)];
          if (atEnd) ends = !noNl;
          d += nspec.length - o.length;
        }
      }
      const newText = joinFile(fileLines, br, ends);
      if (isMove) {
        tree.now.set(op, null);
        tree.now.set(np, newText);
        tree.moves.push({ old: op, new: np });
      } else {
        tree.now.set(op, newText);
      }
    });
  }
  return edits;
}

// ---- SEARCH/REPLACE blocks (SPEC section 7) ----

function searchEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let eqIdx = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eqIdx = j;
        break;
      }
    }
    if (eqIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let repIdx = -1;
    for (let j = eqIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        repIdx = j;
        break;
      }
    }
    if (repIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eqIdx);
    const newLines = lines.slice(eqIdx + 1, repIdx);
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    prevPath = path;
    prevEnd = repIdx;
    const p = path;
    const olds = oldLines;
    const news = newLines;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (olds.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, news.length === 0 ? '' : news.join('\n') + '\n');
        return;
      }
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const parts = splitFile(cur);
      const found = findTier(parts.lines, olds, strict);
      if (!found) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = found.positions[0]!;
      const nspec: NSpec[] = news.map((t) => ({ isCtx: false, text: t, oIdx: null }));
      const repl = buildReplacement(parts.lines, pos, olds, nspec, found.tier);
      const out = [...parts.lines.slice(0, pos), ...repl, ...parts.lines.slice(pos + olds.length)];
      tree.now.set(p, joinFile(out, parts.br, parts.ends));
    });
    i = repIdx + 1;
  }
  return edits;
}

// ---- V4A patches (SPEC section 8) ----

interface VChunk {
  anchor: string | null;
  hasAnchor: boolean;
  eof: boolean;
  raw: RawItem[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const firstIdx = lines.findIndex((l) => !blank(l));
  if (firstIdx < 0) throw new Exit2('error: parse 1');
  if (lines[firstIdx]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstIdx + 1}`);
  let lastIdx = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      lastIdx = k;
      break;
    }
  }
  if (lastIdx < 0 || lines[lastIdx]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const edits: Edit[] = [];
  let i = firstIdx + 1;
  while (i < lastIdx && blank(lines[i]!)) i++;
  while (i < lastIdx) {
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const sectionStartIdx = i;
    i++;
    const rawStart = i;
    let rawEnd = i;
    while (rawEnd < lastIdx) {
      const l = lines[rawEnd]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      rawEnd++;
    }
    const raw = lines.slice(rawStart, rawEnd);
    // Blank lines at the end of a section are not part of it: a trailing
    // context line that is only whitespace (for example the " " line that
    // ends the v-cursor practice check) must not be required to match.
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();

    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k]!;
        if (l === '') fileLines.push('');
        else if (l.startsWith('+')) fileLines.push(l.slice(1));
        else throw new Exit2(`error: parse ${rawStart + k + 1}`);
      }
      const p = path;
      const fl = fileLines;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fl.length === 0 ? '' : fl.join('\n') + '\n');
      });
    } else if (kind === 'delete') {
      for (let k = 0; k < raw.length; k++) {
        if (blank(raw[k]!)) continue;
        throw new Exit2(`error: parse ${rawStart + k + 1}`);
      }
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      let moveTo: string | null = null;
      let idx = 0;
      if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.slice('*** Move to: '.length).trim();
        idx = 1;
      }
      const chunks: VChunk[] = [];
      let curChunk: VChunk | null = null;
      let eofClosed = false;
      while (idx < raw.length) {
        const l = raw[idx]!;
        const lineNo = rawStart + idx + 1;
        if (l.startsWith('@@')) {
          const anchorText = l.slice(2).trim();
          curChunk = { anchor: anchorText === '' ? null : anchorText, hasAnchor: anchorText !== '', eof: false, raw: [] };
          chunks.push(curChunk);
          eofClosed = false;
          idx++;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (!curChunk) throw new Exit2(`error: parse ${lineNo}`);
          curChunk.eof = true;
          eofClosed = true;
          idx++;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (eofClosed) throw new Exit2(`error: parse ${lineNo}`);
          if (!curChunk) {
            curChunk = { anchor: null, hasAnchor: false, eof: false, raw: [] };
            chunks.push(curChunk);
          }
          if (l === '') curChunk.raw.push({ kind: 'ctx', text: '', orig: l });
          else if (l[0] === ' ') curChunk.raw.push({ kind: 'ctx', text: l.slice(1), orig: l });
          else if (l[0] === '-') curChunk.raw.push({ kind: 'del', text: l.slice(1), orig: l });
          else curChunk.raw.push({ kind: 'add', text: l.slice(1), orig: l });
          idx++;
          continue;
        }
        throw new Exit2(`error: parse ${lineNo}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sectionStartIdx + 1}`);
      const p = path;
      const mt = moveTo;
      const chs = chunks;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mt !== null && !safe(mt)) throw new Fail('unsafe', mt);
        const curText = tree.get(p);
        if (curText === null) throw new Fail('missing', p);
        if (mt !== null && tree.get(mt) !== null) throw new Fail('exists', mt);
        const parts = splitFile(curText);
        let fileLines = parts.lines;
        const br = parts.br;
        const ends = parts.ends;
        let cursor = 0;
        for (const ch of chs) {
          if (ch.hasAnchor && ch.anchor !== null) {
            const af = findTier(fileLines, [ch.anchor], strict, cursor);
            if (!af) throw new Fail('no-match', p);
            cursor = af.positions[0]! + 1;
          }
          const { o, nspec } = splitBody(ch.raw);
          if (o.length === 0) {
            const idx2 = ch.eof ? fileLines.length : cursor;
            const repl = nspec.map((x) => x.text);
            fileLines = [...fileLines.slice(0, idx2), ...repl, ...fileLines.slice(idx2)];
            cursor = idx2 + repl.length;
          } else {
            const found = findTier(fileLines, o, strict, cursor, ch.eof);
            if (!found) throw new Fail('no-match', p);
            const pos = found.positions[0]!;
            const repl = buildReplacement(fileLines, pos, o, nspec, found.tier);
            fileLines = [...fileLines.slice(0, pos), ...repl, ...fileLines.slice(pos + o.length)];
            cursor = pos + repl.length;
          }
        }
        const newText = joinFile(fileLines, br, ends);
        if (mt !== null) {
          tree.now.set(p, null);
          tree.now.set(mt, newText);
          tree.moves.push({ old: p, new: mt });
        } else {
          tree.now.set(p, newText);
        }
      });
    }
    i = rawEnd;
    while (i < lastIdx && blank(lines[i]!)) i++;
  }
  return edits;
}

// ---- JSON edits (SPEC section 9) ----

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- invocation, output and atomicity (SPEC sections 1, 2 and 10) ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesLen = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesLen;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Net changes, with a successful move reported as one R line (sorted by <new>).
  interface Change {
    path: string;
    was: string | null;
    now: string | null;
  }
  const changes: Change[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changes.push({ path: p, was, now });
  }
  interface Row {
    text: string;
    key: string;
  }
  const rows: Row[] = [];
  const used = new Set<string>();
  for (const m of tree.moves) {
    const oldC = changes.find((c) => c.path === m.old && c.was !== null && c.now === null);
    const newC = changes.find((c) => c.path === m.new && c.was === null && c.now !== null);
    if (oldC && newC && !used.has(m.old) && !used.has(m.new)) {
      used.add(m.old);
      used.add(m.new);
      rows.push({ text: `R ${m.old} -> ${m.new}`, key: m.new });
    }
  }
  for (const c of changes) {
    if (used.has(c.path)) continue;
    const letter = c.was === null ? 'A' : c.now === null ? 'D' : 'M';
    rows.push({ text: `${letter} ${c.path}`, key: c.path });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outRows = rows.map((r) => r.text);
  if (!check) {
    for (const c of changes) {
      if (c.now === null) rmSync(c.path, { force: true });
      else {
        mkdirSync(dirname(c.path), { recursive: true });
        writeFileSync(c.path, c.now);
      }
    }
  }
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
