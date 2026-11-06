/**
 * Cloudflare Pages Functions Catch-All Handler (`functions/[[path]].ts`)
 * Bridges Cloudflare Pages Functions (`onRequest`) directly to the Cloudflare Worker handler (`src/index.ts`),
 * ensuring 100% compatibility whether deployed via Cloudflare Workers or Cloudflare Pages.
 */

import { handleWorkerRequest } from "../src/index.ts";
import type { Env, ExecutionContext } from "../src/types.ts";

export const onRequest = async (context: {
  request: Request;
  env: Env;
  waitUntil: (promise: Promise<unknown>) => void;
  passThroughOnException: () => void;
  next: (input?: Request | string, init?: RequestInit) => Promise<Response>;
}): Promise<Response> => {
  const envWithAssets: Env = {
    ...context.env,
    ASSETS: context.env.ASSETS || {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        if (typeof input === "string" || input instanceof URL) {
          return context.next(input.toString(), init);
        }
        return context.next(input, init);
      }
    }
  };

  const ctx: ExecutionContext = {
    waitUntil: (p) => context.waitUntil(p),
    passThroughOnException: () => context.passThroughOnException()
  };

  return handleWorkerRequest(context.request, envWithAssets, ctx);
};
