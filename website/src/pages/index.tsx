import type { ReactNode } from "react";
import clsx from "clsx";
import Link from "@docusaurus/Link";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Layout from "@theme/Layout";
import Heading from "@theme/Heading";
import CodeBlock from "@theme/CodeBlock";

import styles from "./index.module.css";

const features = [
  {
    icon: "🧵",
    title: "One graph run = one turn",
    body: "Point mekik at a compiled ilmek graph. Each user message drives one run; text, generative UI, tool traces and pauses stream back over one socket. The graph never learns it is being served.",
  },
  {
    icon: "⏸️",
    title: "Durable human-in-the-loop",
    body: "A node calls mekik.approve and suspends. The pause lives in ilmek's checkpoint — it survives a restart — and resumes exactly where it stopped, answered by a thread-scoped interrupt id.",
  },
  {
    icon: "🎯",
    title: "Exactly-once side effects",
    body: "mekik.tool journals each side effect through ctx.step. A resume re-runs the node from the top, but the tool it already ran is memoized — a refund never charges twice.",
  },
  {
    icon: "🪄",
    title: "Generative UI streaming",
    body: "Emit ui / text / event chunks with mekik.ui and mekik.text. They travel as genui frames carrying the same AIChunk shape chativa already renders inline.",
  },
  {
    icon: "🔁",
    title: "Watermark resume",
    body: "Persistent frames carry a per-conversation seq. Reconnect with your watermark and the server replays exactly what you missed — multi-tab and multi-device out of the box.",
  },
  {
    icon: "⚖️",
    title: "Two languages, one wire",
    body: "TypeScript (reference) and .NET (port) speak byte-identical mekik/1, held to that promise by shared golden fixtures replayed through both mappers.",
  },
];

const HERO_SNIPPET = `import { graph, channel, START, END } from "@ilmek/core";
import { mekik } from "@mekik/core";
import { serveWs } from "@mekik/ws";

const g = graph("refund")
  .channel("input", channel.lastWrite<string>(""))
  .channel("reply", channel.lastWrite<string>(""))
  .node("gate", async (s, ctx) => {
    mekik.ui(ctx, "order-card", { id: s.input });          // stream GenUI
    const ok = await mekik.approve<{ approved: boolean }>( // pause for a human
      ctx,
      { title: \`Refund \${s.input}?\` },
      { ui: { component: "approval-form", props: { orderId: s.input } } },
    );
    return { reply: ok.approved ? "refunded" : "cancelled" };
  })
  .edge(START, "gate").edge("gate", END)
  .compile();

const app = mekik({ graph: g, reply: (s) => s.reply as string });
serveWs(app, { port: 8800, path: "/ws" });`;

function HomepageHeader() {
  return (
    <header className={clsx("hero", styles.heroBanner)}>
      <div className="container">
        <span className={styles.heroBadge}>Open source · MIT</span>
        <Heading as="h1" className={styles.heroTitle}>
          mekik
        </Heading>
        <p className={styles.heroTagline}>
          The realtime serving layer for <strong>ilmek</strong> graphs. Turn a
          running graph into a live conversation — streaming generative UI, tool
          traces, and durable human-in-the-loop over one wire protocol.
        </p>
        <div className={styles.heroButtons}>
          <Link
            className="button button--secondary button--lg"
            to="/getting-started"
          >
            Get started → 5 min
          </Link>
          <Link
            className="button button--outline button--lg"
            style={{ color: "white", borderColor: "white" }}
            to="/protocol/overview"
          >
            Read the protocol ↗
          </Link>
        </div>
        <div className={styles.codeWrap}>
          <CodeBlock language="tsx" className={styles.heroCode}>
            {HERO_SNIPPET}
          </CodeBlock>
        </div>
      </div>
    </header>
  );
}

function HomepageFeatures() {
  return (
    <section className={styles.features}>
      <div className="container">
        <Heading as="h2" style={{ textAlign: "center", marginBottom: "0.5rem" }}>
          What mekik gives your graph
        </Heading>
        <p
          style={{
            textAlign: "center",
            color: "var(--ifm-color-emphasis-700)",
            maxWidth: 760,
            margin: "0 auto 2rem",
          }}
        >
          Everything below comes from <code>@mekik/core</code> +{" "}
          <code>@mekik/ws</code> (or <code>Mekik.Core</code> +{" "}
          <code>Mekik.AspNetCore</code>). Your graph stays pure ilmek.
        </p>
        <div className={styles.featureGrid}>
          {features.map((f) => (
            <div key={f.title} className={styles.featureCard}>
              <span className={styles.featureIcon}>{f.icon}</span>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export default function Home(): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout
      title={siteConfig.title}
      description="mekik — the realtime serving layer for ilmek graphs. WebSocket sessions, generative UI streaming, and durable human-in-the-loop over the mekik/1 wire protocol."
    >
      <HomepageHeader />
      <main>
        <HomepageFeatures />
      </main>
    </Layout>
  );
}
