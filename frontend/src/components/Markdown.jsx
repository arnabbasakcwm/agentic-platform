import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Agent output is model-written text: render it as GitHub-flavored Markdown, never as
// HTML. `skipHtml` drops any raw HTML in the text, and react-markdown's default URL
// handling neutralises javascript: links — nothing here uses dangerouslySetInnerHTML.
const components = {
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  // Wide tables scroll inside their own box instead of widening the page.
  table: ({ node, ...props }) => (
    <div className="md__table" tabIndex={0} role="region" aria-label="Table">
      <table {...props} />
    </div>
  ),
};

export function Markdown({ children }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {children ?? ""}
      </ReactMarkdown>
    </div>
  );
}
