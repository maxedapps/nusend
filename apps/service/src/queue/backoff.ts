const initialBackoffSeconds = 60;
const maxBackoffSeconds = 3600;

export function calculateBackoffSeconds(attempts: number): number {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError("attempts must be a positive integer");
  }

  return Math.min(initialBackoffSeconds * 2 ** (attempts - 1), maxBackoffSeconds);
}
