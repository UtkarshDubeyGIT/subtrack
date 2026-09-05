const paths = {
  layers: "m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5",
  grid: "M3 3h7v7H3V3Zm11 0h7v7h-7V3ZM3 14h7v7H3v-7Zm11 0h7v7h-7v-7Z",
  calendar:
    "M8 2v4m8-4v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2Zm3 10h2m4 0h2m-8 4h2",
  shield: "M12 3 4 6v5c0 5 4 8 8 10 4-2 8-5 8-10V6l-8-3Zm-4 9 3 3 5-6",
  search: "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
  plus: "M12 5v14M5 12h14",
  logout: "M9 3H4v18h5m5-14 5 5-5 5m-5-5h14",
  arrow: "M5 12h14m-5-5 5 5-5 5",
  close: "m6 6 12 12M6 18 18 6",
} as const;

export function Icon({ name }: Readonly<{ name: keyof typeof paths }>) {
  return (
    <svg
      className="ui-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
