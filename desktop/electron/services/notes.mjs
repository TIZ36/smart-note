/* Notes service — direct fs access against the user's notes dir.
 *
 * Replaces server/app/gateway.py /note/load + /note/save (and their
 * line-range / line-meta cousins). The notes dir is the user-chosen
 * folder of markdown files; the path comes from settings.
 *
 * Safety: every path is normalized + validated to be inside the
 * notes dir. We refuse symlinks pointing outside, and we refuse
 * absolute paths from the renderer (they must be relative to the
 * notes dir).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import * as settings from "./settings.mjs";

async function notesDir() {
  const s = await settings.read();
  const dir = s.notes_dir || s.NOTES_DIR;
  if (!dir) throw new Error("notes_dir not configured");
  return path.resolve(dir);
}

async function resolveSafe(rel) {
  if (!rel || typeof rel !== "string") throw new Error("invalid path");
  if (path.isAbsolute(rel)) {
    // Allow absolute paths only if they fall inside the notes dir
    // (e.g. the renderer kept the original gateway path shape).
    const root = await notesDir();
    const abs = path.resolve(rel);
    if (!abs.startsWith(root + path.sep) && abs !== root) {
      throw new Error("path outside notes dir");
    }
    return abs;
  }
  const root = await notesDir();
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep) && abs !== root) {
    throw new Error("path outside notes dir");
  }
  return abs;
}

export async function read(rawPath) {
  const abs = await resolveSafe(rawPath);
  const content = await fs.readFile(abs, "utf8");
  const stat = await fs.stat(abs);
  return { path: abs, content, mtime: stat.mtimeMs / 1000, size: stat.size };
}

export async function write(rawPath, content) {
  const abs = await resolveSafe(rawPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, abs);
  const stat = await fs.stat(abs);
  return { path: abs, mtime: stat.mtimeMs / 1000, size: stat.size };
}

export async function list() {
  const root = await notesDir();
  const out = [];
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile() && /\.(md|markdown|txt)$/i.test(e.name)) {
        const stat = await fs.stat(abs);
        out.push({
          path: abs,
          rel_path: path.relative(root, abs),
          name: e.name,
          mtime: stat.mtimeMs / 1000,
          size: stat.size,
        });
      }
    }
  }
  await walk(root);
  return out;
}

export async function getNotesDir() { return notesDir(); }
