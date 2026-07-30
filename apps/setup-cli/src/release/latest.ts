import { Effect, Schema } from "effect";

import { PUBLIC_REPO_URL } from "../deploy/constants.ts";
import { SetupCommandError } from "../errors.ts";
import { assertReleaseTag } from "../state/schema.ts";

/** Public GitHub repository used for published releases. */
export const GITHUB_RELEASES_OWNER = "maxedapps";
export const GITHUB_RELEASES_REPO = "nusend";

export const LATEST_RELEASE_API_URL =
  `https://api.github.com/repos/${GITHUB_RELEASES_OWNER}/${GITHUB_RELEASES_REPO}/releases/latest` as const;

const LatestReleaseSchema = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.optional(Schema.Boolean),
  prerelease: Schema.optional(Schema.Boolean),
});

export type FetchLike = (
  input: string,
  init?: {
    readonly headers?: Record<string, string>;
    readonly signal?: AbortSignal;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly text: () => Promise<string>;
}>;

export type ResolveLatestReleaseOptions = {
  readonly fetchImpl?: FetchLike;
  readonly env?: NodeJS.ProcessEnv;
  readonly apiUrl?: string;
};

/**
 * Resolve the latest non-draft/non-prerelease GitHub Release tag and validate it.
 * Pins should happen at init: call once and store the returned tag in setup state.
 */
export function resolveLatestReleaseTag(
  options: ResolveLatestReleaseOptions = {},
): Effect.Effect<string, SetupCommandError> {
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const env = options.env ?? process.env;
  const apiUrl = options.apiUrl ?? LATEST_RELEASE_API_URL;

  return Effect.gen(function* () {
    const bodyText = yield* Effect.tryPromise({
      try: async (signal) => {
        const headers: Record<string, string> = {
          Accept: "application/vnd.github+json",
          "User-Agent": "nusend-setup-cli",
          "X-GitHub-Api-Version": "2022-11-28",
        };
        const token = firstNonEmpty(env.GH_TOKEN, env.GITHUB_TOKEN);
        if (token !== null) {
          headers.Authorization = `Bearer ${token}`;
        }

        const response = await fetchImpl(apiUrl, { headers, signal });
        const text = await response.text();
        if (!response.ok) {
          throw new SetupCommandError({
            message: formatApiFailure(response.status, text),
          });
        }
        return text;
      },
      catch: (error) => mapFetchError(error),
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return yield* Effect.fail(
        new SetupCommandError({
          message: "GitHub Releases API returned malformed JSON for the latest release.",
        }),
      );
    }

    const release = yield* (
      Schema.decodeUnknownEffect(LatestReleaseSchema)(parsed, { errors: "all" }) as Effect.Effect<
        typeof LatestReleaseSchema.Type,
        unknown
      >
    ).pipe(
      Effect.mapError(
        () =>
          new SetupCommandError({
            message: "GitHub Releases API latest payload is missing a valid tag_name.",
          }),
      ),
    );

    if (release.draft === true || release.prerelease === true) {
      // /releases/latest should already skip these; fail closed if the API shape changes.
      return yield* Effect.fail(
        new SetupCommandError({
          message:
            "Latest GitHub release is a draft or prerelease; Nusend setup requires a full published release.",
        }),
      );
    }

    return yield* Effect.try({
      try: () => assertReleaseTag(release.tag_name.trim()),
      catch: (error) =>
        new SetupCommandError({
          message:
            error instanceof Error
              ? `Latest GitHub release tag is invalid: ${error.message}`
              : "Latest GitHub release tag is invalid.",
        }),
    });
  });
}

function defaultFetch(
  input: string,
  init?: {
    readonly headers?: Record<string, string>;
    readonly signal?: AbortSignal;
  },
): Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly text: () => Promise<string>;
}> {
  return fetch(input, {
    headers: init?.headers,
    signal: init?.signal,
  });
}

function firstNonEmpty(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function mapFetchError(error: unknown): SetupCommandError {
  if (error instanceof SetupCommandError) return error;
  return new SetupCommandError({
    message: `Could not resolve the latest published Nusend release from GitHub (${PUBLIC_REPO_URL}). ${
      error instanceof Error ? error.message : String(error)
    } Check network access to api.github.com, then retry. Optional: set GH_TOKEN for a higher API rate limit.`,
  });
}

function formatApiFailure(status: number, bodyText: string): string {
  const snippet = bodyText.replace(/\s+/gu, " ").trim().slice(0, 180);
  if (status === 404) {
    return `No published GitHub Release found for ${GITHUB_RELEASES_OWNER}/${GITHUB_RELEASES_REPO}. Publish a non-prerelease release, then retry.`;
  }
  if (status === 403 || status === 429) {
    return `GitHub Releases API rate-limited or forbade the request (HTTP ${status}). Retry later${
      snippet ? `: ${snippet}` : "."
    } Optional: set GH_TOKEN for a higher rate limit.`;
  }
  return `GitHub Releases API failed with HTTP ${status}${snippet ? `: ${snippet}` : "."}`;
}
