/* Settings service — JSON file in userData/.
 *
 * Replaces server/app/gateway.py /settings/* endpoints. The shape
 * stays the same as before so renderer code can swap transports
 * without changing keys.
 *
 * Atomic writes: write to tmp + rename so a crash mid-write can't
 * corrupt the file. Reads tolerate missing/empty file (returns {}).
 */
import { app } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

export async function read() {
  try {
    const txt = await fs.readFile(settingsPath(), "utf8");
    return txt.trim() ? JSON.parse(txt) : {};
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw e;
  }
}

export async function write(patch) {
  const cur = await read();
  const next = { ...cur, ...patch };
  const file = settingsPath();
  const tmp = `${file}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await fs.rename(tmp, file);
  return next;
}

export async function clear() {
  try { await fs.unlink(settingsPath()); } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}
