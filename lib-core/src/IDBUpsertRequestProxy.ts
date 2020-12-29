export interface IDBUpsertRequestProxyOptions {
  onSuccess?: (event: Event) => void;
  onError?: (event: Event) => void;
}

export function proxyPutRequest(
  target: Partial<IDBRequest<IDBValidKey>>,
  options: IDBUpsertRequestProxyOptions
): Partial<IDBRequest<IDBValidKey>> {
  const proxy = new IDBUpsertRequestProxy(target, options);
  return new Proxy(target, proxy);
}

/**
 * Use this class as a proxy/wrapper for IDBRequest objects resulting from object store calls to `put()` and `add()`.
 */
export class IDBUpsertRequestProxy {
  target: Partial<IDBRequest<IDBValidKey>>;
  options: IDBUpsertRequestProxyOptions;

  constructor(target: Partial<IDBRequest<IDBValidKey>>, options: IDBUpsertRequestProxyOptions = {}) {
    this.target = target;
    this.options = options;
  }

  set(target: IDBRequest<IDBValidKey>, prop: keyof IDBRequest<IDBValidKey>, value: unknown, receiver: unknown) {
    this.target = target;

    if (prop === 'onsuccess') {
      // Instead of allowing the user to assign _their_ function to 'onupgradeneeded', assign _our_ function.
      target.onsuccess = (event) => {
        if (typeof value === 'function') {
          this.options.onSuccess?.(event);
          // // Run our success handler first, ensuring that we are able to successfully record the operation
          // try {
          //   this.options.onSuccess?.(event);
          //   value(event);
          // } catch (error) {
          //   //TODO: find a way to ensure that both transactions are rolled back
          //   this.target.transaction?.abort();
          // }
        }
      };

      // Proxies should return true to indicate that an assignment (set) succeeded. For more info see
      // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy/Proxy/set#Return_value
      return true;
    } else if (prop === 'onerror') {
      target.onerror = (event) => {
        if (typeof value === 'function') {
          this.options.onError?.(event);
          // try {
          //   value(event);
          // } finally {
          //   this.options.onError?.(event);
          // }
        }
      };
      return true;
    }

    return Reflect.set(target, prop, value, receiver);
  }
}
