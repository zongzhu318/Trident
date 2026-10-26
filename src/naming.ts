// Session titles append a " (2)" style suffix when the base name is already open.
const NAME_MAX = 100;
const suffixPattern = /^(.*) \((\d+)\)$/;

export function uniqueName(name: string, taken: string[], max = NAME_MAX) {
  const used = new Set(taken.map((value) => value.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  const matched = suffixPattern.exec(name);
  const root = matched ? matched[1] : name;
  let index = matched ? Number(matched[2]) + 1 : 2;
  for (;;) {
    const suffix = ` (${index})`;
    const candidate = `${root.slice(0, max - suffix.length).trimEnd()}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
    index += 1;
  }
}
