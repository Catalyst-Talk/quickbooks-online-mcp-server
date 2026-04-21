import { AsyncLocalStorage } from "node:async_hooks";

export interface AuthContext {
  accessToken?: string;
  principalId?: string;
  clientId?: string;
  tokenScopes?: string[];
  quickBooksConnectionId?: string;
  quickBooksRealmId?: string;
  quickBooksEnvironment?: "sandbox" | "production";
}

export const authStorage = new AsyncLocalStorage<AuthContext>();

export function getAuthContext(): AuthContext | undefined {
  return authStorage.getStore();
}

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

export function getOptionalPrincipalId(): string | undefined {
  return authStorage.getStore()?.principalId;
}

export function getCurrentPrincipalId(): string {
  const principalId = getOptionalPrincipalId();
  if (!principalId) {
    throw new Error("No principal ID in current request context");
  }

  return principalId;
}

export function getOptionalConnectionId(): string | undefined {
  return authStorage.getStore()?.quickBooksConnectionId;
}

export function getCurrentConnectionId(): string {
  const connectionId = getOptionalConnectionId();
  if (!connectionId) {
    throw new Error("No QuickBooks connection ID in current request context");
  }

  return connectionId;
}
