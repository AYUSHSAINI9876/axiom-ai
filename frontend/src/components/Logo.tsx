interface Props {
  size?: number;
  className?: string;
}

/**
 * The Axiom mark: an A drawn as two converging strokes over a gradient tile.
 *
 * Inline SVG rather than an image file so it inherits the theme gradient and
 * stays crisp at any size without a second asset to keep in sync.
 */
export default function Logo({ size = 36, className = "" }: Props) {
  return (
    <span
      className={`gradient-brand relative inline-flex shrink-0 items-center justify-center rounded-xl ${className}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg
        width={size * 0.58}
        height={size * 0.58}
        viewBox="0 0 24 24"
        fill="none"
        stroke="#ffffff"
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 20 L12 4 L20 20" />
        <path d="M8.2 14.4 H15.8" />
      </svg>
    </span>
  );
}
