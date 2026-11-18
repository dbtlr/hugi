/** Prereleases need a digit to distinguish specific builds from moving aliases. */
export function pinnedVersion(tool: string, version: string) {
  const numeric =
    /^v?\d+(?:\.\d+){0,2}(?:-(?=[0-9A-Za-z.-]*\d)[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u.test(
      version,
    );
  const datedRust = tool === 'rust' && /^(?:stable|beta|nightly)-\d{4}-\d{2}-\d{2}$/u.test(version);
  if (!numeric && !datedRust) {
    throw new Error(`unpinned ${tool} version ${JSON.stringify(version)}`);
  }
  return `${tool}@${version}`;
}
