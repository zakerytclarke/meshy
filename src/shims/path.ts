export function normalize(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

export default { normalize };
