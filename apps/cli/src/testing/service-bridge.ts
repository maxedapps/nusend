export function createServiceBridge(handler: (request: Request) => Response | Promise<Response>) {
  const bridge = async (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    handler(
      input instanceof Request
        ? new Request(input, init)
        : new Request(input instanceof URL ? input.toString() : input, init),
    );

  // Bun's fetch typing requires `preconnect`; Node's runtime fetch lacks it.
  // Copy the real one when present, otherwise a no-op stands in.
  return Object.assign(bridge, {
    preconnect: globalThis.fetch.preconnect ?? (() => undefined),
  });
}
