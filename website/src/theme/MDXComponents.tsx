// Make <Tabs> / <TabItem> available in every .md / .mdx file without a per-file
// import, so a TypeScript-vs-.NET language switch can be dropped in anywhere.
// Tabs sharing groupId="lang" sync across the whole site and persist the choice,
// which is the "pick your language once, at the top" behaviour.
import MDXComponents from "@theme-original/MDXComponents";
import Tabs from "@theme/Tabs";
import TabItem from "@theme/TabItem";

export default {
  ...MDXComponents,
  Tabs,
  TabItem,
};
