export type ClassValue = string | number | boolean | bigint | null | undefined;

/** Tiny classnames helper — avoids pulling in clsx for a dozen call sites. */
export function cn(...values: ClassValue[]): string {
  return values
    .filter((value): value is string | number => typeof value !== "boolean" && Boolean(value))
    .join(" ");
}
