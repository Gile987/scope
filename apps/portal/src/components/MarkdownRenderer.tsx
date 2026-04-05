// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import ReactMarkdown, { type Options } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkGithubAlerts from "remark-github-markdown-alerts";

/**
 * Extends the default GitHub-style sanitize schema to allow:
 * - className on div/p/span (needed for remark-github-markdown-alerts)
 */
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    div: [
      ...(defaultSchema.attributes?.div ?? []),
      ["className", /^markdown-alert/],
    ],
    p: [
      ...(defaultSchema.attributes?.p ?? []),
      ["className", /^markdown-alert/],
    ],
    span: [
      ...(defaultSchema.attributes?.span ?? []),
      ["className", /^markdown-alert/],
    ],
  },
};

interface MarkdownRendererProps {
  children: string;
  /** Enable remark-github-markdown-alerts (e.g. > [!NOTE]) */
  githubAlerts?: boolean;
}

export function MarkdownRenderer({
  children,
  githubAlerts,
}: MarkdownRendererProps) {
  const remarkPlugins: Options["remarkPlugins"] = [remarkGfm];
  if (githubAlerts) {
    remarkPlugins.push(remarkGithubAlerts);
  }

  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
    >
      {children}
    </ReactMarkdown>
  );
}
