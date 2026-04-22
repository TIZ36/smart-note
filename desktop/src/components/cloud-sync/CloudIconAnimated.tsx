import { cn } from "@/lib/cn";

/* Cloud icon that fills from outline → light blue as upload progresses.
   Used in both the left nav (24px) and the page header (32px).
   Progress is a 0–1 float; 0 = pure outline, 1 = fully filled. */

type Props = {
  progress?: number;          // 0 to 1 (undefined → treat as 0)
  size?: number;
  animating?: boolean;        // true during active upload — adds a subtle pulse
  className?: string;
  filledColor?: string;       // override the blue; default = CSS var
  strokeColor?: string;
};

const CLOUD_PATH =
  "M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z";

export function CloudIconAnimated({
  progress = 0,
  size = 20,
  animating = false,
  className,
  filledColor = "var(--color-cloud-fill, #7dd3fc)",   // sky-300
  strokeColor = "currentColor",
}: Props) {
  const clamped = Math.max(0, Math.min(1, progress));
  // clip the fill from the bottom up — `inset(top right bottom left)`.
  // 0% fill → inset(100% 0 0 0) (nothing visible); 1.0 → inset(0 0 0 0).
  const insetTop = `${(1 - clamped) * 100}%`;

  return (
    <span
      className={cn("proto-cloud-icon", animating && "proto-cloud-icon-animating", className)}
      style={{ width: size, height: size, display: "inline-flex" }}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="none"
        stroke={strokeColor}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ position: "absolute" }}
      >
        <path d={CLOUD_PATH} />
      </svg>
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill={filledColor}
        stroke="none"
        style={{
          position: "absolute",
          clipPath: `inset(${insetTop} 0 0 0)`,
          transition: "clip-path 0.3s ease",
        }}
      >
        <path d={CLOUD_PATH} />
      </svg>
    </span>
  );
}
