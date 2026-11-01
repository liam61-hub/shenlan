/**
 * 代码块 — highlight.js 语法高亮
 */
import { Text, Box } from 'ink';
import hljs from 'highlight.js';

interface CodeBlockProps {
  language: string;
  code: string;
}

export function CodeBlock({ language, code }: CodeBlockProps) {
  let highlighted: string;
  try {
    if (language && hljs.getLanguage(language)) {
      highlighted = hljs.highlight(code, { language }).value;
    } else if (language) {
      // 未知语言，尝试自动检测
      const result = hljs.highlightAuto(code);
      highlighted = result.value;
    } else {
      highlighted = hljs.highlightAuto(code).value;
    }
  } catch {
    highlighted = code;
  }

  // Convert highlight.js markup to readable source. The surrounding assistant
  // frame already provides context, so code blocks stay unboxed.
  const plain = highlighted
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

  const lines = plain.split('\n');

  return (
    <Box flexDirection="column" marginY={1}>
      {language ? <Text dimColor>{language}</Text> : null}
      {lines.map((line, i) => (
        <Text key={i} dimColor>{line}</Text>
      ))}
    </Box>
  );
}
