import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const production = process.env.NEXT_PUBLIC_APP_ENV === "production";
  return production ? {
    rules: { userAgent: "*", allow: ["/", "/faq", "/privacy", "/support"],
      disallow: ["/history", "/interview", "/login", "/report", "/settings"] },
    sitemap: `${process.env.NEXT_PUBLIC_SITE_URL}/sitemap.xml`,
  } : { rules: { userAgent: "*", disallow: "/" } };
}
