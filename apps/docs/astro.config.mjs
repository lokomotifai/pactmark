import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://pactmark.github.io",
  base: "/pactmark",
  integrations: [
    starlight({
      title: { en: "Pactmark", tr: "Pactmark" },
      description: "Evidence-native TypeScript framework for bounded agent work",
      defaultLocale: "en",
      locales: {
        en: { label: "English", lang: "en" },
        tr: { label: "Türkçe", lang: "tr" },
      },
      customCss: ["./src/styles/docs.css"],
      lastUpdated: false,
      sidebar: [
        {
          label: "Getting started",
          items: [{ autogenerate: { directory: "en/getting-started" } }],
        },
        { label: "Concepts", items: [{ autogenerate: { directory: "en/concepts" } }] },
        { label: "Guides", items: [{ autogenerate: { directory: "en/guides" } }] },
        { label: "Production", items: [{ autogenerate: { directory: "en/production" } }] },
        { label: "Security", items: [{ autogenerate: { directory: "en/security" } }] },
        { label: "Reference", items: [{ autogenerate: { directory: "en/reference" } }] },
        { label: "Community", items: [{ autogenerate: { directory: "en/community" } }] },
      ],
    }),
    sitemap(),
  ],
});
