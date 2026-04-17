import { AsyncLocalStorage } from "node:async_hooks";

interface AuthContext {
  accessToken?: string;
}

export const authStorage = new AsyncLocalStorage<AuthContext>();

export function getOptionalAccessToken(): string | undefined {
  return authStorage.getStore()?.accessToken;
}

export function getCurrentAccessToken(): string {
  const accessToken = getOptionalAccessToken();
  if (!accessToken) {
    throw new Error("No access token in current request context");
  }
  return accessToken;
}
