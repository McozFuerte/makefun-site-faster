// makefun-site-faster: a faster drop-in replacement for makefun-site 1.0.0.
//
// run(input) returns exactly the output tree makefun-site 1.0.0's build(input) returns — every path it
// writes and that file's text — but rebuilt for speed: front matter is scanned without splitting the
// body, slugs have an ASCII fast path behind a memo, Markdown is rendered in a single fused pass with
// chunked HTML escaping, and templates are parsed once per case and compiled to closures that write
// into a joined string buffer. It imports nothing and reads no clock, environment or randomness: the
// output is a function of the input alone.

// ---------------------------------------------------------------- text

const ESC_RE = /[&<>"']/;
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escChar = (c) => ESC_MAP[c];

/** `text` with & < > " and ' escaped (fast path when none are present). */
function esc(text) {
  return ESC_RE.test(text) ? text.replace(/[&<>"']/g, escChar) : text;
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/** The slug of `text`: NFKD, combining marks dropped, A-Z lowered, runs of non-alphanumerics one "-",
 *  none at either end, cut to 64 with a trailing "-" dropped, "untitled" when nothing is left. */
function slugify(text) {
  let out = '';
  let gap = false;
  // ASCII fast path: NFKD and the \p{M} strip are identity on ASCII, so the loop below is exact.
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 127) {
      ascii = false;
      break;
    }
    if (c >= 97 && c <= 122) {
      if (gap) {
        out += '-';
        gap = false;
      }
      out += String.fromCharCode(c);
    } else if (c >= 65 && c <= 90) {
      if (gap) {
        out += '-';
        gap = false;
      }
      out += String.fromCharCode(c + 32);
    } else if (c >= 48 && c <= 57) {
      if (gap) {
        out += '-';
        gap = false;
      }
      out += String.fromCharCode(c);
    } else gap = out.length > 0;
  }
  if (!ascii) {
    out = '';
    gap = false;
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const KEY_SET = new Set(KEYS);
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const FM_BLANK = /^[ \t]*$/;
const FM_RTRIM = /[ \t]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1)
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      if (!m) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      const y = Number(m[1]);
      const mo = Number(m[2]);
      const d = Number(m[3]);
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo))
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) if (t === '' || !FM_TAG.test(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
  }
  return { error: `unknown key "${key}"` };
}

