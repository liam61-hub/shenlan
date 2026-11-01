import type { TodoItem, PlanItem } from '@shenlan/core';

export interface TaskTreeRow {
  key: string;
  text: string;
  status: TodoItem['status'];
  depth: number;
}

/** Both tools feed one visible tree; the latest explicit update owns its statuses. */
export function visibleTaskItems(todos: TodoItem[], plan: PlanItem[], source?: 'todos' | 'plan'): TodoItem[] {
  if (source === 'plan' || (source === undefined && !todos.length)) {
    return plan.map(({ step, ...rest }) => ({ ...rest, content: step }));
  }
  return todos;
}

interface Group {
  key: string;
  title: string;
  nested: boolean;
  items: Array<{ item: TodoItem; index: number; title: string }>;
}

/** Fold existing stage prefixes as well as explicitly grouped items into parents. */
export function taskTreeRows(items: TodoItem[], maxRows: number): TaskTreeRow[] {
  if (maxRows <= 0) return [];
  const groups = new Map<string, Group>();
  items.forEach((item, index) => {
    const prefix = /^(S\d+|N\d+)\s*[:：.)、-]?\s*(.*)$/i.exec(item.content);
    const key = item.group ? `group:${item.group}` : prefix ? `stage:${prefix[1]!.toUpperCase()}` : `item:${index}`;
    let group = groups.get(key);
    if (!group) {
      const stageTitle = prefix ? `${prefix[1]!.toUpperCase()} ${prefix[2]!.split(/[:：]/)[0]}`.trim() : item.content;
      group = { key, title: item.group || stageTitle, nested: !!item.group || !!prefix, items: [] };
      groups.set(key, group);
    }
    group.items.push({ item, index, title: prefix && !item.group ? prefix[2]! : item.content });
  });
  const nodes = [...groups.values()];
  const active = nodes.find(node => node.items.some(({ item }) => item.status === 'in_progress'))
    ?? nodes.find(node => node.items.some(({ item }) => item.status === 'pending'));
  const rows: TaskTreeRow[] = [];
  let activeParent = -1;
  let activeChild = -1;
  for (const node of nodes) {
    const completed = node.items.filter(({ item }) => item.status === 'completed').length;
    const status = completed === node.items.length ? 'completed'
      : node.items.some(({ item }) => item.status === 'in_progress') ? 'in_progress' : 'pending';
    if (node === active) activeParent = rows.length;
    const expanded = node.nested && node === active;
    rows.push({ key: node.key, text: node.nested
      ? `${expanded ? '▾' : '▸'} ${node.title} (${completed}/${node.items.length})`
      : `${node.items[0]!.index + 1}. ${node.title}`, status, depth: 0 });
    if (expanded) {
      for (const { item, index, title } of node.items) {
        if (activeChild < 0 && item.status === 'in_progress') activeChild = rows.length;
        rows.push({ key: `${node.key}-${index}`, text: `${index + 1}. ${title}`, status: item.status, depth: 1 });
      }
      if (activeChild < 0) activeChild = activeParent + 1;
    }
  }
  if (rows.length <= maxRows) return rows;
  if (maxRows === 1) return [rows[Math.max(0, activeParent)]!];
  const capacity = maxRows - 1;
  const selected = new Set<number>([Math.max(0, activeParent)]);
  if (activeChild >= 0 && capacity > 1) selected.add(activeChild);
  const candidates = rows.map((_, index) => index).sort((a, b) =>
    Math.abs(a - Math.max(0, activeParent)) - Math.abs(b - Math.max(0, activeParent)));
  for (const index of candidates) {
    if (selected.size >= capacity) break;
    // A child is never detached from its parent.
    if (rows[index]!.depth === 0 || selected.has(activeParent)) selected.add(index);
  }
  return [...selected].sort((a, b) => a - b).map(index => rows[index]!).concat({
    key: 'overflow', text: `… +${rows.length - selected.size} tasks`, status: 'pending', depth: 0,
  });
}
