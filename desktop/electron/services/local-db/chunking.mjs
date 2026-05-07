/**
 * Semantic chunking — port of cloud's strategy ("semantic-512" with
 * 64-token overlap). We can't rely on the same tokenizer in JS, so
 * approximate by character count: 1 token ≈ 4 chars for English,
 * ≈ 1 char for CJK. The chars-per-token heuristic is good enough for
 * chunking decisions; the LLM never sees this estimation.
 *
 * Strategy:
 *   1) Try splitting on H1/H2 headings (preserves chapter integrity)
 *   2) Within each section, split on blank-line paragraphs
 *   3) If a paragraph is too large, fall back to sentence splits
 *   4) Sliding-window-pack into ~512-token chunks with 64-token overlap
 *
 * Exposes: chunk(text) → [{ ord, content, line_start, line_end }]
 */

const TARGET_TOKENS = 512;
const OVERLAP_TOKENS = 64;
// chars-per-token (mixed-language heuristic). Smaller = more
// conservative chunking (more / smaller chunks). 3 errs toward
// smaller.
const CHARS_PER_TOKEN = 3;

const TARGET_CHARS  = TARGET_TOKENS  * CHARS_PER_TOKEN;
const OVERLAP_CHARS = OVERLAP_TOKENS * CHARS_PER_TOKEN;

export function chunk(text) {
  if (!text) return [];
  const lines = text.split("\n");
  const blocks = _splitByHeadingsThenParagraphs(lines);
  const chunks = _packBlocks(blocks);
  return chunks.map((c, i) => ({ ord: i, ...c }));
}

function _splitByHeadingsThenParagraphs(lines) {
  // Each block = { content, line_start, line_end }. Hard-break on
  // H1/H2; soft-break (blank line) inside.
  const out = [];
  let cur = { content: "", line_start: 0, line_end: 0 };
  let started = false;

  function flush() {
    if (cur.content.trim()) out.push({ ...cur });
    cur = { content: "", line_start: 0, line_end: 0 };
    started = false;
  }

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const isHeading = /^#{1,2}\s/.test(ln);
    if (isHeading && started) {
      flush();
    }
    if (!started) {
      cur.line_start = i;
      started = true;
    }
    cur.content += (cur.content ? "\n" : "") + ln;
    cur.line_end = i;
  }
  flush();

  // Soft-break very long blocks on paragraph boundaries.
  const refined = [];
  for (const b of out) {
    if (b.content.length <= TARGET_CHARS) {
      refined.push(b);
      continue;
    }
    const paras = b.content.split(/\n\s*\n+/);
    let lineCursor = b.line_start;
    let acc = "";
    let accStart = lineCursor;
    for (const p of paras) {
      if (acc && (acc.length + p.length + 2) > TARGET_CHARS) {
        const accLines = acc.split("\n").length;
        refined.push({
          content: acc,
          line_start: accStart,
          line_end: accStart + accLines - 1,
        });
        accStart = accStart + accLines + 1;
        acc = "";
      }
      acc = acc ? acc + "\n\n" + p : p;
    }
    if (acc) {
      const accLines = acc.split("\n").length;
      refined.push({
        content: acc,
        line_start: accStart,
        line_end: accStart + accLines - 1,
      });
    }
  }
  return refined;
}

function _packBlocks(blocks) {
  // Sliding-window pack: combine small blocks until close to
  // TARGET_CHARS. Larger ones pass through; sub-paragraph splitting
  // handled by _splitByHeadingsThenParagraphs already.
  const out = [];
  let cur = null;
  for (const b of blocks) {
    if (b.content.length > TARGET_CHARS) {
      // Standalone big block — possibly fall back to sentence split
      const subs = _sentenceSplit(b);
      for (const s of subs) out.push(s);
      cur = null;
      continue;
    }
    if (!cur) {
      cur = { ...b };
      continue;
    }
    if ((cur.content.length + 2 + b.content.length) <= TARGET_CHARS) {
      cur.content += "\n\n" + b.content;
      cur.line_end = b.line_end;
    } else {
      out.push(cur);
      // Overlap by tail of previous chunk so context isn't sliced.
      const tail = cur.content.slice(-OVERLAP_CHARS);
      cur = {
        content: tail + (tail ? "\n\n" : "") + b.content,
        line_start: b.line_start,
        line_end: b.line_end,
      };
    }
  }
  if (cur) out.push(cur);
  return out;
}

function _sentenceSplit(block) {
  // Naive but dependable: split on `.?!。?！` followed by space/EOL.
  // Pack sentences up to TARGET_CHARS.
  const sentences = block.content.split(/(?<=[\.?!。？！])\s+/);
  const packed = [];
  let cur = { content: "", line_start: block.line_start, line_end: block.line_end };
  for (const s of sentences) {
    if (cur.content && (cur.content.length + s.length + 1) > TARGET_CHARS) {
      packed.push(cur);
      cur = { content: s, line_start: block.line_start, line_end: block.line_end };
    } else {
      cur.content = cur.content ? cur.content + " " + s : s;
    }
  }
  if (cur.content) packed.push(cur);
  return packed;
}
