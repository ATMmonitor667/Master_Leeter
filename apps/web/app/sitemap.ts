import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
  return ["", "/faq", "/privacy", "/support"].map((path) => ({
    url: `${base}${path}`, changeFrequency: path ? "monthly" : "weekly", priority: path ? 0.6 : 1,
  }));
}
