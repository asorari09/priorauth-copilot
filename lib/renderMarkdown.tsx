import { type ReactNode } from "react";

export function renderInlineMarkdown(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={`bold-${index}`}>{part.slice(2, -2)}</strong>;
    }
    return <span key={`text-${index}`}>{part}</span>;
  });
}

export function renderReasoningMarkdown(text: string): ReactNode[] {
  return text.split(/\n\n+/).map((paragraph, index) => (
    <p key={`para-${index}`} className={index > 0 ? "mt-3" : undefined}>
      {renderInlineMarkdown(paragraph)}
    </p>
  ));
}
