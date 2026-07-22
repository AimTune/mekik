import { themes as prismThemes } from "prism-react-renderer";
import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

const GITHUB_REPO = "https://github.com/AimTune/mekik";
const SITE_URL = "https://mekik.aimtune.dev";
const BASE_URL = "/";

const config: Config = {
  title: "mekik",
  tagline:
    "The realtime serving layer for ilmek graphs — one wire protocol, two implementations, durable human-in-the-loop.",
  favicon: "img/logo.svg",

  future: {
    v4: true,
    faster: true,
  },

  url: SITE_URL,
  baseUrl: BASE_URL,

  organizationName: "AimTune",
  projectName: "mekik",
  trailingSlash: false,

  onBrokenLinks: "throw",
  onBrokenAnchors: "throw",
  markdown: {
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: "warn",
      onBrokenMarkdownImages: "warn",
    },
  },
  themes: ["@docusaurus/theme-mermaid"],

  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  presets: [
    [
      "classic",
      {
        docs: {
          sidebarPath: "./sidebars.ts",
          routeBasePath: "/",
          editUrl: `${GITHUB_REPO}/edit/main/website/`,
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: "img/mekik-social-card.png",
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: "mekik",
      logo: {
        alt: "mekik logo",
        src: "img/logo.svg",
      },
      items: [
        {
          type: "docSidebar",
          sidebarId: "docs",
          position: "left",
          label: "Docs",
        },
        {
          to: "/concepts",
          position: "left",
          label: "Concepts",
        },
        {
          to: "/protocol/overview",
          position: "left",
          label: "Protocol",
        },
        {
          to: "/authoring/human-in-the-loop",
          position: "left",
          label: "Human-in-the-loop",
        },
        {
          href: GITHUB_REPO,
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Learn",
          items: [
            { label: "What is mekik?", to: "/intro" },
            { label: "Getting started", to: "/getting-started" },
            { label: "Concepts", to: "/concepts" },
            { label: "Architecture", to: "/architecture" },
          ],
        },
        {
          title: "Reference",
          items: [
            { label: "Protocol", to: "/protocol/overview" },
            { label: "Frames", to: "/protocol/frames" },
            { label: "Authoring helpers", to: "/authoring/helpers" },
            { label: "TypeScript ↔ .NET", to: "/parity/languages" },
          ],
        },
        {
          title: "More",
          items: [
            { label: "ilmek", href: "https://www.npmjs.com/package/@ilmek/core" },
            { label: "chativa", href: "https://github.com/AimTune/chativa" },
            { label: "GitHub", href: GITHUB_REPO },
            { label: "Issues", href: `${GITHUB_REPO}/issues` },
          ],
        },
      ],
      copyright: `© ${new Date().getFullYear()} Hamza Agar — mekik is MIT licensed.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ["bash", "json", "diff", "csharp"],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
