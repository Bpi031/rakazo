/** Historical Prisma payloads must not be presented as provider failures or leaked in Details. */
export function usageRunError(details: string): { summary: string; details: string } | null {
  if (!/^ROST_USAGE_RECORD_FAILED:/.test(details.trim()) &&
      !/^Invalid\s+`?prisma\.usageRecord\.(?:createMany|create)\(\)`?\s+invocation:/i.test(details.trim())) {
    return null;
  }
  return {
    summary: "Rakazo could not save model usage. Check existing work before retrying.",
    details: "ROST_USAGE_RECORD_FAILED: Usage accounting failed. An administrator must investigate. This does not establish whether a background job is running.",
  };
}
