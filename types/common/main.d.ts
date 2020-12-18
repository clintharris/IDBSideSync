interface OpLogEntry {
  // 'id' is created by concatenating {store}:{idPath}={idValue} (e.g., "customers:customerId=123")
  id: string;
  hlcTime: string;
  store: string;
  idPath: string;
  idValue: string;
  operation: SetOperation;
}

interface SetOperation {
  set: Record<string, unknown>;
}