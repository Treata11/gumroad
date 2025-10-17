export type RequestSettings = {
  accept: "json" | "html" | "csv";
  url: string;
  abortSignal?: AbortSignal | undefined;
  timeoutMs?: number;
} & ({ method: "GET" } | { method: "POST" | "PUT" | "PATCH" | "DELETE"; data?: Record<string, unknown> | FormData });

export class AbortError extends Error {
  constructor() {
    super("Request aborted");
  }
}

export class TimeoutError extends Error {
  constructor() {
    super("Request timed out");
  }
}

export class ResponseError extends Error {
  constructor(message = "Something went wrong.") {
    super(message);
  }
}

export function assertResponseError(e: unknown): asserts e is ResponseError {
  if (!(e instanceof ResponseError)) throw e;
}

declare global {
  // eslint-disable-next-line -- hack, used in `wait_for_ajax` in testing
  var __activeRequests: number;
}
globalThis.__activeRequests = 0;

export const defaults: RequestInit = {};

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

export const request = async (settings: RequestSettings): Promise<Response> => {
  ++globalThis.__activeRequests;

  const data =
    settings.method === "GET"
      ? null
      : settings.data instanceof FormData
      ? settings.data
      : JSON.stringify(settings.data);

  const acceptType = {
    json: "application/json, text/html",
    html: "text/html",
    csv: "text/csv",
  }[settings.accept];

  const headers = new Headers(defaults.headers);
  headers.set("Accept", acceptType);
  if (data && !(data instanceof FormData)) headers.set("Content-Type", "application/json");

  const maxAttempts = settings.method === "GET" ? 3 : 1;
  const baseTimeout = typeof settings.timeoutMs === "number" ? settings.timeoutMs : 60000;

  let attempt = 0;
  while (attempt < maxAttempts) {
    const timeoutController = new AbortController();
    const combinedSignal = timeoutController.signal;
    const userSignal = settings.abortSignal;

    const onUserAbort = () => {
      if (!timeoutController.signal.aborted) timeoutController.abort();
    };

    if (userSignal) {
      if (userSignal.aborted) {
        --globalThis.__activeRequests;
        throw new AbortError();
      }
      userSignal.addEventListener("abort", onUserAbort);
    }

    const timeoutId = setTimeout(() => {
      if (!timeoutController.signal.aborted) timeoutController.abort();
    }, baseTimeout);

    try {
      const response = await fetch(settings.url, {
        ...defaults,
        method: settings.method,
        body: data,
        headers,
        signal: combinedSignal as AbortSignal,
      });

      clearTimeout(timeoutId);
      if (userSignal) userSignal.removeEventListener("abort", onUserAbort);

      if (response.status >= 500) throw new ResponseError();
      if (response.status === 429) throw new ResponseError("Something went wrong, please try again after some time.");
      return response;
    } catch (e: unknown) {
      clearTimeout(timeoutId);
      if (userSignal) userSignal.removeEventListener("abort", onUserAbort);

      if (e instanceof DOMException && e.name === "AbortError") {
        if (userSignal && userSignal.aborted) {
          throw new AbortError();
        } else {
          if (attempt < maxAttempts - 1 && settings.method === "GET") {
            const backoff = 500 * Math.pow(2, attempt);
            await sleep(backoff);
            attempt += 1;
            continue;
          } else {
            throw new TimeoutError();
          }
        }
      }

      if (e instanceof ResponseError) throw e;

      const isNetworkFailure = e instanceof TypeError;
      if (isNetworkFailure && attempt < maxAttempts - 1 && settings.method === "GET") {
        const backoff = 500 * Math.pow(2, attempt);
        await sleep(backoff);
        attempt += 1;
        continue;
      }

      throw new ResponseError();
    }
  }

  --globalThis.__activeRequests;
  throw new ResponseError();
};
