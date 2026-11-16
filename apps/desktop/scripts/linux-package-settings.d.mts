/**
 * Validate Linux worker limits and compression before packaging starts.
 * File-owned compression takes precedence over the existing electron-builder environment override.
 * @param environment Loaded packaging settings and inherited build environment.
 * @returns A positive integer pack limit defaulting to four and archive compression from zero to nine, defaulting to three. Invalid values throw.
 */
export function resolveLinuxPackageSettings(environment: NodeJS.ProcessEnv): { packConcurrency: number, compressionLevel: number }
