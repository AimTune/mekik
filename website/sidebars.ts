import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  docs: [
    "intro",
    "getting-started",
    "concepts",
    {
      type: "category",
      label: "Architecture",
      collapsed: false,
      items: ["architecture", "engine", "persistence", "scaling"],
    },
    {
      type: "category",
      label: "Protocol",
      link: { type: "doc", id: "protocol/overview" },
      items: [
        "protocol/frames",
        "protocol/identity",
        "protocol/event-mapping",
      ],
    },
    {
      type: "category",
      label: "Authoring",
      link: { type: "doc", id: "authoring/helpers" },
      items: [
        "authoring/generative-ui",
        "authoring/tools",
        "authoring/human-in-the-loop",
      ],
    },
    {
      type: "category",
      label: "Serving",
      items: ["serving/transport", "authentication"],
    },
    {
      type: "category",
      label: "Agent integrations",
      link: { type: "doc", id: "integrations/overview" },
      items: [
        "integrations/langchain",
        "integrations/dotnet-agents",
        "integrations/semantic-kernel",
      ],
    },
    {
      type: "category",
      label: "Parity",
      items: ["parity/languages", "parity/conformance"],
    },
    "examples",
  ],
};

export default sidebars;
