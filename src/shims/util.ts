export const types = {
  isNativeError(value: unknown): boolean {
    return value instanceof Error;
  },
};

export function formatWithOptions(_options: unknown, ...args: unknown[]): string {
  return args
    .map((value) => {
      if (typeof value === "string") return value;
      if (value instanceof Error) return value.stack || value.message;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join(" ");
}

export default { types, formatWithOptions };
