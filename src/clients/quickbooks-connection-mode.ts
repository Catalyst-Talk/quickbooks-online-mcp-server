const DEFAULT_SHARED_QUICKBOOKS_CONNECTION_PRINCIPAL_ID =
  "connector:shared-quickbooks-installation";

export function isSharedQuickBooksConnectionMode(): boolean {
  return process.env.MCP_QUICKBOOKS_CONNECTION_MODE === "shared";
}

export function getSharedQuickBooksConnectionPrincipalId(): string {
  const explicitPrincipalId = process.env.MCP_QUICKBOOKS_SHARED_CONNECTION_PRINCIPAL_ID;
  if (explicitPrincipalId) {
    return explicitPrincipalId;
  }

  const organizationId = process.env.MCP_QUICKBOOKS_SHARED_CONNECTION_ORG_ID;
  if (!organizationId) {
    throw new Error(
      "MCP_QUICKBOOKS_SHARED_CONNECTION_ORG_ID is required when MCP_QUICKBOOKS_CONNECTION_MODE=shared unless MCP_QUICKBOOKS_SHARED_CONNECTION_PRINCIPAL_ID is set",
    );
  }

  return `${DEFAULT_SHARED_QUICKBOOKS_CONNECTION_PRINCIPAL_ID}:${organizationId}`;
}

export function getQuickBooksConnectionOwnerPrincipalId(
  requestPrincipalId: string,
): string {
  return isSharedQuickBooksConnectionMode()
    ? getSharedQuickBooksConnectionPrincipalId()
    : requestPrincipalId;
}

export function getQuickBooksConnectionMode(): "per-principal" | "shared" {
  return isSharedQuickBooksConnectionMode() ? "shared" : "per-principal";
}
