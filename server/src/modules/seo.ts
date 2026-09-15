import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { env } from "../config/env.js";
import { buildSeo, injectSeoIntoShell, robotsTxt, sitemapXml } from "../services/seo.js";

/**
 * SEO surface (ТЗ §8): machine-readable files and the prerendered storefront
 * shell. Mounted at the site root (not under /api) so the URLs are the
 * canonical ones crawlers expect.
 */
export const seoRouter: Router = Router();

/** Public origin for absolute URLs: APP_PUBLIC_URL, or the request's own host. */
function originFrom(req: { protocol: string; get(name: string): string | undefined }): string {
  const configured = env.APP_PUBLIC_URL.replace(/\/$/, "");
  if (configured && !/localhost|127\.0\.0\.1/.test(configured)) return configured;
  const host = req.get("host");
  return host ? `${req.protocol}://${host}` : configured || "http://localhost:5173";
}

seoRouter.get("/sitemap.xml", (req, res) => {
  res.type("application/xml").send(sitemapXml(originFrom(req)));
});

seoRouter.get("/robots.txt", (req, res) => {
  res.type("text/plain").send(robotsTxt(originFrom(req)));
});

/**
 * Serves the built SPA shell with per-route metadata, JSON-LD and a noscript
 * storefront. Used for every client route when `SERVE_CLIENT` is on.
 */
export async function serveShell(
  req: Parameters<typeof originFrom>[0] & { path: string },
  res: {
    setHeader(name: string, value: string): void;
    status(code: number): { type(value: string): { send(body: string): void } };
    send(body: string): void;
  },
  next: (error?: unknown) => void,
): Promise<void> {
  try {
    const indexFile = path.join(env.clientDist, "index.html");
    const html = fs.readFileSync(indexFile, "utf8");
    const meta = await buildSeo(req.path, originFrom(req));
    res.setHeader("Cache-Control", "no-store");
    res.send(injectSeoIntoShell(html, meta));
  } catch (error) {
    next(error);
  }
}
