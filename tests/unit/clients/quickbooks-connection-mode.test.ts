import { afterEach, describe, expect, it } from "@jest/globals";
import {
  getQuickBooksConnectionMode,
  getQuickBooksConnectionOwnerPrincipalId,
  getSharedQuickBooksConnectionPrincipalId,
  isSharedQuickBooksConnectionMode,
} from "../../../src/clients/quickbooks-connection-mode";

describe("quickbooks connection mode", () => {
  afterEach(() => {
    delete process.env.MCP_QUICKBOOKS_CONNECTION_MODE;
    delete process.env.MCP_QUICKBOOKS_SHARED_CONNECTION_PRINCIPAL_ID;
    delete process.env.MCP_QUICKBOOKS_SHARED_CONNECTION_ORG_ID;
  });

  it("defaults to per-principal QuickBooks connections", () => {
    expect(isSharedQuickBooksConnectionMode()).toBe(false);
    expect(getQuickBooksConnectionMode()).toBe("per-principal");
    expect(
      getQuickBooksConnectionOwnerPrincipalId("connector:user-principal"),
    ).toBe("connector:user-principal");
  });

  it("uses the default shared owner when shared mode is enabled", () => {
    process.env.MCP_QUICKBOOKS_CONNECTION_MODE = "shared";
    process.env.MCP_QUICKBOOKS_SHARED_CONNECTION_ORG_ID = "acme";

    expect(isSharedQuickBooksConnectionMode()).toBe(true);
    expect(getQuickBooksConnectionMode()).toBe("shared");
    expect(getSharedQuickBooksConnectionPrincipalId()).toBe(
      "connector:shared-quickbooks-installation:acme",
    );
    expect(
      getQuickBooksConnectionOwnerPrincipalId("connector:user-principal"),
    ).toBe("connector:shared-quickbooks-installation:acme");
  });

  it("requires a shared owner scope when shared mode is enabled", () => {
    process.env.MCP_QUICKBOOKS_CONNECTION_MODE = "shared";

    expect(() => getSharedQuickBooksConnectionPrincipalId()).toThrow(
      "MCP_QUICKBOOKS_SHARED_CONNECTION_ORG_ID is required",
    );
  });

  it("uses a configured shared owner principal", () => {
    process.env.MCP_QUICKBOOKS_CONNECTION_MODE = "shared";
    process.env.MCP_QUICKBOOKS_SHARED_CONNECTION_PRINCIPAL_ID =
      "connector:company-install";

    expect(getSharedQuickBooksConnectionPrincipalId()).toBe(
      "connector:company-install",
    );
    expect(
      getQuickBooksConnectionOwnerPrincipalId("connector:user-principal"),
    ).toBe("connector:company-install");
  });
});