/** A source's front matter and body: { data, body }, or { error }. `text` has "\n" line ends. */
function parseFrontMatter(text) {
  if (!(text.charCodeAt(0) === 45 && text.charCodeAt(1) === 45 && text.charCodeAt(2) === 45)) return { error: 'no front matter' };
  if (text.length === 3 || text.charCodeAt(3) !== 10) return { error: 'no front matter' };
  // The front matter runs to the next line that is exactly "---".
  let idx = text.indexOf('\n---', 3);
  while (idx !== -1) {
    const after = idx + 4;
    if (after === text.length || text.charCodeAt(after) === 10) break;
    idx = text.indexOf('\n---', idx + 1);
  }
  if (idx === -1) return { error: 'the front matter is not closed' };
  const lines = text.slice(4, idx).split('\n');
  const data = {};
  for (let j = 0; j < lines.length; j++) {
    const line = lines[j];
    if (FM_BLANK.test(line) || line.charCodeAt(0) === 35) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${j + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(FM_RTRIM, '');
    if (!KEY_SET.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(idx + 5) };
}

// ---------------------------------------------------------------- markdown

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const QUOTE = /^>/;
const QUOTE_STRIP = /^> ?/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;
const TRIM_LINE = /^[ \t]+|[ \t]+$/g;
const WS_RE = /\s/;
const WORDS = /\S+/g;

/** Whether a code unit is JS `\s` whitespace (exactly, for word counting). */
function isWs(c) {
  if (c === 32 || (c >= 9 && c <= 13)) return true;
  if (c === 0xa0 || c === 0x1680) return true;
  if (c >= 0x2000 && c <= 0x200a) return true;
  return c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** The reading minutes of a body: its words (runs of non-whitespace) over 200, rounded up, at least 1. */
function countWords(s) {
  let n = 0;
  const L = s.length;
  let i = 0;
  while (i < L) {
    if (isWs(s.charCodeAt(i))) i++;
    else {
      n++;
      while (i < L && !isWs(s.charCodeAt(i))) i++;
    }
  }
  return Math.max(1, Math.ceil(n / 200));
}

/** The characters a backslash escapes (checked by code). */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  if (s.indexOf('\\') === -1) return what === ']' ? s.indexOf(']', from) : s.indexOf(what, from);
  const wl = what.length;
  for (let j = from; j <= s.length - wl; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  if (s.indexOf('\\') === -1) {
    let j = s.indexOf('*', from);
    while (j !== -1 && s[j + 1] === '*') j = s.indexOf('*', j + 2);
    return j;
  }
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Markdown's inline specials (backslash, backtick, star, bracket): a string with none renders as its escaped self. */
const MD_SPECIAL = new RegExp('[`\\\\*\\[]', '');

/** `s` rendered inline into `out` (an array of strings); `link(target)` is a link's href. */
function inline(s, link, out) {
  if (!MD_SPECIAL.test(s)) {
    out.push(esc(s));
    return;
  }
  let i = 0;
  const n = s.length;
  let run = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92) {
      const nx = i + 1 < n ? s[i + 1] : '';
      if (ESCAPABLE.has(nx)) {
        if (i > run) out.push(esc(s.slice(run, i)));
        out.push(nx === '>' ? '&gt;' : nx);
        i += 2;
        run = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > run) out.push(esc(s.slice(run, i)));
        out.push('<code>', esc(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        run = i;
      } else i++;
      continue;
    }
    if (c === 42) {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > run) out.push(esc(s.slice(run, i)));
          out.push('<strong>');
          inline(s.slice(i + 2, j), link, out);
          out.push('</strong>');
          i = j + 2;
          run = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > run) out.push(esc(s.slice(run, i)));
        out.push('<em>');
        inline(s.slice(i + 1, j), link, out);
        out.push('</em>');
        i = j + 1;
        run = i;
      } else i++;
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !WS_RE.test(target)) {
        if (i > run) out.push(esc(s.slice(run, i)));
        out.push('<a href="', esc(link(target)), '">');
        inline(s.slice(i + 1, k), link, out);
        out.push('</a>');
        i = m + 1;
        run = i;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  if (n > run) out.push(esc(s.slice(run, n)));
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** A line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  const a = line.charCodeAt(0);
  const b = line.charCodeAt(line.length - 1);
  if ((a !== 32 && a !== 9) && (b !== 32 && b !== 9)) return line;
  return line.replace(TRIM_LINE, '');
}

/**
 * `src` rendered in one pass: its HTML (each block followed by "\n"), its table of contents (every
 * level 2 and 3 heading: level, id, html) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, link, slugMemo) {
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  const lines = src.split('\n');
  const L = lines.length;
  let i = 0;
  while (i < L) {
    const line = lines[i];
    const c0 = line.length === 0 ? 10 : line.charCodeAt(0);
    if (c0 === 10 || ((c0 === 32 || c0 === 9) && BLANK.test(line))) {
      i++;
      continue;
    }
    if (c0 === 96) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        i++;
        let body = '';
        while (i < L) {
          const ln = lines[i];
          if (ln.charCodeAt(0) === 96 && FENCE_CLOSE.test(ln)) break;
          body += esc(ln) + '\n';
          i++;
        }
        i++;
        out.push(fence[1] === '' ? `<pre><code>${body}</code></pre>\n` : `<pre><code class="language-${fence[1]}">${body}</code></pre>\n`);
        continue;
      }
    }
    if (c0 === 35) {
      const m = HEADING.exec(line);
      if (m !== null && m[2] !== '') {
        const depth = m[1].length;
        const id = uniqueSlug(slugMemo(m[2]), ids);
        const h = [];
        inline(m[2], link, h);
        const html = h.join('');
        out.push(`<h${depth} id="${id}">`, html, `</h${depth}>\n`);
        if (depth === 2 || depth === 3) toc.push({ level: depth, id, html });
        i++;
        continue;
      }
    }
    if (c0 === 45 || c0 === 42) {
      if (HR.test(line)) {
        out.push('<hr>\n');
        i++;
        continue;
      }
      const bullet = BULLET.exec(line);
      const ordered = bullet === null ? ORDERED.exec(line) : null;
      if (bullet !== null || ordered !== null) {
        const isOrdered = ordered !== null;
        const parts = [];
        while (i < L) {
          const m = isOrdered ? ORDERED.exec(lines[i]) : BULLET.exec(lines[i]);
          if (m !== null) {
            parts.push([trimLine(isOrdered ? m[2] : m[1])]);
            i++;
          } else if (CONTINUED.test(lines[i])) {
            parts[parts.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        const tag = isOrdered ? 'ol' : 'ul';
        const start = isOrdered && ordered[1] !== '1' ? Number(ordered[1]) : 1;
        out.push(isOrdered && start !== 1 ? `<ol start="${start}">\n` : `<${tag}>\n`);
        for (const p of parts) {
          out.push('<li>');
          inline(p.join('\n'), link, out);
          out.push('</li>\n');
        }
        out.push(`</${tag}>\n`);
        continue;
      }
    } else if (c0 >= 48 && c0 <= 57) {
      const ordered = ORDERED.exec(line);
      if (ordered !== null) {
        const parts = [];
        while (i < L) {
          const m = ORDERED.exec(lines[i]);
          if (m !== null) {
            parts.push([trimLine(m[2])]);
            i++;
          } else if (CONTINUED.test(lines[i])) {
            parts[parts.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        const start = ordered[1] !== '1' ? Number(ordered[1]) : 1;
        out.push(start !== 1 ? `<ol start="${start}">\n` : '<ol>\n');
        for (const p of parts) {
          out.push('<li>');
          inline(p.join('\n'), link, out);
          out.push('</li>\n');
        }
        out.push('</ol>\n');
        continue;
      }
    }
    if (c0 === 62) {
      if (QUOTE.test(line)) {
        const kept = [];
        while (i < L && QUOTE.test(lines[i])) {
          const t = trimLine(lines[i++].replace(QUOTE_STRIP, ''));
          if (t !== '') kept.push(t);
        }
        if (kept.length === 0) out.push('<blockquote>\n</blockquote>\n');
        else {
          out.push('<blockquote>\n<p>');
          inline(kept.join('\n'), link, out);
          out.push('</p>\n</blockquote>\n');
        }
        continue;
      }
    }
    // A paragraph: this line and the lines after it up to a blank line, a fence, a heading or a break.
    const body = [trimLine(line)];
    i++;
    for (;;) {
      if (i >= L) break;
      const ln = lines[i];
      const c = ln.length === 0 ? 10 : ln.charCodeAt(0);
      if (c === 10 || ((c === 32 || c === 9) && BLANK.test(ln))) break;
      if (c === 96 && FENCE_OPEN.test(ln)) break;
      if (c === 35 && headingOf(ln) !== null) break;
      if ((c === 45 || c === 42) && HR.test(ln)) break;
      body.push(trimLine(ln));
      i++;
    }
    const p = [];
    inline(body.join('\n'), link, p);
    const html = p.join('');
    if (excerpt === null) excerpt = html;
    out.push('<p>', html, '</p>\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if'))
          throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: first name from the nearest scope holding it, then own props. */
function lookup(scope, path) {
  let s = scope;
  const first = path[0];
  while (s !== null && !Object.hasOwn(s.vars, first)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[first];
  for (let k = 1; k < path.length; k++) {
    const nm = path[k];
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, nm)) return undefined;
    v = v[nm];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true/false, an array by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** A template's nodes compiled to one function (scope, out, depth) that appends its HTML to `out`. */
function compileNodes(nodes, templates) {
  const parts = nodes.map((n) => compileNode(n, templates));
  return (scope, out, depth) => {
    for (let k = 0; k < parts.length; k++) parts[k](scope, out, depth);
  };
}

function compileNode(n, templates) {
  switch (n.kind) {
    case 'text': {
      const t = n.text;
      return (scope, out) => {
        out.push(t);
      };
    }
    case 'var': {
      const p = n.path;
      if (p.length === 2) {
        const a = p[0];
        const b = p[1];
        return (scope, out) => {
          let s = scope;
          while (s !== null && !Object.hasOwn(s.vars, a)) s = s.parent;
          let v;
          if (s === null) v = undefined;
          else {
            const v0 = s.vars[a];
            v = v0 !== null && typeof v0 === 'object' && Object.hasOwn(v0, b) ? v0[b] : undefined;
          }
          out.push(typeof v === 'string' ? esc(v) : esc(textOf(v)));
        };
      }
      if (p.length === 1) {
        const a = p[0];
        return (scope, out) => {
          let s = scope;
          while (s !== null && !Object.hasOwn(s.vars, a)) s = s.parent;
          const v = s === null ? undefined : s.vars[a];
          out.push(typeof v === 'string' ? esc(v) : esc(textOf(v)));
        };
      }
      return (scope, out) => {
        const v = lookup(scope, p);
        out.push(typeof v === 'string' ? esc(v) : esc(textOf(v)));
      };
    }
    case 'raw': {
      const p = n.path;
      if (p.length === 2) {
        const a = p[0];
        const b = p[1];
        return (scope, out) => {
          let s = scope;
          while (s !== null && !Object.hasOwn(s.vars, a)) s = s.parent;
          let v;
          if (s === null) v = undefined;
          else {
            const v0 = s.vars[a];
            v = v0 !== null && typeof v0 === 'object' && Object.hasOwn(v0, b) ? v0[b] : undefined;
          }
          out.push(textOf(v));
        };
      }
      if (p.length === 1) {
        const a = p[0];
        return (scope, out) => {
          let s = scope;
          while (s !== null && !Object.hasOwn(s.vars, a)) s = s.parent;
          out.push(textOf(s === null ? undefined : s.vars[a]));
        };
      }
      return (scope, out) => {
        out.push(textOf(lookup(scope, p)));
      };
    }
    case 'if': {
      const thenFn = compileNodes(n.then, templates);
      const elseFn = n.else === null ? null : compileNodes(n.else, templates);
      const p = n.path;
      const not = n.not;
      return (scope, out, depth) => {
        const v = truthy(lookup(scope, p));
        const fn = v !== not ? thenFn : elseFn;
        if (fn !== null) fn(scope, out, depth);
      };
    }
    case 'for': {
      const bodyFn = compileNodes(n.body, templates);
      const name = n.name;
      const p = n.path;
      return (scope, out, depth) => {
        const xs = lookup(scope, p);
        if (!Array.isArray(xs)) return;
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          bodyFn({ vars: { [name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len } }, parent: scope }, out, depth);
        }
      };
    }
    case 'include': {
      const nm = n.name;
      return (scope, out, depth) => {
        const t = templates.get(nm);
        if (t === undefined || depth >= INCLUDE_DEPTH) return;
        if (t.fn === undefined) t.fn = compileNodes(t.nodes, templates);
        t.fn(scope, out, depth + 1);
      };
    }
  }
}

// ---------------------------------------------------------------- the build

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out. */
function resolvePath(dir, rel) {
  // Fast path: no empty, "." or ".." segment, so the resolved path is dir + "/" + rel verbatim.
  const c0 = rel.charCodeAt(0);
  if (c0 !== 46 && c0 !== 47 && rel.charCodeAt(rel.length - 1) !== 47 && rel.indexOf('/.') === -1 && rel.indexOf('//') === -1) {
    return dir === '' ? rel : dir + '/' + rel;
  }
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const CRLF = /\r\n?/g;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const TRAILING_SLASH = /\/+$/;

/** One site's output tree: path -> text, exactly makefun-site 1.0.0's. */
export function run(input) {
  // The slug and long-date memos, shared across this one case.
  const slugCache = new Map();
  const slugMemo = (text) => {
    const hit = slugCache.get(text);
    if (hit !== undefined) return hit;
    const s = slugify(text);
    slugCache.set(text, s);
    return s;
  };
  const dateCache = new Map();
  const longMemo = (date) => {
    const hit = dateCache.get(date);
    if (hit !== undefined) return hit;
    const s = longDate(date);
    dateCache.set(date, s);
    return s;
  };

  // 1. Templates, parsed (and later compiled) in code-unit order of their names.
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort()) {
    try {
      templates.set(name, { nodes: parseTemplate(name, input.templates[name]), fn: undefined });
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(TRAILING_SLASH, '');

  // 2. The sources, in code-unit order of their paths.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(CRLF, '\n'), data: null, body: '', post: false, layout: '', slug: '', outDir: '', url: '', html: '', toc: null, excerpt: '', newer: null, older: null, tagRefs: null, reading: 1 });
    else statics.push(f);
  }

  // 3. Front matter, refusals and drafts.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 4. Permalinks.
  const takenRoot = new Set(['posts', 'tags', 'page']);
  const takenIn = new Map();
  takenIn.set('', takenRoot);
  const takenPosts = new Set();
  takenIn.set('posts', takenPosts);
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = takenIn.get(dir);
    if (set === undefined) {
      set = new Set();
      takenIn.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugMemo(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 5. Markdown, its links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if ((target.indexOf(':') !== -1 && SCHEME.test(target)) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null) {
        const t = bySource.get(path);
        if (t !== undefined) return `${t.url}${frag}`;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link, slugMemo);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.reading = countWords(s.body);
  }

  // 6. The posts, newest first and then by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 7. The tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const names = s.data.tags ?? [];
    const seen = new Set();
    const out = [];
    for (const name of names) {
      const slug = slugMemo(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugMemo(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugMemo(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 8. Layouts.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longMemo(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.reading,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const linkOf = (s) =>
    s === null
      ? null
      : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longMemo(s.data.date) };
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));

  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));

  const render = (name, vars) => {
    const t = templates.get(name);
    if (t === undefined) return null;
    const out = [];
    if (t.fn === undefined) t.fn = compileNodes(t.nodes, templates);
    t.fn({ vars: { site, tags: allTags, recent, ...vars }, parent: null }, out, 0);
    return out.join('');
  };

  const output = {};
  for (const s of kept)
    output[s.outDir + '/index.html'] = render(s.layout, {
      page: {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longMemo(s.data.date),
        summary: s.data.summary ?? '',
        excerpt: s.excerpt,
        reading_minutes: s.reading,
        tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
        slug: s.slug,
        content: s.html,
        toc: s.toc,
        newer: linkOf(s.newer ?? null),
        older: linkOf(s.older ?? null),
        is_post: s.post,
      },
    });

  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  {
    const html = render('tags', {});
    if (html !== null) output['tags/index.html'] = html;
  }
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 9. The report.
  const lines = [...report, ...broken].sort();
  let pagesCount = 0;
  for (const s of kept) if (!s.post) pagesCount++;
  lines.push(`built ${pagesCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;

  return output;
}
