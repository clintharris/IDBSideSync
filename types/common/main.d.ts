/**
 * Objects with this shape respresent a recorded data mutation that took place at some time, on some node, as specified
 * by the Hybrid Logical Clock timestamp (`hlcTime`). When shared with another node, it should be possible to identify
 * the affected object store (and object if it exists), and apply the same mutation (i.e., re-create the operation).
 */
interface OpLogEntry {
  hlcTime: string;
  store: string;
  objectKey: string;
  prop: string | null;
  value: unknown;
}
