export function nowIso(): string {
  return new Date().toISOString();
}

export function addSecondsIso(isoTime: string, seconds: number): string {
  return new Date(new Date(isoTime).getTime() + seconds * 1000).toISOString();
}
