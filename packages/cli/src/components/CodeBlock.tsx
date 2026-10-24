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

  // highlight.js 返回 HTML，简单转换为终端样式
  // 这里用简化方案：清除 HTML tags，用 dim 渲染；反转义实体（&quot; 等）
  const plain = highlighted
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

  const lines = plain.split('\n');
  const w = Math.min(process.stdout.columns || 80, 100);

  return (
    <Box flexDirection="column" marginY={1}>
      {language ? (
        <Text dimColor>┌── {language} ──</Text>
      ) : (
        <Text dimColor>┌── code ──</Text>
      )}
      {lines.map((line, i) => (
        <Text key={i} dimColor>
          {'│ ' + line.slice(0, w - 2)}
        </Text>
      ))}
      <Text dimColor>└{'─'.repeat(Math.min(w - 1, 20))}</Text>
    </Box>
  );
}
