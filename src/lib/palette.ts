export type ColorTag =
  | "amber"
  | "blue"
  | "green"
  | "violet"
  | "orange"
  | "red"
  | "sky"
  | "teal"
  | "pink"
  | "lime";

export const COLOR_TAGS: ColorTag[] = [
  "amber",
  "blue",
  "green",
  "violet",
  "orange",
  "red",
  "sky",
  "teal",
  "pink",
  "lime",
];

export interface Triple {
  accent: string;
  tint: string;
  border: string;
}

export const PALETTE: Record<ColorTag, Triple> = {
  amber: { accent: "#b45309", tint: "#fef9f0", border: "#fde68a" },
  blue: { accent: "#1d4ed8", tint: "#eff6ff", border: "#93b4f0" },
  green: { accent: "#15803d", tint: "#f0fdf4", border: "#86efac" },
  violet: { accent: "#6d28d9", tint: "#f5f3ff", border: "#c4b5fd" },
  orange: { accent: "#c2410c", tint: "#fff7ed", border: "#fdba74" },
  red: { accent: "#dc2626", tint: "#fef2f2", border: "#fca5a5" },
  sky: { accent: "#0369a1", tint: "#f0f9ff", border: "#7dd3fc" },
  teal: { accent: "#0f766e", tint: "#f0fdfa", border: "#5eead4" },
  pink: { accent: "#be185d", tint: "#fdf2f8", border: "#f9a8d4" },
  lime: { accent: "#4d7c0f", tint: "#f7fee7", border: "#bef264" },
};

export function isColorTag(value: unknown): value is ColorTag {
  return typeof value === "string" && (COLOR_TAGS as string[]).includes(value);
}

export function applyPalette(tag: ColorTag | null): void {
  const s = document.documentElement.style;
  if (!tag) {
    s.removeProperty("--proj-accent");
    s.removeProperty("--proj-tint");
    s.removeProperty("--proj-border");
    return;
  }
  const t = PALETTE[tag];
  s.setProperty("--proj-accent", t.accent);
  s.setProperty("--proj-tint", t.tint);
  s.setProperty("--proj-border", t.border);
}
