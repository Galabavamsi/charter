import Markdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';

const markdownComponents: Components = {
  a({ node: _node, ...props }) {
    return <a {...props} rel="noreferrer noopener" />;
  },
  table({ node: _node, ...props }) {
    return (
      <div className="bubble-table-wrap">
        <table {...props} />
      </div>
    );
  },
  img() {
    return null;
  },
};

export function ChatMarkdown({ text }: { text: string }) {
  return (
    <div className="bubble-md">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        skipHtml
        components={markdownComponents}
      >
        {text}
      </Markdown>
    </div>
  );
}
