import { quickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";

export async function deleteQuickbooksTransfer(idOrEntity: any): Promise<ToolResponse<any>> {
  try {
    await quickbooksClient.authenticate();
    const quickbooks = quickbooksClient.getQuickbooks();
    return new Promise((resolve) => {
      (quickbooks as any).deleteTransfer(idOrEntity, (err: any, response: any) => {
        if (err) resolve({ result: null, isError: true, error: formatError(err) });
        else resolve({ result: response, isError: false, error: null });
      });
    });
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}
