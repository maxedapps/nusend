export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function printContinuationHint(nextOffset: number | null): void {
  if (nextOffset !== null) {
    console.log(`More results available: rerun with --offset ${nextOffset}.`);
  }
}
