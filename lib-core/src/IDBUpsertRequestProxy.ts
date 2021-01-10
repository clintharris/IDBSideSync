export interface IDBUpsertRequestProxyOptions {
  onSuccess?: (event: Event) => void;
  onError?: (event: Event) => void;
}

export function proxyPutRequest(
  target: IDBRequest<IDBValidKey>,
  options: IDBUpsertRequestProxyOptions
): IDBRequest<IDBValidKey> {
  const proxy = new IDBUpsertRequestProxy(target, options);
  return new Proxy(target, proxy);
}

/**
 * Use this class as a proxy/wrapper for IDBRequest objects resulting from object store calls to `put()` and `add()`.
 */
export class IDBUpsertRequestProxy {
  target: IDBRequest<IDBValidKey>;
  options: IDBUpsertRequestProxyOptions;
  upstreamOnSuccess: IDBRequest['onsuccess'] = null;
  upstreamOnError: IDBRequest['onerror'] = null;

  constructor(target: IDBRequest<IDBValidKey>, options: IDBUpsertRequestProxyOptions = {}) {
    this.target = target;
    this.options = options;
    this.target.onsuccess = this.onSuccess;
    this.target.onerror = this.onError;
  }

  get = (target: IDBRequest<IDBValidKey>, prop: keyof IDBRequest<IDBValidKey>) => {
    if (target && target[prop]) {
      const value = target[prop];
      if (value !== null && typeof value === 'function') {
        return value.bind(target);
      }
    }

    // The `Proxy` API docs indicate that we should actually return `Reflect.get(target, prop, receiver)` at this point
    // but, in practice, Chrome throws "TypeError: Illegal invocation" when this is done.
    return target[prop];
  };

  set = (target: IDBRequest<IDBValidKey>, prop: keyof IDBRequest<IDBValidKey>, value: unknown, receiver: unknown) => {
    if (prop === 'onsuccess' && typeof value === 'function') {
      // Upstream developer is attempting to assign theor own `onsuccess` handler to the request object; however, we're
      // going to just capture their handler function and not actually allow it to be assigned. We have already assigned
      // an `onsuccess` handler to the request (myOnSuccess), and that will call the upstream developer's handler.
      this.upstreamOnSuccess = value.bind(target);

      // Proxies should return true to indicate that an assignment (set) succeeded. For more info see
      // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy/Proxy/set#Return_value
      return true;
    }

    if (prop === 'onerror' && typeof value === 'function') {
      this.upstreamOnError = value.bind(target);
      return true;
    }

    return Reflect.set(target, prop, value, receiver);
  };

  onSuccess: IDBRequest['onsuccess'] = (...args) => {
    if (typeof this.options.onSuccess === 'function') {
      this.options.onSuccess(...args);
    }

    if (typeof this.upstreamOnSuccess === 'function') {
      this.upstreamOnSuccess.apply(this.target, args);
    }
  };

  onError: IDBRequest['onerror'] = (...args) => {
    if (typeof this.options.onError === 'function') {
      this.options.onError(...args);
    }

    if (typeof this.upstreamOnError === 'function') {
      this.upstreamOnError.apply(this.target, args);
    }
  };
}
