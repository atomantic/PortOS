import ReactMarkdown from 'react-markdown';

const components = {
  h1: ({ children }) => <h1 className="text-base font-bold text-white mt-3 mb-1">{children}</h1>,
  h2: ({ children }) => <h2 className="text-sm font-bold text-white mt-3 mb-1">{children}</h2>,
  h3: ({ children }) => <h3 className="text-xs font-semibold text-port-accent mt-2 mb-1">{children}</h3>,
  h4: ({ children }) => <h4 className="text-xs font-semibold text-gray-300 mt-2 mb-0.5">{children}</h4>,
  p: ({ children }) => <p className="text-xs text-gray-300 my-0.5">{children}</p>,
  strong: ({ children }) => <strong className="text-white font-semibold">{children}</strong>,
  em: ({ children }) => <em className="text-gray-300 italic">{children}</em>,
  code: ({ children, className }) => {
    // Fenced code block (has language className like "language-js")
    if (className) {
      return (
        <code className="block bg-port-bg rounded p-2 my-1 text-xs font-mono text-cyan-400 overflow-x-auto">
          {children}
        </code>
      );
    }
    // Inline code
    return <code className="bg-port-bg px-1 py-0.5 rounded text-cyan-400 font-mono text-xs">{children}</code>;
  },
  pre: ({ children }) => <pre className="my-1 overflow-x-auto">{children}</pre>,
  ul: ({ children }) => <ul className="my-0.5 pl-4 space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="my-0.5 pl-4 space-y-0.5 list-decimal">{children}</ol>,
  li: ({ children }) => <li className="text-xs text-gray-300 list-disc">{children}</li>,
  hr: () => <hr className="border-port-border my-2" />,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-port-accent/50 pl-2 my-1 text-gray-400 italic">{children}</blockquote>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto my-1">
      <table className="text-xs border-collapse w-full">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b border-port-border">{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr className="border-b border-port-border/50">{children}</tr>,
  th: ({ children }) => <th className="text-left px-2 py-1 text-gray-400 font-medium">{children}</th>,
  td: ({ children }) => <td className="px-2 py-1 text-gray-300">{children}</td>,
  a: ({ children, href }) => (
    <a href={href} className="text-port-accent hover:underline" target="_blank" rel="noopener noreferrer">{children}</a>
  ),
};

export default function MarkdownOutput({ content }) {
  return (
    <div className="markdown-output">
      <ReactMarkdown components={components}>{content}</ReactMarkdown>
    </div>
  );
}
