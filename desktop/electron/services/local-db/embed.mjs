/**
 * Embed-service client.
 *
 * Talks HTTP to the local docker container (`local_embedding/`,
 * already in cloud/infra/docker-compose.yml as the `embed` service).
 * Default URL `http://localhost:8009`; override via env or settings.
 *
 * The service exposes POST `/embed` accepting `{ texts: string[] }`
 * and returning `{ embeddings: number[][] }`. Same contract that
 * cloud uses today.
 *
 * Batch size of 16 is a sweet spot for BGE-m3 on a single 4090 —
 * larger eats GPU mem with diminishing throughput; smaller wastes
 * the round-trip overhead. Tunable via env if needed.
 */

const DEFAULT_URL = "http://localhost:8009";
const BATCH_SIZE = 16;

let _baseUrl = process.env.EMBED_URL || DEFAULT_URL;
export function setEmbedUrl(u) { _baseUrl = u || DEFAULT_URL; }

/** Embed an array of strings; returns parallel array of float vectors. */
export async function embedAll(texts) {
  if (!Array.isArray(texts) || !texts.length) return [];
  const out = new Array(texts.length);
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const slice = texts.slice(i, i + BATCH_SIZE);
    const vecs = await _embedBatch(slice);
    for (let j = 0; j < vecs.length; j++) out[i + j] = vecs[j];
  }
  return out;
}

async function _embedBatch(texts) {
  const r = await fetch(`${_baseUrl.replace(/\/+$/, "")}/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`embed service ${r.status}: ${body.slice(0, 200)}`);
  }
  const j = await r.json();
  if (!Array.isArray(j.embeddings) || j.embeddings.length !== texts.length) {
    throw new Error(`embed service shape mismatch: expected ${texts.length} embeddings`);
  }
  return j.embeddings;
}
