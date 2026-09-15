import civilWar from "@/assets/civil-war.png";
import dune from "@/assets/dune.png";
import furiosa from "@/assets/furiosa.png";
import ifPoster from "@/assets/if.png";
import planetApes from "@/assets/planet-apes.png";
import sheriff from "@/assets/sheriff.png";
import logo from "@/assets/logo.png";

/**
 * Posters are bundled (and content-hashed) by Vite, so they work under any
 * deployment base path — unlike the original hard-coded `/movie-tickets/...`
 * URLs, which broke as soon as the app was served from a different root.
 */
const POSTERS: Record<string, string> = {
  furiosa,
  if: ifPoster,
  "civil-war": civilWar,
  "kingdom-of-the-planet-of-the-apes": planetApes,
  "dune-part-two": dune,
  sheriff,
};

export const logoUrl = logo;

export function posterFor(slug: string, fallbackUrl?: string): string | undefined {
  return POSTERS[slug] ?? fallbackUrl;
}
