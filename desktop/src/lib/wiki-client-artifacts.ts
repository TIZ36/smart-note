import { aiChat } from "./electron";
import * as cloudApi from "./cloud-api";

type Chapter = cloudApi.WikiChapterArtifact & { text: string };

const ATX_H2 = /^##\s+(.+?)\s*#*\s*$/;
const SETEXT_H2 = /^-{3,}\s*$/;
const SETEXT_H1 = /^={3,}\s*$/;
const FENCE = /^(?<fence>(?:```+|~~~+))\s*[^\s`]*\s*$/;
const INDENTED = /^(?: {4,}|\t)/;

function slugify(title: string): string {
  const base = title
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af-]+/gu, "-")
    .replace(/[-\s]+/g, "-")
    .replace(/^-|-$/g, "");
  return base || "section";
}

function contentSha(content: string): string {
  // Browser-safe SHA-256 wrapper; caller awaits via async helper below.
  return content;
}

async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function canonicalSha(text: string): Promise<string> {
  const canonical = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  return sha256(canonical);
}

export function splitWikiChapters(content: string): Chapter[] {
  if (!content) return [];
  const text = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = text.split("\n");
  const boundaries: { index: number; title: string }[] = [];
  let inFence = false;
  let fenceMarker = "";

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (inFence) {
      if (line.trimStart().startsWith(fenceMarker)) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }
    const open = FENCE.exec(line);
    if (open?.groups?.fence) {
      inFence = true;
      fenceMarker = open.groups.fence;
      continue;
    }
    if (INDENTED.test(line)) continue;
    const atx = ATX_H2.exec(line);
    if (atx) {
      boundaries.push({ index: i, title: atx[1].trim() });
      continue;
    }
    const next = lines[i + 1] || "";
    if (SETEXT_H2.test(next) && line.trim() && !ATX_H2.test(line)) {
      boundaries.push({ index: i, title: line.trim() });
      i += 1;
      continue;
    }
    if (SETEXT_H1.test(next) && line.trim()) i += 1;
  }

  const seen = new Map<string, number>();
  const nextAnchor = (title: string) => {
    const base = slugify(title);
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };
  const out: Chapter[] = [];
  const push = (title: string, start: number, end: number) => {
    const body = lines.slice(start, end + 1).join("\n");
    if (!body.trim()) return;
    out.push({
      ord: out.length,
      level: 2,
      anchor: nextAnchor(title),
      title,
      line_start: start + 1,
      line_end: Math.max(start + 1, end + 1),
      text: body,
      summary: "",
      keywords: [],
      entities: [],
    });
  };

  if (boundaries.length === 0) {
    const title = lines.find((ln) => ln.trim())?.trim() || "preamble";
    push(title, 0, Math.max(0, lines.length - 1));
    return out;
  }
  const first = boundaries[0].index;
  if (lines.slice(0, first).some((ln) => ln.trim())) push("preamble", 0, first - 1);
  for (let i = 0; i < boundaries.length; i += 1) {
    const cur = boundaries[i];
    const end = i + 1 < boundaries.length ? boundaries[i + 1].index - 1 : lines.length - 1;
    push(cur.title, cur.index, end);
  }
  return out;
}

function cleanSummary(raw: string): string {
  return raw
    .replace(/^```\w*\s*/, "")
    .replace(/```$/g, "")
    .replace(/^summary\s*[:：]\s*/i, "")
    .trim()
    .slice(0, 2000);
}

function fallbackSummary(text: string): string {
  const lines = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^#{1,6}\s+/.test(line));
  const joined = lines.slice(0, 5).join(" ").trim();
  return (joined || text.trim() || "No summary available.").slice(0, 2000);
}

function parseJsonObject(raw: unknown): { summary?: string; keywords?: unknown[]; entities?: unknown[] } {
  let s = String(raw || "").trim();
  if (!s) return {};
  if (s.startsWith("```")) {
    s = s.replace(/^```\w*\s*/, "").replace(/```$/, "").trim();
  }
  try {
    const parsed = JSON.parse(s);
    if (!parsed || typeof parsed !== "object") return { summary: cleanSummary(s) };
    const obj = parsed as Record<string, unknown>;
    return {
      ...obj,
      summary: String(obj.summary || obj.content || obj.text || obj.answer || ""),
    };
  } catch {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(s.slice(start, end + 1)); } catch {}
    }
  }
  return { summary: cleanSummary(s) };
}

async function summarizeChapter(ch: Chapter): Promise<Chapter> {
  const system = [
    "You summarize one section of a knowledge-base wiki for storage as an abstract sheet.",
    "Write in the same language as the section text.",
    "Output ONLY valid JSON with schema:",
    '{"summary":"1 to 3 sentences","keywords":["..."],"entities":[{"name":"...","type":"concept|tool|person|product|other"}]}',
  ].join("\n");
  const user = `Section title: ${ch.title}\n\nSection text:\n${ch.text.slice(0, 12000)}`;
  const res = await aiChat({ system, user, temperature: 0.1, max_tokens: 1200 });
  const parsed = parseJsonObject(res.content);
  const summary = String(parsed.summary || "").trim().slice(0, 2000) || fallbackSummary(ch.text);
  return {
    ...ch,
    summary,
    keywords: (Array.isArray(parsed.keywords) ? parsed.keywords : [])
      .map((k) => String(k).trim())
      .filter(Boolean)
      .slice(0, 32),
    entities: (Array.isArray(parsed.entities) ? parsed.entities : [])
      .filter((e): e is Record<string, unknown> => (
        !!e && typeof e === "object" && !!(e as Record<string, unknown>).name
      ))
      .map((e) => ({ name: String(e.name), type: String(e.type || "concept") }))
      .slice(0, 32),
    summary_sha: await canonicalSha(ch.text),
  };
}

export async function buildWikiAbstractClient(
  documentId: string,
  opts: {
    force?: boolean;
    onProgress?: (p: { phase: string; done: number; total: number; title?: string }) => void;
  } = {},
): Promise<{ chapters: number; summarized: number; reused: number }> {
  const doc = await cloudApi.getDocument(documentId);
  const baseContentSha = await sha256(contentSha(doc.content || ""));
  const existing = await cloudApi.getDocumentKn(documentId).catch(() => null);
  const existingByOrd = new Map((existing?.wiki_chapters || []).map((ch) => [ch.ord, ch]));
  const chapters = splitWikiChapters(doc.content || "");
  const total = chapters.length;
  let done = 0;
  let summarized = 0;
  let reused = 0;
  const out: cloudApi.WikiChapterArtifact[] = [];

  for (const ch of chapters) {
    const sha = await canonicalSha(ch.text);
    const prior = existingByOrd.get(ch.ord);
    const canReuse = !opts.force && prior?.summary && prior.summary_sha === sha;
    if (canReuse) {
      reused += 1;
      done += 1;
      out.push({ ...ch, summary: prior.summary, keywords: prior.keywords || [], entities: [], summary_sha: sha });
      opts.onProgress?.({ phase: "reused", done, total, title: ch.title });
      continue;
    }
    opts.onProgress?.({ phase: "summarizing", done, total, title: ch.title });
    const summarizedChapter = await summarizeChapter(ch);
    summarized += String(summarizedChapter.summary || "").trim() ? 1 : 0;
    done += 1;
    out.push(summarizedChapter);
    opts.onProgress?.({ phase: "done", done, total, title: ch.title });
  }

  await cloudApi.replaceWikiChapters(documentId, {
    base_content_sha: baseContentSha,
    executor: "desktop-client",
    chapters: out,
  });
  return { chapters: total, summarized, reused };
}
