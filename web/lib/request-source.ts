import { cache } from "react";
import { getPublicRequest, type PublicRequest } from "./public-api";

const REQUEST_ID = /^[1-9A-HJ-NP-Za-km-z]{6,32}$/;

/** Request ids are short base58 strings; anything else is a 404 without a database read. */
export function isRequestId(id: string): boolean {
  return REQUEST_ID.test(id);
}

/** One read per request id per render, shared by the page, its metadata and its preview card. */
export const loadPublicRequest = cache(async (id: string): Promise<PublicRequest | null> => {
  if (!isRequestId(id)) return null;
  return getPublicRequest(id);
});
