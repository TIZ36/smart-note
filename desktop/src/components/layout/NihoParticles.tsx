import { useEffect, useRef } from "react";

/**
 * Full-screen canvas particle system for niho theme.
 * - Starfield: Windows-style "flying through space" — stars radiate from center, grow as they approach
 * - Mouse trail: small squares that fade along cursor path
 * - Emitter: active UI elements emit particles that start large and shrink as they float away
 */

/** A star in 3D space, projected to 2D */
interface Star {
  x: number;   // -1 to 1 (horizontal position in 3D)
  y: number;   // -1 to 1 (vertical position in 3D)
  z: number;   // depth: starts at maxZ, decreases toward 0 (closer = bigger/faster)
  speed: number;
}

interface TrailDot {
  x: number;
  y: number;
  opacity: number;
  birth: number;
}

interface EmitParticle {
  x: number;
  y: number;
  size: number;
  startSize: number;
  opacity: number;
  vx: number;
  vy: number;
  life: number;
  speed: number;
}

const STAR_COUNT = 120;
const STAR_MAX_Z = 1000;
const STAR_SPEED_BASE = 0.8;    // base z-speed per frame
const STAR_SPEED_RANGE = 1.2;   // random additional speed
const FOCAL_LENGTH = 300;       // projection focal length — controls spread

const TRAIL_MAX = 8;
const TRAIL_LIFETIME = 300;
const TRAIL_THROTTLE = 30;

const EMIT_INTERVAL = 80;
const EMIT_MAX = 60;
const SELECTORS = [
  ".proto-nav-item-active",
  ".proto-topk-option-active",
  ".proto-settings-theme-btn-active",
  ".proto-toggle-switch-on",
  ".proto-wiki-selected",
];

const ACCENT = [94, 234, 212]; // #5eead4

function makeStar(): Star {
  return {
    x: (Math.random() - 0.5) * 2,
    y: (Math.random() - 0.5) * 2,
    z: Math.random() * STAR_MAX_Z,
    speed: STAR_SPEED_BASE + Math.random() * STAR_SPEED_RANGE,
  };
}

function resetStar(s: Star) {
  s.x = (Math.random() - 0.5) * 2;
  s.y = (Math.random() - 0.5) * 2;
  s.z = STAR_MAX_Z + Math.random() * 200;
  s.speed = STAR_SPEED_BASE + Math.random() * STAR_SPEED_RANGE;
}

