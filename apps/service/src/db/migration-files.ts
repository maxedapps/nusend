import { createHash } from "node:crypto";

export type MigrationFile = {
  checksum: string;
  downSql: string;
  upSql: string;
  version: string;
};

const upMarker = /^\s*--\s*migrate:up\s*$/gim;
const downMarker = /^\s*--\s*migrate:down\s*$/gim;

export function parseMigrationFile(version: string, content: string): MigrationFile {
  const upMatches = findMarkerMatches(content, upMarker);
  const downMatches = findMarkerMatches(content, downMarker);

  if (upMatches.length !== 1) {
    throw new Error(`Migration ${version} must contain exactly one -- migrate:up marker.`);
  }

  if (downMatches.length !== 1) {
    throw new Error(`Migration ${version} must contain exactly one -- migrate:down marker.`);
  }

  const upMatch = upMatches[0];
  const downMatch = downMatches[0];

  if (downMatch.index < upMatch.index) {
    throw new Error(`Migration ${version} must place -- migrate:up before -- migrate:down.`);
  }

  const upSql = content.slice(upMatch.end, downMatch.index).trim();
  const downSql = content.slice(downMatch.end).trim();

  if (upSql.length === 0) {
    throw new Error(`Migration ${version} has an empty up section.`);
  }

  if (downSql.length === 0) {
    throw new Error(`Migration ${version} has an empty down section.`);
  }

  return {
    checksum: checksum(content),
    downSql,
    upSql,
    version,
  };
}

export function checksum(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

type MarkerMatch = {
  end: number;
  index: number;
};

function findMarkerMatches(content: string, marker: RegExp): MarkerMatch[] {
  marker.lastIndex = 0;

  return [...content.matchAll(marker)].map((match) => ({
    end: match.index + match[0].length,
    index: match.index,
  }));
}
