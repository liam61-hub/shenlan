/**
 * Braille spinner — 动态旋转动画
 */
import { Text } from 'ink';
import { useAnimation } from 'ink';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function Spinner() {
  const { frame } = useAnimation();
  return <Text color="yellow">{FRAMES[frame % FRAMES.length]}</Text>;
}