export function NihoParticles() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stars = useRef<Star[]>([]);
  const trail = useRef<TrailDot[]>([]);
  const emitted = useRef<EmitParticle[]>([]);
  const mouse = useRef({ x: -1, y: -1 });
  const lastTrailTime = useRef(0);
  const lastEmitTime = useRef(0);
  const rafId = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    function resize() {
      if (!canvas) return;
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      canvas.style.width = window.innerWidth + "px";
      canvas.style.height = window.innerHeight + "px";
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener("resize", resize);

    const w = () => window.innerWidth;
    const h = () => window.innerHeight;

    // Init stars
    stars.current = Array.from({ length: STAR_COUNT }, makeStar);

    // Mouse tracking
    function onMouseMove(e: MouseEvent) {
      mouse.current.x = e.clientX;
      mouse.current.y = e.clientY;
      const now = performance.now();
      if (now - lastTrailTime.current > TRAIL_THROTTLE) {
        trail.current.push({ x: e.clientX, y: e.clientY, opacity: 0.4, birth: now });
        if (trail.current.length > TRAIL_MAX) trail.current.shift();
        lastTrailTime.current = now;
      }
    }
    window.addEventListener("mousemove", onMouseMove);

    function emitFromActiveElements(now: number) {
      if (now - lastEmitTime.current < EMIT_INTERVAL) return;
      if (emitted.current.length >= EMIT_MAX) return;
      lastEmitTime.current = now;

      const els = document.querySelectorAll(SELECTORS.join(","));
      for (const el of els) {
        const rect = (el as HTMLElement).getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;

        const edge = Math.random();
        let x: number, y: number;
        if (edge < 0.6) {
          x = rect.left + Math.random() * rect.width;
          y = rect.top;
        } else {
          x = rect.right;
          y = rect.top + Math.random() * rect.height;
        }

        const startSize = 3 + Math.random() * 3;
        emitted.current.push({
          x, y, size: startSize, startSize,
          opacity: 0.4 + Math.random() * 0.3,
          vx: 0.3 + Math.random() * 0.6,
          vy: -(0.4 + Math.random() * 0.8),
          life: 0,
          speed: 0.008 + Math.random() * 0.012,
        });
      }
    }

    function render() {
      if (document.hidden) {
        rafId.current = requestAnimationFrame(render);
        return;
      }
      const cw = w();
      const ch = h();
      ctx!.clearRect(0, 0, cw, ch);
      const now = performance.now();

      // Vanishing point: slightly right of center (offset for sidebar)
      const cx = cw * 0.55;
      const cy = ch * 0.48;

      // ── 1. Starfield ──
      for (const s of stars.current) {
        // Store previous projected position for streak
        const prevZ = s.z;
        const prevSx = cx + s.x * (FOCAL_LENGTH / prevZ) * cw * 0.5;
        const prevSy = cy + s.y * (FOCAL_LENGTH / prevZ) * ch * 0.5;

        // Move star closer
        s.z -= s.speed;

        // Off screen or too close → respawn far away
        if (s.z <= 1) { resetStar(s); continue; }

        // Project to screen
        const scale = FOCAL_LENGTH / s.z;
        const sx = cx + s.x * scale * cw * 0.5;
        const sy = cy + s.y * scale * ch * 0.5;

        if (sx < -20 || sx > cw + 20 || sy < -20 || sy > ch + 20) {
          resetStar(s);
          continue;
        }

        // Depth → size and brightness: closer = bigger + brighter
        const depthT = 1 - s.z / STAR_MAX_Z; // 0 (far) → 1 (close)
        const size = 0.5 + depthT * 2.5;     // 0.5px → 3px
        const opacity = 0.05 + depthT * 0.45; // dim far, bright close

        // Draw streak line from previous to current position
        const streakLen = Math.hypot(sx - prevSx, sy - prevSy);
        if (streakLen > 1.5 && depthT > 0.15) {
          ctx!.strokeStyle = `rgba(${ACCENT[0]},${ACCENT[1]},${ACCENT[2]},${opacity * 0.5})`;
          ctx!.lineWidth = Math.max(0.5, size * 0.4);
          ctx!.beginPath();
          ctx!.moveTo(prevSx, prevSy);
          ctx!.lineTo(sx, sy);
          ctx!.stroke();
        }

        // Draw star dot (square pixel)
        ctx!.fillStyle = `rgba(${ACCENT[0]},${ACCENT[1]},${ACCENT[2]},${opacity})`;
        const roundedSize = Math.max(1, Math.round(size));
        ctx!.fillRect(
          Math.round(sx - roundedSize / 2),
          Math.round(sy - roundedSize / 2),
          roundedSize,
          roundedSize,
        );
      }

      // ── 2. Mouse trail ──
      trail.current = trail.current.filter((d) => {
        const age = now - d.birth;
        if (age > TRAIL_LIFETIME) return false;
        const op = d.opacity * (1 - age / TRAIL_LIFETIME);
        ctx!.fillStyle = `rgba(${ACCENT[0]},${ACCENT[1]},${ACCENT[2]},${op})`;
        ctx!.fillRect(Math.round(d.x), Math.round(d.y), 2, 2);
        return true;
      });

      // ── 3. Emit from active elements ──
      emitFromActiveElements(now);

      // ── 4. Emitted particles (large → small) ──
      emitted.current = emitted.current.filter((p) => {
        p.life += p.speed;
        if (p.life >= 1) return false;
        p.x += p.vx;
        p.y += p.vy;
        p.vx *= 0.995;
        p.vy *= 0.995;
        const t = p.life;
        p.size = p.startSize * (1 - t);
        const fadeT = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
        const op = p.opacity * fadeT;
        if (p.size < 0.5) return false;
        ctx!.fillStyle = `rgba(${ACCENT[0]},${ACCENT[1]},${ACCENT[2]},${op})`;
        ctx!.fillRect(Math.round(p.x), Math.round(p.y), Math.round(p.size), Math.round(p.size));
        return true;
      });

      rafId.current = requestAnimationFrame(render);
    }
    rafId.current = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(rafId.current);
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMouseMove);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10,
        pointerEvents: "none",
      }}
    />
  );
}
