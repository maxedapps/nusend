// The public error envelope: every non-2xx JSON response uses this shape.
export function errorResponse(
  code: string,
  message: string,
): { error: { code: string; message: string } } {
  return { error: { code, message } };
}
