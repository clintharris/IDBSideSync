interface TodoItem {
  id: number;
  name: string;
  done: boolean;
}

interface ScopedSetting {
  scope: string;
  name: string;
  [k: string]: unknown;
}
