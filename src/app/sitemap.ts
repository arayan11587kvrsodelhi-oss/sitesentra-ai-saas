
import type { MetadataRoute } from "next";

const SITE_URL = "https://sitesentra-ai-saas-lime.vercel.app";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: SITE_URL,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${SITE_URL}/methodology`,
      changeFrequency: "monthly",
      priority: 0.8,
    },
  ];
}
