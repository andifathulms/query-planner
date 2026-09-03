/**
 * The product mark: the planner's own DP lattice.
 *
 * Three cells at level one, the kept plan above them, and only the kept cell
 * filled. It is the same figure the search panel draws, which is the reason it
 * is a good mark for this app and a database cylinder would not be.
 *
 * This is the brand package's 32 px tier — at header size the three-level,
 * hairline-outlined version turns to mud, so the cells go solid and the level
 * count drops. The colours are the app's own tokens rather than the brand's
 * mint: inside the interface the winner is drawn in ink and never in a hue
 * (DESIGN.md §2.3), and a mint cell in the header would be the one place that
 * rule broke. The mint version is what ships as the favicon, the home-screen
 * icon and the social card, where the brand is doing the talking.
 */
export function Mark({ size = 18 }: { size?: number }) {
  return (
    <svg
      className="app-mark"
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden="true"
      focusable="false"
    >
      <rect className="app-mark-kept" x="32" y="10" width="36" height="28" rx="3" />
      <rect className="app-mark-cell" x="4" y="58" width="36" height="28" rx="3" />
      <rect className="app-mark-cell" x="60" y="58" width="36" height="28" rx="3" />
    </svg>
  );
}
