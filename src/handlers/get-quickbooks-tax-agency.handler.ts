import { quickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";

export async function getQuickbooksTaxAgency(id: string): Promise<ToolResponse<any>> {
  try {
    await quickbooksClient.authenticate();
    const quickbooks = quickbooksClient.getQuickbooks();
    return new Promise((resolve) => {
      (quickbooks as any).getTaxAgency(id, (err: any, taxAgency: any) => {
        if (err) resolve({ result: null, isError: true, error: formatError(err) });
        else resolve({ result: taxAgency, isError: false, error: null });
      });
    });
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}
